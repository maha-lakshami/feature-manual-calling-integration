import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import type { Permission } from '@aiking/shared';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AppShell } from './components/layout/AppShell';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { WalletPage } from './pages/WalletPage';
import { ContactsPage } from './pages/ContactsPage';
import { ContactDetailPage } from './pages/ContactDetailPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { CallsPage } from './pages/CallsPage';
import { TenantsPage } from './pages/TenantsPage';
import { TeamManagementPage } from './pages/TeamManagementPage';

const ProtectedRoute: React.FC<{
  children: React.ReactNode;
  requireSuperAdmin?: boolean;
  requirePermission?: Permission;
  requireAnyPermission?: Permission[];
}> = ({
  children,
  requireSuperAdmin = false,
  requirePermission,
  requireAnyPermission,
}) => {
  const { user, token } = useAuth();

  if (!token || !user) {
    return <Navigate to="/login" replace />;
  }

  if (requireSuperAdmin && !user.isSuperAdmin) {
    return <Navigate to="/" replace />;
  }

  if (requirePermission && !user.permissions.includes(requirePermission)) {
    return <Navigate to="/" replace />;
  }

  if (requireAnyPermission && !requireAnyPermission.some((permission) => user.permissions.includes(permission))) {
    return <Navigate to="/" replace />;
  }

  return <AppShell>{children}</AppShell>;
};

export const App: React.FC = () => {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route
            path="/"
            element={
              <ProtectedRoute requirePermission="wallet:view">
                <DashboardPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/wallet"
            element={
              <ProtectedRoute requirePermission="wallet:view">
                <WalletPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/contacts"
            element={
              <ProtectedRoute requirePermission="contacts:manage">
                <ContactsPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/contacts/:id"
            element={
              <ProtectedRoute requirePermission="contacts:manage">
                <ContactDetailPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/templates"
            element={
              <ProtectedRoute requirePermission="templates:manage">
                <TemplatesPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/campaigns"
            element={
              <ProtectedRoute requirePermission="campaigns:launch">
                <CampaignsPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/calls"
            element={
              <ProtectedRoute requirePermission="calls:trigger">
                <CallsPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/team"
            element={
              <ProtectedRoute requirePermission="staff:manage">
                <TeamManagementPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/tenants"
            element={
              <ProtectedRoute requireSuperAdmin>
                <TenantsPage />
              </ProtectedRoute>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
};
