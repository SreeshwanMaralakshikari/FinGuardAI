import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const { Schema } = mongoose;

const userSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false,          // never returned by default — must explicitly .select('+password')
    },
    role: {
      type: String,
      enum: {
        values: ['CUSTOMER', 'ANALYST', 'ADMIN'],
        message: 'Role must be CUSTOMER, ANALYST, or ADMIN',
      },
      required: [true, 'Role is required'],
    },
    profileImage: {
      type: String,
      default: '',            // Cloudinary URL; empty string = no image uploaded yet
    },
    trustScore: {
      type: Number,
      min: [0, 'Trust score cannot be below 0'],
      max: [100, 'Trust score cannot exceed 100'],
      default: 50,            // neutral starting score; recalculated by utils/updateTrustScore.js after every transaction
    },
    isActive: {
      type: Boolean,
      default: true,          // Admin sets false to deactivate; blocks login in verifyToken.js
    },
    lastLogin: {
      type: Date,             // Set by CommonAPI.js /login handler on each successful login
    },
    passwordChangedAt: {
      type: Date,             // AUD-23: JWTs issued before this are rejected (verifyToken, socketAuth)
      select: false,          // internal — never returned in API responses
    },
  },
  {
    timestamps: true,         // injects createdAt, updatedAt
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
userSchema.index({ email: 1, role: 1 });

// ── Pre-save hook: bcrypt password hashing ────────────────────────────────────
// Mongoose 9 middleware is promise-based: hooks do NOT receive a `next`
// callback (calling next() throws "next is not a function"). An async hook
// signals completion by resolving and failure by throwing. (AUD-01)
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 12);  // cost factor 12 per Phase 1 D-06
  // AUD-23 / L-15: a password CHANGE revokes every existing session. Stored as
  // the exact instant (no back-dating): tokens carry an `iatMs` claim and are
  // compared at millisecond precision in middleware/verifyToken.js, so a token
  // issued at or before the change is rejected and the next login is accepted.
  if (!this.isNew) this.passwordChangedAt = new Date();
});

const UserModel = mongoose.model('User', userSchema);

export default UserModel;
