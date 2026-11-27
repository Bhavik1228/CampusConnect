import * as React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  className?: string;
}

export function Input({ label, hint, error, className = '', ...props }: InputProps) {
  const id = React.useId();
  return (
    <div className="field">
      {label && <label htmlFor={id}>{label}</label>}
      <input
        id={id}
        className={`input-base ${className}`}
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
