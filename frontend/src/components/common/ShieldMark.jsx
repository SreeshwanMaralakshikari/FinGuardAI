/**
 * @file src/components/common/ShieldMark.jsx
 * @description Round 4: the FinGuardAI emblem — a shield inside watch rings with a pulse line across it.
 *   Decorative (aria-hidden). Colours come from the theme tokens, so it works on chrome and on surfaces.
 *   `scanning` adds the one piece of ambient motion in the app: a slow sweep around the rings
 *   (off under prefers-reduced-motion).
 */
export default function ShieldMark({ className = 'h-24 w-24', scanning = false }) {
  return (
    <svg className={className} viewBox="0 0 120 120" fill="none" aria-hidden="true">
      <circle cx="60" cy="60" r="56" stroke="var(--color-primary-500)" strokeOpacity="0.25" strokeWidth="1" />
      <circle cx="60" cy="60" r="44" stroke="var(--color-primary-500)" strokeOpacity="0.4" strokeWidth="1" strokeDasharray="2 5" />
      {scanning && (
        <g className="origin-center animate-[spin_6s_linear_infinite] motion-reduce:hidden" style={{ transformOrigin: '60px 60px' }}>
          <path d="M60 4a56 56 0 0 1 48.5 28" stroke="var(--color-primary-400)" strokeWidth="2.5" strokeLinecap="round" />
        </g>
      )}
      <path
        d="M60 26 84 35v19c0 17-11 30-24 37-13-7-24-20-24-37V35l24-9z"
        fill="var(--color-primary-600)"
        fillOpacity="0.16"
        stroke="var(--color-primary-500)"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path d="M44 58h8l4-8 7 16 4-8h9" stroke="var(--color-primary-400)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
