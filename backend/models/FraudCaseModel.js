import mongoose from 'mongoose';

const { Schema } = mongoose;

// Sub-document: a single analyst note in the case thread
const caseNoteSchema = new Schema(
  {
    analystId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Analyst ID is required'],
    },
    text: {
      type: String,
      required: [true, 'Note text is required'],
      trim: true,
      maxlength: [2000, 'Note cannot exceed 2000 characters'],
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }   // each note gets its own ObjectId for individual identification
);

const fraudCaseSchema = new Schema(
  {
    publicId: {
      type: String,
      unique: true,
      sparse: true,           // publicId is always set at insert (AUD-05); sparse kept for legacy documents
      match: [/^CASE-\d{4}-\d{5,}$/, 'Invalid CASE public ID format'], // 5 digits, more once a year passes 99,999 (L-15)
    },
    fraudAlertId: {
      type: Schema.Types.ObjectId,
      ref: 'FraudAlert',
      required: [true, 'Fraud alert ID is required'],
    },
    transactionId: {
      type: Schema.Types.ObjectId,
      ref: 'Transaction',
      required: [true, 'Transaction ID is required'],
    },
    assignedAnalystId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,          // null when status is OPEN (unassigned)
    },
    status: {
      type: String,
      enum: {
        values: ['OPEN', 'ASSIGNED', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'],
        message: 'Case status must be OPEN, ASSIGNED, UNDER_REVIEW, RESOLVED, or DISMISSED',
      },
      default: 'OPEN',
    },
    notes: {
      type: [caseNoteSchema],
      default: [],            // append-only by POST /analyst-api/cases/:id/notes
    },
    resolutionSummary: {
      type: String,
      trim: true,
      maxlength: [5000, 'Resolution summary cannot exceed 5000 characters'],
      default: '',            // written when analyst sets status to RESOLVED or DISMISSED
    },
    openedAt: {
      type: Date,
      default: Date.now,      // set when the case document is first created
    },
    resolvedAt: {
      type: Date,
      default: null,          // set by route handler when status transitions to RESOLVED/DISMISSED
    },
  },
  {
    timestamps: true,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
fraudCaseSchema.index({ status: 1, assignedAnalystId: 1 });
// L-04: ONE case per alert, enforced by the database (the route's findOne
// pre-check alone lets two simultaneous requests both pass). If an existing
// database already holds duplicates, MongoDB cannot build this index until they
// are removed — see the README / deployment notes.
fraudCaseSchema.index({ fraudAlertId: 1 }, { unique: true });
fraudCaseSchema.index({ transactionId: 1 });

const FraudCaseModel = mongoose.model('FraudCase', fraudCaseSchema);

export default FraudCaseModel;
