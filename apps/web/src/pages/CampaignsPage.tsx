import React, { useEffect, useState } from 'react';
import type { CampaignDto } from '@aiking/shared';
import { CheckCircle2, Clock, Mail, MessageSquare, RefreshCw, Send } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { ActionMenu, type ActionMenuItem } from '../components/common/ActionMenu';
import { ConfirmationDialog } from '../components/common/ConfirmationDialog';
import { CreateCampaignModal } from '../components/campaigns/CreateCampaignModal';
import { useAuth } from '../context/AuthContext';

type PendingAction = { action: 'delete' | 'cancel'; campaign: CampaignDto };

export const CampaignsPage: React.FC = () => {
  const { user } = useAuth();
  const location = useLocation();
  const prefillTags = (location.state as { prefillTags?: string[] } | null)?.prefillTags;
  const [campaigns, setCampaigns] = useState<CampaignDto[]>([]);
  const [isCreateOpen, setIsCreateOpen] = useState(Boolean(prefillTags?.length));
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [isActionPending, setIsActionPending] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManage = user?.permissions.includes('campaigns:launch') === true;

  const fetchCampaigns = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.campaigns.list();
      setCampaigns(response.items || []);
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load campaigns.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void fetchCampaigns();
  }, []);

  const applyAction = async () => {
    if (!pendingAction) return;
    setIsActionPending(true);
    setError(null);
    try {
      if (pendingAction.action === 'delete') {
        await api.campaigns.remove(pendingAction.campaign.id);
        setNotice('Untouched campaign draft deleted.');
      } else {
        await api.campaigns.cancel(pendingAction.campaign.id, 'Cancelled from Campaign Management');
        setNotice('Campaign cancelled. Sent recipients and financial history remain unchanged.');
      }
      setPendingAction(null);
      await fetchCampaigns();
    } catch (actionError: unknown) {
      setError(actionError instanceof Error ? actionError.message : 'Could not update campaign lifecycle.');
      setPendingAction(null);
    } finally {
      setIsActionPending(false);
    }
  };

  const actionsFor = (campaign: CampaignDto): ActionMenuItem[] => {
    if (!canManage) return [];
    if (campaign.status === 'draft') {
      return [{ label: 'Delete draft', danger: true, onSelect: () => setPendingAction({ action: 'delete', campaign }) }];
    }
    if (['scheduled', 'queued', 'sending', 'halted_insufficient_funds'].includes(campaign.status)) {
      return [{ label: 'Cancel campaign', danger: true, onSelect: () => setPendingAction({ action: 'cancel', campaign }) }];
    }
    return [];
  };

  return (
    <div>
      <div className="page-heading">
        <div><h1>Broadcast Campaigns</h1><p>Real delivery progress and recipient-level outcomes across supported channels.</p></div>
        <div className="page-heading__actions">
          <button type="button" onClick={() => void fetchCampaigns()} className="btn btn-secondary" disabled={isLoading}><RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} /> Refresh</button>
          {canManage && <button type="button" onClick={() => setIsCreateOpen(true)} className="btn btn-emerald"><Send size={16} /> Create Campaign</button>}
        </div>
      </div>

      {notice && <div className="state-notice state-notice--success" role="status">{notice}</div>}
      {error && <div className="state-notice state-notice--error" role="alert">{error}</div>}

      <div className="data-card" style={{ overflow: 'visible' }}>
        <div className="table-container">
          <table className="data-table">
            <thead><tr><th>Campaign</th><th>Channel</th><th>Status</th><th>Audience / Progress</th><th>Created</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {campaigns.map((campaign) => {
                const total = campaign.stats.total;
                const processed = total - campaign.stats.pending;
                const actions = actionsFor(campaign);
                const complete = campaign.status === 'completed';
                return (
                  <tr key={campaign.id}>
                    <td><strong>{campaign.name}</strong><div className="table-secondary">ID: {campaign.id.slice(0, 10)}</div></td>
                    <td><span className={`badge ${campaign.channel === 'whatsapp' ? 'badge-emerald' : 'badge-indigo'}`}>{campaign.channel === 'whatsapp' ? <MessageSquare size={12} /> : <Mail size={12} />}{campaign.channel.toUpperCase()}</span></td>
                    <td><span className={`badge ${complete ? 'badge-emerald' : campaign.status === 'failed' || campaign.status === 'cancelled' ? 'badge-rose' : 'badge-amber'}`}>{complete ? <CheckCircle2 size={12} /> : <Clock size={12} />}{campaign.status.replaceAll('_', ' ').toUpperCase()}</span></td>
                    <td><strong>{total} targeted</strong><div className="table-secondary">{processed} processed · {campaign.stats.failed} failed</div></td>
                    <td className="table-secondary">{new Date(campaign.createdAt).toLocaleString()}</td>
                    <td style={{ textAlign: 'right' }}>{actions.length > 0 ? <ActionMenu label={`Actions for ${campaign.name}`} items={actions} /> : <span className="table-secondary">History retained</span>}</td>
                  </tr>
                );
              })}
              {!isLoading && campaigns.length === 0 && <tr><td colSpan={6}><div className="empty-state"><Send size={28} /><h3>No campaigns yet</h3><p>{canManage ? 'Create your first campaign when your audience and approved template are ready.' : 'No campaign history is available.'}</p></div></td></tr>}
              {isLoading && <tr><td colSpan={6}><div className="empty-state"><RefreshCw size={28} className="animate-spin" /><h3>Loading campaigns</h3></div></td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {isCreateOpen && <CreateCampaignModal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} prefillTags={prefillTags} onSuccess={() => { void fetchCampaigns(); setIsCreateOpen(false); setNotice('Campaign draft created.'); }} />}
      {pendingAction && <ConfirmationDialog title={pendingAction.action === 'delete' ? 'Delete draft campaign?' : 'Cancel campaign?'} message={pendingAction.action === 'delete' ? 'Deletion is allowed only when the draft has no recipients, provider activity, or financial history. This cannot be undone.' : 'Pending delivery will stop. Already-sent messages, recipient outcomes, and wallet history will remain available.'} confirmLabel={pendingAction.action === 'delete' ? 'Delete Draft' : 'Cancel Campaign'} danger pending={isActionPending} onCancel={() => setPendingAction(null)} onConfirm={() => void applyAction()} />}
    </div>
  );
};
