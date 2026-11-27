import * as React from 'react';

type StatusVariant = 'success' | 'warning' | 'danger' | 'info';

interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: StatusVariant;
  label: string;
  className?: string;
}

export function StatusPill({ variant = 'info', label, className = '', ...props }: StatusPillProps) {
  return (
    <span className={`status-pill status-${variant} ${className}`} {...props}>
      <span className="status-pill-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
