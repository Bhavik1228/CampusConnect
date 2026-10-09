import { AlertCircle, CheckCircle2, LoaderCircle } from 'lucide-react';

export function LoadingState({ label = 'Loading your workspace…' }: { label?: string }) {
  return <div className="feedback"><LoaderCircle className="spin" size={20} aria-hidden="true" /><span>{label}</span></div>;
}

export function ErrorState({ message }: { message: string }) {
  return <div className="feedback feedback-error" role="alert"><AlertCircle size={19} aria-hidden="true" /><span>{message}</span></div>;
}

export function SuccessMessage({ message }: { message: string }) {
  return <div className="feedback feedback-success" role="status"><CheckCircle2 size={18} aria-hidden="true" /><span>{message}</span></div>;
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><div className="empty-icon">CC</div><h3>{title}</h3><p>{detail}</p></div>;
}
