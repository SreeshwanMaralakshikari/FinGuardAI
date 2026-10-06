/**
 * generateSequentialId.js
 *
 * Race-free sequential public ID generator for FinGuardAI models.
 *
 * Purpose:
 *   Returns the next PREFIX-YYYY-NNNNN ID (e.g. TXN-2026-00042) for the given
 *   model. Sequence numbers restart at 00001 every calendar year (in
 *   APP_TIME_ZONE, N-11). The number is zero-padded to 5 digits and simply
 *   grows (TXN-2026-100000) after 99,999 in one year (L-15).
 *
 * Why an atomic counter (AUD-05):
 *   The original "read the highest existing ID, add 1" approach let two
 *   concurrent requests read the same maximum and generate the SAME ID; the
 *   second doc.save() then failed on the unique index (HTTP 500) and left a
 *   transaction without a public ID. Verified at runtime: 8 concurrent
 *   submissions → 4 × 500 and orphaned documents.
 *
 *   Each PREFIX-YEAR pair now has one document in the `counters` collection,
 *   incremented with a single atomic findOneAndUpdate($inc). MongoDB guarantees
 *   every caller receives a distinct value.
 *
 *   Existing data is respected: before incrementing, the counter is raised
 *   (with $max, which never lowers it) to the highest ID already stored, so
 *   deploying this over a database with TXN-2026-00042 continues at 00043.
 *
 * Usage (D-P4-07 revised): call createWithSequentialId(Model, 'publicId', 'TXN', data)
 * below — it reserves the ID and inserts the document in a single write.
 *
 * @param {import('mongoose').Model} Model  Mongoose model whose IDs are generated
 * @param {string}                   field  Document field that stores the public ID
 * @param {string}                   prefix ID prefix (e.g. 'TXN', 'CASE')
 * @returns {Promise<string>}               e.g. "TXN-2026-00001"
 */

import { getYearInAppZone } from '../config/timeZone.js';

const COUNTERS_COLLECTION = 'counters';

/** Highest sequence among stored IDs whose number part matches `digits` (a regex fragment). */
const findMaxSequenceMatching = async (Model, field, prefix, year, digits) => {
  const lastDoc = await Model.findOne({ [field]: { $regex: `^${prefix}-${year}-${digits}$` } })
    .sort({ [field]: -1 }) // equal digit count + zero padding → lexicographic order === numeric order
    .select({ [field]: 1, _id: 0 })
    .lean();

  const lastSeq = lastDoc?.[field] ? parseInt(lastDoc[field].split('-').pop(), 10) : 0;
  return Number.isNaN(lastSeq) ? 0 : lastSeq;
};

/**
 * Highest sequence number already stored for PREFIX-YEAR (0 if none).
 * Lexicographic order only equals numeric order for IDs with the SAME number of
 * digits ("99999" sorts after "100000"), so the 5-digit IDs and the longer ones
 * are looked up separately (two indexed one-document queries) and the larger wins.
 * (Correct up to 999,999 IDs per prefix and year; after that the atomic counter
 * itself keeps issuing unique numbers and a collision is retried.)
 */
const findCurrentMaxSequence = async (Model, field, prefix, year) => {
  const [fiveDigit, longer] = await Promise.all([
    findMaxSequenceMatching(Model, field, prefix, year, '\\d{5}'),
    findMaxSequenceMatching(Model, field, prefix, year, '\\d{6,}'),
  ]);
  return Math.max(fiveDigit, longer);
};

const generateSequentialId = async (Model, field, prefix) => {
  const year = getYearInAppZone(); // N-11: business-zone year, not the host's
  const counterId = `${Model.collection.collectionName}:${field}:${prefix}-${year}`;
  const counters = Model.db.collection(COUNTERS_COLLECTION);

  // 1. Never let the counter fall behind IDs that already exist (idempotent).
  const currentMax = await findCurrentMaxSequence(Model, field, prefix, year);
  await counters.updateOne({ _id: counterId }, { $max: { seq: currentMax } }, { upsert: true });

  // 2. Atomically reserve the next number.
  const counter = await counters.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const nextSequence = counter?.seq ?? counter?.value?.seq; // driver v6+ returns the doc; older returns { value }

  return `${prefix}-${year}-${String(nextSequence).padStart(5, '0')}`;
};

export default generateSequentialId;

/**
 * createWithSequentialId — insert a document WITH its public ID in one write.
 *
 * AUD-05 (second half): the original pattern created the document first and
 * set publicId in a later save(). If that save failed, the document stayed in
 * the collection without a public ID. Generating the ID first and inserting
 * once removes that window entirely. A duplicate-key error on the ID field
 * (only possible if the counters collection is reset or on a datastore
 * without atomic updates) is retried with a fresh ID.
 *
 * @param {import('mongoose').Model} Model
 * @param {string} field   e.g. 'publicId'
 * @param {string} prefix  e.g. 'TXN'
 * @param {object} data    document fields (without the public ID)
 * @param {{ maxAttempts?: number }} [options]
 * @returns {Promise<import('mongoose').Document>} the created document
 */
export const createWithSequentialId = async (Model, field, prefix, data, { maxAttempts = 5 } = {}) => {
  // Validate BEFORE reserving a number, so rejected input never consumes an
  // ID (no TXN-2026-00001 skipped because the first submission was invalid).
  await Model.validate(data);
  for (let attempt = 1; ; attempt += 1) {
    const publicId = await generateSequentialId(Model, field, prefix);
    try {
      return await Model.create({ ...data, [field]: publicId });
    } catch (err) {
      const duplicateKeys = Object.keys(err?.keyPattern ?? err?.keyValue ?? {});
      const isDuplicateId = err?.code === 11000
        && (duplicateKeys.includes(field) || (duplicateKeys.length === 0 && String(err.message).includes(field)));
      if (!isDuplicateId || attempt >= maxAttempts) throw err;
    }
  }
};
