/**
 * @file src/components/common/Badges.jsx
 * @description Risk / transaction-status / case-status / alert-status badges.
 *   Class strings come from common.js lookups only (D-P7-07) — never concatenated.
 */
import {
  RISK_COLORS, TX_STATUS_COLORS, CASE_STATUS_COLORS, badgeClass,
} from '../../utils/common.js';
import { CASE_OUTCOME } from '../../utils/constants.js';

const ALERT_STATUS_COLORS = {
  OPEN:      CASE_STATUS_COLORS.OPEN,
  REVIEWED:  CASE_STATUS_COLORS.UNDER_REVIEW,
  DISMISSED: CASE_STATUS_COLORS.DISMISSED,
  // B-04: ACKNOWLEDGED (coming: a MEDIUM alert seen by the customer / analyst) — neutral grey-blue
  ACKNOWLEDGED: Object.freeze({ text: 'text-slate-700', bg: 'bg-slate-100', border: 'border-slate-300' }),
};

const label = (v) => String(v ?? '—').replaceAll('_', ' ');

export function RiskBadge({ level }) {
  return <span className={badgeClass(RISK_COLORS[level])}>{label(level)}</span>;
}

export function TxStatusBadge({ status }) {
  return <span className={badgeClass(TX_STATUS_COLORS[status])}>{label(status)}</span>;
}

export function CaseStatusBadge({ status }) {
  return <span className={badgeClass(CASE_STATUS_COLORS[status])} title={CASE_OUTCOME[status]}>{label(status)}</span>;
}

export function AlertStatusBadge({ status }) {
  return <span className={badgeClass(ALERT_STATUS_COLORS[status])}>{label(status)}</span>;
}
