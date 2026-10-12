/**
 * @file src/pages/shared/NotFound.jsx
 * @description 404 page. Home destination depends on the signed-in role (H-10: layout lives in
 *   components/common/StatusPage.jsx, shared with Unauthorized).
 */
import StatusPage from '../../components/common/StatusPage.jsx';

export default function NotFound() {
  return (
    <StatusPage code="404" codeClass="text-primary-600" title="Page not found">
      The page you’re looking for doesn’t exist or has moved.
    </StatusPage>
  );
}
