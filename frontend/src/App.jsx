import { Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import AppShell from './components/layout/AppShell';
import SignInPage from './pages/SignInPage';
import SignUpPage from './pages/SignUpPage';
import DashboardPage from './pages/DashboardPage';

export default function App() {
  return (
    <Routes>
      <Route path="/sign-in/*" element={<SignInPage />} />
      <Route path="/sign-up/*" element={<SignUpPage />} />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <AppShell>
              <DashboardPage />
            </AppShell>
          </ProtectedRoute>
        }
      />
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
