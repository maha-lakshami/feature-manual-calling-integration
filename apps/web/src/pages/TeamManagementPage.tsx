import React, { useEffect, useMemo, useState } from 'react';
import type { TeamActivityDto, TenantUserDto } from '@aiking/shared';
import { Loader2, Plus, Power, PowerOff, RefreshCw, UserCog, Users, X } from 'lucide-react';
import { api } from '../api/client';
import { ActionMenu } from '../components/common/ActionMenu';
import { ConfirmationDialog } from '../components/common/ConfirmationDialog';
import './TeamManagementPage.css';

export const TeamManagementPage: React.FC = () => {
  const [members, setMembers] = useState<TenantUserDto[]>([]);
  const [activity, setActivity] = useState<TeamActivityDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formMember, setFormMember] = useState<TenantUserDto | null | undefined>(undefined);
  const [activityStaffId, setActivityStaffId] = useState('all');
  const [pendingAccessMember, setPendingAccessMember] = useState<TenantUserDto | null>(null);
  const [isAccessPending, setIsAccessPending] = useState(false);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [loadedMembers, loadedActivity] = await Promise.all([api.users.list(), api.users.activity()]);
      setMembers(loadedMembers);
      setActivity(loadedActivity);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load team information.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const lastActivity = useMemo(() => {
    const result = new Map<string, string>();
    for (const item of activity) {
      if (!result.has(item.staffUserId)) result.set(item.staffUserId, item.occurredAt);
    }
    return result;
  }, [activity]);

  const filteredActivity = activityStaffId === 'all'
    ? activity
    : activity.filter((item) => item.staffUserId === activityStaffId);
  const activeCount = members.filter((member) => member.inviteStatus === 'active').length;
  const inactiveCount = members.filter((member) => member.inviteStatus === 'revoked').length;

  const changeAccess = async () => {
    if (!pendingAccessMember) return;
    const member = pendingAccessMember;
    const activating = member.inviteStatus === 'revoked';
    setIsAccessPending(true);
    setError(null);
    try {
      await api.users.setActive(member.id, activating);
      setNotice(`${member.fullName} ${activating ? 'reactivated' : 'deactivated'}.`);
      setPendingAccessMember(null);
      await load();
    } catch (statusError: unknown) {
      setError(statusError instanceof Error ? statusError.message : 'Unable to change staff access.');
      setPendingAccessMember(null);
    } finally {
      setIsAccessPending(false);
    }
  };

  return (
    <div className="team-page">
      <header className="team-page__header">
        <div>
          <h1>Team Management</h1>
          <p>Manage staff access and review team activity.</p>
        </div>
        <div className="team-page__header-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={isLoading}>
            <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setFormMember(null)}>
            <Plus size={16} /> Add Staff
          </button>
        </div>
      </header>

      {notice && <div className="team-notice">{notice}</div>}
      {error && <div className="team-error" role="alert">{error}</div>}

      <section className="team-summary" aria-label="Staff summary">
        <article><div className="team-summary__icon team-summary__icon--blue"><Users size={20} /></div><div><span>Total Staff</span><strong>{isLoading ? '—' : members.length}</strong></div></article>
        <article><div className="team-summary__icon team-summary__icon--green"><Power size={20} /></div><div><span>Active Staff</span><strong>{isLoading ? '—' : activeCount}</strong></div></article>
        <article><div className="team-summary__icon team-summary__icon--orange"><PowerOff size={20} /></div><div><span>Inactive Staff</span><strong>{isLoading ? '—' : inactiveCount}</strong></div></article>
      </section>

      <section className="team-panel">
        <div className="team-panel__heading"><div><h2>Team Members</h2><p>Staff accounts scoped to this workspace.</p></div></div>
        <div className="table-container">
          <table className="data-table team-table">
            <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Last activity</th><th>Actions</th></tr></thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id}>
                  <td><div className="team-member"><span>{member.fullName.charAt(0) || 'S'}</span><strong>{member.fullName}</strong></div></td>
                  <td>{member.email}</td>
                  <td><StatusBadge status={member.inviteStatus} /></td>
                  <td>{formatDate(lastActivity.get(member.userId) ?? member.lastLoginAt)}</td>
                  <td>
                    <ActionMenu
                      label={`Actions for ${member.fullName}`}
                      items={[
                        { label: 'Edit staff profile', onSelect: () => setFormMember(member) },
                        { label: 'View activity', onSelect: () => setActivityStaffId(member.userId) },
                        {
                          label: member.inviteStatus === 'revoked' ? 'Reactivate staff' : 'Deactivate staff',
                          danger: member.inviteStatus !== 'revoked',
                          onSelect: () => setPendingAccessMember(member),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {!isLoading && members.length === 0 && <tr><td colSpan={5} className="team-empty">No staff members yet.</td></tr>}
              {isLoading && <tr><td colSpan={5} className="team-empty">Loading team members…</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="team-panel" id="team-activity">
        <div className="team-panel__heading team-panel__heading--filter">
          <div><h2>Recent Team Activity</h2><p>Authoritative campaign, template, and call actions.</p></div>
          <select className="input-field" value={activityStaffId} onChange={(event) => setActivityStaffId(event.target.value)} aria-label="Filter activity by staff member">
            <option value="all">All staff</option>
            {members.map((member) => <option key={member.userId} value={member.userId}>{member.fullName}</option>)}
          </select>
        </div>
        <div className="table-container">
          <table className="data-table team-table">
            <thead><tr><th>Staff</th><th>Action</th><th>Resource</th><th>Status</th><th>Timestamp</th></tr></thead>
            <tbody>
              {filteredActivity.map((item) => (
                <tr key={item.id}>
                  <td><strong>{item.staffName}</strong></td>
                  <td>{item.action}</td>
                  <td><span className="team-resource-type">{item.resourceType}</span>{item.resourceName}</td>
                  <td><span className="badge badge-slate">{item.status.replaceAll('_', ' ')}</span></td>
                  <td>{formatDate(item.occurredAt)}</td>
                </tr>
              ))}
              {!isLoading && filteredActivity.length === 0 && <tr><td colSpan={5} className="team-empty">No attributable staff activity found.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {formMember !== undefined && (
        <StaffFormModal
          member={formMember}
          onClose={() => setFormMember(undefined)}
          onSaved={async (message) => {
            setFormMember(undefined);
            setNotice(message);
            await load();
          }}
        />
      )}
      {pendingAccessMember && (
        <ConfirmationDialog
          title={pendingAccessMember.inviteStatus === 'revoked' ? 'Reactivate staff member?' : 'Deactivate staff member?'}
          message={pendingAccessMember.inviteStatus === 'revoked'
            ? 'The retained tenant membership will be restored.'
            : 'Active tenant sessions will be revoked. Historical campaigns, templates, calls, and activity attribution remain intact.'}
          confirmLabel={pendingAccessMember.inviteStatus === 'revoked' ? 'Reactivate Staff' : 'Deactivate Staff'}
          danger={pendingAccessMember.inviteStatus !== 'revoked'}
          pending={isAccessPending}
          onCancel={() => setPendingAccessMember(null)}
          onConfirm={() => void changeAccess()}
        />
      )}
    </div>
  );
};

const StatusBadge: React.FC<{ status: TenantUserDto['inviteStatus'] }> = ({ status }) => (
  <span className={`badge ${status === 'active' ? 'badge-emerald' : status === 'revoked' ? 'badge-rose' : 'badge-amber'}`}>
    {status === 'revoked' ? 'Inactive' : status === 'invited' ? 'Invited' : 'Active'}
  </span>
);

const StaffFormModal: React.FC<{
  member: TenantUserDto | null;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}> = ({ member, onClose, onSaved }) => {
  const [fullName, setFullName] = useState(member?.fullName ?? '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSaving(true);
    setError(null);
    try {
      if (member) {
        await api.users.update(member.id, { fullName });
        await onSaved('Staff profile updated.');
      } else {
        const result = await api.users.invite({ fullName, email, password: password || undefined });
        const credentialNotice = result.temporaryPassword ? ` Temporary password: ${result.temporaryPassword}` : '';
        await onSaved(`Staff invitation created.${credentialNotice}`);
      }
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save staff member.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="modal-overlay" role="presentation">
      <div className="modal-content team-form" role="dialog" aria-modal="true" aria-labelledby="staff-form-title">
        <div className="team-form__header">
          <div className="team-form__title"><span><UserCog size={20} /></span><div><h2 id="staff-form-title">{member ? 'Edit Staff' : 'Add Staff'}</h2><p>Role and access remain limited to Staff.</p></div></div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={isSaving} aria-label="Close"><X size={18} /></button>
        </div>
        {error && <div className="team-error" role="alert">{error}</div>}
        <form onSubmit={submit} className="team-form__fields">
          <label>Full Name<input className="input-field" required value={fullName} onChange={(event) => setFullName(event.target.value)} /></label>
          <label>Email Address<input className="input-field" type="email" required value={email} disabled={Boolean(member)} onChange={(event) => setEmail(event.target.value)} /></label>
          {!member && <label>Temporary Password <span>(optional)</span><input className="input-field" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /><small>Leave blank to generate a secure temporary password.</small></label>}
          <div className="team-form__actions"><button type="button" className="btn btn-secondary" onClick={onClose} disabled={isSaving}>Cancel</button><button type="submit" className="btn btn-primary" disabled={isSaving}>{isSaving && <Loader2 size={16} className="animate-spin" />}{member ? 'Save Changes' : 'Add Staff'}</button></div>
        </form>
      </div>
    </div>
  );
};

function formatDate(value?: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
