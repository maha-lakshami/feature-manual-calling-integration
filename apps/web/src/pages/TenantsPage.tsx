import React, { useState, useEffect, useMemo } from 'react';
import {
  Building2,
  Shield,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Ban,
  Plus,
  Wallet,
  ArrowDownLeft,
  ArrowUpRight,
  Sparkles,
  Search,
  Receipt,
  Coins,
  TrendingUp,
  CreditCard,
  Users,
} from 'lucide-react';
import { api } from '../api/client';
import { ActionMenu, type ActionMenuItem } from '../components/common/ActionMenu';
import { ConfirmationDialog } from '../components/common/ConfirmationDialog';
import { CreateTenantModal } from '../components/tenants/CreateTenantModal';
import { TenantWalletDetailModal } from '../components/tenants/TenantWalletDetailModal';
import { AdjustWalletModal } from '../components/tenants/AdjustWalletModal';
import { useAuth } from '../context/AuthContext';

export const TenantsPage: React.FC = () => {
  const { user } = useAuth();
  const [tenants, setTenants] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'suspended'>('all');

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedWalletTenant, setSelectedWalletTenant] = useState<any | null>(null);
  const [selectedAdjustTenant, setSelectedAdjustTenant] = useState<any | null>(null);
  const [pendingStatusTenant, setPendingStatusTenant] = useState<any | null>(null);
  const [isStatusPending, setIsStatusPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canOnboard = user?.permissions.includes('tenant:onboard') === true;
  const canSuspend = user?.permissions.includes('tenant:suspend') === true;
  const canViewBilling = user?.permissions.includes('billing:view_cross_tenant') === true;
  const canAdjustBilling = user?.permissions.includes('platform:config') === true;

  const fetchTenants = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await api.tenants.list();
      setTenants(res.items || []);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load tenant organizations.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTenants();
  }, []);

  const handleToggleSuspend = async () => {
    if (!pendingStatusTenant) return;
    setIsStatusPending(true);
    setError(null);
    try {
      if (pendingStatusTenant.status === 'suspended') {
        await api.tenants.resume(pendingStatusTenant.id);
        setNotice(`${pendingStatusTenant.name} reactivated.`);
      } else {
        await api.tenants.suspend(pendingStatusTenant.id, 'Administrative review');
        setNotice(`${pendingStatusTenant.name} suspended. Tenant data and financial history were retained.`);
      }
      setPendingStatusTenant(null);
      await fetchTenants();
    } catch (statusError: unknown) {
      setError(statusError instanceof Error ? statusError.message : 'Failed to update tenant status.');
      setPendingStatusTenant(null);
    } finally {
      setIsStatusPending(false);
    }
  };

  // Platform-wide Super Admin aggregates
  const platformStats = useMemo(() => {
    const hasCompleteWalletData = tenants.length > 0 && tenants.every((tenant) => Boolean(tenant.wallet));
    let totalRechargedRupees = 0;
    let totalAvailableRupees = 0;
    let totalPaidFloatRupees = 0;
    let totalFreeFloatRupees = 0;
    let totalSpentRupees = 0;
    let activeCount = 0;
    let totalContacts = 0;

    for (const t of tenants) {
      if (t.status === 'active') activeCount++;
      totalContacts += t.contactCount || 0;

      if (t.wallet) {
        totalRechargedRupees += t.wallet.totalRecharged?.rupees || 0;
        totalAvailableRupees += t.wallet.availableBalance?.rupees || t.wallet.balance?.rupees || 0;
        totalPaidFloatRupees += t.wallet.paidBalance?.rupees || 0;
        totalFreeFloatRupees += t.wallet.freeCreditBalance?.rupees || 0;
        totalSpentRupees += t.wallet.totalSpent?.rupees || 0;
      }
    }

    return {
      totalRecharged: hasCompleteWalletData ? `₹${totalRechargedRupees.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—',
      totalAvailable: hasCompleteWalletData ? `₹${totalAvailableRupees.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—',
      totalPaidFloat: hasCompleteWalletData ? `₹${totalPaidFloatRupees.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—',
      totalFreeFloat: hasCompleteWalletData ? `₹${totalFreeFloatRupees.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—',
      totalSpent: hasCompleteWalletData ? `₹${totalSpentRupees.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—',
      activeCount,
      totalCount: tenants.length,
      totalContacts,
    };
  }, [tenants]);

  // Filtered list
  const filteredTenants = useMemo(() => {
    return tenants.filter((t) => {
      const matchesSearch =
        t.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.slug?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.id?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.contactEmail?.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'active' && t.status === 'active') ||
        (statusFilter === 'suspended' && t.status === 'suspended');

      return matchesSearch && matchesStatus;
    });
  }, [tenants, searchQuery, statusFilter]);

  return (
    <div>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '24px',
          flexWrap: 'wrap',
          gap: '16px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span className="badge badge-indigo">
              <Shield size={12} /> Super Admin Control Center
            </span>
            <span className="badge badge-emerald">Software Vendor View</span>
          </div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-primary)' }}>
            Client Organizations & Wallet Financials
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '4px' }}>
            Platform-wide tenant oversight, lifetime customer top-up revenue, and real-time float balances
          </p>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={fetchTenants} className="btn btn-secondary" disabled={isLoading}>
            <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
          {canOnboard && <button onClick={() => setIsCreateOpen(true)} className="btn btn-emerald">
            <Plus size={16} />
            <span>Onboard New Tenant</span>
          </button>}
        </div>
      </div>

      {notice && <div className="state-notice state-notice--success" role="status">{notice}</div>}
      {error && <div className="state-notice state-notice--error" role="alert">{error}</div>}

      {/* Super Admin Financial KPI Summary Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: '16px',
          marginBottom: '28px',
        }}
      >
        {/* Total Recharges / Platform Revenue */}
        <div
          className="data-card"
          style={{
            padding: '20px',
            background: 'linear-gradient(135deg, #ffffff 0%, #f0fdf4 100%)',
            border: '1px solid #bbf7d0',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#166534', textTransform: 'uppercase' }}>
              Total Recharges Collected
            </div>
            <Coins size={20} color="#166534" />
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: '#14532d', margin: '8px 0 4px 0' }}>
            {platformStats.totalRecharged}
          </div>
          <div style={{ fontSize: '0.8rem', color: '#15803d', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <TrendingUp size={14} />
            <span>Gross Razorpay Top-up Payments</span>
          </div>
        </div>

        {/* Total Spendable Float */}
        <div
          className="data-card"
          style={{
            padding: '20px',
            background: 'linear-gradient(135deg, #ffffff 0%, #eff6ff 100%)',
            border: '1px solid #bfdbfe',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#1e40af', textTransform: 'uppercase' }}>
              Total Active Float in Wallets
            </div>
            <Wallet size={20} color="#1e40af" />
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: '#1e3a8a', margin: '8px 0 4px 0' }}>
            {platformStats.totalAvailable}
          </div>
          <div style={{ fontSize: '0.8rem', color: '#3b82f6' }}>
            Paid Cash: <strong>{platformStats.totalPaidFloat}</strong> | Promo: {platformStats.totalFreeFloat}
          </div>
        </div>

        {/* Total Lifetime Usage Debits */}
        <div className="data-card" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Total Platform Usage Consumed
            </div>
            <Receipt size={20} color="var(--text-muted)" />
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: '#991b1b', margin: '8px 0 4px 0' }}>
            {platformStats.totalSpent}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            WhatsApp, Email & Voice Calling
          </div>
        </div>

        {/* Active Organizations */}
        <div className="data-card" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              Client Organizations
            </div>
            <Building2 size={20} color="var(--text-muted)" />
          </div>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)', margin: '8px 0 4px 0' }}>
            {isLoading ? '—' : platformStats.activeCount} <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>/ {isLoading ? '—' : platformStats.totalCount} active</span>
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {isLoading ? 'Loading tenant totals…' : `Managing ${platformStats.totalContacts} registered customer contacts`}
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div
        className="data-card"
        style={{
          padding: '16px 20px',
          marginBottom: '20px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: '280px' }}>
          <div style={{ position: 'relative', width: '100%', maxWidth: '400px' }}>
            <Search
              size={16}
              style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}
            />
            <input
              type="text"
              placeholder="Search by company name, slug, email, or ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="input-field"
              style={{ paddingLeft: '36px', width: '100%' }}
            />
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={() => setStatusFilter('all')}
              className={`btn btn-sm ${statusFilter === 'all' ? 'btn-primary' : 'btn-secondary'}`}
            >
              All ({tenants.length})
            </button>
            <button
              onClick={() => setStatusFilter('active')}
              className={`btn btn-sm ${statusFilter === 'active' ? 'btn-primary' : 'btn-secondary'}`}
            >
              Active ({platformStats.activeCount})
            </button>
            <button
              onClick={() => setStatusFilter('suspended')}
              className={`btn btn-sm ${statusFilter === 'suspended' ? 'btn-primary' : 'btn-secondary'}`}
            >
              Suspended ({tenants.length - platformStats.activeCount})
            </button>
          </div>
        </div>
      </div>

      {/* Tenants Table */}
      <div className="data-card" style={{ overflow: 'hidden' }}>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Organization</th>
                <th>Status & Plan</th>
                <th style={{ background: '#f0fdf4' }}>Total Recharged</th>
                <th>Available Balance</th>
                <th>Usage Spent</th>
                <th>Contacts</th>
                <th>Created</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredTenants.length > 0 ? (
                filteredTenants.map((t) => {
                  const isSuspended = t.status === 'suspended';
                  const totalRechargedStr = t.wallet?.totalRecharged?.formatted || '—';
                  const rechargeCount = t.wallet?.rechargeCount || 0;
                  const availableStr = t.wallet?.availableBalance?.formatted || t.wallet?.balance?.formatted || '—';
                  const paidStr = t.wallet?.paidBalance?.formatted || '—';
                  const freeStr = t.wallet?.freeCreditBalance?.formatted || '—';
                  const spentStr = t.wallet?.totalSpent?.formatted || '—';
                  const actions: ActionMenuItem[] = [
                    ...(canViewBilling ? [{ label: 'View wallet & ledger', onSelect: () => setSelectedWalletTenant(t) }] : []),
                    ...(canAdjustBilling ? [{ label: 'Credit or adjust balance', onSelect: () => setSelectedAdjustTenant(t) }] : []),
                    ...(canSuspend ? [{ label: isSuspended ? 'Reactivate tenant' : 'Suspend tenant', danger: !isSuspended, onSelect: () => setPendingStatusTenant(t) }] : []),
                  ];

                  return (
                    <tr key={t.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <div
                            style={{
                              width: '38px',
                              height: '38px',
                              borderRadius: '10px',
                              background: '#eff6ff',
                              border: '1px solid #bfdbfe',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <Building2 size={18} color="#004e9f" />
                          </div>
                          <div>
                            <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{t.name}</div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                              {t.slug}
                            </div>
                          </div>
                        </div>
                      </td>

                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <span className={`badge ${isSuspended ? 'badge-rose' : 'badge-emerald'}`} style={{ width: 'fit-content' }}>
                            {isSuspended ? <Ban size={12} /> : <CheckCircle2 size={12} />}
                            {t.status?.toUpperCase() || 'ACTIVE'}
                          </span>
                          <span className="badge badge-slate" style={{ width: 'fit-content', fontSize: '0.7rem' }}>
                            {t.plan?.toUpperCase() || 'STANDARD'}
                          </span>
                        </div>
                      </td>

                      {/* Total Recharged Column */}
                      <td style={{ background: '#f0fdf4' }}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, color: '#166534', fontSize: '1rem' }}>
                          {totalRechargedStr}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: '#15803d' }}>
                          {rechargeCount > 0 ? `${rechargeCount} top-up${rechargeCount > 1 ? 's' : ''}` : 'No paid top-ups yet'}
                        </div>
                      </td>

                      {/* Available Balance Column */}
                      <td>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-primary)' }}>
                          {availableStr}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          Paid: {paidStr} | Free: {freeStr}
                        </div>
                      </td>

                      {/* Usage Spent Column */}
                      <td>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: '#be123c' }}>
                          {spentStr}
                        </div>
                      </td>

                      {/* Contacts */}
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                          <Users size={14} />
                          <span>{t.contactCount ?? 0}</span>
                        </div>
                      </td>

                      <td style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                        {new Date(t.createdAt).toLocaleDateString()}
                      </td>

                      {/* Actions */}
                      <td style={{ textAlign: 'right' }}>
                        {actions.length > 0 && <ActionMenu label={`Actions for ${t.name}`} items={actions} />}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px' }}>
                    {isLoading ? 'Loading tenant organizations...' : 'No tenant organizations matched your criteria.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Onboard Tenant Modal */}
      {isCreateOpen && (
        <CreateTenantModal
          isOpen={isCreateOpen}
          onClose={() => setIsCreateOpen(false)}
          onSuccess={() => {
            fetchTenants();
            setIsCreateOpen(false);
          }}
        />
      )}

      {/* Tenant Wallet Detail Modal */}
      {selectedWalletTenant && (
        <TenantWalletDetailModal
          isOpen={!!selectedWalletTenant}
          tenant={selectedWalletTenant}
          onClose={() => setSelectedWalletTenant(null)}
          onOpenAdjust={(t) => {
            setSelectedWalletTenant(null);
            setSelectedAdjustTenant(t);
          }}
        />
      )}

      {/* Adjust / Grant Balance Modal */}
      {selectedAdjustTenant && (
        <AdjustWalletModal
          isOpen={!!selectedAdjustTenant}
          tenant={selectedAdjustTenant}
          onClose={() => setSelectedAdjustTenant(null)}
          onSuccess={() => {
            fetchTenants();
            setSelectedAdjustTenant(null);
          }}
        />
      )}

      {pendingStatusTenant && (
        <ConfirmationDialog
          title={pendingStatusTenant.status === 'suspended' ? 'Reactivate tenant?' : 'Suspend tenant?'}
          message={pendingStatusTenant.status === 'suspended'
            ? 'Tenant access will be restored using the existing membership and financial history.'
            : 'Users will lose tenant access until reactivation. Tenant data, billing, and audit history will not be deleted.'}
          confirmLabel={pendingStatusTenant.status === 'suspended' ? 'Reactivate Tenant' : 'Suspend Tenant'}
          danger={pendingStatusTenant.status !== 'suspended'}
          pending={isStatusPending}
          onCancel={() => setPendingStatusTenant(null)}
          onConfirm={() => void handleToggleSuspend()}
        />
      )}
    </div>
  );
};
