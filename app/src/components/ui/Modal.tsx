import * as React from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function Modal({ isOpen, onClose, title, children, className = '' }: ModalProps) {
  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title ?? 'Dialog'}
    >
      <div className={`modal ${className}`} onClick={(event) => event.stopPropagation()}>
        {title && (
          <div className="modal-header">
            <h2 className="modal-title">{title}</h2>
            <button className="modal-close" onClick={onClose} aria-label="Close dialog">
              <X size={18} />
            </button>
          </div>
        )}
        <div className="modal-content">{children}</div>
      </div>
    </div>
  );
}
