/**
 * @file src/components/shared/ChangePasswordForm.jsx
 * @description PATCH /auth/change-password (AUD-35). The button is disabled by RHF
 *   `isSubmitting` (the global auth.loading no longer changes). On success the server has
 *   ended the session and the store is reset, so the user is sent to /login.
 */
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAppDispatch } from '../../store/hooks.js';
import { validatePasswordBytes } from '../../utils/forms.js';
import { changePasswordThunk } from '../../store/slices/authSlice.js';
import { BTN, CARD } from '../../utils/common.js';
import FormField from '../common/FormField.jsx';
import Alert from '../common/Alert.jsx';
import { useState } from 'react';

export default function ChangePasswordForm() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState('');
  const {
    register, handleSubmit, formState: { errors, isSubmitting },
  } = useForm({ defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' } });

  const onSubmit = async ({ currentPassword, newPassword }) => {
    setServerError('');
    const action = await dispatch(changePasswordThunk({ currentPassword, newPassword }));
    if (changePasswordThunk.fulfilled.match(action)) {
      toast.success('Password changed — please sign in again.');
      navigate('/login', { replace: true });
    } else {
      setServerError(action.payload ?? 'Password change failed');
    }
  };

  return (
    <section className={CARD.base} aria-labelledby="change-password-title">
      <div className={CARD.header}>
        <h2 id="change-password-title" className="text-base font-semibold text-gray-900">Change password</h2>
        <p className="mt-1 text-sm text-gray-500">You’ll be signed out everywhere after changing it.</p>
      </div>
      <form onSubmit={handleSubmit(onSubmit, () => setServerError(''))} noValidate className={`${CARD.body} space-y-4`}>
        <Alert tone="error">{serverError}</Alert>

        <FormField
          name="currentPassword"
          label="Current password"
          errors={errors}
          render={(p) => (
            <input {...p} type="password" autoComplete="current-password"
              {...register('currentPassword', { required: 'Current password is required', deps: ['newPassword'] })} />
          )}
        />
        <FormField
          name="newPassword"
          label="New password"
          errors={errors}
          hint="8 to 72 characters (accented and non-Latin characters count as more than one), different from the current one."
          render={(p) => (
            <input {...p} type="password" autoComplete="new-password"
              {...register('newPassword', {
                required: 'New password is required',
                minLength: { value: 8, message: 'New password must be at least 8 characters' },
                deps: ['confirmPassword'],
                validate: {
                  bytes: validatePasswordBytes,
                  different: (v, form) => v !== form.currentPassword || 'New password must be different from the current password',
                },
              })} />
          )}
        />
        <FormField
          name="confirmPassword"
          label="Confirm new password"
          errors={errors}
          render={(p) => (
            <input {...p} type="password" autoComplete="new-password"
              {...register('confirmPassword', {
                required: 'Please confirm the new password',
                validate: (v, form) => v === form.newPassword || 'Passwords do not match',
              })} />
          )}
        />
        <button type="submit" disabled={isSubmitting} className={`${BTN.base} ${BTN.primary} ${BTN.md}`}>
          {isSubmitting ? 'Updating…' : 'Update password'}
        </button>
      </form>
    </section>
  );
}
