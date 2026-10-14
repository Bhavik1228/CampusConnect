import { SystemOwnerSchoolsPanel } from './SystemOwnerSchoolsPanel';

export function SystemOwnerSchoolsPage() {
  return <main className="system-owner-page">
    <header className="system-owner-header"><div><span className="eyebrow">Platform administration</span><h1>School management</h1><p>Review, register, configure and administer every school on Campus Connect.</p></div></header>
    <SystemOwnerSchoolsPanel />
  </main>;
}
