/**
 * @file src/App.jsx
 * @description Root application component.
 *   - Dispatches checkAuthThunk on mount to restore the session from the HTTP-only cookie
 *   - ProtectedRoute (auth gate) and RoleRoute (role gate)
 *   - Each role renders inside its own layout (CustomerLayout / AnalystLayout / AdminLayout)
 *   - All pages are lazy-loaded (D-P6-09); layouts wrap their Outlet in Suspense + ErrorBoundary
 * @phase Phase 6 → Phase 7 (layouts + routes)
 * @decision D-P6-08, D-P6-09
 */

import { useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from './store/hooks.js';
import { checkAuthThunk } from './store/slices/authSlice.js';
import { ROLE_HOME } from './utils/constants.js';
import Spinner from './components/common/Spinner.jsx';
import ErrorBoundary from './components/common/ErrorBoundary.jsx';
import CustomerLayout from './layouts/CustomerLayout.jsx';
import AnalystLayout from './layouts/AnalystLayout.jsx';
import AdminLayout from './layouts/AdminLayout.jsx';

// ─── Lazy pages ───────────────────────────────────────────────────────────────
const LoginPage           = lazy(() => import('./pages/auth/LoginPage.jsx'));
const RegisterPage        = lazy(() => import('./pages/auth/RegisterPage.jsx'));

const CustomerDashboard   = lazy(() => import('./pages/customer/CustomerDashboard.jsx'));
const TransactionHistory  = lazy(() => import('./pages/customer/TransactionHistory.jsx'));
const FraudAlerts         = lazy(() => import('./pages/customer/FraudAlerts.jsx'));
const SubmitTransaction   = lazy(() => import('./pages/customer/SubmitTransaction.jsx'));
const TrustScore          = lazy(() => import('./pages/customer/TrustScore.jsx'));
const Profile             = lazy(() => import('./pages/customer/Profile.jsx'));

const AnalystDashboard    = lazy(() => import('./pages/analyst/AnalystDashboard.jsx'));
const FlaggedTransactions = lazy(() => import('./pages/analyst/FlaggedTransactions.jsx'));
const CaseManagement      = lazy(() => import('./pages/analyst/CaseManagement.jsx'));
const CaseDetail          = lazy(() => import('./pages/analyst/CaseDetail.jsx'));
const DeviceReputation    = lazy(() => import('./pages/analyst/DeviceReputation.jsx'));
const FraudPatterns       = lazy(() => import('./pages/analyst/FraudPatterns.jsx'));

const AdminDashboard      = lazy(() => import('./pages/admin/AdminDashboard.jsx'));
const AdminTrends         = lazy(() => import('./pages/admin/AdminTrends.jsx'));
const UserManagement      = lazy(() => import('./pages/admin/UserManagement.jsx'));
const SimulationPanel     = lazy(() => import('./pages/admin/SimulationPanel.jsx'));
const ThresholdConfig     = lazy(() => import('./pages/admin/ThresholdConfig.jsx'));
const AuditLogs           = lazy(() => import('./pages/admin/AuditLogs.jsx'));

const Account             = lazy(() => import('./pages/shared/Account.jsx'));
const NotFound            = lazy(() => import('./pages/shared/NotFound.jsx'));
const Unauthorized        = lazy(() => import('./pages/shared/Unauthorized.jsx'));

// ─── Route guards ─────────────────────────────────────────────────────────────

/**
 * Redirects unauthenticated users to /login (remembering where they wanted to go, so the login
 * page can return them there — N-17); shows a loader while the auth check is in flight.
 */
function ProtectedRoute() {
  const { isAuthenticated, loading } = useAppSelector((s) => s.auth);
  const location = useLocation();

  if (loading) return <Spinner className="min-h-screen" />;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location }} />;
  return <Outlet />;
}

/** Redirects to /unauthorized when the user's role is not in allowedRoles. */
function RoleRoute({ allowedRoles }) {
  const { user } = useAppSelector((s) => s.auth);

  if (!user?.role || !allowedRoles.includes(user.role)) {
    return <Navigate to="/unauthorized" replace />;
  }
  return <Outlet />;
}

/** Sends authenticated users to their role dashboard, everyone else to /login. */
function RootRedirect() {
  const { isAuthenticated, user, loading } = useAppSelector((s) => s.auth);

  if (loading) return <Spinner className="min-h-screen" />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <Navigate to={ROLE_HOME[user?.role] ?? '/login'} replace />;
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const dispatch = useAppDispatch();

  /** Restore session from HTTP-only cookie on every hard refresh */
  useEffect(() => {
    dispatch(checkAuthThunk());
  }, [dispatch]);

  return (
    <ErrorBoundary>
      <Suspense fallback={<Spinner className="min-h-screen" />}>
        <Routes>
          {/* Public */}
          <Route path="/login"        element={<LoginPage />} />
          <Route path="/register"     element={<RegisterPage />} />
          <Route path="/unauthorized" element={<Unauthorized />} />

          {/* CUSTOMER */}
          <Route element={<ProtectedRoute />}>
            <Route element={<RoleRoute allowedRoles={['CUSTOMER']} />}>
              <Route element={<CustomerLayout />}>
                <Route path="/customer"                    element={<CustomerDashboard />} />
                <Route path="/customer/transactions"       element={<TransactionHistory />} />
                <Route path="/customer/fraud-alerts"       element={<FraudAlerts />} />
                <Route path="/customer/submit-transaction" element={<SubmitTransaction />} />
                <Route path="/customer/trust-score"        element={<TrustScore />} />
                <Route path="/customer/profile"            element={<Profile />} />
              </Route>
            </Route>
          </Route>

          {/* ANALYST */}
          <Route element={<ProtectedRoute />}>
            <Route element={<RoleRoute allowedRoles={['ANALYST']} />}>
              <Route element={<AnalystLayout />}>
                <Route path="/analyst"                      element={<AnalystDashboard />} />
                <Route path="/analyst/flagged-transactions" element={<FlaggedTransactions />} />
                <Route path="/analyst/cases"                element={<CaseManagement />} />
                <Route path="/analyst/cases/:id"            element={<CaseDetail />} />
                <Route path="/analyst/fraud-patterns"       element={<FraudPatterns />} />
                <Route path="/analyst/device-reputation"    element={<DeviceReputation />} />
                <Route path="/analyst/account"              element={<Account />} />
              </Route>
            </Route>
          </Route>

          {/* ADMIN */}
          <Route element={<ProtectedRoute />}>
            <Route element={<RoleRoute allowedRoles={['ADMIN']} />}>
              <Route element={<AdminLayout />}>
                <Route path="/admin"            element={<AdminDashboard />} />
                <Route path="/admin/trends"     element={<AdminTrends />} />
                <Route path="/admin/users"      element={<UserManagement />} />
                <Route path="/admin/simulation" element={<SimulationPanel />} />
                <Route path="/admin/thresholds" element={<ThresholdConfig />} />
                <Route path="/admin/audit-logs" element={<AuditLogs />} />
                <Route path="/admin/account"    element={<Account />} />
              </Route>
            </Route>
          </Route>

          <Route path="/" element={<RootRedirect />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
