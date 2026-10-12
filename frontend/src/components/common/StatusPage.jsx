/**
 * @file src/components/common/StatusPage.jsx
 * @description Full-screen status page shared by NotFound (404) and Unauthorized (403) (H-10):
 *   big code, title, message, "Go back" and a link home (role dashboard, or Sign in).
 *   Handles the "session check still running" state so the role-specific copy never flashes.
 */
import { Link } from 'react-router-dom';
import { useAppSelector } from '../../store/hooks.js';
import { ROLE_HOME } from '../../utils/constants.js';
import { useGoBack } from '../../hooks/useGoBack.js';
import Spinner from './Spinner.jsx';
import { BTN } from '../../utils/common.js';

/**
 * @param {{ code: string, codeClass: string, title: string, children: import('react').ReactNode }} props
 *   codeClass: complete Tailwind class for the code colour (kept as a whole string for the scanner)
 */
export default function StatusPage({ code, codeClass, title, children }) {
  const { isAuthenticated, user, loading } = useAppSelector((s) => s.auth);
  const home = isAuthenticated ? (ROLE_HOME[user?.role] ?? '/login') : '/login';
  const goBack = useGoBack(home);

  // N-17: while the session check runs the role is unknown — don't flash "sign in" copy
  if (loading) return <Spinner className="min-h-screen" />;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md text-center">
        <p className={`text-6xl font-bold ${codeClass}`}>{code}</p>
        <h1 className="mt-4 text-2xl font-bold text-gray-900">{title}</h1>
        <p className="mt-2 text-sm text-gray-600">{children}</p>
        <div className="mt-6 flex justify-center gap-3">
          <button type="button" className={`${BTN.base} ${BTN.secondary} ${BTN.md}`} onClick={goBack}>Go back</button>
          <Link to={home} className={`${BTN.base} ${BTN.primary} ${BTN.md}`}>{isAuthenticated ? 'My dashboard' : 'Sign in'}</Link>
        </div>
      </div>
    </div>
  );
}
