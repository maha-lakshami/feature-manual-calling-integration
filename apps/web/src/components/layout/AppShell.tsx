/// <reference types="vite/client" />

import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Building2,
  ChevronDown,
  ExternalLink,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  PhoneCall,
  PlusCircle,
  Send,
  Shield,
  Users,
  UserCog,
  Wallet,
  X,
  Zap,
} from 'lucide-react';
import { api, API_DOCS_URL } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { TopupModal } from '../wallet/TopupModal';
import { navigationFor, type NavigationItem } from './navigation';
import './AppShell.css';

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [walletBalance, setWalletBalance] = useState<string | null>(null);
  const [isTopupOpen, setIsTopupOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const isPlatformContext = user?.isSuperAdmin === true && !user.tenantId;
  const canViewWallet = Boolean(user && !isPlatformContext && user.permissions.includes('wallet:view'));
  const canTopup = Boolean(user && !isPlatformContext && user.permissions.includes('wallet:topup'));

  const fetchWallet = async () => {
    if (!canViewWallet) return;

    try {
      const data = await api.wallet.get();
      const balance = data.summary.availableBalance || data.summary.effectiveBalance || data.summary.balance;
      setWalletBalance(balance?.formatted || '—');
    } catch {
      setWalletBalance('—');
    }
  };

  useEffect(() => {
    fetchWallet();
  }, [user]);

  useEffect(() => {
    setIsSidebarOpen(false);
    setIsProfileOpen(false);
  }, [location.pathname]);

  const workspaceName = user?.tenantName || (user?.isSuperAdmin ? 'Platform Management' : 'Workspace');
  const iconFor = (item: NavigationItem) => ({
    dashboard: LayoutDashboard,
    contacts: Users,
    campaigns: Send,
    templates: FileText,
    calls: PhoneCall,
    wallet: Wallet,
    tenants: Building2,
    team: UserCog,
  })[item.icon];
  const navSections = user ? navigationFor(user) : [];

  return (
    <div className="app-shell">
      {isSidebarOpen && (
        <button
          type="button"
          className="app-shell__backdrop"
          aria-label="Close navigation"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      <aside
        id="primary-navigation"
        className={`app-sidebar${isSidebarOpen ? ' app-sidebar--open' : ''}`}
      >
        <div className="app-sidebar__brand">
          <div className="app-sidebar__logo" aria-hidden="true">
            <Zap size={20} />
          </div>
          <div>
            <div className="app-sidebar__brand-name">Aiking Connect</div>
            <div className="app-sidebar__brand-subtitle">Customer Operations</div>
          </div>
          <button
            type="button"
            className="app-sidebar__close"
            onClick={() => setIsSidebarOpen(false)}
            aria-label="Close navigation"
          >
            <X size={19} />
          </button>
        </div>

        <div className="app-sidebar__workspace">
          <div className="app-sidebar__workspace-label">Workspace</div>
          <div className="app-sidebar__workspace-name">
            {user?.isSuperAdmin ? <Shield size={15} /> : <Building2 size={15} />}
            <span>{workspaceName}</span>
          </div>
        </div>

        <nav className="app-sidebar__nav" aria-label="Primary navigation">
          {navSections.map((section) => (
            <React.Fragment key={section.label}>
              <div className="app-sidebar__section-label">{section.label}</div>
              {section.items.map((item) => {
                const Icon = iconFor(item);
                const isActive = location.pathname === item.path;

                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={`app-sidebar__nav-link${isActive ? ' app-sidebar__nav-link--active' : ''}`}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    <Icon size={18} strokeWidth={1.9} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </React.Fragment>
          ))}
        </nav>

        {import.meta.env.DEV && (
          <div className="app-sidebar__developer-link">
            <a href={API_DOCS_URL} target="_blank" rel="noreferrer">
              <span>API Explorer</span>
              <ExternalLink size={14} />
            </a>
          </div>
        )}

        <div className="app-sidebar__profile">
          <div className="app-avatar" aria-hidden="true">
            {user?.fullName?.charAt(0) || 'U'}
          </div>
          <div className="app-sidebar__profile-copy">
            <div className="app-sidebar__profile-name">{user?.fullName}</div>
            <div className="app-sidebar__profile-role">{user?.role?.replace('_', ' ')}</div>
          </div>
          <button type="button" onClick={() => void logout()} className="app-icon-button" aria-label="Log out">
            <LogOut size={17} />
          </button>
        </div>
      </aside>

      <div className="app-shell__content">
        <header className="app-header">
          <div className="app-header__workspace">
            <button
              type="button"
              className="app-header__menu app-icon-button"
              onClick={() => setIsSidebarOpen(true)}
              aria-label="Open navigation"
              aria-controls="primary-navigation"
              aria-expanded={isSidebarOpen}
            >
              <Menu size={20} />
            </button>
            <div>
              <span className="app-header__workspace-label">Workspace</span>
              <span className="app-header__workspace-name">{workspaceName}</span>
            </div>
          </div>

          <div className="app-header__actions">
            {canViewWallet && (
              <div className="app-header__wallet">
                <div className="app-header__wallet-balance">
                  <Wallet size={15} aria-hidden="true" />
                  <span className="app-header__wallet-label">Balance</span>
                  <strong>{walletBalance || '—'}</strong>
                </div>
                {canTopup && <button type="button" onClick={() => setIsTopupOpen(true)} className="app-header__topup">
                  <PlusCircle size={14} />
                  <span>Top Up</span>
                </button>}
              </div>
            )}

            <div className="app-header__profile-menu">
              <button
                type="button"
                className="app-header__profile-trigger"
                onClick={() => setIsProfileOpen((current) => !current)}
                aria-haspopup="menu"
                aria-expanded={isProfileOpen}
              >
                <span className="app-avatar app-avatar--small" aria-hidden="true">
                  {user?.fullName?.charAt(0) || 'U'}
                </span>
                <span className="app-header__profile-name">{user?.fullName}</span>
                <ChevronDown size={15} aria-hidden="true" />
              </button>

              {isProfileOpen && (
                <div className="app-profile-menu" role="menu">
                  <div className="app-profile-menu__identity">
                    <strong>{user?.fullName}</strong>
                    <span>{user?.email}</span>
                  </div>
                  <div className="app-profile-menu__workspace">{workspaceName}</div>
                  <button type="button" role="menuitem" onClick={() => void logout()}>
                    <LogOut size={16} />
                    Log out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="app-main">{children}</main>
      </div>

      {canTopup && isTopupOpen && (
        <TopupModal
          isOpen={isTopupOpen}
          onClose={() => setIsTopupOpen(false)}
          onSuccess={() => {
            fetchWallet();
            setIsTopupOpen(false);
          }}
        />
      )}
    </div>
  );
};
