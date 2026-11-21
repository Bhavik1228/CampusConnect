import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { BarChart3, Calendar, GraduationCap, Plus, Pencil, Search, Send, Trash2, Users, CircleDollarSign } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type ReportLayout = 'classic' | 'modern' | 'minimal' | 'academic' | 'vibrant';

type ReportTemplate = {
  id: string;
  school_id: string;
  name: string;
  layout: ReportLayout;
  title: string;
  subtitle: string;
  accent_color: string;
  footer: string;
  created_by: string;
  created_at: string;
  profiles: { full_name: string | null } | null;
};

const layoutLabels: Record<ReportLayout, string> = {
  classic: 'Classic',
  modern: 'Modern',
  minimal: 'Minimal',
  academic: 'Academic',
  vibrant: 'Vibrant',
};

const reportTypes = [
  { key: 'students', label: 'Student records', icon: GraduationCap, description: 'Enrolment, class placement and contact information.' },
  { key: 'attendance', label: 'Attendance', icon: Calendar, description: 'Daily attendance, absences and register summaries.' },
  { key: 'academic', label: 'Academic results', icon: BarChart3, description: 'Grades, assessments and examination outcomes.' },
  { key: 'finance', label: 'Finance', icon: CircleDollarSign, description: 'Fees, invoices, payments and outstanding balances.' },
  { key: 'staff', label: 'Staff & directory', icon: Users, description: 'Staff records, roles and teaching assignments.' },
];

