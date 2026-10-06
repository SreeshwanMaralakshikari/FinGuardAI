import mongoose from 'mongoose';

const { Schema } = mongoose;

const notificationSchema = new Schema(
  {
    recipientId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Recipient ID is required'],
    },
    recipientRole: {
      type: String,
      enum: {
        values: ['CUSTOMER', 'ANALYST'],
        message: 'Recipient role must be CUSTOMER or ANALYST',
      },
      required: [true, 'Recipient role is required'],
                          // ADMIN does not receive in-app notifications per Phase 1
    },
    type: {
      type: String,
      enum: {
        values: ['FRAUD_ALERT', 'CASE_ASSIGNED', 'CASE_STATUS_CHANGED'],
        message: 'Notification type must be FRAUD_ALERT, CASE_ASSIGNED, or CASE_STATUS_CHANGED',
      },
      required: [true, 'Notification type is required'],
    },
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      maxlength: [200, 'Title cannot exceed 200 characters'],
    },
    message: {
      type: String,
      required: [true, 'Message is required'],
      trim: true,
      maxlength: [1000, 'Message cannot exceed 1000 characters'],
    },
    relatedEntityId: {
      type: Schema.Types.ObjectId,
      required: [true, 'Related entity ID is required'],
                          // polymorphic: points to Transaction, FraudAlert, or FraudCase
    },
    relatedEntityType: {
      type: String,
      enum: {
        values: ['TRANSACTION', 'FRAUD_ALERT', 'FRAUD_CASE'],
        message: 'Related entity type must be TRANSACTION, FRAUD_ALERT, or FRAUD_CASE',
      },
      required: [true, 'Related entity type is required'],
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,       // createdAt is used in the compound index below
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
notificationSchema.index({ recipientId: 1, isRead: 1, createdAt: -1 });

const NotificationModel = mongoose.model('Notification', notificationSchema);

export default NotificationModel;
