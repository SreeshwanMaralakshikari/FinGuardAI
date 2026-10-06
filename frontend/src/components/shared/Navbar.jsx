/**
 * @file src/components/shared/Navbar.jsx
 * @description Top bar: mobile menu button, notification bell (not for ADMIN), user chip, sign-out.
 *   Static structural classes are inline (D-P7-03).
 *   F-04: the client always signs out locally (state is wiped, /login), but when the logout request
 *   itself failed the server cookie may still be valid until it expires — the toast says so
 *   instead of claiming a clean "Signed out".
 */
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import { logoutThunk } from '../../store/slices/authSlice.js';
import { getInitials, BTN } from '../../utils/common.js';
import { ROLES } from '../../utils/constants.js';
import Icon from '../common/Icon.jsx';
import NotificationPanel from './NotificationPanel.jsx';

export const LOGOUT_FAILED_MESSAGE =
  'Signed out on this device. The server could not be reached, so your session may stay active until it expires.';

export default function Navbar({ onMenuClick }) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const user = useAppSelector((s) => s.auth.user);

  const onLogout = async () => {
    const action = await dispatch(logoutThunk());
    if (logoutThunk.rejected.match(action)) {
      toast.error(LOGOUT_FAILED_MESSAGE, { duration: 8000 });
    } else {
      toast.success('Signed out');
    }
    navigate('/login', { replace: true });
  };

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-gray-200 bg-white px-4 sm:px-6">
      <button type="button" onClick={onMenuClick} className="rounded-lg p-2 text-gray-600 hover:bg-gray-100 lg:hidden" aria-label="Open menu">
        <Icon name="menu" />
      </button>
      <div className="hidden lg:block" />

      <div className="flex items-center gap-2 sm:gap-3">
        {user?.role !== ROLES.ADMIN && <NotificationPanel />}

        <div className="flex items-center gap-2">
          {user?.profileImage ? (
            <img src={user.profileImage} alt="" className="h-9 w-9 rounded-full object-cover" />
          ) : (
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-600 text-sm font-semibold text-white" aria-hidden="true">
              {getInitials(user?.name)}
            </span>
          )}
          <div className="hidden leading-tight sm:block">
            <p className="text-sm font-medium text-gray-900">{user?.name}</p>
            <p className="text-xs text-gray-500">{user?.role}</p>
          </div>
        </div>

        <button type="button" onClick={onLogout} className={`${BTN.base} ${BTN.ghost} ${BTN.sm}`} aria-label="Sign out">
          <Icon name="logout" className="h-4 w-4" />
          <span className="hidden sm:inline">Sign out</span>
        </button>
      </div>
    </header>
  );
}
