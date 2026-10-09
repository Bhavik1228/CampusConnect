interface AuthErrorDetails {
  message?: string;
  code?: string;
  status?: number;
}

export function getAuthErrorMessage(error: unknown): string {
  if (error instanceof TypeError) {
    return 'Campus Connect could not reach Supabase. Check your internet connection and confirm that VITE_SUPABASE_URL points to an active Supabase project.';
  }

  if (!error || typeof error !== 'object') {
    return 'Unable to complete authentication. Please try again.';
  }

  const details = error as AuthErrorDetails;
  const message = details.message?.toLowerCase() ?? '';
  const code = details.code?.toLowerCase() ?? '';

  if (
    code === 'invalid_credentials' ||
    message.includes('invalid login credentials')
  ) {
    return 'The email or password is incorrect.';
  }
  if (code === 'email_not_confirmed' || message.includes('email not confirmed')) {
    return 'Confirm your email address using the link we sent, then sign in.';
  }
  if (
    code === 'user_already_exists' ||
    code === 'email_exists' ||
    message.includes('user already registered')
  ) {
    return 'An account already exists for this email. Sign in or request a password reset.';
  }
  if (details.status === 429) {
    return 'Too many authentication attempts. Wait a few minutes, then try again.';
  }
  if (
    message.includes('failed to fetch') ||
    message.includes('fetch failed') ||
    message.includes('networkerror') ||
    message.includes('err_name_not_resolved') ||
    message.includes('enotfound')
  ) {
    return 'Campus Connect could not reach Supabase. Verify the project URL in app/.env, make sure the project is active, and check your network connection.';
  }
  if (message.includes('invalid api key') || details.status === 401) {
    return 'Supabase rejected the public API key. Check VITE_SUPABASE_ANON_KEY in app/.env.';
  }
  if (details.message) return details.message;
  return 'Unable to complete authentication. Please try again.';
}
