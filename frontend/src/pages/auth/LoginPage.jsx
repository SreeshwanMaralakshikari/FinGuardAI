/**
 * @file src/pages/auth/LoginPage.jsx
 * @description Sign-in form (react-hook-form v7, D-P7-04). Dispatches loginThunk and sends the
 *   user to their role dashboard. Redirects already-authenticated users away.
 *   The submit button is disabled by `formState.isSubmitting` — not by auth.loading,
 *   which starts as true until the first session check settles (AUD-12/AUD-35).
 *   N-17: ProtectedRoute passes the page the visitor wanted in `location.state.from`; after
 *   signing in the user is returned there when their role may open it, else to the role home.
 *   E-01: when the server ended the session because the account was deactivated, the axios
 *   interceptor leaves a notice in sessionStorage (api/session.js); it is shown here once.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import { loginThunk, clearAuthError } from '../../store/slices/authSlice.js';
import { resolvePostLogin } from '../../utils/navigation.js';
import { peekSessionNotice, clearSessionNotice } from '../../api/session.js';
import { BTN } from '../../utils/common.js';
import AuthShell from '../../components/shared/AuthShell.jsx';
import FormField from '../../components/common/FormField.jsx';
import Alert from '../../components/common/Alert.jsx';

export default function LoginPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const from = useLocation().state?.from;
  const { isAuthenticated, user, error } = useAppSelector((s) => s.auth);
  const {
    register, handleSubmit, formState: { errors, isSubmitting },
  } = useForm({ defaultValues: { email: '', password: '' } });

  const [notice, setNotice] = useState(peekSessionNotice); // read in render (safe for StrictMode), cleared below

  useEffect(() => { clearSessionNotice(); }, []);
  useEffect(() => () => { dispatch(clearAuthError()); }, [dispatch]);

  if (isAuthenticated && user?.role) {
    return <Navigate to={resolvePostLogin(user.role, from)} replace />;
  }

  const onSubmit = async (values) => {
    setNotice('');
    const action = await dispatch(loginThunk({ email: values.email.trim(), password: values.password }));
    if (loginThunk.fulfilled.match(action)) {
      navigate(resolvePostLogin(action.payload.role, from), { replace: true });
    }
  };

  return (
    <AuthShell
      title="Sign in to FinGuardAI"
      subtitle="Welcome back — enter your credentials to continue."
      footer={<>New here? <Link to="/register" className="font-medium text-primary-600 hover:underline">Create an account</Link></>}
    >
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        <Alert tone="warning">{notice}</Alert>
        <Alert tone="error">{error}</Alert>

        <FormField
          name="email"
          label="Email"
          errors={errors}
          render={(p) => (
            <input
              {...p}
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              {...register('email', {
                required: 'Email is required',
                pattern: { value: /^\S+@\S+\.\S+$/, message: 'Enter a valid email address' },
              })}
            />
          )}
        />

        <FormField
          name="password"
          label="Password"
          errors={errors}
          render={(p) => (
            <input
              {...p}
              type="password"
              autoComplete="current-password"
              {...register('password', { required: 'Password is required' })}
            />
          )}
        />

        <button type="submit" disabled={isSubmitting} className={`${BTN.base} ${BTN.primary} ${BTN.md} w-full`}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthShell>
  );
}
