/**
 * @file src/pages/shared/Unauthorized.jsx
 * @description 403 page: shows the current role and links back to its own dashboard.
 */
import { Link } from 'react-router-dom';
import { useAppSelector } from '../../store/hooks.js';
import { ROLE_HOME } from '../../utils/constants.js';
import { useGoBack } from '../../hooks/useGoBack.js';
import Spinner from '../../components/common/Spinner.jsx';
import { BTN } from '../../utils/common.js';

export default function Unauthorized() {
  const { isAuthenticated, user, loading } = useAppSelector((s) => s.auth);
  const home = isAuthenticated ? (ROLE_HOME[user?.role] ?? '/login') : '/login';
  const goBack = useGoBack(home);

  // N-17: while the session check runs the role is unknown — don't flash "sign in" copy
  if (loading) return <Spinner className="min-h-screen" />;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md text-center">
        <p className="text-6xl font-bold text-red-600">403</p>
        <h1 className="mt-4 text-2xl font-bold text-gray-900">Access denied</h1>
        <p className="mt-2 text-sm text-gray-600">
          {user?.role ? <>Your role (<span className="font-semibold">{user.role}</span>) can’t open this page.</> : 'You need to sign in to open this page.'}
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button type="button" className={`${BTN.base} ${BTN.secondary} ${BTN.md}`} onClick={goBack}>Go back</button>
          <Link to={home} className={`${BTN.base} ${BTN.primary} ${BTN.md}`}>{isAuthenticated ? 'My dashboard' : 'Sign in'}</Link>
        </div>
      </div>
    </div>
  );
}
