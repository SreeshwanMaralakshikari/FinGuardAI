/**
 * @file config/cloudinary.js
 * @description Cloudinary v2 SDK configuration (used by PATCH /customer-api/profile).
 *   secure: true forces https:// URLs in upload results — required because the
 *   Vercel frontend is served over HTTPS (mixed content would be blocked).
 * @phase Phase 9 — Deployment (env names must match Render dashboard)
 */
import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

export default cloudinary;
