import { useEffect, useState, type FormEvent } from 'react';
import { Clock, Pencil, Plus, Send, Trash2, User, Users, ShieldCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';
import { resolveTimeZone } from '../lib/timezone';

type Audience = 'school' | 'class' | 'staff' | 'students' | 'parents';

type Announcement = {
  id: string;
  school_id: string;
  class_id: string | null;
  author_id: string;
  title: string;
  content: string;
  audience: Audience;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  profiles: { full_name: string | null; email: string | null } | null;
  school_class: { name: string } | null;
};

const audienceLabels: Record<Audience, string> = {
  school: 'Whole school',
  class: 'Specific class',
  staff: 'Staff only',
  students: 'Students only',
  parents: 'Parents only',
};

const audienceIcons: Record<Audience, React.ElementType> = {
  school: BuildingIcon,
  class: Users,
  staff: ShieldCheck,
  students: User,
  parents: User,
};

function BuildingIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 12V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v16l4-4h10a2 2 0 0 0 2-2Z" />
      <path d="M10 22h4" />
      <path d="M14 22h4" />
      <path d="M10 22v-4" />
      <path d="M14 22v-4" />
    </svg>
  );
}

export function AnnouncementsPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const schoolTimeZone = resolveTimeZone(activeMembership?.school.timezone);
  const canManage = activeMembership?.role === 'school_admin' || activeMembership?.role === 'teacher';
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [audience, setAudience] = useState<Audience>('school');
  const [classId, setClassId] = useState<string | null>(null);
  const [publishNow, setPublishNow] = useState(true);
  const [classes, setClasses] = useState<{ id: string; name: string }[]>([]);
  const [classesLoading, setClassesLoading] = useState(false);

  useEffect(() => {
    if (!schoolId) {
      setAnnouncements([]);
      setLoading(false);
      return;
    }
    let active = true;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const client = requireSupabase();
        const { data, error: queryError } = await client
          .from('announcements')
          .select(
            'id, school_id, class_id, author_id, title, content, audience, published_at, created_at, updated_at, profiles(full_name, email), school_class(name)',
          )
          .eq('school_id', schoolId)
          .order('created_at', { ascending: false });
        if (queryError) throw queryError;
        if (active) setAnnouncements((data ?? []) as unknown as Announcement[]);
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Announcements could not be loaded.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [schoolId, schoolTimeZone]);

  useEffect(() => {
    if (!schoolId || !canManage || audience !== 'class') {
      setClasses([]);
      return;
    }
    setClassesLoading(true);
    let active = true;
    async function loadClasses() {
      try {
        const client = requireSupabase();
        const { data, error: queryError } = await client
          .from('school_classes')
          .select('id, name')
          .eq('school_id', schoolId)
          .order('name');
        if (queryError) throw queryError;
        if (active) setClasses((data ?? []));
      } catch {
        if (active) setClasses([]);
      } finally {
        if (active) setClassesLoading(false);
      }
    }
    void loadClasses();
    return () => {
      active = false;
    };
  }, [schoolId, canManage, audience]);

  const statusLabel = (a: Announcement) => (a.published_at ? 'Published' : 'Draft');

  async function saveAnnouncement(event: FormEvent) {
    event.preventDefault();
    if (!schoolId || !user) return;
    setFormError('');
    if (!title.trim()) {
      setFormError('Please enter a title.');
      return;
    }
    if (!content.trim()) {
      setFormError('Please enter the announcement content.');
      return;
    }
    if (audience === 'class' && !classId) {
      setFormError('Please select a class.');
      return;
    }
    setSaving(true);
    try {
      const client = requireSupabase();
      const publishedAt = publishNow ? new Date().toISOString() : null;
      const payload = {
        school_id: schoolId,
        class_id: audience === 'class' ? classId : null,
        author_id: user.id,
        title: title.trim(),
        content: content.trim(),
        audience,
        published_at: publishedAt,
      };
      if (editing) {
        const { error: updateError } = await client
          .from('announcements')
          .update({
            title: payload.title,
            content: payload.content,
            audience: payload.audience,
            class_id: payload.class_id,
            published_at: payload.published_at,
          })
          .eq('id', editing.id)
          .eq('school_id', schoolId);
        if (updateError) throw updateError;
        setNotice(editing.published_at ? 'Announcement updated.' : 'Announcement updated and published.');
      } else {
        const { error: insertError } = await client.from('announcements').insert(payload);
        if (insertError) throw insertError;
        setNotice(publishNow ? 'Announcement published.' : 'Announcement saved as draft.');
      }
      resetForm();
      setFormOpen(false);
      setEditing(null);
      setTimeout(() => {
        void (async () => {
          const client = requireSupabase();
          const { data } = await client
            .from('announcements')
            .select('id')
            .eq('school_id', schoolId)
            .order('created_at', { ascending: false });
          if (data) setAnnouncements(data as unknown as Announcement[]);
        })();
      }, 400);
    } catch (saveError) {
      setFormError(saveError instanceof Error ? saveError.message : 'The announcement could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function publishAnnouncement(id: string, currentlyPublished: boolean) {
    if (!schoolId) return;
    setError('');
    try {
      const client = requireSupabase();
      const { error: updateError } = await client
        .from('announcements')
        .update({ published_at: currentlyPublished ? null : new Date().toISOString() })
        .eq('id', id)
        .eq('school_id', schoolId);
      if (updateError) throw updateError;
      setNotice(currentlyPublished ? 'Announcement unpublished.' : 'Announcement published.');
      setAnnouncements((current) =>
        current.map((a) => (a.id === id ? { ...a, published_at: currentlyPublished ? null : new Date().toISOString() } : a)),
      );
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : 'Could not update publication status.');
    }
  }

  async function deleteAnnouncement(id: string) {
    if (!schoolId || !window.confirm('Delete this announcement?')) return;
    setError('');
    try {
      const client = requireSupabase();
      const { error: deleteError } = await client.from('announcements').delete().eq('id', id).eq('school_id', schoolId);
      if (deleteError) throw deleteError;
      setNotice('Announcement deleted.');
      setAnnouncements((current) => current.filter((a) => a.id !== id));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'The announcement could not be deleted.');
    }
  }

  function resetForm() {
    setTitle('');
    setContent('');
    setAudience('school');
    setClassId(null);
    setPublishNow(true);
    setFormError('');
  }

  function formatDate(value: string | null) {
    if (!value) return '—';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  }

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <span className="eyebrow">School announcements</span>
          <h1>Announcements</h1>
          <p>Share updates with the school community, classes, staff, students, or parents.</p>
        </div>
        {canManage && (
          <button className="button button-primary" type="button" onClick={() => {
            resetForm();
            setEditing(null);
            setFormOpen(true);
          }}>
            <Plus size={15} /> New announcement
          </button>
        )}
      </div>

      {error && <ErrorState message={error} />}
      {notice && <SuccessMessage message={notice} />}

      {loading ? (
        <LoadingState label="Loading announcements…" />
      ) : (
        <section className="content-card" aria-label="Announcements">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Announcements</span>
              <h2>{announcements.length} announcement{announcements.length === 1 ? '' : 's'}</h2>
            </div>
          </div>

          {announcements.length === 0 ? (
            <EmptyState title="No announcements yet" detail="Create your first announcement to share updates with your school community." />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Audience</th>
                    <th>Author</th>
                    <th>Status</th>
                    <th>Published</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {announcements.map((announcement) => {
                    const AudienceIcon = audienceIcons[announcement.audience];
                    return (
                      <tr key={announcement.id}>
                        <td>
                          <strong>{announcement.title}</strong>
                          <p style={{ margin: '4px 0 0', fontSize: '0.8125rem', color: 'var(--muted)' }}>
                            {announcement.content.slice(0, 120)}{announcement.content.length > 120 ? '…' : ''}
                          </p>
                        </td>
                        <td>
                          <span className="audience-chip">
                            <AudienceIcon size={14} className="chip-icon" />
                            {audienceLabels[announcement.audience]}
                            {announcement.audience === 'class' && announcement.school_class ? ` · ${announcement.school_class.name}` : ''}
                          </span>
                        </td>
                        <td>{announcement.profiles?.full_name ?? 'Unknown'}</td>
                        <td>
                          <span className={`status-chip ${announcement.published_at ? 'published' : 'draft'}`}>
                            {statusLabel(announcement)}
                          </span>
                        </td>
                        <td>{formatDate(announcement.published_at)}</td>
                        <td>
                          {canManage && (
                            <div className="action-row">
                              <button
                                type="button"
                                className="icon-button"
                                title={announcement.published_at ? 'Unpublish' : 'Publish'}
                                onClick={() => void publishAnnouncement(announcement.id, !!announcement.published_at)}
                              >
                                <Clock size={14} />
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                title="Edit"
                                onClick={() => {
                                  setEditing(announcement);
                                  setTitle(announcement.title);
                                  setContent(announcement.content);
                                  setAudience(announcement.audience);
                                  setClassId(announcement.class_id);
                                  setPublishNow(!!announcement.published_at);
                                  setFormOpen(true);
                                }}
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                title="Delete"
                                onClick={() => void deleteAnnouncement(announcement.id)}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canManage && (
        <section className="content-card" hidden={!formOpen} aria-label="Create or edit announcement">
          <div className="section-heading">
            <div>
              <span className="eyebrow">{editing ? 'Edit announcement' : 'New announcement'}</span>
              <h2>{editing ? 'Edit announcement' : 'New announcement'}</h2>
            </div>
          </div>
          <form onSubmit={saveAnnouncement}>
            <div className="settings-fields settings-fields-spaced">
              <label className="field">
                <span>Title</span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} placeholder="e.g. School closure reminder" />
              </label>
              <label className="field">
                <span>Content</span>
                <textarea value={content} onChange={(event) => setContent(event.target.value)} required maxLength={4000} rows={5} placeholder="Write your announcement here…" />
              </label>
              <label className="field">
                <span>Audience</span>
                <select value={audience} onChange={(event) => setAudience(event.target.value as Audience)}>
                  {Object.entries(audienceLabels).map(([key, label]) => (
                    <option key={key} value={key as Audience}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {audience === 'class' && (
                <label className="field">
                  <span>Class</span>
                  <select value={classId ?? ''} onChange={(event) => setClassId(event.target.value || null)} disabled={classesLoading} required>
                    <option value="">Select a class</option>
                    {classes.map((klass) => (
                      <option key={klass.id} value={klass.id}>{klass.name}</option>
                    ))}
                  </select>
                  {classesLoading && <span style={{ fontSize: '0.8125rem', color: 'var(--muted)' }}> Loading…</span>}
                </label>
              )}
              <label className="field">
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={publishNow} onChange={(event) => setPublishNow(event.target.checked)} />
                  {publishNow ? 'Publish immediately' : 'Save as draft'}
                </span>
              </label>
            </div>
            {formError && <ErrorState message={formError} />}
            <div className="settings-actions">
              <button type="button" className="button button-quiet" onClick={() => {
                resetForm();
                setEditing(null);
                setFormOpen(false);
              }}>
                Cancel
              </button>
              <button type="submit" className="button button-primary" disabled={saving}>
                <Send size={15} /> {saving ? 'Saving…' : editing ? 'Update announcement' : 'Publish announcement'}
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
