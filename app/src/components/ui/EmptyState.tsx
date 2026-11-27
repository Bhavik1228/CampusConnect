import * as React from 'react';

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, className = '' }: EmptyStateProps) {
  return (
    <div className={`empty-state ${className}`}>
      {icon ?? <span className="empty-icon">CC</span>}
      <h3>{title}</h3>
      {description && <p>{description}</p>}
    </div>
  );
}
