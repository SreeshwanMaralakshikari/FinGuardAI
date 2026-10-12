/**
 * @file utils/deviceCap.js
 * @description C-08: a customer (or a script posting random deviceIds) could create unlimited DeviceReputation
 *   documents. Once a user has used MAX_DEVICES_PER_USER (default 20) OTHER device ids, a further id with no
 *   reputation document yet is still scored (as an unknown device) but gets no document.
 */
import mongoose from 'mongoose';
import TransactionModel from '../models/TransactionModel.js';
import { getMaxDevicesPerUser } from '../config/opsSettings.js';

/**
 * How many distinct device ids `userId` has used OTHER than `deviceId`, stopping at `limit`
 * (index {userId, deviceId}; the aggregation never returns more than `limit` rows).
 */
export const countOtherDevices = async (userId, deviceId, limit) => {
  const rows = await TransactionModel.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(String(userId)), deviceId: { $ne: deviceId } } },
    { $group: { _id: '$deviceId' } },
    { $limit: limit },
  ]);
  return rows.length;
};

/**
 * True when `deviceId` must NOT get a DeviceReputation document: it has none yet and the user already
 * used the maximum number of other devices. Call it only for devices without a document (the common,
 * known-device path never reaches the database here).
 * @param {any} userId
 * @param {string} deviceId
 * @param {boolean} hasReputation  a DeviceReputation document for `deviceId` already exists
 */
export const isDeviceCapReached = async (userId, deviceId, hasReputation) => {
  if (hasReputation) return false; // an existing document is always kept up to date (also shared devices)
  const max = getMaxDevicesPerUser();
  return (await countOtherDevices(userId, deviceId, max)) >= max;
};
