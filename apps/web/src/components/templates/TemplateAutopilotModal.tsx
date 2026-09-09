import React, { useEffect, useState } from 'react';
import type { Channel, TemplateAutopilotResult, TemplateDto } from '@aiking/shared';
import { AlertCircle, Loader2, Sparkles, X } from 'lucide-react';
import { api } from '../../api/client';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (template: TemplateDto) => void;
  initialChannel?: 'whatsapp' | 'email';
  template?: TemplateDto | null;
}

export const TemplateAutopilotModal: React.FC<Props> = ({
  isOpen, onClose, onSaved, initialChannel = 'whatsapp', template,
}) => {
  const [channel, setChannel] = useState<'whatsapp' | 'email'>(template?.channel as 'whatsapp' | 'email' || initialChannel);
  const [prompt, setPrompt] = useState('');
  const [tone, setTone] = useState('professional and friendly');
  const [language, setLanguage] = useState('English');
  const [result, setResult] = useState<TemplateAutopilotResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [isOpen, busy, onClose]);

  if (!isOpen) return null;
  const modifying = Boolean(template);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(modifying
        ? await api.templates.modify(template!.id, { instruction: prompt })
        : await api.templates.generate({ channel: channel as Channel, prompt, tone, language }));
    } catch (err: any) {
      setError(err.message || 'Template generation failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      const saved = modifying
        ? await api.templates.update(template!.id, {
            name: result.name, body: result.body, subject: result.subject ?? undefined,
          })
        : await api.templates.create({
            name: result.name, channel: result.channel, language, body: result.body,
            subject: result.subject ?? undefined,
          });
      onSaved(saved);
    } catch (err: any) {
      setError(err.message || 'Could not save the template draft.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" role="presentation">
      <div className="modal-content" role="dialog" aria-modal="true" aria-labelledby="autopilot-title" style={{ maxWidth: '820px', maxHeight: '92vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div>
            <h3 id="autopilot-title" style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)' }}>
              ✨ {modifying ? 'Modify with AI' : 'Template AI Autopilot'}
            </h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>AI proposes content only. You control saving and approval.</div>
          </div>
          <button type="button" aria-label="Close Autopilot" onClick={onClose} disabled={busy} className="btn btn-ghost btn-sm"><X size={19} /></button>
        </div>

        {error && <div role="alert" style={{ padding: 12, marginBottom: 14, borderRadius: 8, background: 'var(--accent-rose-light)', color: '#9f1239', display: 'flex', gap: 8 }}><AlertCircle size={17} />{error}</div>}

        {modifying && template && (
          <section style={{ marginBottom: 16 }}>
            <div style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--text-muted)', marginBottom: 6 }}>ORIGINAL</div>
            <div style={{ padding: 14, border: '1px solid var(--border-subtle)', borderRadius: 8, background: '#f8fafc', whiteSpace: 'pre-wrap' }}>
              {template.subject && <strong>{template.subject}<br /><br /></strong>}{template.body}
            </div>
          </section>
        )}

        {!modifying && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
            <label style={{ fontSize: '0.8rem', fontWeight: 700 }}>Channel
              <select className="input-field" value={channel} onChange={(e) => { setChannel(e.target.value as any); setResult(null); }} disabled={busy} style={{ marginTop: 5 }}>
                <option value="whatsapp">WhatsApp</option><option value="email">Email</option>
              </select>
            </label>
            <label style={{ fontSize: '0.8rem', fontWeight: 700 }}>Tone
              <input className="input-field" value={tone} onChange={(e) => setTone(e.target.value)} disabled={busy} style={{ marginTop: 5 }} />
            </label>
            <label style={{ fontSize: '0.8rem', fontWeight: 700 }}>Language
              <input className="input-field" value={language} onChange={(e) => setLanguage(e.target.value)} disabled={busy} style={{ marginTop: 5 }} />
            </label>
          </div>
        )}

        <label style={{ fontSize: '0.8rem', fontWeight: 700, display: 'block' }}>
          {modifying ? 'How should AI revise this template?' : 'Describe the customer communication you need'}
          <textarea autoFocus className="input-field" rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={busy}
            placeholder={modifying ? 'Make this shorter and more urgent while preserving all variables.' : 'Create a Diwali fleet service offer with 15% discount, professional tone, customer name and expiry date.'}
            style={{ resize: 'vertical', marginTop: 6 }} />
        </label>

        <button type="button" className="btn btn-primary" onClick={generate} disabled={busy || !prompt.trim()} style={{ marginTop: 12 }}>
          {busy ? <><Loader2 size={17} className="animate-spin" /> Generating…</> : <><Sparkles size={17} /> {result ? 'Regenerate' : 'Generate Template'}</>}
        </button>

        {result && (
          <section style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: '0.72rem', fontWeight: 800, color: '#6d28d9', marginBottom: 8 }}>{modifying ? 'AI PROPOSED REVISION' : 'GENERATED DRAFT PREVIEW'}</div>
            <h4 style={{ fontSize: '1.05rem', marginBottom: 5 }}>{result.name}</h4>
            <div style={{ display: 'flex', gap: 7, marginBottom: 10 }}><span className="badge badge-indigo">{result.channel.toUpperCase()}</span>{result.category && <span className="badge badge-slate">{result.category}</span>}</div>
            {result.subject && <div style={{ fontWeight: 700, marginBottom: 8 }}>Subject: {result.subject}</div>}
            <div style={{ padding: 15, background: '#f8fafc', border: '1px solid var(--border-subtle)', borderRadius: 8, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{result.body}</div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 9 }}>Variables: {result.variables.length ? result.variables.map((v) => `{{${v}}}`).join(', ') : 'None'}</div>
            {result.notes && <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 6 }}>{result.notes}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="button" className="btn btn-emerald" onClick={save} disabled={busy}>{modifying ? 'Accept Revision' : 'Save as Draft'}</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
};
