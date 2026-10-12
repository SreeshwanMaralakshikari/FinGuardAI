/**
 * @file utils/statusCounts.js
 * @description C-07: total / APPROVED / HELD transaction counts for a user or a device in ONE
 *   aggregation instead of three countDocuments round trips (used by updateTrustScore and
 *   updateDeviceReputation; the numbers are identical to the three separate counts).
 */
import mongoose from 'mongoose';
import TransactionModel from '../models/TransactionModel.js';

const ofStatus = (status) => ({ $sum: { $cond: [{ $eq: ['$status', status] }, 1, 0] } });

/**
 * @param {{ userId?: any, deviceId?: string }} match  exactly one of the two
 * @returns {Promise<{ total: number, approved: number, held: number }>}
 */
export const countStatuses = async ({ userId, deviceId }) => {
  // aggregate() does not cast: an ObjectId string must become a real ObjectId to match.
  const $match = userId !== undefined ? { userId: new mongoose.Types.ObjectId(String(userId)) } : { deviceId };
  const [row] = await TransactionModel.aggregate([
    { $match },
    { $group: { _id: null, total: { $sum: 1 }, approved: ofStatus('APPROVED'), held: ofStatus('HELD') } },
  ]);
  return { total: row?.total ?? 0, approved: row?.approved ?? 0, held: row?.held ?? 0 };
};
