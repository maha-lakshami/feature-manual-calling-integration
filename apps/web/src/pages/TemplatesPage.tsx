import React, { useEffect, useState } from 'react';
import type { TemplateDto } from '@aiking/shared';
import { FileText, Mail, MessageSquare, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { api } from '../api/client';
import { ActionMenu, type ActionMenuItem } from '../components/common/ActionMenu';
import { ConfirmationDialog } from '../components/common/ConfirmationDialog';
import { canManageTemplates } from '../components/common/permission-ui';
import { CreateTemplateModal } from '../components/templates/CreateTemplateModal';
import { TemplateAutopilotModal } from '../components/templates/TemplateAutopilotModal';
import { useAuth } from '../context/AuthContext';

type PendingLifecycle = { action: 'delete' | 'pause'; template: TemplateDto };

export const TemplatesPage: React.FC = () => {
  const { user } = useAuth();
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTemplate, setEditTemplate] = useState<TemplateDto | null>(null);
  const [aiTemplate, setAiTemplate] = useState<TemplateDto | null | undefined>(undefined);
  const [pendingLifecycle, setPendingLifecycle] = useState<PendingLifecycle | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManage = canManageTemplates(user?.permissions);

  const fetchTemplates = async () => {
    setLoading(true);
    setError(null);
    try {
      setTemplates(await api.templates.list());
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load templates.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchTemplates();
  }, []);

  const saved = (template: TemplateDto, message = 'Template saved as a draft.') => {
    setCreateOpen(false);
    setEditTemplate(null);
    setAiTemplate(undefined);
    setNotice(message);
    void fetchTemplates();
  };

  const submit = async (template: TemplateDto) => {
    setError(null);
    try {
      await api.templates.submit(template.id);
      setNotice(template.channel === 'whatsapp'
        ? 'Template submitted through the approval lifecycle.'
        : 'Email template is now approved.');
      await fetchTemplates();
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : 'Could not submit template.');
    }
  };

  const applyLifecycle = async () => {
    if (!pendingLifecycle) return;
    setLifecycleBusy(true);
    setError(null);
    try {
      if (pendingLifecycle.action === 'delete') {
        await api.templates.remove(pendingLifecycle.template.id);
        setNotice('Unused draft template deleted.');
      } else {
        await api.templates.pause(pendingLifecycle.template.id);
        setNotice('Template paused. Existing campaign history remains available.');
      }
      setPendingLifecycle(null);
      await fetchTemplates();
    } catch (lifecycleError: unknown) {
      setError(lifecycleError instanceof Error ? lifecycleError.message : 'Could not update template lifecycle.');
      setPendingLifecycle(null);
    } finally {
      setLifecycleBusy(false);
    }
  };

  const actionsFor = (template: TemplateDto): ActionMenuItem[] => {
    const actions: ActionMenuItem[] = [{
      label: 'Copy content',
      onSelect: () => {
        void navigator.clipboard.writeText(template.body);
        setNotice('Template content copied.');
      },
    }];
    if (!canManage) return actions;

    actions.push(
      { label: 'Edit', onSelect: () => setEditTemplate(template) },
      { label: 'Modify with AI', onSelect: () => setAiTemplate(template) },
    );
    if (template.status !== 'approved' && template.status !== 'pending_approval') {
      actions.push({ label: 'Submit', onSelect: () => void submit(template) });
    }
    if (template.status !== 'paused') {
      actions.push({ label: 'Pause', onSelect: () => setPendingLifecycle({ action: 'pause', template }) });
    }
    if (template.status === 'draft') {
      actions.push({
        label: 'Delete draft',
        danger: true,
        onSelect: () => setPendingLifecycle({ action: 'delete', template }),
      });
    }
    return actions;
  };

  return (
    <div>
      <div className="page-heading">
        <div><h1>Message Templates</h1><p>Create drafts, manage approval, and prepare WhatsApp or email content.</p></div>
        <div className="page-heading__actions">
          <button type="button" onClick={() => void fetchTemplates()} className="btn btn-secondary" disabled={loading}><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Refresh</button>
          {canManage && <button type="button" onClick={() => setCreateOpen(true)} className="btn btn-primary"><Plus size={16} /> Create Template</button>}
          {canManage && <button type="button" onClick={() => setAiTemplate(null)} className="btn btn-emerald"><Sparkles size={16} /> AI Autopilot</button>}
        </div>
      </div>

      {notice && <div className="state-notice state-notice--success" role="status">{notice}</div>}
      {error && <div className="state-notice state-notice--error" role="alert">{error}</div>}

      {loading ? (
        <div className="data-card empty-state"><RefreshCw size={28} className="animate-spin" /><h3>Loading templates</h3><p>Retrieving current template lifecycle information.</p></div>
      ) : templates.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 22 }}>
          {templates.map((template) => (
            <article key={template.id} className="data-card" style={{ padding: 22, display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                  <span className={`badge ${template.channel === 'whatsapp' ? 'badge-emerald' : 'badge-indigo'}`}>{template.channel === 'whatsapp' ? <MessageSquare size={12} /> : <Mail size={12} />}{template.channel.toUpperCase()}</span>
                  <span className={`badge ${template.status === 'approved' ? 'badge-emerald' : template.status === 'rejected' ? 'badge-rose' : template.status === 'pending_approval' ? 'badge-amber' : 'badge-slate'}`}>{template.status.replaceAll('_', ' ').toUpperCase()}</span>
                  {template.providerTemplateName && <span className="badge badge-blue">PROVIDER LINKED</span>}
                </div>
                <ActionMenu label={`Actions for ${template.name}`} items={actionsFor(template)} />
              </div>
              <h3 style={{ fontSize: '1.08rem', marginBottom: 7 }}>{template.name}</h3>
              {template.subject && <div style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: 8 }}>Subject: {template.subject}</div>}
              <div style={{ padding: 14, background: '#f8fafc', border: '1px solid var(--border-subtle)', borderRadius: 8, whiteSpace: 'pre-wrap', lineHeight: 1.55, flex: 1 }}>{template.body}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 9 }}>Variables: {template.variables.length ? template.variables.map((variable) => `{{${variable}}}`).join(', ') : 'None'}</div>
              {template.rejectionReason && <div style={{ fontSize: '0.75rem', color: '#9f1239', marginTop: 6 }}>Provider: {template.rejectionReason}</div>}
            </article>
          ))}
        </div>
      ) : (
        <div className="data-card empty-state"><FileText size={30} /><h3>No templates yet</h3><p>{canManage ? 'Create a template manually or generate one with AI.' : 'No templates are available for your permitted campaign workflows.'}</p>{canManage && <button type="button" className="btn btn-emerald" onClick={() => setAiTemplate(null)}><Sparkles size={16} /> Create with AI</button>}</div>
      )}

      {createOpen && <CreateTemplateModal isOpen onClose={() => setCreateOpen(false)} onSuccess={() => { setNotice('Template saved as a draft.'); setCreateOpen(false); void fetchTemplates(); }} />}
      {editTemplate && <CreateTemplateModal isOpen template={editTemplate} onClose={() => setEditTemplate(null)} onSuccess={() => saved(editTemplate, 'Template changes saved.')} />}
      {aiTemplate !== undefined && <TemplateAutopilotModal isOpen template={aiTemplate} onClose={() => setAiTemplate(undefined)} onSaved={(template) => saved(template)} />}
      {pendingLifecycle && <ConfirmationDialog title={pendingLifecycle.action === 'delete' ? 'Delete draft template?' : 'Pause template?'} message={pendingLifecycle.action === 'delete' ? 'Only an unused draft can be deleted. This action cannot be undone.' : 'The template will be unavailable to new campaigns, while existing campaign history remains intact.'} confirmLabel={pendingLifecycle.action === 'delete' ? 'Delete Draft' : 'Pause Template'} danger={pendingLifecycle.action === 'delete'} pending={lifecycleBusy} onCancel={() => setPendingLifecycle(null)} onConfirm={() => void applyLifecycle()} />}
    </div>
  );
};
