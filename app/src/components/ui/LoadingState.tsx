interface LoadingStateProps {
  label?: string;
  className?: string;
}

export function LoadingState({ label = 'Loading…', className = '' }: LoadingStateProps) {
  return (
    <div className={`loading-state ${className}`}>
      <div className="loading-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
