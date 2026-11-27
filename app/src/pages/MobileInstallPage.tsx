import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';

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
    <main className="min-h-screen bg-surface cc-flex-col cc-flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-md">
        <div className="cc-flex items-center gap-3 mb-8">
          <ShieldCheck size={20} />
          <span className="font-bold text-lg cc-text-ink tracking-tight">Campus Connect</span>
        </div>
        <h1 className="cc-text-2xl cc-font-bold cc-leading-tight cc-text-ink mb-4">
          School tools, ready when you are.
        </h1>
        <p className="cc-text-sm cc-text-text leading-relaxed mb-8">
          Download the official Android app and sign in with your existing Campus Connect account. Your
          school's enabled modules and logo will appear after you sign in and choose your school.
        </p>

        {downloadAvailable ? (
          <a href={apkDownloadUrl} rel="noreferrer" className="btn-base btn-primary w-full py-3 mb-3">
            Download Android APK
          </a>
        ) : (
          <p className="cc-text-sm cc-text-danger mb-3" role="alert">
            The Android app download is not configured yet. Please contact your school administrator.
          </p>
        )}

        {downloadAvailable && schoolDeepLink && (
          <a href={schoolDeepLink} className="btn-base btn-quiet w-full py-3 mb-6">
            Open Campus Connect and continue to your school
          </a>
        )}

        <ol className="cc-text-sm cc-text-muted leading-relaxed mb-8 list-decimal list-inside gap-2">
          <li>Download and open the APK on your Android device.</li>
          <li>If Android asks, allow your browser to install unknown apps, then confirm installation.</li>
          <li>Return here and tap “Open Campus Connect” to sign in and continue to your school.</li>
        </ol>

        <Link to="/login" className="cc-text-sm cc-text-primary font-semibold hover:underline">
          Already installed? Sign in on the web
        </Link>
      </div>
    </main>
  );
}
