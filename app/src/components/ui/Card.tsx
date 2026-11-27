import * as React from 'react';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
}

export function Card({ children, className = '', ...props }: CardProps) {
  return <div className={`card ${className}`} {...props}>{children}</div>;
}

interface CardSectionProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  className?: string;
}

export function CardHeader({ children, className = '', ...props }: CardSectionProps) {
  return <div className={`card-header ${className}`} {...props}>{children}</div>;
}

export function CardTitle({ children, className = '', ...props }: React.HTMLAttributes<HTMLHeadingElement> & CardSectionProps) {
  return <h3 className={`card-title ${className}`} {...props}>{children}</h3>;
}

export function CardDescription({ children, className = '', ...props }: React.HTMLAttributes<HTMLParagraphElement> & CardSectionProps) {
  return <p className={`card-description ${className}`} {...props}>{children}</p>;
}

export function CardContent({ children, className = '', ...props }: CardSectionProps) {
  return <div className={`card-content ${className}`} {...props}>{children}</div>;
}