export function ReportsPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const isAdmin = activeMembership?.role === 'school_admin';
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ReportTemplate | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [layout, setLayout] = useState<ReportLayout>('classic');
  const [subtitle, setSubtitle] = useState('');
  const [accentColor, setAccentColor] = useState('#5147c7');
  const [footer, setFooter] = useState('');

  useEffect(() => {
    if (!schoolId) { setTemplates([]); setLoading(false); return; }
    let active = true;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const client = requireSupabase();
        const { data, error: queryError } = await client
          .from('school_report_templates')
          .select('id, school_id, name, layout, title, subtitle, accent_color, footer, created_by, created_at, profiles(full_name)')
          .eq('school_id', schoolId)
          .order('created_at', { ascending: false });
        if (queryError) throw queryError;
        if (active) setTemplates((data ?? []) as unknown as ReportTemplate[]);
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Report templates could not be loaded.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [schoolId]);

  const filtered = useMemo(() => templates.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()) || t.title.toLowerCase().includes(search.toLowerCase())), [templates, search]);

  async function saveTemplate(event: FormEvent) {
    event.preventDefault();
    if (!schoolId || !user) return;
    setFormError('');
    if (!name.trim()) { setFormError('Please enter a template name.'); return; }
    if (!title.trim()) { setFormError('Please enter a report title.'); return; }
    setSaving(true);
    try {
      const client = requireSupabase();
      const payload = {
        school_id: schoolId,
        name: name.trim(),
        layout,
        title: title.trim(),
        subtitle: subtitle.trim(),
        accent_color: accentColor,
        footer: footer.trim(),
        created_by: user.id,
      };
      if (editing) {
        const { error: updateError } = await client
          .from('school_report_templates')
          .update({ name: payload.name, layout: payload.layout, title: payload.title, subtitle: payload.subtitle, accent_color: payload.accent_color, footer: payload.footer })
          .eq('id', editing.id)
          .eq('school_id', schoolId);
        if (updateError) throw updateError;
        setNotice('Report template updated.');
      } else {
        const { error: insertError } = await client.from('school_report_templates').insert(payload);
        if (insertError) throw insertError;
        setNotice('Report template created.');
      }
      resetForm();
      setFormOpen(false);
      setEditing(null);
      setTimeout(() => { void loadTemplates(); }, 300);
    } catch (saveError) {
      setFormError(saveError instanceof Error ? saveError.message : 'The template could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  const loadTemplates = useCallback(() => {
    void (async () => {
      const client = requireSupabase();
      const { data, error: queryError } = await client
        .from('school_report_templates')
        .select('id, school_id, name, layout, title, subtitle, accent_color, footer, created_by, created_at, profiles(full_name)')
        .eq('school_id', schoolId)
        .order('created_at', { ascending: false });
      if (queryError) throw queryError;
      setTemplates((data ?? []) as unknown as ReportTemplate[]);
    })();
  }, [schoolId]);

  async function deleteTemplate(id: string) {
    if (!schoolId || !window.confirm('Delete this report template?')) return;
    setError('');
    try {
      const client = requireSupabase();
      const { error: deleteError } = await client.from('school_report_templates').delete().eq('id', id).eq('school_id', schoolId);
      if (deleteError) throw deleteError;
      setNotice('Report template deleted.');
      setTemplates((current) => current.filter((t) => t.id !== id));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'The template could not be deleted.');
    }
  }

  function resetForm() {
    setName(''); setTitle(''); setLayout('classic'); setSubtitle(''); setAccentColor('#5147c7'); setFooter(''); setFormError('');
  }

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Reports</span>
          <h1>Reports</h1>
          <p>Generate and manage school reports for students, attendance, academics, finance and staff.</p>
        </div>
        {isAdmin && <button className="button button-primary" type="button" onClick={() => { resetForm(); setEditing(null); setFormOpen(true); }}><Plus size={15} /> New report template</button>}
      </div>

      {error && <ErrorState message={error} />}
      {notice && <SuccessMessage message={notice} />}

      {loading ? <LoadingState label="Loading reports…" /> : (
        <section className="content-card" aria-label="Reports">
          <div className="section-heading"><div><span className="eyebrow">Report templates</span><h2>{templates.length} template{templates.length === 1 ? '' : 's'}</h2></div></div>

          <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <Search size={16} style={{ color: 'var(--muted)' }} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search templates…" style={{ flex: 1, padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--surface)', color: 'var(--ink)', fontSize: '0.875rem' }} />
          </label>

          {filtered.length === 0 ? (
            <EmptyState title="No report templates" detail={isAdmin ? 'Create your first report template to generate school reports.' : 'There are no report templates available for your school.'} />
          ) : (
            <div className="table-scroll"><table><thead><tr><th>Name</th><th>Layout</th><th>Title</th><th>Created by</th><th>Created</th><th /></tr></thead><tbody>
              {filtered.map((template) => (
                <tr key={template.id}>
                  <td><strong>{template.name}</strong><p style={{ margin: '4px 0 0', fontSize: '0.8125rem', color: 'var(--muted)' }}>{template.subtitle}</p></td>
                  <td><span className="layout-chip">{layoutLabels[template.layout]}</span></td>
                  <td>{template.title}</td>
                  <td>{template.profiles?.full_name ?? 'Unknown'}</td>
                  <td>{new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(new Date(template.created_at))}</td>
                  <td>
                    {isAdmin && (
                      <div className="action-row">
                        <button type="button" className="icon-button" title="Edit" onClick={() => { setEditing(template); setName(template.name); setTitle(template.title); setLayout(template.layout); setSubtitle(template.subtitle); setAccentColor(template.accent_color); setFooter(template.footer); setFormOpen(true); }}><Pencil size={14} /></button>
                        <button type="button" className="icon-button" title="Delete" onClick={() => void deleteTemplate(template.id)}><Trash2 size={14} /></button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody></table></div>
          )}

          <div className="report-type-grid" style={{ marginTop: 20 }}>
            <h3 style={{ fontSize: '0.875rem', fontWeight: 600, marginBottom: 10, color: 'var(--ink)' }}>Generate a report</h3>
            <div className="grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
              {reportTypes.map((type) => (
                <div key={type.key} className="content-card" style={{ padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}><type.icon size={16} style={{ color: 'var(--muted)' }} /><strong style={{ fontSize: '0.875rem' }}>{type.label}</strong></div>
                  <p style={{ fontSize: '0.8125rem', color: 'var(--muted)', margin: 0 }}>{type.description}</p>
                  <button type="button" className="button button-quiet" style={{ marginTop: 8, width: '100%', fontSize: '0.8125rem', padding: '6px 10px' }} disabled={!isAdmin} title={isAdmin ? undefined : 'School administrators manage report templates'}>Generate</button>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {isAdmin && (
        <section className="content-card" hidden={!formOpen} aria-label="Create or edit report template">
          <div className="section-heading"><div><span className="eyebrow">{editing ? 'Edit report template' : 'New report template'}</span><h2>{editing ? 'Edit report template' : 'New report template'}</h2></div></div>
          <form onSubmit={saveTemplate}>
            <div className="settings-fields settings-fields-spaced">
              <label className="field"><span>Template name</span><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={60} placeholder="e.g. End-of-term student report" /></label>
              <label className="field"><span>Report title</span><input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={100} placeholder="e.g. Student Progress Report" /></label>
              <label className="field"><span>Layout</span><select value={layout} onChange={(event) => setLayout(event.target.value as ReportLayout)}>
                {Object.entries(layoutLabels).map(([key, label]) => <option key={key} value={key as ReportLayout}>{label}</option>)}
              </select></label>
              <label className="field"><span>Subtitle</span><input value={subtitle} onChange={(event) => setSubtitle(event.target.value)} maxLength={160} placeholder="Optional subtitle" /></label>
              <label className="field"><span>Accent colour</span><input type="color" value={accentColor} onChange={(event) => setAccentColor(event.target.value)} /></label>
              <label className="field"><span>Footer</span><input value={footer} onChange={(event) => setFooter(event.target.value)} maxLength={200} placeholder="Optional footer text" /></label>
            </div>
            {formError && <ErrorState message={formError} />}
            <div className="settings-actions">
              <button type="button" className="button button-quiet" onClick={() => { resetForm(); setEditing(null); setFormOpen(false); }}>Cancel</button>
              <button type="submit" className="button button-primary" disabled={saving}><Send size={15} />{saving ? 'Saving…' : editing ? 'Update template' : 'Create template'}</button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
