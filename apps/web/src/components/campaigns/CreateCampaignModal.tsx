import React, { useEffect, useRef, useState } from 'react';
import type { TemplateDto } from '@aiking/shared';
import { X, Send, AlertCircle, Loader2, Sparkles, Plus } from 'lucide-react';
import { api } from '../../api/client';
import { CreateTemplateModal } from '../templates/CreateTemplateModal';
import { TemplateAutopilotModal } from '../templates/TemplateAutopilotModal';

interface CreateCampaignModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  prefillTags?: string[];
}

type CampaignChannel = 'whatsapp' | 'email';
type LoadState = 'idle' | 'loading' | 'success' | 'empty' | 'error';

const EMPTY_PREFILL_TAGS: string[] = [];

export const isCampaignTemplateEligible = (template: TemplateDto, channel: CampaignChannel): boolean =>
  template.channel === channel &&
  (channel === 'whatsapp' ? template.status === 'approved' : template.status !== 'paused');

export const CreateCampaignModal: React.FC<CreateCampaignModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  prefillTags,
}) => {
  const initialTags = prefillTags ?? EMPTY_PREFILL_TAGS;
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<CampaignChannel>('whatsapp');
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [templatesState, setTemplatesState] = useState<LoadState>('idle');
  const [templateReloadVersion, setTemplateReloadVersion] = useState(0);
  const [createTemplateOpen, setCreateTemplateOpen] = useState(false);
  const [autopilotOpen, setAutopilotOpen] = useState(false);
  const [templateNotice, setTemplateNotice] = useState<string | null>(null);
  const [audienceType, setAudienceType] = useState<'all' | 'tags'>(initialTags.length > 0 ? 'tags' : 'all');
  const [availableTags, setAvailableTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [tagsState, setTagsState] = useState<LoadState>('idle');
  const [tagsReloadVersion, setTagsReloadVersion] = useState(0);
  const [selectedTags, setSelectedTags] = useState<string[]>(initialTags);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const templateRequestVersion = useRef(0);
  const templateRequests = useRef(new Map<CampaignChannel, Promise<TemplateDto[]>>());
  const tagsRequest = useRef<Promise<Array<{ tag: string; count: number }>> | null>(null);

  const requestTemplates = (requestedChannel: CampaignChannel): Promise<TemplateDto[]> => {
    const inFlight = templateRequests.current.get(requestedChannel);
    if (inFlight) return inFlight;

    const request = api.templates.list({ channel: requestedChannel });
    templateRequests.current.set(requestedChannel, request);
    void request.then(
      () => {
        if (templateRequests.current.get(requestedChannel) === request) templateRequests.current.delete(requestedChannel);
      },
      () => {
        if (templateRequests.current.get(requestedChannel) === request) templateRequests.current.delete(requestedChannel);
      },
    );
    return request;
  };

  useEffect(() => {
    if (!isOpen) return;

    const requestVersion = ++templateRequestVersion.current;
    let active = true;
    setTemplatesState('loading');
    setTemplates([]);
    setTemplateId('');

    void (async () => {
      let completedState: LoadState = 'error';
      try {
        const rows = await requestTemplates(channel);
        if (!active || requestVersion !== templateRequestVersion.current) return;
        const eligible = rows.filter((template) => isCampaignTemplateEligible(template, channel));
        setTemplates(eligible);
        setTemplateId(eligible[0]?.id || '');
        completedState = eligible.length > 0 ? 'success' : 'empty';
      } catch {
        if (!active || requestVersion !== templateRequestVersion.current) return;
        setTemplates([]);
        setTemplateId('');
      } finally {
        if (active && requestVersion === templateRequestVersion.current) {
          setTemplatesState(completedState);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [isOpen, channel, templateReloadVersion]);

  useEffect(() => {
    if (!isOpen) return;

    let active = true;
    setTagsState('loading');

    if (!tagsRequest.current) {
      const request = api.contacts.tags();
      tagsRequest.current = request;
      void request.then(
        () => {
          if (tagsRequest.current === request) tagsRequest.current = null;
        },
        () => {
          if (tagsRequest.current === request) tagsRequest.current = null;
        },
      );
    }

    void (async () => {
      let completedState: LoadState = 'error';
      try {
        const tags = await tagsRequest.current;
        if (!active) return;
        const loadedTags = tags || [];
        setAvailableTags(loadedTags);
        completedState = loadedTags.length > 0 ? 'success' : 'empty';
      } catch {
        if (!active) return;
        setAvailableTags([]);
      } finally {
        if (active) setTagsState(completedState);
      }
    })();

    return () => {
      active = false;
    };
  }, [isOpen, tagsReloadVersion]);

  useEffect(() => {
    if (!isOpen) return;
    const requestedTags = prefillTags ?? EMPTY_PREFILL_TAGS;
    setSelectedTags(requestedTags);
    setAudienceType(requestedTags.length > 0 ? 'tags' : 'all');
  }, [isOpen, prefillTags]);

  const reloadTemplates = () => setTemplateReloadVersion((version) => version + 1);

  if (!isOpen) return null;

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (audienceType === 'tags' && selectedTags.length === 0) {
      setError('Please select at least one tag or choose "All Opted-in Contacts"');
      return;
    }
    if (!templateId) { setError(`Choose an eligible ${channel === 'whatsapp' ? 'WhatsApp' : 'Email'} template before launching.`); return; }

    setIsSubmitting(true);
    setError(null);
    try {
      const filter =
        audienceType === 'all'
          ? { all: true }
          : { tags: selectedTags };

      const created = await api.campaigns.create({
        name,
        channel,
        templateId: templateId || undefined,
        filter,
      });

      // Auto launch the created campaign in demo mode (spec §7.2)
      await api.campaigns.launch(created.id);
      onSuccess();
    } catch (err: any) {
      setError(err.message || 'Failed to create campaign');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '560px', width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '10px',
                background: 'var(--accent-amber-light)',
                border: '1px solid var(--accent-amber-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Send size={20} color="#92400e" />
            </div>
            <div>
              <h3 style={{ fontSize: '1.2rem', color: 'var(--text-primary)' }}>Launch Broadcast Campaign</h3>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Multi-channel bulk messaging dispatch (spec §6 & §7)</div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
          >
            <X size={20} />
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: '12px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--accent-rose-light)',
              border: '1px solid var(--accent-rose-border)',
              color: '#9f1239',
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '16px',
            }}
          >
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
              Campaign Name *
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Diwali Offer — Delhi VIPs"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-field"
            />
          </div>

          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
              Channel *
            </label>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as any)}
              className="input-field"
            >
              <option value="whatsapp">WhatsApp Broadcast (Meta Cloud API)</option>
              <option value="email">Email Campaign (Amazon SES)</option>
            </select>
          </div>

          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
              Select Template
            </label>
            {templatesState === 'loading' || templatesState === 'idle' ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>Loading eligible templates…</div>
            ) : templatesState === 'error' ? (
              <div role="alert" style={{ padding: 14, border: '1px solid var(--accent-rose-border)', borderRadius: 8, background: 'var(--accent-rose-light)' }}>
                <div style={{ color: '#9f1239', fontSize: '0.84rem', fontWeight: 700, marginBottom: 10 }}>Unable to load templates.</div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={reloadTemplates}>Retry</button>
              </div>
            ) : templatesState === 'success' ? (
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="input-field">
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.status.replace('_', ' ')})</option>)}
              </select>
            ) : (
              <div style={{ padding: 14, border: '1px dashed var(--border-subtle)', borderRadius: 8, background: '#f8fafc' }}>
                <div style={{ fontSize: '0.84rem', fontWeight: 700, marginBottom: 10 }}>No {channel === 'whatsapp' ? 'approved WhatsApp' : 'eligible Email'} templates available.</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCreateTemplateOpen(true)}><Plus size={13} /> Create Template</button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAutopilotOpen(true)}><Sparkles size={13} /> Create with AI Autopilot</button>
                </div>
              </div>
            )}
            {templatesState === 'success' && <div style={{ display: 'flex', gap: 8, marginTop: 8 }}><button type="button" className="btn btn-ghost btn-sm" onClick={() => setCreateTemplateOpen(true)}><Plus size={13} /> Create Template</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => setAutopilotOpen(true)}><Sparkles size={13} /> Create with AI Autopilot</button></div>}
            {templateNotice && <div style={{ color: '#166534', fontSize: '0.76rem', marginTop: 7 }}>{templateNotice}</div>}
          </div>

          {/* Audience Selector (Spec §7.2.1) */}
          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
              Audience Targeting (spec §7.2)
            </label>
            <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
              <button
                type="button"
                onClick={() => setAudienceType('all')}
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-md)',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  border: audienceType === 'all' ? '2px solid var(--brand-blue)' : '1px solid var(--border-subtle)',
                  background: audienceType === 'all' ? 'var(--brand-blue-light)' : '#ffffff',
                  color: audienceType === 'all' ? 'var(--brand-blue)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                All Opted-in Contacts
              </button>
              <button
                type="button"
                onClick={() => setAudienceType('tags')}
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-md)',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  border: audienceType === 'tags' ? '2px solid var(--brand-blue)' : '1px solid var(--border-subtle)',
                  background: audienceType === 'tags' ? 'var(--brand-blue-light)' : '#ffffff',
                  color: audienceType === 'tags' ? 'var(--brand-blue)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                Target by Tags
              </button>
            </div>

            {audienceType === 'tags' && (
              <div style={{ padding: '12px', background: '#f8fafc', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
                <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '8px' }}>
                  Select Tags to Target (contacts bearing ALL selected tags will receive message):
                </div>
                {tagsState === 'loading' || tagsState === 'idle' ? (
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Loading contact tags…</div>
                ) : tagsState === 'error' ? (
                  <div role="alert" style={{ fontSize: '0.75rem', color: '#9f1239' }}>
                    Unable to load contact tags.{' '}
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTagsReloadVersion((version) => version + 1)}>Retry</button>
                  </div>
                ) : availableTags.length > 0 ? (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {availableTags.map((t) => {
                      const isSelected = selectedTags.includes(t.tag);
                      return (
                        <button
                          key={t.tag}
                          type="button"
                          onClick={() => toggleTag(t.tag)}
                          style={{
                            padding: '4px 10px',
                            borderRadius: 'var(--radius-pill)',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            border: isSelected ? '1px solid var(--brand-blue)' : '1px solid var(--border-subtle)',
                            background: isSelected ? 'var(--brand-blue)' : '#ffffff',
                            color: isSelected ? '#ffffff' : 'var(--text-secondary)',
                            cursor: 'pointer',
                            transition: 'all 0.1s ease',
                          }}
                        >
                          #{t.tag} ({t.count})
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    No tags found in CRM. Import contacts with tags first via CSV.
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={{ padding: '12px 14px', background: '#f8fafc', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Campaigns atomically reserve wallet balance and enqueue BullMQ jobs per recipient. Settlement occurs automatically upon provider delivery receipts.
          </div>

          <button
            type="submit"
            disabled={isSubmitting || templatesState === 'loading' || !templateId}
            className="btn btn-emerald btn-lg"
            style={{ marginTop: '8px', width: '100%' }}
          >
            {isSubmitting ? (
              <>
                <Loader2 size={18} className="animate-spin" /> Launching Dispatch...
              </>
            ) : (
              'Launch Campaign Now'
            )}
          </button>
        </form>
      </div>
      {createTemplateOpen && <CreateTemplateModal isOpen initialChannel={channel} onClose={() => setCreateTemplateOpen(false)} onSuccess={() => { setCreateTemplateOpen(false); setTemplateNotice('Template saved. Complete approval before it can be used when required.'); reloadTemplates(); }} />}
      {autopilotOpen && <TemplateAutopilotModal isOpen initialChannel={channel} onClose={() => setAutopilotOpen(false)} onSaved={() => { setAutopilotOpen(false); setTemplateNotice('Template saved as draft. Complete approval before it can be used in a campaign.'); reloadTemplates(); }} />}
    </div>
  );
};
