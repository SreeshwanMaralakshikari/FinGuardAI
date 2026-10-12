/**
 * @file src/pages/shared/Unauthorized.jsx
 * @description 403 page: shows the current role and links back to its own dashboard (H-10: layout
 *   lives in components/common/StatusPage.jsx, shared with NotFound).
 */
import { useAppSelector } from '../../store/hooks.js';
import StatusPage from '../../components/common/StatusPage.jsx';

export default function Unauthorized() {
  const role = useAppSelector((s) => s.auth.user?.role);
  return (
    <StatusPage code="403" codeClass="text-red-600" title="Access denied">
      {role ? <>Your role (<span className="font-semibold">{role}</span>) can’t open this page.</> : 'You need to sign in to open this page.'}
    </StatusPage>
  );
}
