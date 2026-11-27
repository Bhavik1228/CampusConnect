import * as React from 'react';
import { LoaderCircle } from 'lucide-react';

type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
type ButtonSize = 'default' | 'large';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export function Button({
  children,
  variant = 'primary',
  size = 'default',
  loading = false,
  disabled,
  className = '',
  ...props
}: ButtonProps) {
  const disabledOrLoading = disabled || loading;
  return (
    <button
      className={`btn-base btn-${size} btn-${variant} ${className}`}
      disabled={disabledOrLoading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <LoaderCircle size={15} strokeWidth={2} />}
      {children}
    </button>
  );
}
