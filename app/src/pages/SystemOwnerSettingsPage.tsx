import { SystemOwnerPlatformSettingsPanel } from './SystemOwnerPlatformSettingsPanel';

export function SystemOwnerSettingsPage() {
  return <main className="system-owner-page">
    <header className="system-owner-header"><div><span className="eyebrow">Platform configuration</span><h1>Platform settings</h1><p>Manage global branding, regional defaults, feature access and notifications.</p></div></header>
    <SystemOwnerPlatformSettingsPanel />
  </main>;
}
