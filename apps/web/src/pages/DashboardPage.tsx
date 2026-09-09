/// <reference types="vite/client" />

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TenantDto } from '@aiking/shared';
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Ban,
  Building2,
  CreditCard,
  FileText,
  Mail,
  MessageCircle,
  PhoneCall,
  Send,
  Users,
  UserCog,
  Wallet,
  Zap,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import { TopupModal } from '../components/wallet/TopupModal';
import './DashboardPage.css';
import { summarizePlatformTenants } from './platform-summary';

export const DashboardPage: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [wallet, setWallet] = useState<any>(null);
  const [pricing, setPricing] = useState<any>(null);
  const [contactsCount, setContactsCount] = useState(0);
  const [campaignsCount, setCampaignsCount] = useState(0);
  const [callsCount, setCallsCount] = useState(0);
  const [teamCount, setTeamCount] = useState(0);
  const [isTopupOpen, setIsTopupOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const isPlatformContext = user?.isSuperAdmin === true && !user.tenantId;
  const canContacts = user?.permissions.includes('contacts:manage') === true;
  const canCampaigns = user?.permissions.includes('campaigns:launch') === true;
  const canTemplates = user?.permissions.includes('templates:manage') === true;
  const canCalls = user?.permissions.includes('calls:trigger') === true;
  const canViewWallet = user?.permissions.includes('wallet:view') === true;
  const canTopup = user?.permissions.includes('wallet:topup') === true;
  const canManageTeam = user?.permissions.includes('staff:manage') === true;

  const loadData = async () => {
    setIsLoading(true);
    try {
      if (!isPlatformContext) {
        const [walletRes, pricingRes, contactsRes, campaignsRes, callsRes, teamRes] = await Promise.allSettled([
          canViewWallet ? api.wallet.get() : Promise.resolve(null),
          canViewWallet ? api.wallet.getEffectivePricing() : Promise.resolve(null),
          canContacts ? api.contacts.list({ pageSize: 1 }) : Promise.resolve(null),
          canCampaigns ? api.campaigns.list() : Promise.resolve(null),
          canCalls ? api.calls.list() : Promise.resolve(null),
          canManageTeam ? api.users.list() : Promise.resolve(null),
        ]);

        if (walletRes.status === 'fulfilled' && walletRes.value) setWallet(walletRes.value);
        if (pricingRes.status === 'fulfilled' && pricingRes.value) setPricing(pricingRes.value);
        if (contactsRes.status === 'fulfilled' && contactsRes.value) setContactsCount(contactsRes.value.page.total || 0);
        if (campaignsRes.status === 'fulfilled' && campaignsRes.value) setCampaignsCount(campaignsRes.value.page.total);
        if (callsRes.status === 'fulfilled' && callsRes.value) setCallsCount(callsRes.value.page.total);
        if (teamRes.status === 'fulfilled' && teamRes.value) setTeamCount(teamRes.value.length);
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [user]);

  const availableBalance =
    wallet?.summary?.availableBalance?.formatted ||
    wallet?.summary?.effectiveBalance?.formatted ||
    wallet?.summary?.balance?.formatted ||
    '—';

  if (isPlatformContext) {
    return <PlatformDashboard />;
  }

  return (
    <div className="dashboard">
      <section className="dashboard-hero">
        <div className="dashboard-hero__copy">
          <div className="dashboard-hero__status">
            <span className="dashboard-status dashboard-status--healthy">
              <Building2 size={13} />
              Workspace overview
            </span>
            {import.meta.env.DEV && (
              <span className="dashboard-status dashboard-status--dev">
                <Zap size={13} />
                Mock Mode
              </span>
            )}
          </div>
          <h1>Welcome back, {user?.fullName || 'Team member'}</h1>
          <p>{canManageTeam ? 'Run customer communication and team operations from one place.' : 'Your permitted customer tasks and shortcuts are ready.'}</p>
        </div>

        {canTopup && (
          <button type="button" onClick={() => setIsTopupOpen(true)} className="btn btn-emerald dashboard-hero__action">
            <CreditCard size={17} />
            Top Up Wallet
          </button>
        )}
      </section>

      <section className="dashboard-kpis" aria-label="Workspace summary">
        {canViewWallet && <article className="dashboard-kpi dashboard-kpi--green">
          <div className="dashboard-kpi__header">
            <span>Available Balance</span>
            <div className="dashboard-kpi__icon"><Wallet size={21} /></div>
          </div>
          <strong className="dashboard-kpi__value">{availableBalance}</strong>
          <p>
            Free promotional: <strong>{wallet?.summary?.freeCreditBalance?.formatted || '—'}</strong>
          </p>
        </article>}

        {canContacts && <button type="button" className="dashboard-kpi dashboard-kpi--blue dashboard-kpi--interactive" onClick={() => navigate('/contacts')}>
          <div className="dashboard-kpi__header">
            <span>CRM Contacts</span>
            <div className="dashboard-kpi__icon"><Users size={21} /></div>
          </div>
          <strong className="dashboard-kpi__value">{isLoading ? '—' : contactsCount}</strong>
          <p>Manage customer records <ArrowUpRight size={14} /></p>
        </button>}

        {canCampaigns && <button type="button" className="dashboard-kpi dashboard-kpi--orange dashboard-kpi--interactive" onClick={() => navigate('/campaigns')}>
          <div className="dashboard-kpi__header">
            <span>Campaigns</span>
            <div className="dashboard-kpi__icon"><Send size={21} /></div>
          </div>
          <strong className="dashboard-kpi__value">{isLoading ? '—' : campaignsCount}</strong>
          <p>View broadcast activity <ArrowUpRight size={14} /></p>
        </button>}

        {canCalls && <button type="button" className="dashboard-kpi dashboard-kpi--purple dashboard-kpi--interactive" onClick={() => navigate('/calls')}>
          <div className="dashboard-kpi__header">
            <span>Calls</span>
            <div className="dashboard-kpi__icon"><PhoneCall size={21} /></div>
          </div>
          <strong className="dashboard-kpi__value">{isLoading ? '—' : callsCount}</strong>
          <p>Open calling console <ArrowUpRight size={14} /></p>
        </button>}

        {canManageTeam && <button type="button" className="dashboard-kpi dashboard-kpi--blue dashboard-kpi--interactive" onClick={() => navigate('/team')}>
          <div className="dashboard-kpi__header"><span>Team Members</span><div className="dashboard-kpi__icon"><UserCog size={21} /></div></div>
          <strong className="dashboard-kpi__value">{isLoading ? '—' : teamCount}</strong>
          <p>Manage staff access <ArrowUpRight size={14} /></p>
        </button>}
      </section>

      <div className="dashboard-lower-grid">
        {(canCalls || canCampaigns || canContacts || canTemplates || canTopup || canManageTeam) && <section className="dashboard-panel dashboard-launchpad">
          <div className="dashboard-section-heading">
            <div>
              <h2>Instant Launchpad</h2>
              <p>Quick access to your most-used workflows.</p>
            </div>
          </div>

          <div className="dashboard-launchpad__grid">
            {canCalls && <button type="button" className="launch-card launch-card--purple" onClick={() => navigate('/calls')}>
              <div className="launch-card__icon"><PhoneCall size={22} /></div>
              <div className="launch-card__copy"><strong>Place Call</strong><span>Start an outbound customer call</span></div>
              <ArrowRight className="launch-card__arrow" size={18} />
            </button>}

            {canCampaigns && <button type="button" className="launch-card launch-card--orange" onClick={() => navigate('/campaigns')}>
              <div className="launch-card__icon"><Send size={22} /></div>
              <div className="launch-card__copy"><strong>Launch Campaign</strong><span>Start a WhatsApp or email broadcast</span></div>
              <ArrowRight className="launch-card__arrow" size={18} />
            </button>}

            {canContacts && <button type="button" className="launch-card launch-card--blue" onClick={() => navigate('/contacts')}>
              <div className="launch-card__icon"><Users size={22} /></div>
              <div className="launch-card__copy"><strong>Add CRM Contact</strong><span>Create or import customer records</span></div>
              <ArrowRight className="launch-card__arrow" size={18} />
            </button>}

            {canTemplates && <button type="button" className="launch-card launch-card--purple" onClick={() => navigate('/templates')}>
              <div className="launch-card__icon"><FileText size={22} /></div>
              <div className="launch-card__copy"><strong>Manage Templates</strong><span>Create and approve campaign content</span></div>
              <ArrowRight className="launch-card__arrow" size={18} />
            </button>}

            {canManageTeam && <button type="button" className="launch-card launch-card--blue" onClick={() => navigate('/team')}>
              <div className="launch-card__icon"><UserCog size={22} /></div>
              <div className="launch-card__copy"><strong>Team Management</strong><span>Manage staff access and activity</span></div>
              <ArrowRight className="launch-card__arrow" size={18} />
            </button>}

            {canTopup && <button type="button" className="launch-card launch-card--green" onClick={() => setIsTopupOpen(true)}>
              <div className="launch-card__icon"><Wallet size={22} /></div>
              <div className="launch-card__copy"><strong>Add Balance</strong><span>Top up your workspace wallet</span></div>
              <ArrowRight className="launch-card__arrow" size={18} />
            </button>}
          </div>
        </section>}

        {canViewWallet && <section className="dashboard-panel dashboard-rates">
          <div className="dashboard-section-heading">
            <div>
              <h2>Channel Rate Sheet</h2>
              <p>Your current effective pricing.</p>
            </div>
          </div>

          <div className="dashboard-rates__list">
            <div className="rate-row rate-row--blue">
              <div className="rate-row__icon"><MessageCircle size={19} /></div>
              <div className="rate-row__copy"><strong>WhatsApp Messaging</strong><span>Meta Cloud API template</span></div>
              <div className="rate-row__price"><strong>{pricing?.whatsapp_message?.formatted || '—'}</strong><span>/ msg</span></div>
            </div>

            <div className="rate-row rate-row--purple">
              <div className="rate-row__icon"><PhoneCall size={19} /></div>
              <div className="rate-row__copy"><strong>Voice Calling</strong><span>Outbound call with analysis</span></div>
              <div className="rate-row__price"><strong>{pricing?.ai_call_minute?.formatted || '—'}</strong><span>/ min</span></div>
            </div>

            <div className="rate-row rate-row--orange">
              <div className="rate-row__icon"><Mail size={19} /></div>
              <div className="rate-row__copy"><strong>Email Broadcast</strong><span>Amazon SES delivery</span></div>
              <div className="rate-row__price"><strong>{pricing?.email_message?.formatted || '—'}</strong><span>/ email</span></div>
            </div>
          </div>
        </section>}
      </div>

      {canTopup && isTopupOpen && (
        <TopupModal
          isOpen={isTopupOpen}
          onClose={() => setIsTopupOpen(false)}
          onSuccess={() => {
            loadData();
            setIsTopupOpen(false);
          }}
        />
      )}
    </div>
  );
};

const PlatformDashboard: React.FC = () => {
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<TenantDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await api.tenants.list();
        if (active) setTenants(response.items || []);
      } catch {
        if (active) setError('Unable to load platform information.');
      } finally {
        if (active) setIsLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  const summary = useMemo(() => summarizePlatformTenants(tenants), [tenants]);
  const value = (actual: string | number | null) => isLoading ? '—' : actual ?? '—';

  return (
    <div className="dashboard dashboard--platform">
      <section className="dashboard-hero dashboard-platform-hero">
        <div className="dashboard-hero__copy">
          <div className="dashboard-hero__status">
            <span className="dashboard-status dashboard-status--healthy">
              <Building2 size={13} /> Platform management
            </span>
          </div>
          <h1>Platform overview</h1>
          <p>Monitor tenant organizations and cross-tenant billing from one place.</p>
        </div>
        <button type="button" className="btn btn-primary dashboard-hero__action" onClick={() => navigate('/tenants')}>
          <Building2 size={17} /> Manage Tenants
        </button>
      </section>

      {error && <div className="dashboard-platform-error" role="alert">{error}</div>}

      <section className="dashboard-kpis dashboard-platform-kpis" aria-label="Platform summary">
        <button type="button" className="dashboard-kpi dashboard-kpi--blue dashboard-kpi--interactive" onClick={() => navigate('/tenants')}>
          <div className="dashboard-kpi__header"><span>Total Tenants</span><div className="dashboard-kpi__icon"><Building2 size={21} /></div></div>
          <strong className="dashboard-kpi__value">{value(summary.total)}</strong>
          <p>View tenant directory <ArrowUpRight size={14} /></p>
        </button>
        <article className="dashboard-kpi dashboard-kpi--green">
          <div className="dashboard-kpi__header"><span>Active Tenants</span><div className="dashboard-kpi__icon"><CheckCircle2 size={21} /></div></div>
          <strong className="dashboard-kpi__value">{value(summary.active)}</strong>
          <p>Organizations with active access</p>
        </article>
        <article className="dashboard-kpi dashboard-kpi--orange">
          <div className="dashboard-kpi__header"><span>Suspended Tenants</span><div className="dashboard-kpi__icon"><Ban size={21} /></div></div>
          <strong className="dashboard-kpi__value">{value(summary.suspended)}</strong>
          <p>Organizations with suspended access</p>
        </article>
        {summary.availableBalance !== null && (
          <article className="dashboard-kpi dashboard-kpi--purple">
            <div className="dashboard-kpi__header"><span>Tenant Wallet Float</span><div className="dashboard-kpi__icon"><Wallet size={21} /></div></div>
            <strong className="dashboard-kpi__value">{value(summary.availableBalance)}</strong>
            <p>Available balance across tenant wallets</p>
          </article>
        )}
      </section>
    </div>
  );
};
