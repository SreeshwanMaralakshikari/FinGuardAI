import express from 'express';
import mongoose from 'mongoose';
import { verifyToken, authorizeRoles } from '../middleware/verifyToken.js';
import validate from '../middleware/validate.js';
import asyncHandler from '../middleware/asyncHandler.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { createCaseRules, updateStatusRules, addNoteRules } from '../validators/caseValidators.js';
import { createWithSequentialId } from '../utils/generateSequentialId.js';
import createNotification from '../utils/createNotification.js';
import createAuditLog from '../utils/createAuditLog.js';
import { buildDateRange } from '../utils/dateRange.js';
import { FLAGGED_RISK_LEVELS } from '../utils/enums.js';
import { analystCasesQueryRules, flaggedTransactionsQueryRules } from '../validators/queryValidators.js';
import {
  CLOSED_STATUSES,
  isTransitionAllowed,
  describeTransition,
  applyCaseOutcome,
  notifyAnalystsOfStatusChange,
} from '../utils/caseWorkflow.js';
import TransactionModel from '../models/TransactionModel.js';
import FraudAlertModel from '../models/FraudAlertModel.js';
import FraudCaseModel from '../models/FraudCaseModel.js';
import DeviceReputationModel from '../models/DeviceReputationModel.js';

const router = express.Router();

// ── RBAC: all routes under /analyst-api require ANALYST role ──────────────────
router.use(verifyToken, authorizeRoles('ANALYST'));

const CLOSED_CASE_MESSAGE = 'This case is already closed and cannot be updated.';

/**
 * A guarded write matched nothing: the case changed (or closed) between our read
 * and our write. Reload it and answer accurately instead of overwriting (L-04).
 */
const respondCaseChanged = async (res, caseId) => {
  const current = await FraudCaseModel.findById(caseId).select('status');
  if (!current) return res.status(404).json({ success: false, message: 'Case not found.' });
  if (CLOSED_STATUSES.includes(current.status)) {
    return res.status(400).json({ success: false, message: CLOSED_CASE_MESSAGE });
  }
  return res.status(409).json({
    success: false,
    message: 'This case was just updated by someone else. Refresh and try again.',
  });
};

/**
 * Is this the duplicate-key error of the unique index on FraudCase.fraudAlertId?
 * MongoDB names the index in keyPattern / the message; some MongoDB-compatible
 * stores send neither, so in that case look whether a case for the alert exists.
 */
const isDuplicateAlertCase = async (err, fraudAlertId) => {
  if (err?.code !== 11000) return false;
  const keys = Object.keys(err.keyPattern ?? err.keyValue ?? {});
  if (keys.includes('fraudAlertId') || String(err.message).includes('fraudAlertId')) return true;
  if (keys.length === 0) return Boolean(await FraudCaseModel.exists({ fraudAlertId }));
  return false;
};

// ── GET /analyst-api/flagged-transactions ─────────────────────────────────────
router.get(
  '/flagged-transactions',
  flaggedTransactionsQueryRules, // E-14: ?riskLevel=LOW used to be ignored silently
  validate,
  asyncHandler(async (req, res) => {
    const { riskLevel } = req.query;
    const { page, limit, skip } = parsePagination(req.query, 20); // AUD-21

    // Base: system-wide HIGH and CRITICAL only
    const filter = { riskLevel: { $in: FLAGGED_RISK_LEVELS } };

    // Optional narrow filter — the validator guarantees HIGH or CRITICAL
    if (riskLevel) filter.riskLevel = riskLevel;

    const dateFilter = buildDateRange(req.query); // L-05: 'YYYY-MM-DD' = a whole IST day
    if (dateFilter) filter.timestamp = dateFilter;

    const [transactions, total] = await Promise.all([
      TransactionModel.find(filter)
        .sort({ timestamp: -1, _id: -1 }) // C-06: stable paging when timestamps tie
        .skip(skip)
        .limit(Number(limit))
        .populate('userId', 'name email trustScore')
        .select('publicId amount merchantName merchantCategory paymentMethod riskLevel fraudScore reasons recommendedAction status timestamp deviceId ipAddress customerResponse'),
      TransactionModel.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: transactions,
      pagination: buildPagination(page, limit, total),
    });
  })
);

