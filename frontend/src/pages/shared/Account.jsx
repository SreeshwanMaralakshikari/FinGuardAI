/**
 * @file src/pages/shared/Account.jsx
 * @description Account page for ANALYST and ADMIN: read-only identity + change password.
 *   (The editable profile with picture upload exists for CUSTOMER only — the API
 *   restricts PATCH /customer-api/profile to that role.)
 */
import { useAppSelector } from '../../store/hooks.js';
import { CARD } from '../../utils/common.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import ChangePasswordForm from '../../components/shared/ChangePasswordForm.jsx';

export default function Account() {
  const user = useAppSelector((s) => s.auth.user);
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Account" subtitle="Your sign-in details and password." />
      <section className={CARD.base}>
        <dl className={`${CARD.body} grid grid-cols-1 gap-4 sm:grid-cols-3`}>
          <div><dt className="text-xs font-semibold uppercase text-gray-500">Name</dt><dd className="mt-1 text-sm text-gray-900">{user?.name}</dd></div>
          <div><dt className="text-xs font-semibold uppercase text-gray-500">Email</dt><dd className="mt-1 break-all text-sm text-gray-900">{user?.email}</dd></div>
          <div><dt className="text-xs font-semibold uppercase text-gray-500">Role</dt><dd className="mt-1 text-sm text-gray-900">{user?.role}</dd></div>
        </dl>
      </section>
      <ChangePasswordForm />
    </div>
  );
}
