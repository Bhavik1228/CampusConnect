const apkDownloadUrl = import.meta.env.VITE_ANDROID_APK_URL?.trim() ?? '';

function isSafeDownloadUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function MobileInstallPage() {
  const downloadAvailable = isSafeDownloadUrl(apkDownloadUrl);
  const schoolId = new URLSearchParams(window.location.search).get('school');
  const schoolDeepLink = schoolId && /^[0-9a-f-]{36}$/i.test(schoolId)
    ? `campusconnect://select-school?school=${encodeURIComponent(schoolId)}`
    : null;

  return (
    <main className="mobile-install-page">
      <section className="mobile-install-card">
        <span className="mobile-install-brand">CAMPUS CONNECT</span>
        <h1>School tools, ready when you are.</h1>
        <p>Download the official Android app and sign in with your existing Campus Connect account. Your school’s enabled modules and logo will appear after you sign in and choose your school.</p>
        {downloadAvailable
          ? <a className="mobile-install-download" href={apkDownloadUrl} rel="noreferrer">
              Download Android APK
            </a>
          : <p className="inline-warning" role="alert">The Android app download is not configured yet. Please contact your school administrator.</p>}
        {downloadAvailable && schoolDeepLink && <a className="mobile-install-download" href={schoolDeepLink}>Open Campus Connect and continue to your school</a>}
        <ol>
          <li>Download and open the APK on your Android device.</li>
          <li>If Android asks, allow your browser to install unknown apps, then confirm installation.</li>
          <li>Return here and tap “Open Campus Connect” to sign in and continue to your school.</li>
        </ol>
        <a className="mobile-install-web-link" href="/login">Already installed? Sign in on the web</a>
      </section>
    </main>
  );
}
