import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, CheckCircle2, LifeBuoy, LoaderCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';
import {
  createDiagnosticError,
  explainDiagnosticError,
  makeSupportErrorLink,
  saveSupportDiagnosticContext,
  supportRetryStorageKey,
} from '../lib/diagnostic-errors';

export function LoadingState({ label = 'Loading your workspace…' }: { label?: string }) {
  return <div className="feedback"><LoaderCircle className="spin" size={20} aria-hidden="true" /><span>{label}</span></div>;
}

export function ErrorState({ message }: { message: string }) {
  const { activeMembership } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [copyNotice, setCopyNotice] = useState('');
  const eventId = useRef(crypto.randomUUID());
  const { feature, code } = createDiagnosticError(location.pathname, message);
  const supportLink = makeSupportErrorLink(location.pathname, code);

  useEffect(() => {
    const schoolId = activeMembership?.school_id;
    if (!schoolId) return;

    const storageKey = `campus-connect-error-event:${schoolId}:${code}`;
    const now = Date.now();
    try {
      const lastRecordedAt = Number(sessionStorage.getItem(storageKey));
      if (Number.isFinite(lastRecordedAt) && now - lastRecordedAt < 5 * 60 * 1000) return;
      sessionStorage.setItem(storageKey, String(now));
    } catch (error) {
      console.error('Could not deduplicate diagnostic event capture.', error);
    }

    void Promise.resolve().then(() => requireSupabase().functions.invoke('support-bot', {
      body: { action: 'record-error-event', schoolId, eventId: eventId.current, errorCode: code },
    })).then(({ error }) => {
      if (error) {
        console.warn('Could not record this diagnostic event.', error);
        try {
          sessionStorage.removeItem(storageKey);
        } catch (storageError) {
          console.error('Could not clear the diagnostic event capture marker.', storageError);
        }
      }
    }).catch((error: unknown) => {
      console.warn('Could not record this diagnostic event.', error);
      try {
        sessionStorage.removeItem(storageKey);
      } catch (storageError) {
        console.error('Could not clear the diagnostic event capture marker.', storageError);
      }
    });
  }, [activeMembership?.school_id, code]);

  useEffect(() => {
    let pending: unknown;
    try {
      const saved = sessionStorage.getItem(supportRetryStorageKey);
      if (!saved) return;
      pending = JSON.parse(saved) as unknown;
    } catch (error) {
      console.error('Could not restore the pending support retry.', error);
      try {
        sessionStorage.removeItem(supportRetryStorageKey);
      } catch (storageError) {
        console.error('Could not clear the pending support retry.', storageError);
      }
      return;
    }
    if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return;
    const retry = pending as { code?: unknown; path?: unknown; createdAt?: unknown };
    if (typeof retry.code !== 'string' || typeof retry.path !== 'string' || typeof retry.createdAt !== 'number') return;
    if (Date.now() - retry.createdAt > 30_000) {
      try {
        sessionStorage.removeItem(supportRetryStorageKey);
      } catch (error) {
        console.error('Could not clear the expired support retry.', error);
      }
      return;
    }
    if (retry.path !== location.pathname || (retry.code && retry.code !== code)) return;
    try {
      sessionStorage.removeItem(supportRetryStorageKey);
    } catch (error) {
      console.error('Could not clear the completed support retry.', error);
    }
    saveSupportDiagnosticContext(code, message);
    navigate(makeSupportErrorLink(location.pathname, code, location.pathname, true), { replace: true });
  }, [code, location.pathname, message, navigate]);

  async function copyDiagnostic() {
    try {
      await navigator.clipboard.writeText(`Error code: ${code}\nFeature: ${feature.name}\nWhat happened: ${message}`);
      setCopyNotice('Diagnostic details copied.');
    } catch (error) {
      console.error('Could not copy diagnostic details.', error);
      setCopyNotice('Copy failed. Select and copy the error code above.');
    }
  }

  return <div className="feedback feedback-error diagnostic-error" role="alert">
    <AlertCircle size={19} aria-hidden="true" />
    <div className="diagnostic-error-content">
      <strong>{feature.name} could not complete this request</strong>
      <span>{explainDiagnosticError(message)}</span>
      <details><summary>Technical details</summary><p>{message}</p></details>
      <div className="diagnostic-error-actions">
        <span className="diagnostic-error-code">Error code: <code>{code}</code></span>
        <button type="button" className="diagnostic-copy-button" onClick={() => void copyDiagnostic()}>Copy details</button>
        <Link
          to={supportLink}
          onClick={() => {
            if (!saveSupportDiagnosticContext(code, message)) {
              setCopyNotice('The original error details could not be saved. The error code is still included.');
            }
          }}
        ><LifeBuoy size={14} /> Ask Support Bot</Link>
      </div>
      {copyNotice && <small role="status">{copyNotice}</small>}
    </div>
  </div>;
}

export function SuccessMessage({ message }: { message: string }) {
  return <div className="feedback feedback-success" role="status"><CheckCircle2 size={18} aria-hidden="true" /><span>{message}</span></div>;
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><div className="empty-icon">CC</div><h3>{title}</h3><p>{detail}</p></div>;
}