// ── GET /analyst-api/flagged-transactions/:id ──────────────────────────────────
router.get(
  '/flagged-transactions/:id',
  asyncHandler(async (req, res) => {
    // E-05: same visibility as the list — LOW / MEDIUM transactions are not part of the analyst queue.
    const transaction = await TransactionModel.findOne({ _id: req.params.id, riskLevel: { $in: FLAGGED_RISK_LEVELS } })
      .populate('userId', 'name email trustScore createdAt');

    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found.' });
    }

    // Fetch full investigation context in parallel
    const [deviceReputation, fraudAlert, existingCase] = await Promise.all([
      DeviceReputationModel.findOne({ deviceId: transaction.deviceId })
        .populate('associatedUserIds', 'name email'),
      FraudAlertModel.findOne({ transactionId: transaction._id }),
      FraudCaseModel.findOne({ transactionId: transaction._id })
        .select('publicId status assignedAnalystId openedAt')
        .populate('assignedAnalystId', 'name email'),
    ]);

    // A-09: an analyst reading a customer's transaction is part of the audit trail (a failed write is only logged).
    await createAuditLog(
      req.user._id,
      'ANALYST',
      'TRANSACTION_VIEWED',
      'Transaction',
      transaction.publicId,
      { customerId: String(transaction.userId?._id ?? transaction.userId), riskLevel: transaction.riskLevel },
      req.ip
    );

    res.status(200).json({
      success: true,
      data: {
        transaction,
        deviceReputation: deviceReputation ?? null,
        fraudAlert: fraudAlert ?? null,
        existingCase: existingCase ?? null,
      },
    });
  })
);

// ── POST /analyst-api/cases ────────────────────────────────────────────────────
router.post(
  '/cases',
  createCaseRules,
  validate,
  asyncHandler(async (req, res) => {
    const { fraudAlertId, initialNote } = req.body;

    const fraudAlert = await FraudAlertModel.findById(fraudAlertId);
    if (!fraudAlert) {
      return res.status(404).json({ success: false, message: 'Fraud alert not found.' });
    }

    // E-05: MEDIUM alerts never enter the analyst queue (AUD-38), so no case can be opened on one.
    if (!FLAGGED_RISK_LEVELS.includes(fraudAlert.riskLevel)) {
      return res.status(400).json({ success: false, message: 'Cases can only be opened for HIGH or CRITICAL alerts.' });
    }

    // Prevent duplicate cases for the same alert (friendly pre-check; the unique
    // index on fraudAlertId is what makes it race-proof — see the catch below).
    const duplicateMessage = 'A case already exists for this alert.';
    if (await FraudCaseModel.exists({ fraudAlertId })) {
      return res.status(400).json({ success: false, message: duplicateMessage });
    }

    // Build initial notes array if an opening note was provided
    const notes = initialNote
      ? [{ analystId: req.user._id, text: initialNote.trim(), createdAt: new Date() }]
      : [];

    // Insert the case together with its CASE-YYYY-NNNNN public ID (AUD-05)
    let fraudCase;
    try {
      fraudCase = await createWithSequentialId(FraudCaseModel, 'publicId', 'CASE', {
        fraudAlertId,
        transactionId: fraudAlert.transactionId,
        status: 'OPEN',
        notes,
      });
    } catch (err) {
      // Two simultaneous requests both passed the pre-check: the unique index stopped the second.
      if (await isDuplicateAlertCase(err, fraudAlertId)) {
        return res.status(400).json({ success: false, message: duplicateMessage });
      }
      throw err;
    }
    const { publicId } = fraudCase;

    // B-04: the alert stays OPEN while its case is open; applyCaseOutcome sets REVIEWED / DISMISSED when the case closes.

    await createAuditLog(
      req.user._id,
      'ANALYST',
      'CASE_CREATED',
      'FraudCase',
      publicId,
      { fraudAlertId: fraudAlert._id.toString(), transactionId: fraudAlert.transactionId.toString() },
      req.ip
    );

    res.status(201).json({
      success: true,
      message: 'Investigation case created.',
      data: fraudCase,
    });
  })
);

// ── GET /analyst-api/cases ────────────────────────────────────────────────────
router.get(
  '/cases',
  analystCasesQueryRules, // E-14
  validate,
  asyncHandler(async (req, res) => {
    const { status, assignedToMe } = req.query;
    const { page, limit, skip } = parsePagination(req.query, 20); // AUD-21

    const filter = {};
    if (status) filter.status = status;
    if (assignedToMe === 'true') filter.assignedAnalystId = req.user._id;

    const [cases, total] = await Promise.all([
      FraudCaseModel.find(filter)
        .sort({ openedAt: -1, _id: -1 }) // C-06
        .skip(skip)
        .limit(Number(limit))
        .populate('assignedAnalystId', 'name email')
        .populate('transactionId', 'publicId amount merchantName riskLevel fraudScore')
        .select('publicId status assignedAnalystId transactionId openedAt resolvedAt'),
      FraudCaseModel.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: cases,
      pagination: buildPagination(page, limit, total),
    });
  })
);

