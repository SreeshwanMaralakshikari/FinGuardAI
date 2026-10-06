/**
 * @file middleware/uploadMiddleware.js
 * @description Multer v2 configuration for the profile image upload
 *   (PATCH /customer-api/profile → uploadMiddleware.single('profileImage')).
 *   - memoryStorage: the buffer is streamed straight to Cloudinary; nothing
 *     is written to disk (Render's filesystem is ephemeral anyway)
 *   - Only JPEG, PNG and WebP; max 2 MB; one file
 *   - A rejected type becomes a 400 via errorHandler (err.status = 400)
 *   - requireImageContent (run AFTER multer) checks the file's magic bytes,
 *     because the MIME type above is whatever the client claims (N-09)
 * @phase Phase 2 spec → implementation recorded in the Phase 1–9 audit
 */
import multer from 'multer';
import { detectImageType } from '../utils/imageUpload.js';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB

const INVALID_IMAGE_MESSAGE = 'Only JPG, PNG or WebP images are allowed.';

const fileFilter = (req, file, callback) => {
  if (ALLOWED_MIME_TYPES.has(file.mimetype)) return callback(null, true);
  const error = new Error(INVALID_IMAGE_MESSAGE);
  error.status = 400;
  return callback(error);
};

const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1, fields: 3, fieldSize: 1024, parts: 4 },
  fileFilter,
});

/**
 * Rejects an uploaded file whose bytes are not really a JPEG, PNG or WebP
 * (N-09). No-op when the request carries no file.
 */
export const requireImageContent = (req, res, next) => {
  if (req.file && !detectImageType(req.file.buffer)) {
    return res.status(400).json({ success: false, message: INVALID_IMAGE_MESSAGE });
  }
  return next();
};

export default uploadMiddleware;
