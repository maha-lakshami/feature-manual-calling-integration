import React, { useState } from 'react';
import type { TemplateDto } from '@aiking/shared';
import { X, FileText, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '../../api/client';

interface CreateTemplateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  template?: TemplateDto | null;
  initialChannel?: 'whatsapp' | 'email';
}

export const CreateTemplateModal: React.FC<CreateTemplateModalProps> = ({ isOpen, onClose, onSuccess, template, initialChannel = 'whatsapp' }) => {
  const [name, setName] = useState(template?.name || '');
  const [channel, setChannel] = useState<'whatsapp' | 'email'>((template?.channel as any) || initialChannel);
  const [content, setContent] = useState(template?.body || 'Hello {{fullName}}, your order #{{orderId}} is out for delivery with tracking {{trackingNo}}.');
  const [subject, setSubject] = useState(template?.subject || 'Order Shipment Update #{{orderId}}');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const data = { name, channel, body: content, subject: channel === 'email' ? subject : undefined };
      if (template) await api.templates.update(template.id, data);
      else await api.templates.create(data);

      onSuccess();
    } catch (err: any) {
      setError(err.message || 'Failed to create template');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '10px',
                background: 'var(--brand-blue-light)',
                border: '1px solid var(--brand-blue-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <FileText size={20} color="#004e9f" />
            </div>
            <div>
              <h3 style={{ fontSize: '1.2rem', color: 'var(--text-primary)' }}>{template ? 'Edit Message Template' : 'New Message Template'}</h3>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Parameterized broadcast templates</div>
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
              Template Name *
            </label>
            <input
              type="text"
              required
              placeholder="e.g. delivery_out_for_delivery"
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
              disabled={Boolean(template)}
            >
              <option value="whatsapp">WhatsApp Template (Meta)</option>
              <option value="email">Email Template (SES)</option>
            </select>
          </div>

          {channel === 'email' && (
            <div>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
                Email Subject *
              </label>
              <input
                type="text"
                required
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="input-field"
              />
            </div>
          )}

          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
              Template Body Content (with variables) *
            </label>
            <textarea
              rows={4}
              required
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="input-field"
              style={{ resize: 'vertical' }}
            />
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
              Tip: Wrap parameters with double curly braces like <code>{'{{fullName}}'}</code> or <code>{'{{trackingNo}}'}</code>.
            </div>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="btn btn-primary btn-lg"
            style={{ marginTop: '8px', width: '100%' }}
          >
            {isSubmitting ? (
              <>
                <Loader2 size={18} className="animate-spin" /> Saving Template...
              </>
            ) : (
              template ? 'Save Changes' : 'Save as Draft'
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
