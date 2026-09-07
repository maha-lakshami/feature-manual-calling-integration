import React from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';

export interface ConfirmationDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const ConfirmationDialog: React.FC<ConfirmationDialogProps> = ({
  title,
  message,
  confirmLabel,
  danger = false,
  pending = false,
  onCancel,
  onConfirm,
}) => (
  <div className="modal-overlay" role="presentation">
    <section className="modal-content confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
      <div className="confirm-dialog__heading">
        <span className={danger ? 'confirm-dialog__icon confirm-dialog__icon--danger' : 'confirm-dialog__icon'}>
          <AlertTriangle size={20} />
        </span>
        <div><h2 id="confirm-title">{title}</h2><p id="confirm-message">{message}</p></div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={pending} aria-label="Close confirmation"><X size={18} /></button>
      </div>
      <div className="confirm-dialog__actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={pending}>Cancel</button>
        <button type="button" className={danger ? 'btn btn-danger-outline' : 'btn btn-primary'} onClick={onConfirm} disabled={pending}>
          {pending && <Loader2 size={16} className="animate-spin" />}{confirmLabel}
        </button>
      </div>
    </section>
  </div>
);
