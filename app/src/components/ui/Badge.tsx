import * as React from 'react';

type BadgeVariant = 'soft' | 'primary' | 'success' | 'warning' | 'danger';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  className?: string;
  children: React.ReactNode;
}

export function Badge({ variant = 'soft', className = '', children, ...props }: BadgeProps) {
  return <span className={`badge badge-${variant} ${className}`} {...props}>{children}</span>;
}
