import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { isSupabaseConfigured, requireSupabase } from '../lib/supabase';

type PlatformBranding = {
  platformName: string;
  logoUrl: string;
  faviconUrl: string;
  maintenanceNotice: string;
  maintenanceActive: boolean;
  maintenanceReadOnly: boolean;
};

const defaultBranding: PlatformBranding = {
  platformName: 'Campus Connect',
  logoUrl: '',
  faviconUrl: '',
  maintenanceNotice: '',
  maintenanceActive: false,
  maintenanceReadOnly: false,
};

const PlatformBrandingContext = createContext(defaultBranding);

export function PlatformBrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState(defaultBranding);

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    let active = true;
    async function loadBranding() {
      try {
        const { data, error } = await requireSupabase().rpc('platform_public_branding');
        if (error) throw error;
        if (!data || typeof data.platform_name !== 'string') throw new Error('Platform branding returned an invalid response.');
        if (active) {
          setBranding({
            platformName: data.platform_name,
            logoUrl: typeof data.logo_url === 'string' ? data.logo_url : '',
            faviconUrl: typeof data.favicon_url === 'string' ? data.favicon_url : '',
            maintenanceNotice: typeof data.maintenance_notice === 'string' ? data.maintenance_notice : '',
            maintenanceActive: data.maintenance_active === true,
            maintenanceReadOnly: data.maintenance_read_only === true,
          });
        }
      } catch (error) {
        console.error('Could not load platform branding.', error);
      }
    }
    const refresh = () => { void loadBranding(); };
    refresh();
    window.addEventListener('platform-branding-updated', refresh);
    const timer = window.setInterval(refresh, 20_000);
    return () => {
      active = false;
      window.removeEventListener('platform-branding-updated', refresh);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    document.title = branding.platformName;
    let favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (!favicon) {
      favicon = document.createElement('link');
      favicon.rel = 'icon';
      document.head.append(favicon);
    }
    if (branding.faviconUrl) favicon.href = branding.faviconUrl;
  }, [branding]);

  return <PlatformBrandingContext.Provider value={branding}>{children}</PlatformBrandingContext.Provider>;
}

export function usePlatformBranding() {
  return useContext(PlatformBrandingContext);
}
