import { useEffect, useState, type FormEvent } from 'react';
import { Save } from 'lucide-react';
import { ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type PlatformSettings = {
  platform_name: string;
  logo_url: string;
  favicon_url: string;
  contact_email: string;
  contact_phone: string;
  default_language: string;
  default_timezone: string;
  default_date_format: string;
  supported_school_types: string[];
  default_academic_configuration: { academicYearStartMonth: number; academicYearStartDay: number; termCount: number };
  global_feature_availability: Record<string, boolean>;
  maintenance_notice: string;
  default_notification_settings: { email: boolean; inApp: boolean; maintenanceNotices: boolean };
};

const schoolTypes = [
  ['primary', 'Primary'], ['secondary', 'Secondary'], ['k12', 'K-12'],
  ['university', 'University'], ['other', 'Other'],
];
const globalFeatures = [
  ['attendance', 'Attendance'], ['timetable', 'Timetable'], ['learning', 'Learning'],
  ['assignments', 'Assignments'], ['grades', 'Grades and results'], ['finance', 'Finance'],
  ['messaging', 'Messaging'], ['admissions', 'Admissions'], ['mobile_app', 'Android app access'],
];
const dateFormats = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY'];

const defaultSettings: PlatformSettings = {
  platform_name: 'Campus Connect',
  logo_url: '',
  favicon_url: '',
  contact_email: '',
  contact_phone: '',
  default_language: 'en',
  default_timezone: 'UTC',
  default_date_format: 'YYYY-MM-DD',
  supported_school_types: schoolTypes.map(([value]) => value),
  default_academic_configuration: { academicYearStartMonth: 9, academicYearStartDay: 1, termCount: 3 },
  global_feature_availability: Object.fromEntries(globalFeatures.map(([key]) => [key, true])),
  maintenance_notice: '',
  default_notification_settings: { email: true, inApp: true, maintenanceNotices: true },
};

export function SystemOwnerPlatformSettingsPanel() {
  const [settings, setSettings] = useState<PlatformSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    async function loadSettings() {
      setLoading(true);
      setError('');
      try {
        const { data, error: loadError } = await requireSupabase().functions.invoke('system-owner-admin', {
          body: { action: 'get-platform-settings' },
        });
        if (loadError) throw loadError;
        if (!data?.settings) throw new Error('The platform settings service returned an invalid response.');
        const value = data.settings as Partial<PlatformSettings>;
        if (active) setSettings({
          ...defaultSettings,
          ...value,
          supported_school_types: Array.isArray(value.supported_school_types) ? value.supported_school_types : defaultSettings.supported_school_types,
          default_academic_configuration: { ...defaultSettings.default_academic_configuration, ...value.default_academic_configuration },
          global_feature_availability: { ...defaultSettings.global_feature_availability, ...value.global_feature_availability },
          default_notification_settings: { ...defaultSettings.default_notification_settings, ...value.default_notification_settings },
        });
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load platform settings.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadSettings();
    return () => { active = false; };
  }, []);

  function updateSetting<K extends keyof PlatformSettings>(key: K, value: PlatformSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function toggleSchoolType(type: string) {
    updateSetting('supported_school_types', settings.supported_school_types.includes(type)
      ? settings.supported_school_types.filter((item) => item !== type)
      : [...settings.supported_school_types, type]);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { error: saveError } = await requireSupabase().functions.invoke('system-owner-admin', {
        body: { action: 'save-platform-settings', settings },
      });
      if (saveError) throw saveError;
      window.dispatchEvent(new Event('platform-branding-updated'));
      setNotice('Platform settings saved.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save platform settings.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <section className="content-card system-owner-panel"><LoadingState label="Loading platform settings…" /></section>;

  return (
    <form className="content-card system-owner-panel system-owner-settings-form" onSubmit={(event) => void save(event)}>
      <div className="system-owner-panel-heading"><div><span className="eyebrow">Platform configuration</span><h2>Branding and global defaults</h2><p>These defaults apply to Campus Connect and new school profiles. School-specific values may still be set individually.</p></div></div>
      {error && <ErrorState message={error} />}
      {notice && <p className="inline-success" role="status">{notice}</p>}

      <section className="system-owner-settings-section">
        <h3>Platform name and branding</h3>
        <div className="settings-fields">
          <label className="field"><span>Platform name</span><input required minLength={2} maxLength={120} value={settings.platform_name} onChange={(event) => updateSetting('platform_name', event.target.value)} /></label>
          <label className="field"><span>Logo URL</span><input type="url" maxLength={2000} value={settings.logo_url} onChange={(event) => updateSetting('logo_url', event.target.value)} placeholder="https://…" /></label>
          <label className="field"><span>Favicon URL</span><input type="url" maxLength={2000} value={settings.favicon_url} onChange={(event) => updateSetting('favicon_url', event.target.value)} placeholder="https://…" /></label>
        </div>
      </section>

      <section className="system-owner-settings-section">
        <h3>Platform contact information</h3>
        <div className="settings-fields">
          <label className="field"><span>Support email</span><input type="email" maxLength={320} value={settings.contact_email} onChange={(event) => updateSetting('contact_email', event.target.value)} /></label>
          <label className="field"><span>Support phone</span><input maxLength={40} value={settings.contact_phone} onChange={(event) => updateSetting('contact_phone', event.target.value)} /></label>
        </div>
      </section>

      <section className="system-owner-settings-section">
        <h3>Default language and regional settings</h3>
        <div className="settings-fields">
          <label className="field"><span>Default language code</span><input required maxLength={20} value={settings.default_language} onChange={(event) => updateSetting('default_language', event.target.value)} /></label>
          <label className="field"><span>Default time zone</span><input required maxLength={100} value={settings.default_timezone} onChange={(event) => updateSetting('default_timezone', event.target.value)} placeholder="UTC or Europe/London" /></label>
          <label className="field"><span>Date format</span><select value={settings.default_date_format} onChange={(event) => updateSetting('default_date_format', event.target.value)}>{dateFormats.map((format) => <option key={format} value={format}>{format}</option>)}</select></label>
        </div>
      </section>

      <section className="system-owner-settings-section">
        <h3>Supported school types</h3>
        <div className="system-owner-check-grid">{schoolTypes.map(([value, label]) => <label key={value}><input type="checkbox" checked={settings.supported_school_types.includes(value)} onChange={() => toggleSchoolType(value)} />{label}</label>)}</div>
      </section>

      <section className="system-owner-settings-section">
        <h3>Default academic configuration</h3>
        <div className="settings-fields">
          <label className="field"><span>Academic year start month</span><select value={settings.default_academic_configuration.academicYearStartMonth} onChange={(event) => updateSetting('default_academic_configuration', { ...settings.default_academic_configuration, academicYearStartMonth: Number(event.target.value) })}>{Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={index + 1}>{new Date(2026, index).toLocaleString(undefined, { month: 'long' })}</option>)}</select></label>
          <label className="field"><span>Academic year start day</span><input type="number" min={1} max={28} value={settings.default_academic_configuration.academicYearStartDay} onChange={(event) => updateSetting('default_academic_configuration', { ...settings.default_academic_configuration, academicYearStartDay: Number(event.target.value) })} /></label>
          <label className="field"><span>Terms per academic year</span><input type="number" min={1} max={6} value={settings.default_academic_configuration.termCount} onChange={(event) => updateSetting('default_academic_configuration', { ...settings.default_academic_configuration, termCount: Number(event.target.value) })} /></label>
        </div>
      </section>

      <section className="system-owner-settings-section">
        <h3>Global feature availability</h3>
        <p className="system-owner-muted">This controls which modules are available to schools; school administrators can’t enable features disabled platform-wide.</p>
        <div className="system-owner-check-grid">{globalFeatures.map(([key, label]) => <label key={key}><input type="checkbox" checked={settings.global_feature_availability[key] !== false} onChange={(event) => updateSetting('global_feature_availability', { ...settings.global_feature_availability, [key]: event.target.checked })} />{label}</label>)}</div>
      </section>

      <section className="system-owner-settings-section">
        <h3>Maintenance notice</h3>
        <label className="field"><span>Notice shown to users when maintenance is planned</span><textarea rows={4} maxLength={2000} value={settings.maintenance_notice} onChange={(event) => updateSetting('maintenance_notice', event.target.value)} placeholder="Leave blank when there is no active notice." /></label>
      </section>

      <section className="system-owner-settings-section">
        <h3>Default notifications</h3>
        <div className="system-owner-check-grid">{([
          ['email', 'Email notifications'],
          ['inApp', 'In-app notifications'],
          ['maintenanceNotices', 'Maintenance notices'],
        ] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={settings.default_notification_settings[key]} onChange={(event) => updateSetting('default_notification_settings', { ...settings.default_notification_settings, [key]: event.target.checked })} />{label}</label>)}</div>
      </section>

      <div className="settings-actions"><button className="button button-primary" disabled={saving}><Save size={15} /> {saving ? 'Saving…' : 'Save platform settings'}</button></div>
    </form>
  );
}
