/**
 * @file src/components/common/Avatar.jsx
 * @description Round profile picture with the person's initials as the fallback. The initials are also shown
 *   when the picture cannot load (no internet in the offline demo: pictures live on Cloudinary), instead of a
 *   broken-image icon. Remembering WHICH url failed means a newly chosen picture is tried again.
 */
import { useState } from 'react';
import { getInitials } from '../../utils/common.js';

export default function Avatar({ src, name, className, textClassName, alt = '' }) {
  const [failedSrc, setFailedSrc] = useState(null);
  if (src && src !== failedSrc) {
    return <img src={src} alt={alt} className={`${className} rounded-full object-cover`} onError={() => setFailedSrc(src)} />;
  }
  return (
    <span className={`${className} ${textClassName} flex items-center justify-center rounded-full bg-primary-600 font-semibold text-on-accent`} aria-hidden="true">
      {getInitials(name)}
    </span>
  );
}
