/**
 * @file src/components/common/Pagination.jsx
 * @description Prev/Next pager driven by { page, limit, total }.
 *   N-19: the displayed range is clamped, and when `page` is beyond the last page while rows
 *   exist (the data shrank, or a stale URL/state) the pager asks its owner to move to the last
 *   page through `onChange`, instead of showing "Showing 21–15 of 15" over an empty table.
 */
import { useEffect } from 'react';
import { BTN } from '../../utils/common.js';

export default function Pagination({ page, limit, total, onChange }) {
  const pages = Math.max(1, Math.ceil((total || 0) / (limit || 1)));
  const beyondLast = Boolean(total) && page > pages;

  useEffect(() => {
    if (beyondLast) onChange(pages);
  }, [beyondLast, pages, onChange]);

  if (!total) return null;
  const current = Math.min(Math.max(1, page || 1), pages);
  const from = (current - 1) * limit + 1;
  const to = Math.min(current * limit, total);

  return (
    <nav className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row" aria-label="Pagination">
      <p className="text-sm text-gray-500">
        Showing <span className="font-medium text-gray-700">{from}–{to}</span> of{' '}
        <span className="font-medium text-gray-700">{total}</span>
      </p>
      <div className="flex items-center gap-2">
        <button type="button" className={`${BTN.base} ${BTN.secondary} ${BTN.sm}`} disabled={current <= 1} onClick={() => onChange(current - 1)}>
          Previous
        </button>
        <span className="text-sm text-gray-600">Page {current} of {pages}</span>
        <button type="button" className={`${BTN.base} ${BTN.secondary} ${BTN.sm}`} disabled={current >= pages} onClick={() => onChange(current + 1)}>
          Next
        </button>
      </div>
    </nav>
  );
}
