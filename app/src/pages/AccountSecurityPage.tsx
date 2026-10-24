import { Link } from 'react-router-dom';
import { MfaAuthenticator } from '../components/MfaAuthenticator';

export function AccountSecurityPage() {
  return (
    <main className="page-content">
      <div className="page-stack">
        <div className="page-heading">
          <div><span className="eyebrow">Your account</span><h1>Account security</h1><p>Set up a second sign-in step with an authenticator app.</p></div>
          <Link className="button button-quiet" to="/dashboard">Back to workspace</Link>
        </div>
        <section className="content-card mfa-how-to">
          <h2>How to use authenticator MFA</h2>
          <ol>
            <li>Install an authenticator app such as Google Authenticator, Microsoft Authenticator, 1Password, or Authy.</li>
            <li>Select <strong>Set up authenticator app</strong>, then scan the QR code. If scanning is unavailable, enter the displayed setup key in the app.</li>
            <li>Enter the current code from the app to verify setup. Keep the authenticator available; sign-in will ask for a code after you enable it or whenever your school requires MFA.</li>
          </ol>
          <p>Never share your setup key or one-time codes. If you lose access to your authenticator, contact your school administrator.</p>
        </section>
        <MfaAuthenticator />
      </div>
    </main>
  );
}
