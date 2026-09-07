import React from 'react';
import { MoreVertical } from 'lucide-react';
import './ActionMenu.css';

export interface ActionMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export const ActionMenu: React.FC<{ label: string; items: ActionMenuItem[] }> = ({ label, items }) => (
  <details className="action-menu" onClick={(event) => event.stopPropagation()}>
    <summary aria-label={label} title={label}>
      <MoreVertical size={18} />
    </summary>
    <div className="action-menu__panel" role="menu">
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? 'action-menu__danger' : undefined}
          disabled={item.disabled}
          onClick={(event) => {
            item.onSelect();
            event.currentTarget.closest('details')?.removeAttribute('open');
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  </details>
);
