/**
 * @file utils/imageUpload.js
 * @description Profile-image helpers around the Cloudinary SDK (N-09).
 *   Kept in one small module so route code never touches the SDK directly and
 *   tests can replace config/cloudinary.js (jest.unstable_mockModule).
 *
 *   - detectImageType(): magic-byte sniffing. multer's `file.mimetype` is
 *     whatever the client claims, so a text file named fake.png sent as
 *     image/png used to be forwarded to Cloudinary.
 *   - uploadProfileImage(): buffer → Cloudinary (upload_stream).
 *   - destroyImageByUrl(): best-effort delete of a previous upload, derived
 *     from its secure_url. Never throws; only touches files in OUR folder.
 */
import cloudinary from '../config/cloudinary.js';

export const PROFILE_FOLDER = 'finguardai/profiles';

/**
 * @param {Buffer|Uint8Array|undefined} buffer
 * @returns {'jpeg'|'png'|'webp'|null}
 */
export const detectImageType = (buffer) => {
  if (!buffer || buffer.length < 12) return null;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, i) => buffer[i] === byte)) return 'png';
  // WebP: "RIFF" <size> "WEBP"
  const ascii = (start, end) => String.fromCharCode(...buffer.subarray(start, end));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
};

/**
 * @param {Buffer} buffer
 * @returns {Promise<{ secure_url: string, public_id: string }>}
 */
export const uploadProfileImage = (buffer) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: PROFILE_FOLDER, resource_type: 'image' },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(buffer);
  });

/**
 * Cloudinary public_id of one of OUR uploaded profile images, or null for any
 * other value (empty string, someone else's URL, a different folder).
 *   https://res.cloudinary.com/<cloud>/image/upload/v1712345678/finguardai/profiles/abc123.jpg
 *   → "finguardai/profiles/abc123"
 * @param {string|undefined} url
 * @returns {string|null}
 */
export const getPublicIdFromUrl = (url) => {
  if (typeof url !== 'string' || !url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'res.cloudinary.com') return null;
  const marker = '/image/upload/';
  const at = parsed.pathname.indexOf(marker);
  if (at === -1) return null;
  const withoutVersion = parsed.pathname.slice(at + marker.length).replace(/^v\d+\//, '');
  let decoded;
  try {
    decoded = decodeURIComponent(withoutVersion);
  } catch {
    return null; // malformed percent-escape in a stored URL
  }
  const publicId = decoded.replace(/\.[A-Za-z0-9]+$/, '');
  return publicId.startsWith(`${PROFILE_FOLDER}/`) ? publicId : null;
};

/**
 * Best-effort removal of an uploaded image. Failure is logged, never thrown.
 * @param {string|undefined} url  the stored secure_url
 * @returns {Promise<boolean>} true when Cloudinary accepted the delete
 */
export const destroyImageByUrl = async (url) => {
  const publicId = getPublicIdFromUrl(url);
  if (!publicId) return false;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
    return true;
  } catch (err) {
    console.error('[imageUpload] Could not delete old image:', err?.message ?? err);
    return false;
  }
};
