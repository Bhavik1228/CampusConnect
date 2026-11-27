import * as React from 'react';

type AlertVariant = 'success' | 'warning' | 'danger' | 'info';

interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant;
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function Alert({ variant = 'info', title, children, className = '', ...props }: AlertProps) {
  return (
    <div className={`alert alert-${variant} ${className}`} role="alert" {...props}>
      {title && <strong>{title}</strong>}
      {children}
    </div>
  );
}
