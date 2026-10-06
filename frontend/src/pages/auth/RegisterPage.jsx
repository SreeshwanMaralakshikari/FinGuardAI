/**
 * @file src/pages/auth/RegisterPage.jsx
 * @description Registration (react-hook-form v7) with a required role selector
 *   (CUSTOMER / ANALYST — ADMIN is seeded only). Registration creates NO session
 *   (AUD-11): on success a toast is shown and the user is sent to /login.
 *   ANALYST accounts need an invite code (shown only for that role, sent as `inviteCode`);
 *   the server's 403 messages ("Analyst registration is disabled." / "Invalid invite code.")
 *   are shown as returned. Name / email / password rules mirror the server (N-16, L-11).
 */
import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import { registerThunk, clearAuthError } from '../../store/slices/authSlice.js';
import { ROLE_HOME } from '../../utils/constants.js';
import { BTN } from '../../utils/common.js';
import { isValidEmail, validateName, validatePasswordBytes } from '../../utils/forms.js';
import AuthShell from '../../components/shared/AuthShell.jsx';
import FormField from '../../components/common/FormField.jsx';
import Alert from '../../components/common/Alert.jsx';

export default function RegisterPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { isAuthenticated, user, error } = useAppSelector((s) => s.auth);
  const {
    register, handleSubmit, control, formState: { errors, isSubmitting },
  } = useForm({ defaultValues: { name: '', email: '', password: '', confirmPassword: '', role: 'CUSTOMER', inviteCode: '' } });
  const role = useWatch({ control, name: 'role' });

  useEffect(() => () => { dispatch(clearAuthError()); }, [dispatch]);

  if (isAuthenticated && user?.role) {
    return <Navigate to={ROLE_HOME[user.role] ?? '/'} replace />;
  }

  const onSubmit = async (values) => {
    const payload = { name: values.name.trim(), email: values.email.trim(), password: values.password, role: values.role };
    // The invite code only exists for ANALYST sign-ups; CUSTOMER requests never carry it.
    if (values.role === 'ANALYST') payload.inviteCode = values.inviteCode.trim();
    const action = await dispatch(registerThunk(payload));
    if (registerThunk.fulfilled.match(action)) {
      toast.success('Account created — please sign in.');
      navigate('/login', { replace: true });
    }
  };

  return (
    <AuthShell
      title="Create your account"
      subtitle="Customers submit and review their own transactions; analysts investigate flagged ones."
      footer={<>Already registered? <Link to="/login" className="font-medium text-primary-600 hover:underline">Sign in</Link></>}
    >
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        <Alert tone="error">{error}</Alert>

        <FormField
          name="name"
          label="Full name"
          errors={errors}
          render={(p) => (
            <input
              {...p}
              type="text"
              autoComplete="name"
              {...register('name', { validate: validateName })}
            />
          )}
        />

        <FormField
          name="email"
          label="Email"
          errors={errors}
          render={(p) => (
            <input
              {...p}
              type="email"
              autoComplete="email"
              {...register('email', {
                required: 'Email is required',
                validate: (v) => isValidEmail(v) || 'Enter a valid email address',
              })}
            />
          )}
        />

        <FormField
          name="role"
          label="I am a"
          errors={errors}
          render={(p) => (
            <select {...p} {...register('role', { required: 'Choose a role' })}>
              <option value="CUSTOMER">Customer</option>
              <option value="ANALYST">Fraud analyst</option>
            </select>
          )}
        />

        {role === 'ANALYST' && (
          <FormField
            name="inviteCode"
            label="Analyst invite code"
            errors={errors}
            hint="Analyst accounts can only be created with the invite code given by an administrator."
            render={(p) => (
              <input
                {...p}
                type="password"
                autoComplete="off"
                {...register('inviteCode', {
                  validate: (v) => role !== 'ANALYST' || v.trim().length > 0 || 'The invite code is required for analyst accounts',
                })}
              />
            )}
          />
        )}

        <FormField
          name="password"
          label="Password"
          errors={errors}
          hint="8 to 72 characters (accented and non-Latin characters count as more than one)."
          render={(p) => (
            <input
              {...p}
              type="password"
              autoComplete="new-password"
              {...register('password', {
                required: 'Password is required',
                minLength: { value: 8, message: 'Password must be at least 8 characters' },
                validate: validatePasswordBytes,
                deps: ['confirmPassword'], // re-check the confirmation when the password changes
              })}
            />
          )}
        />

        <FormField
          name="confirmPassword"
          label="Confirm password"
          errors={errors}
          render={(p) => (
            <input
              {...p}
              type="password"
              autoComplete="new-password"
              {...register('confirmPassword', {
                required: 'Please confirm your password',
                validate: (v, form) => v === form.password || 'Passwords do not match',
              })}
            />
          )}
        />

        <button type="submit" disabled={isSubmitting} className={`${BTN.base} ${BTN.primary} ${BTN.md} w-full`}>
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthShell>
  );
}
