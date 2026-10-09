import { supabase } from './supabase';

type LoginAlertAction = 'login_succeeded' | 'login_failed';

export function notifyLoginAlert(action: LoginAlertAction, email?: string) {
  if (!supabase) return;

  void supabase.functions
    .invoke('login-alert', { body: { action, ...(email ? { email } : {}) } })
    .then(({ error }) => {
      if (error) {
        console.error('Campus Connect could not send a login security notification.', error.message);
      }
    })
    .catch((error: unknown) => {
      console.error('Campus Connect could not send a login security notification.', error);
    });
}
