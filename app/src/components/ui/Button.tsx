import * as React from 'react';
import { LoaderCircle } from 'lucide-react';

type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
type ButtonSize = 'default' | 'large' | 'sm';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  asChild?: boolean;
}

export function Button({
  children,
  variant = 'primary',
  size = 'default',
  loading = false,
  disabled,
  className = '',
  asChild = false,
  ...props
}: ButtonProps) {
  const disabledOrLoading = disabled || loading;
  const baseClass = `btn-base btn-${size} btn-${variant} ${className}`;

  if (asChild) {
    const child = children as React.ReactElement & { props: Record<string, unknown> };
    return React.cloneElement(child, {
      ...props,
      className: `${baseClass} ${(child.props.className as string | undefined) ?? ''}`,
      disabled: disabledOrLoading,
      'aria-busy': loading || undefined,
    });
  }

  return (
    <button className={baseClass} disabled={disabledOrLoading} aria-busy={loading || undefined} {...props}>
      {loading && <LoaderCircle size={15} strokeWidth={2} />}
      {children}
    </button>
  );
}