// ── GET /analyst-api/cases/:id ────────────────────────────────────────────────
router.get(
  '/cases/:id',
  asyncHandler(async (req, res) => {
    const fraudCase = await FraudCaseModel.findById(req.params.id)
      .populate('fraudAlertId')
      .populate('transactionId')
      .populate('assignedAnalystId', 'name email')
      .populate('notes.analystId', 'name email');

    if (!fraudCase) {
      return res.status(404).json({ success: false, message: 'Case not found.' });
    }

    res.status(200).json({ success: true, data: fraudCase });
  })
);

// ── PATCH /analyst-api/cases/:id/assign ──────────────────────────────────────
// Any analyst may take an open case or take over an unfinished one (the previous
// assignee is told). A case keeps its status when it changes hands: OPEN becomes
// ASSIGNED, UNDER_REVIEW stays UNDER_REVIEW (L-04).
router.patch(
  '/cases/:id/assign',
  asyncHandler(async (req, res) => {
    const fraudCase = await FraudCaseModel.findById(req.params.id);
    if (!fraudCase) {
      return res.status(404).json({ success: false, message: 'Case not found.' });
    }

    if (CLOSED_STATUSES.includes(fraudCase.status)) {
      return res.status(400).json({ success: false, message: 'Cannot assign a closed case.' });
    }

    const previousAnalyst = fraudCase.assignedAnalystId;
    const previousStatus = fraudCase.status;
    const analystId = req.user._id;

    // Already yours: nothing to change, nobody to notify.
    if (previousAnalyst && previousAnalyst.equals(analystId) && previousStatus !== 'OPEN') {
      return res.status(200).json({
        success: true,
        message: 'Case assigned.',
        data: { publicId: fraudCase.publicId, status: previousStatus, assignedAnalystId: String(analystId) },
      });
    }

    const nextStatus = previousStatus === 'OPEN' ? 'ASSIGNED' : previousStatus;

    // Atomic: only succeeds if the case still has the status and owner we just read.
    const updated = await FraudCaseModel.findOneAndUpdate(
      { _id: fraudCase._id, status: previousStatus, assignedAnalystId: previousAnalyst ?? null },
      { $set: { assignedAnalystId: analystId, status: nextStatus } },
      { returnDocument: 'after' }
    );
    if (!updated) return respondCaseChanged(res, fraudCase._id);

    // E-13: the analyst who takes the case is the one making this request, so there is nobody
    // to tell about "their own" action. Only the analyst who LOST the case is notified (below).

    // …and the analyst who just lost it (BS-18)
    if (previousAnalyst && !previousAnalyst.equals(analystId)) {
      try {
        await createNotification({
          recipientId: previousAnalyst,
          recipientRole: 'ANALYST',
          type: 'CASE_STATUS_CHANGED',
          title: `Case ${updated.publicId} Reassigned`,
          message: `Case ${updated.publicId} was reassigned to ${req.user.name}.`,
          relatedEntityId: updated._id,
          relatedEntityType: 'FRAUD_CASE',
        });
      } catch (err) {
        console.error('[AnalystAPI] Could not notify previous analyst:', err.message);
      }
    }

    await createAuditLog(
      req.user._id,
      'ANALYST',
      'CASE_ASSIGNED',
      'FraudCase',
      updated.publicId,
      {
        previousAnalyst: previousAnalyst?.toString() ?? null,
        newAnalyst: req.user._id.toString(),
        previousStatus,
        status: updated.status,
      },
      req.ip
    );

    res.status(200).json({
      success: true,
      message: 'Case assigned.',
      data: { publicId: updated.publicId, status: updated.status, assignedAnalystId: String(analystId) },
    });
  })
);

