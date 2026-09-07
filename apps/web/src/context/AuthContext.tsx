import React, { createContext, useContext, useState, useEffect } from 'react';
import type { Permission } from '@aiking/shared';
import { api } from '../api/client';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: 'super_admin' | 'manager' | 'staff';
  tenantId: string | null;
  tenantName: string | null;
  isSuperAdmin: boolean;
  permissions: Permission[];
}

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  quickLogin: (persona: 'admin' | 'manager' | 'staff') => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const QUICK_PERSONAS = import.meta.env.DEV ? {
  admin: {
    label: 'Platform Super Admin',
    email: 'admin@aiking.example',
    password: 'admin123',
    role: 'super_admin',
    description: 'Manage platform tenants, system pricing & infra',
  },
  manager: {
    label: 'Demo Tenant Manager',
    email: 'manager@demo.example',
    password: 'demo123',
    role: 'manager',
    description: 'Full tenant operations, campaigns, wallet top-ups, AI calls',
  },
  staff: {
    label: 'Demo Tenant Staff',
    email: 'staff@demo.example',
    password: 'demo123',
    role: 'staff',
    description: 'CRM contacts, templates & outbound communications',
  },
} : null;

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    let isMounted = true;
    const restoreSession = async () => {
      try {
        const res = await api.auth.refresh();
        if (isMounted) {
          setUser(res.user as AuthUser);
          setToken(res.accessToken);
        }
      } catch {
        if (isMounted) {
          setUser(null);
          setToken(null);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    restoreSession();
    return () => {
      isMounted = false;
    };
  }, []);

  const login = async (email: string, password: string) => {
    setIsLoading(true);
    try {
      const res = await api.auth.login({ email, password });
      setUser(res.user as AuthUser);
      setToken(res.accessToken);
    } finally {
      setIsLoading(false);
    }
  };

  const quickLogin = async (persona: 'admin' | 'manager' | 'staff') => {
    if (!QUICK_PERSONAS) {
      throw new Error('Developer quick login is unavailable outside development');
    }
    const p = QUICK_PERSONAS[persona];
    await login(p.email, p.password);
  };

  const logout = async () => {
    try {
      await api.auth.logout();
    } catch {
      // Ignore network errors during logout
    } finally {
      setUser(null);
      setToken(null);
    }
  };

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, logout, quickLogin }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
