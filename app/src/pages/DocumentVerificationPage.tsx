import { useEffect, useState } from 'react';
import { CheckCircle2, FileCheck2, ShieldAlert, XCircle } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/Feedback';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';

type Verification = {
  status: 'authentic' | 'superseded' | 'revoked' | 'voided' | 'expired' | 'invalid' | 'unavailable';
  school_name?: string;
  document_type?: string;
  masked_reference?: string;
  issued_at?: string | null;
};

function isVerification(value: unknown): value is Verification {
  return typeof value === 'object' && value !== null && 'status' in value
    && ['authentic', 'superseded', 'revoked', 'voided', 'expired', 'invalid', 'unavailable']
      .includes(String(value.status));
}

const statusCopy: Record<Verification['status'], string> = {
  authentic: 'This document reference is authentic.',
  superseded: 'This document was authentic but has since been replaced by a newer version.',
  revoked: 'This document has been revoked by the issuing school.',
  voided: 'This document has been voided by the issuing school.',
  expired: 'This document verification reference has expired.',
  invalid: 'This verification reference is invalid.',
  unavailable: 'The document could not be verified. Please try again later.',
};

export function DocumentVerificationPage() {
  const { user } = useAuth();
  const { token = '' } = useParams();
  const [verification, setVerification] = useState<Verification | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [authorizedUrl, setAuthorizedUrl] = useState('');
  const [accessError, setAccessError] = useState('');

  useEffect(() => {
    let active = true;
    async function verify() {
      setLoading(true);
      setError('');
      setVerification(null);
      if (!/^[0-9a-f]{64}$/.test(token)) {
        setVerification({ status: 'invalid' });
        setLoading(false);
        return;
      }
      try {
        const { data, error: rpcError } = await requireSupabase()
          .rpc('verify_school_document', { verification_token: token });
        if (rpcError) throw rpcError;
        if (!isVerification(data)) throw new Error('The verification service returned an invalid response.');
        if (active) setVerification(data);
      } catch (verificationError) {
        console.error('Document authenticity verification failed.', verificationError);
        if (active) setError('Verification is temporarily unavailable. The document has not been confirmed.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void verify();
    return () => { active = false; };
  }, [token]);

  useEffect(() => {
    let active = true;
    async function loadAuthorizedDocument() {
      setAuthorizedUrl('');
      setAccessError('');
      if (!user || !verification || !['authentic', 'superseded'].includes(verification.status)) return;
      try {
        const client = requireSupabase();
        const { data, error: documentError } = await client.rpc('get_authorized_school_document', {
          verification_token: token,
        });
        if (documentError) throw documentError;
        if (typeof data !== 'object' || data === null || !('object_path' in data)
          || typeof data.object_path !== 'string') throw new Error('The secure document response was invalid.');
        const { data: signed, error: signedError } = await client.storage
          .from('school-official-documents')
          .createSignedUrl(data.object_path, 120);
        if (signedError) throw signedError;
        if (!signed?.signedUrl) throw new Error('A temporary document link could not be created.');
        if (active) setAuthorizedUrl(signed.signedUrl);
      } catch (documentError) {
        console.error('Authorized official document access failed.', documentError);
        if (active) setAccessError('Your account could not be authorized to view the private document.');
      }
    }
    void loadAuthorizedDocument();
    return () => { active = false; };
  }, [token, user, verification]);

  const status = verification?.status;
  const authentic = status === 'authentic';
  const documentExists = status === 'authentic' || status === 'superseded';
  const StatusIcon = authentic ? CheckCircle2 : status === 'invalid' || status === 'revoked' || status === 'voided' ? XCircle : ShieldAlert;

  return (
    <main className="document-verification-page">
      <section className="document-verification-card">
        <span className="document-verification-brand"><FileCheck2 size={20} /></span>
        <span className="eyebrow">Campus Connect · Document verification</span>
        <h1>Verify an official document</h1>
        {loading ? <LoadingState label="Checking the issuing school’s records…" /> : error ? (
          <ErrorState message={error} />
        ) : verification && (
          <>
            <div className={`document-verification-status ${authentic ? 'is-authentic' : 'is-unverified'}`}>
              <StatusIcon size={22} />
              <div><strong>{statusCopy[verification.status]}</strong><span>{verification.school_name ?? 'No issuing school could be confirmed.'}</span></div>
            </div>
            {verification.document_type && <dl className="document-verification-details">
              <div><dt>Document</dt><dd>{verification.document_type.replaceAll('_', ' ')}</dd></div>
              <div><dt>Reference</dt><dd>{verification.masked_reference}</dd></div>
              {verification.issued_at && <div><dt>Issued</dt><dd>{new Date(verification.issued_at).toLocaleDateString()}</dd></div>}
            </dl>}
            <p className="document-verification-privacy">This public page confirms only document authenticity. Student results, financial balances and document contents are never shown here.</p>
            {documentExists && !user && <Link className="button button-quiet" to={`/login?redirect=${encodeURIComponent(`/verify/document/${token}`)}`}>Sign in to access the document</Link>}
            {user && accessError && <ErrorState message={accessError} />}
            {user && authorizedUrl && <iframe className="document-verification-frame" src={authorizedUrl} title="Authorized official document" />}
            {!authentic && <p className="document-verification-privacy">Do not rely on this copy as current unless the issuing school confirms its status.</p>}
          </>
        )}
        <Link className="button button-quiet" to="/">Return to Campus Connect</Link>
      </section>
    </main>
  );
}