// ── PATCH /analyst-api/cases/:id/status ──────────────────────────────────────
// Rules (L-02 / L-04, utils/caseWorkflow.js): closed cases reject everything;
// only the assigned analyst may change the status; only the transitions in
// ALLOWED_TRANSITIONS are legal; the write is conditional on the status we read,
// so two analysts cannot both close the same case.
router.patch(
  '/cases/:id/status',
  updateStatusRules,
  validate,
  asyncHandler(async (req, res) => {
    const { status, resolutionSummary } = req.body;

    const fraudCase = await FraudCaseModel.findById(req.params.id);
    if (!fraudCase) {
      return res.status(404).json({ success: false, message: 'Case not found.' });
    }

    if (CLOSED_STATUSES.includes(fraudCase.status)) {
      return res.status(400).json({ success: false, message: CLOSED_CASE_MESSAGE });
    }

    const previousStatus = fraudCase.status;
    if (previousStatus === 'OPEN') {
      return res.status(400).json({ success: false, message: describeTransition(previousStatus, status) });
    }

    if (!fraudCase.assignedAnalystId || !fraudCase.assignedAnalystId.equals(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Only the assigned analyst can change the status.' });
    }

    if (!isTransitionAllowed(previousStatus, status)) {
      return res.status(400).json({ success: false, message: describeTransition(previousStatus, status) });
    }

    const closing = CLOSED_STATUSES.includes(status);
    const $set = { status };
    if (resolutionSummary) $set.resolutionSummary = resolutionSummary;
    if (closing) $set.resolvedAt = new Date();

    const updated = await FraudCaseModel.findOneAndUpdate(
      { _id: fraudCase._id, status: previousStatus, assignedAnalystId: req.user._id },
      { $set },
      { returnDocument: 'after', runValidators: true }
    );
    if (!updated) return respondCaseChanged(res, fraudCase._id);

    if (closing) {
      try {
        await applyCaseOutcome({ fraudCase: updated, status, analyst: req.user, ip: req.ip });
      } catch (err) {
        // The case was closed first; undo that so the analyst can simply retry
        // instead of meeting "already closed" with the alert and payment untouched.
        await FraudCaseModel.updateOne(
          { _id: updated._id, status },
          { $set: { status: previousStatus }, $unset: { resolvedAt: 1, resolutionSummary: 1 } }
        ).catch((undoErr) => console.error('[AnalystAPI] Could not reopen case after a failed close:', undoErr.message));
        throw err;
      }
    }

    await createAuditLog(
      req.user._id,
      'ANALYST',
      'CASE_STATUS_CHANGED',
      'FraudCase',
      updated.publicId,
      { previousStatus, newStatus: status, resolutionSummary: resolutionSummary ?? null },
      req.ip
    );

    // A-03: the other analysts are told too (never fails the request).
    await notifyAnalystsOfStatusChange({ fraudCase: updated, previousStatus, newStatus: status, actor: req.user });

    res.status(200).json({
      success: true,
      message: 'Case status updated.',
      data: { publicId: updated.publicId, status: updated.status, resolvedAt: updated.resolvedAt ?? null },
    });
  })
);

// ── POST /analyst-api/cases/:id/notes ─────────────────────────────────────────
router.post(
  '/cases/:id/notes',
  addNoteRules,
  validate,
  asyncHandler(async (req, res) => {
    const note = {
      _id: new mongoose.Types.ObjectId(),
      analystId: req.user._id,
      text: req.body.text.trim(),
      createdAt: new Date(),
    };

    // Atomic append on a case that is still open: no lost updates when two
    // analysts add notes at once, and no note can slip into a closed case.
    const updated = await FraudCaseModel.findOneAndUpdate(
      { _id: req.params.id, status: { $nin: CLOSED_STATUSES } },
      { $push: { notes: note } },
      { returnDocument: 'after', runValidators: true }
    ).select('publicId');

    if (!updated) {
      const exists = await FraudCaseModel.exists({ _id: req.params.id });
      return exists
        ? res.status(400).json({ success: false, message: 'Cannot add notes to a closed case.' })
        : res.status(404).json({ success: false, message: 'Case not found.' });
    }

    await createAuditLog(
      req.user._id,
      'ANALYST',
      'CASE_NOTE_ADDED',
      'FraudCase',
      updated.publicId,
      { noteLength: note.text.length },
      req.ip
    );

    // The saved note sub-document, shaped like the notes of GET /cases/:id (N-24).
    res.status(201).json({
      success: true,
      message: 'Note added.',
      data: { _id: note._id, analystId: String(note.analystId), text: note.text, createdAt: note.createdAt },
    });
  })
);

// ── GET /analyst-api/devices/:deviceId ────────────────────────────────────────
router.get(
  '/devices/:deviceId',
  asyncHandler(async (req, res) => {
    const device = await DeviceReputationModel.findOne({ deviceId: req.params.deviceId })
      .populate('associatedUserIds', 'name email role trustScore');

    if (!device) {
      return res.status(404).json({ success: false, message: 'Device not found in reputation registry.' });
    }

    // Recent 10 transactions from this device for context
    const recentTransactions = await TransactionModel.find({ deviceId: req.params.deviceId })
      .sort({ timestamp: -1, _id: -1 })
      .limit(10)
      .populate('userId', 'name email')
      .select('publicId amount merchantName riskLevel fraudScore status timestamp');

    await createAuditLog(
      req.user._id,
      'ANALYST',
      'DEVICE_VIEWED',
      'Device',
      req.params.deviceId,
      { associatedUsers: device.associatedUserIds?.length ?? 0 },
      req.ip
    );

    res.status(200).json({
      success: true,
      data: { device, recentTransactions },
    });
  })
);

// ── GET /analyst-api/fraud-patterns ───────────────────────────────────────────
router.get(
  '/fraud-patterns',
  asyncHandler(async (req, res) => {
    const highRiskMatch = { riskLevel: { $in: FLAGGED_RISK_LEVELS } };

    const txnProjection = {
      id: '$_id',
      publicId: '$publicId',
      amount: '$amount',
      riskLevel: '$riskLevel',
      userId: '$userId',
      timestamp: '$timestamp',
    };

    // E-04: $push keeps the order the documents reach $group, so without a sort the 10
    // transactions shown per cluster were arbitrary (often not the newest). Sorting
    // newest-first (with an _id tie-break) before every $group makes `$slice: 10` = the 10 newest.
    const newestFirst = { $sort: { timestamp: -1, _id: -1 } };
    // C-06: equal counts resolve in a fixed order, so the top-20 cut is stable.
    const biggestFirst = { $sort: { count: -1, _id: 1 } };

    // AUD-39: each cluster also reports userCount (distinct customers). A "shared"
    // IP/device cluster with userCount 1 is one customer's repeated attempts,
    // not an account-sharing pattern — the UI can tell them apart.
    const [sharedIpClusters, sharedDeviceClusters, highRiskMerchantClusters] = await Promise.all([
      TransactionModel.aggregate([
        { $match: { ...highRiskMatch, ipAddress: { $exists: true, $ne: '' } } },
        newestFirst,
        { $group: { _id: '$ipAddress', count: { $sum: 1 }, users: { $addToSet: '$userId' }, transactions: { $push: txnProjection } } },
        { $match: { count: { $gte: 2 } } },
        biggestFirst,
        { $limit: 20 },
        { $project: { _id: 0, ipAddress: '$_id', count: 1, userCount: { $size: '$users' }, transactions: { $slice: ['$transactions', 10] } } },
      ]).allowDiskUse(true), // round-1 note: $push/$addToSet over a big window can exceed the 100 MB in-memory limit

      TransactionModel.aggregate([
        { $match: highRiskMatch },
        newestFirst,
        { $group: { _id: '$deviceId', count: { $sum: 1 }, users: { $addToSet: '$userId' }, transactions: { $push: txnProjection } } },
        { $match: { count: { $gte: 2 } } },
        biggestFirst,
        { $limit: 20 },
        { $project: { _id: 0, deviceId: '$_id', count: 1, userCount: { $size: '$users' }, transactions: { $slice: ['$transactions', 10] } } },
      ]).allowDiskUse(true), // round-1 note: $push/$addToSet over a big window can exceed the 100 MB in-memory limit

      TransactionModel.aggregate([
        { $match: highRiskMatch },
        newestFirst,
        // E-09: "Casino X", "casino x" and " CASINO X " are one merchant (the count >= 3 threshold
        // under-reported otherwise). Group on the trimmed lower-case key and show the spelling of
        // the newest transaction.
        {
          $group: {
            _id: { $toLower: { $trim: { input: '$merchantName' } } },
            merchantName: { $first: '$merchantName' },
            count: { $sum: 1 },
            users: { $addToSet: '$userId' },
            transactions: { $push: txnProjection },
          },
        },
        { $match: { count: { $gte: 3 } } },
        biggestFirst,
        { $limit: 20 },
        { $project: { _id: 0, merchantName: 1, count: 1, userCount: { $size: '$users' }, transactions: { $slice: ['$transactions', 10] } } },
      ]).allowDiskUse(true), // round-1 note: $push/$addToSet over a big window can exceed the 100 MB in-memory limit
    ]);

    res.status(200).json({
      success: true,
      data: { sharedIpClusters, sharedDeviceClusters, highRiskMerchantClusters },
    });
  })
);

export default router;
