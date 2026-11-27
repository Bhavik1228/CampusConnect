import * as React from 'react';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
  className?: string;
}

export function Textarea({ label, hint, error, className = '', ...props }: TextareaProps) {
  const id = React.useId();
  return (
    <div className="field">
      {label && <label htmlFor={id}>{label}</label>}
      <textarea
        id={id}
        className={`textarea-base ${className}`}
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
