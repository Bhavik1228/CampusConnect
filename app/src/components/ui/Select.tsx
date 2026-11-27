import * as React from 'react';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
  className?: string;
}

export function Select({ label, hint, error, className = '', ...props }: SelectProps) {
  const id = React.useId();
  return (
    <div className="field">
      {label && <label htmlFor={id}>{label}</label>}
      <select
        id={id}
        className={`select-base ${className}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        {...props}
      />
      {hint && <small id={`${id}-hint`}>{hint}</small>}
      {error && <small id={`${id}-error`} style={{ color: 'var(--cc-danger)' }}>
        {error}
      </small>}
    </div>
  );
}
