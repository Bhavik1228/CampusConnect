import { useState, type FormEvent } from 'react';
import { ArrowRight, Building2, LogOut } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

export function SchoolSetup() {
  const { user, createSchool, signOut } = useAuth();
  const [schoolName, setSchoolName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await createSchool(schoolName);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create the school workspace.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="setup-page">
      <header className="setup-header"><a className="brand" href="#"><span className="brand-mark"><Building2 size={19} /></span><span>Campus Connect</span></a><button className="button button-quiet" onClick={() => void signOut()}><LogOut size={16} /> Sign out</button></header>
      <form className="setup-card" onSubmit={submit}>
        <span className="setup-icon"><Building2 size={24} /></span>
        <span className="eyebrow">Your school workspace</span>
        <h1>Set up your school</h1>
        <p>Welcome{user?.user_metadata.full_name ? `, ${user.user_metadata.full_name}` : ''}. Add your school name to create a private workspace. You can manage your school's information once setup is complete.</p>
        <label className="field"><span>School name</span><input autoFocus required maxLength={120} value={schoolName} onChange={(event) => setSchoolName(event.target.value)} placeholder="Enter the official school name" /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary full-width" disabled={busy} type="submit">{busy ? 'Creating workspace…' : 'Create school workspace'}{!busy && <ArrowRight size={17} />}</button>
        <p className="setup-footnote">Only the signed-in account can manage this workspace unless you invite additional users.</p>
      </form>
    </main>
  );
}
