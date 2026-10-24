import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Globe, RefreshCw, Send, ShieldCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState, LoadingState, SuccessMessage } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type DraftStatus = 'draft' | 'pending_review' | 'published' | 'rejected';
interface Website {
  slug: string;
  hero_title: string;
  hero_message: string;
  about_title: string;
  about_text: string;
  admissions_title: string;
  admissions_text: string;
  admission_requirements: string;
}
interface ContentVersion {
  id: string;
  content: Website;
  status: DraftStatus;
  editor_id: string;
  publisher_id: string | null;
  review_note: string;
  created_at: string;
  updated_at: string;
}

const emptyWebsite: Website = {
  slug: '',
  hero_title: '',
  hero_message: '',
  about_title: '',
  about_text: '',
  admissions_title: '',
  admissions_text: '',
  admission_requirements: '',
};

const statusLabels: Record<DraftStatus, string> = {
  draft: 'Draft',
  pending_review: 'Awaiting publisher review',
  published: 'Published',
  rejected: 'Returned for editing',
};

export function WebsiteManagementPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const role = activeMembership?.role;
  const isPublisher = role === 'school_admin' || role === 'website_publisher';
  const canEditDraft = role === 'school_admin' || role === 'website_editor';
  const canAccess = isPublisher || canEditDraft;
  const [website, setWebsite] = useState<Website | null>(null);
  const [versions, setVersions] = useState<ContentVersion[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [content, setContent] = useState<Website>(emptyWebsite);
  const [reviewNote, setReviewNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showDraftPreview, setShowDraftPreview] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const selected = versions.find((version) => version.id === selectedId) ?? null;

  const load = useCallback(async () => {
    if (!schoolId || !canAccess) {
      setWebsite(null);
      setVersions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [websiteResult, versionsResult] = await Promise.all([
        client.from('school_websites')
          .select('slug,hero_title,hero_message,about_title,about_text,admissions_title,admissions_text,admission_requirements')
          .eq('school_id', schoolId).maybeSingle(),
        client.from('school_website_content_versions')
          .select('id,content,status,editor_id,publisher_id,review_note,created_at,updated_at')
          .eq('school_id', schoolId).order('updated_at', { ascending: false }),
      ]);
      if (websiteResult.error) throw websiteResult.error;
      if (versionsResult.error) throw versionsResult.error;
      setWebsite((websiteResult.data as Website | null) ?? null);
      const rows = (versionsResult.data ?? []) as ContentVersion[];
      setVersions(rows);
      setSelectedId((current) => current && rows.some((version) => version.id === current) ? current : rows[0]?.id ?? '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load website drafts.');
    } finally {
      setLoading(false);
    }
  }, [canAccess, schoolId]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => {
    if (selected) {
      setContent(selected.content);
      setReviewNote(selected.review_note);
    } else {
      setContent(website ?? emptyWebsite);
      setReviewNote('');
    }
  }, [selected, website]);

  function updateField<K extends keyof Website>(key: K, value: Website[K]) {
    setContent((current) => ({ ...current, [key]: value }));
  }

  async function saveDraft(submitForReview: boolean) {
    if (!schoolId || !user || !canEditDraft) return;
    if (!website) {
      setError('Ask a school administrator to configure the public school website before creating a draft.');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const values = { ...content, slug: website.slug };
      if (selected && selected.status !== 'rejected' && selected.status !== 'draft') {
        throw new Error('Only a draft or a returned draft can be edited.');
      }
      if (selected) {
        const { error: updateError } = await requireSupabase().from('school_website_content_versions')
          .update({
            content: values,
            status: submitForReview ? 'pending_review' : 'draft',
            review_note: '',
            updated_at: new Date().toISOString(),
          })
          .eq('school_id', schoolId).eq('id', selected.id);
        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await requireSupabase().from('school_website_content_versions').insert({
          school_id: schoolId,
          content: values,
          status: submitForReview ? 'pending_review' : 'draft',
          editor_id: user.id,
        });
        if (insertError) throw insertError;
      }
      setSuccess(submitForReview ? 'Draft submitted to a website publisher for approval.' : 'Website draft saved.');
      setRefreshKey((key) => key + 1);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the website draft.');
    } finally {
      setSaving(false);
    }
  }

  async function reviewDraft(publish: boolean) {
    if (!schoolId || !selected || !isPublisher) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      if (publish) {
        const { error: publishError } = await requireSupabase().rpc('publish_school_website_content', {
          target_version: selected.id,
          publisher_note: reviewNote.trim(),
        });
        if (publishError) throw publishError;
      } else {
        const { error: reviewError } = await requireSupabase().rpc('review_school_website_content', {
          target_version: selected.id,
          approved: false,
          publisher_note: reviewNote.trim(),
        });
        if (reviewError) throw reviewError;
      }
      setSuccess(publish ? 'Website content approved and published.' : 'Draft returned to its editor with review notes.');
      setRefreshKey((key) => key + 1);
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Could not review this website draft.');
    } finally {
      setSaving(false);
    }
  }

  if (!canAccess) return <div className="page-stack"><ErrorState message="Your school role cannot manage website content." /></div>;

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div><span className="eyebrow">School website</span><h1>Website content</h1><p>Editors save drafts; publishers review and publish them to the public school site.</p></div>
        <button className="button button-quiet" type="button" onClick={() => setRefreshKey((key) => key + 1)} disabled={loading}><RefreshCw size={14} />Refresh</button>
      </div>
      {error && <ErrorState message={error} />}
      {success && <SuccessMessage message={success} />}
      {loading ? <LoadingState label="Loading school website drafts…" /> : !website
        ? <section className="content-card"><ErrorState message="The public school website has not been configured yet. Ask a school administrator to set it up in School Settings." /></section>
        : <>
          <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">Review queue</span><h2>Content drafts</h2></div><Globe size={18} className="muted-icon" /></div>
            <div className="settings-actions">
              <label className="field"><span>Select a draft</span><select value={selectedId} disabled={!canEditDraft} onChange={(event) => setSelectedId(event.target.value)}>
                {canEditDraft && <option value="">Create a new draft</option>}
                {versions.map((version) => <option key={version.id} value={version.id}>{statusLabels[version.status]} · {new Date(version.updated_at).toLocaleString()}</option>)}
              </select></label>
              <a className="button button-quiet" href={`/school/${website.slug}`} target="_blank" rel="noreferrer"><ExternalLink size={14} />Preview published site</a>
            </div>
            {selected && <p className="settings-readonly">Draft status: {statusLabels[selected.status]}{selected.review_note ? ` · Publisher note: ${selected.review_note}` : ''}</p>}
          </section>
          <section className="content-card">
            <div className="section-heading"><div><span className="eyebrow">Website content</span><h2>{selected ? 'Edit draft' : 'New draft'}</h2></div></div>
            <div className="settings-actions">
              <button className="button button-quiet" type="button" onClick={() => setShowDraftPreview((visible) => !visible)}>
                {showDraftPreview ? 'Hide draft preview' : 'Preview draft'}
              </button>
            </div>
            {showDraftPreview && <section className="content-card" aria-label="Draft website preview">
              <span className="eyebrow">{website.slug}</span>
              <h2>{content.hero_title || 'Homepage headline'}</h2>
              <p>{content.hero_message || 'Welcome message preview'}</p>
              <h3>{content.about_title || 'About section title'}</h3>
              <p>{content.about_text || 'About section preview'}</p>
              <h3>{content.admissions_title || 'Admissions section title'}</h3>
              <p>{content.admissions_text || 'Admissions information preview'}</p>
              <p><strong>Admission requirements</strong><br />{content.admission_requirements || 'Requirements preview'}</p>
            </section>}
            <div className="settings-fields">
              <label className="field"><span>Homepage headline</span><input maxLength={140} value={content.hero_title} disabled={!canEditDraft || saving || Boolean(selected && !['draft', 'rejected'].includes(selected.status))} onChange={(event) => updateField('hero_title', event.target.value)} /></label>
              <label className="field"><span>About section title</span><input maxLength={100} value={content.about_title} disabled={!canEditDraft || saving || Boolean(selected && !['draft', 'rejected'].includes(selected.status))} onChange={(event) => updateField('about_title', event.target.value)} /></label>
              <label className="field"><span>Welcome message</span><textarea rows={3} maxLength={1000} value={content.hero_message} disabled={!canEditDraft || saving || Boolean(selected && !['draft', 'rejected'].includes(selected.status))} onChange={(event) => updateField('hero_message', event.target.value)} /></label>
              <label className="field"><span>About your school</span><textarea rows={5} maxLength={3000} value={content.about_text} disabled={!canEditDraft || saving || Boolean(selected && !['draft', 'rejected'].includes(selected.status))} onChange={(event) => updateField('about_text', event.target.value)} /></label>
              <label className="field"><span>Admissions section title</span><input maxLength={100} value={content.admissions_title} disabled={!canEditDraft || saving || Boolean(selected && !['draft', 'rejected'].includes(selected.status))} onChange={(event) => updateField('admissions_title', event.target.value)} /></label>
              <label className="field"><span>Admissions information</span><textarea rows={4} maxLength={3000} value={content.admissions_text} disabled={!canEditDraft || saving || Boolean(selected && !['draft', 'rejected'].includes(selected.status))} onChange={(event) => updateField('admissions_text', event.target.value)} /></label>
              <label className="field"><span>Admission requirements</span><textarea rows={3} maxLength={3000} value={content.admission_requirements} disabled={!canEditDraft || saving || Boolean(selected && !['draft', 'rejected'].includes(selected.status))} onChange={(event) => updateField('admission_requirements', event.target.value)} /></label>
            </div>
            {canEditDraft && (!selected || ['draft', 'rejected'].includes(selected.status)) && <div className="settings-actions">
              <button className="button button-quiet" type="button" onClick={() => void saveDraft(false)} disabled={saving}>Save draft</button>
              <button className="button button-primary" type="button" onClick={() => void saveDraft(true)} disabled={saving}><Send size={14} />Submit for approval</button>
            </div>}
            {selected?.status === 'pending_review' && isPublisher && <div className="settings-actions">
              <label className="field"><span>Review note</span><textarea rows={2} maxLength={1000} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} /></label>
              <button className="button button-quiet" type="button" onClick={() => void reviewDraft(false)} disabled={saving}><ShieldCheck size={14} />Return to editor</button>
              <button className="button button-primary" type="button" onClick={() => void reviewDraft(true)} disabled={saving}>Approve &amp; publish</button>
            </div>}
          </section>
        </>}
    </div>
  );
}
