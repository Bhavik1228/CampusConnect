import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  BookOpen, Download, Eye, FileText, Film, Filter, FolderOpen, Pencil, Search,
  Trash2, UploadCloud, X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

type Material = {
  id: string;
  school_id: string;
  class_id: string;
  subject_id: string | null;
  uploaded_by: string;
  title: string;
  description: string | null;
  topic: string;
  storage_path: string;
  storage_provider: 'r2' | 'supabase';
  storage_connection_id: string | null;
  mime_type: string | null;
  file_size: number | null;
  file_name: string | null;
  visibility: 'class' | 'school';
  is_uploaded: boolean;
  is_published: boolean;
  created_at: string;
  subject: { name: string } | null;
  school_class: { name: string } | null;
};
type SchoolClass = { id: string; name: string };
type Subject = { id: string; name: string };
type TeacherProfile = { id: string };
type UploadForm = {
  title: string;
  description: string;
  topic: string;
  class_id: string;
  subject_id: string;
  visibility: 'class' | 'school';
  is_published: boolean;
  storage_connection_id: string;
};
type StorageConnection = { id: string; label: string };
type Preview = { material: Material; url: string };

const MAX_FILE_SIZE = 500 * 1024 * 1024;
const fileTypes: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};
const emptyForm: UploadForm = {
  title: '',
  description: '',
  topic: '',
  class_id: '',
  subject_id: '',
  visibility: 'class',
  is_published: false,
  storage_connection_id: '',
};

function fileType(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return fileTypes[extension] ?? file.type;
}

function readableSize(size: number | null) {
  if (!size || size < 0) return 'Size unavailable';
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(size >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function LearningMaterialsPage() {
  const { activeMembership, user } = useAuth();
  const schoolId = activeMembership?.school_id;
  const role = activeMembership?.role;
  const canUpload = role === 'school_admin' || role === 'academic_coordinator' || role === 'teacher';
  const [materials, setMaterials] = useState<Material[]>([]);
  const [classes, setClasses] = useState<SchoolClass[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [storageConnections, setStorageConnections] = useState<StorageConnection[]>([]);
  const [managedStorageAvailable, setManagedStorageAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [editingMaterial, setEditingMaterial] = useState<Material | null>(null);
  const [editForm, setEditForm] = useState<UploadForm>(emptyForm);
  const [form, setForm] = useState<UploadForm>(emptyForm);
  const [query, setQuery] = useState('');
  const [classFilter, setClassFilter] = useState('');
  const [subjectFilter, setSubjectFilter] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);

  const load = useCallback(async () => {
    if (!schoolId || !user) return;
    setLoading(true);
    setError('');
    try {
      const client = requireSupabase();
      const [materialResult, classResult, subjectResult, storageResult] = await Promise.all([
        client.from('learning_materials')
          .select('id,school_id,class_id,subject_id,uploaded_by,title,description,topic,storage_path,storage_provider,storage_connection_id,mime_type,file_size,file_name,visibility,is_uploaded,is_published,created_at,subject:subjects(name),school_class:school_classes(name)')
          .eq('school_id', schoolId).order('created_at', { ascending: false }),
        client.from('school_classes').select('id,name').eq('school_id', schoolId).order('name'),
        client.from('subjects').select('id,name').eq('school_id', schoolId).order('name'),
        canUpload
          ? client.functions.invoke('learning-material-storage', { body: { action: 'list-connections', schoolId } })
          : Promise.resolve({ data: null, error: null }),
      ]);
      if (materialResult.error) throw materialResult.error;
      if (classResult.error) throw classResult.error;
      if (subjectResult.error) throw subjectResult.error;
      if (storageResult.error) throw storageResult.error;

      let allowedClasses = (classResult.data ?? []) as SchoolClass[];
      let allowedSubjects = (subjectResult.data ?? []) as Subject[];
      if (role === 'teacher') {
        const { data: profiles, error: profileError } = await client.from('teacher_profiles')
          .select('id').eq('school_id', schoolId).eq('profile_id', user.id);
        if (profileError) throw profileError;
        const teacherIds = ((profiles ?? []) as TeacherProfile[]).map((profile) => profile.id);
        if (!teacherIds.length) {
          allowedClasses = [];
          allowedSubjects = [];
        } else {
          const [classAssignments, subjectAssignments] = await Promise.all([
            client.from('teacher_class_assignments').select('class_id').eq('school_id', schoolId).in('teacher_id', teacherIds),
            client.from('teacher_subjects').select('subject_id').eq('school_id', schoolId).in('teacher_id', teacherIds),
          ]);
          if (classAssignments.error) throw classAssignments.error;
          if (subjectAssignments.error) throw subjectAssignments.error;
          const classIds = new Set((classAssignments.data ?? []).map((assignment) => assignment.class_id));
          const subjectIds = new Set((subjectAssignments.data ?? []).map((assignment) => assignment.subject_id));
          allowedClasses = allowedClasses.filter((schoolClass) => classIds.has(schoolClass.id));
          allowedSubjects = allowedSubjects.filter((subject) => subjectIds.has(subject.id));
        }
      }
      setMaterials((materialResult.data ?? []) as unknown as Material[]);
      setClasses(allowedClasses);
      setSubjects(allowedSubjects);
      const storageData = storageResult.data as { connections?: StorageConnection[]; managedStorageAvailable?: boolean } | null;
      setStorageConnections(storageData?.connections ?? []);
      setManagedStorageAvailable(storageData?.managedStorageAvailable === true);
    } catch (loadError) {
      setError(errorMessage(loadError, 'Could not load learning materials.'));
    } finally {
      setLoading(false);
    }
  }, [schoolId, user, role, refreshKey, canUpload]);

  useEffect(() => { void load(); }, [load]);

  const filteredMaterials = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return materials.filter((material) => {
      const matchesQuery = !needle || [
        material.title, material.description ?? '', material.topic, material.file_name ?? '',
        material.subject?.name ?? '', material.school_class?.name ?? '',
      ].join(' ').toLocaleLowerCase().includes(needle);
      return matchesQuery
        && (!classFilter || material.class_id === classFilter)
        && (!subjectFilter || material.subject_id === subjectFilter);
    });
  }, [materials, query, classFilter, subjectFilter]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !user) return;
    const formElement = event.currentTarget;
    const file = new FormData(formElement).get('resource_file');
    if (!(file instanceof File) || file.size === 0) {
      setError('Choose a PDF, document, presentation, or video to upload.');
      return;
    }
    const mimeType = fileType(file);
    if (!Object.values(fileTypes).includes(mimeType)) {
      setError('This file type is not supported. Use PDF, DOC/DOCX, PPT/PPTX, XLS/XLSX, TXT, MP4, WEBM, or MOV.');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setError('Learning materials must be 500 MB or smaller.');
      return;
    }
    if (!form.class_id || !form.subject_id) {
      setError('Choose the class and subject for this resource.');
      return;
    }
    if (!managedStorageAvailable && storageConnections.length === 0) {
      setError('No R2 storage is configured. Ask the school administrator to add a bucket or contact Campus Connect to request managed storage.');
      return;
    }

    setUploading(true);
    setError('');
    setNotice('');
    const client = requireSupabase();
    const resourceId = crypto.randomUUID();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-160);
    const storagePath = `${schoolId}/${resourceId}/${safeName}`;
    let metadataCreated = false;
    try {
      const { error: metadataError } = await client.from('learning_materials').insert({
        id: resourceId,
        school_id: schoolId,
        class_id: form.class_id,
        subject_id: form.subject_id,
        uploaded_by: user.id,
        title: form.title.trim(),
        description: form.description.trim() || null,
        topic: form.topic.trim(),
        visibility: form.visibility,
        is_published: false,
        storage_provider: 'r2',
        storage_connection_id: form.storage_connection_id || null,
        storage_path: storagePath,
        file_name: file.name.slice(0, 200),
        mime_type: mimeType,
        file_size: file.size,
      });
      if (metadataError) throw metadataError;
      metadataCreated = true;

      const { data: signed, error: signError } = await client.functions.invoke('learning-material-storage', {
        body: { action: 'create-upload-url', materialId: resourceId },
      });
      if (signError) throw signError;
      if (typeof signed?.uploadUrl !== 'string') throw new Error('The storage service did not return an upload link.');
      const uploadResponse = await fetch(signed.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType },
        body: file,
      });
      if (!uploadResponse.ok) throw new Error(`The storage provider rejected the upload (HTTP ${uploadResponse.status}).`);

      const { data: completed, error: finalizeError } = await client.functions.invoke('learning-material-storage', {
        body: { action: 'finalize-upload', materialId: resourceId },
      });
      if (finalizeError) throw finalizeError;
      if (completed?.status !== 'uploaded') throw new Error('The uploaded file could not be verified.');

      if (form.is_published) {
        const { error: publishError } = await client.from('learning_materials')
          .update({ is_published: true }).eq('id', resourceId).eq('school_id', schoolId);
        if (publishError) throw publishError;
      }
      setShowUpload(false);
      setForm({ ...emptyForm });
      formElement.reset();
      setNotice('Learning material uploaded and verified.');
      setRefreshKey((current) => current + 1);
    } catch (uploadError) {
      let message = errorMessage(uploadError, 'Could not upload the learning material.');
      if (metadataCreated) {
        const { error: cleanupError } = await client.functions.invoke('learning-material-storage', {
          body: { action: 'delete-resource', materialId: resourceId },
        });
        if (cleanupError) message = `${message} Cleanup also failed: ${cleanupError.message}`;
      }
      setError(message);
    } finally {
      setUploading(false);
    }
  }

  async function getFileUrl(material: Material, disposition: 'inline' | 'attachment') {
    if (material.storage_provider === 'supabase') {
      const { data, error: linkError } = await requireSupabase().storage
        .from('learning-materials').createSignedUrl(material.storage_path, 300, {
          download: disposition === 'attachment' ? material.file_name ?? true : false,
        });
      if (linkError) throw linkError;
      return data.signedUrl;
    }
    const { data, error: signError } = await requireSupabase().functions.invoke('learning-material-storage', {
      body: { action: 'create-download-url', materialId: material.id, disposition },
    });
    if (signError) throw signError;
    if (typeof data?.url !== 'string') throw new Error('The storage service did not return a file link.');
    return data.url;
  }

  async function openPreview(material: Material) {
    setError('');
    try {
      const url = await getFileUrl(material, 'inline');
      setPreview({ material, url });
    } catch (openError) {
      setError(errorMessage(openError, 'Could not create a secure preview link.'));
    }
  }

  async function download(material: Material) {
    setError('');
    try {
      const url = await getFileUrl(material, 'attachment');
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.download = material.file_name ?? material.title;
      document.body.append(link);
      link.click();
      link.remove();
    } catch (downloadError) {
      setError(errorMessage(downloadError, 'Could not create a secure download link.'));
    }
  }

  async function deleteResource(material: Material) {
    if (!window.confirm(`Delete “${material.title}” and its stored file? This cannot be undone.`)) return;
    setError('');
    setNotice('');
    try {
      const { error: deleteError } = await requireSupabase().functions.invoke('learning-material-storage', {
        body: { action: 'delete-resource', materialId: material.id },
      });
      if (deleteError) throw deleteError;
      setNotice('Learning material deleted.');
      if (preview?.material.id === material.id) setPreview(null);
      setRefreshKey((current) => current + 1);
    } catch (deleteError) {
      setError(errorMessage(deleteError, 'Could not delete the learning material.'));
    }
  }

  async function togglePublished(material: Material) {
    setError('');
    try {
      const { error: updateError } = await requireSupabase().from('learning_materials')
        .update({ is_published: !material.is_published })
        .eq('school_id', material.school_id)
        .eq('id', material.id);
      if (updateError) throw updateError;
      setNotice(material.is_published ? 'Resource unpublished.' : 'Resource published to its assigned audience.');
      setRefreshKey((current) => current + 1);
    } catch (updateError) {
      setError(errorMessage(updateError, 'Could not update resource visibility.'));
    }
  }

  function editMaterial(material: Material) {
    setEditingMaterial(material);
    setEditForm({
      title: material.title,
      description: material.description ?? '',
      topic: material.topic,
      class_id: material.class_id,
      subject_id: material.subject_id ?? '',
      visibility: material.visibility,
      is_published: material.is_published,
      storage_connection_id: material.storage_connection_id ?? '',
    });
    setError('');
  }

  async function saveMaterialDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingMaterial || !schoolId) return;
    setError('');
    try {
      const { error: updateError } = await requireSupabase().from('learning_materials')
        .update({
          title: editForm.title.trim(),
          description: editForm.description.trim() || null,
          topic: editForm.topic.trim(),
          class_id: editForm.class_id,
          subject_id: editForm.subject_id || null,
          visibility: editForm.visibility,
          is_published: editForm.is_published,
        })
        .eq('id', editingMaterial.id)
        .eq('school_id', schoolId);
      if (updateError) throw updateError;
      setEditingMaterial(null);
      setNotice('Learning material details saved.');
      setRefreshKey((current) => current + 1);
    } catch (saveError) {
      setError(errorMessage(saveError, 'Could not save learning material details.'));
    }
  }

  const canManage = (material: Material) => role === 'school_admin'
    || role === 'academic_coordinator'
    || (role === 'teacher' && material.uploaded_by === user?.id);

  return (
    <div className="page-stack materials-page">
      <div className="page-heading">
        <div><span className="eyebrow">{activeMembership?.school.name}</span><h1>Learning materials</h1><p>Organize class resources by subject and topic, then share them securely with learners.</p></div>
        {canUpload && <button className="button button-primary" onClick={() => { setError(''); setForm({ ...emptyForm, storage_connection_id: managedStorageAvailable ? '' : storageConnections[0]?.id ?? '' }); setShowUpload(true); }}><UploadCloud size={16} /> Upload material</button>}
      </div>
      <div className="materials-storage-note"><span><FolderOpen size={17} /></span><p><strong>Private learning library</strong> Files are stored in Cloudflare R2; Supabase controls who can see each resource. Supported file size: up to 500 MB.</p></div>
      {notice && <p className="inline-success" role="status">{notice}</p>}
      {error && <ErrorState message={error} />}
      <section className="materials-content">
        <div className="materials-toolbar">
          <label className="table-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, topic, subject, or class" aria-label="Search learning materials" /></label>
          <label className="materials-filter"><Filter size={14} /><select aria-label="Filter by class" value={classFilter} onChange={(event) => setClassFilter(event.target.value)}><option value="">All classes</option>{[...new Map(materials.map((material) => [material.class_id, material.school_class?.name ?? 'Class'])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          <label className="materials-filter"><BookOpen size={14} /><select aria-label="Filter by subject" value={subjectFilter} onChange={(event) => setSubjectFilter(event.target.value)}><option value="">All subjects</option>{[...new Map(materials.filter((material) => material.subject_id).map((material) => [material.subject_id as string, material.subject?.name ?? 'Subject'])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          <span className="table-count">{filteredMaterials.length} resources</span>
        </div>
        {loading ? <LoadingState label="Loading learning materials…" /> : filteredMaterials.length === 0 ? <div className="materials-empty"><span><FolderOpen size={22} /></span><strong>{query || classFilter || subjectFilter ? 'No matching resources' : 'No learning materials yet'}</strong><p>{canUpload ? 'Upload a resource and assign it to a class and subject to start your learning library.' : 'Published materials for your classes will appear here.'}</p></div> : (
          <div className="materials-grid">{filteredMaterials.map((material) => {
            const isVideo = material.mime_type?.startsWith('video/') ?? false;
            const editable = canManage(material);
            return <article className="material-card" key={material.id}>
              <div className="material-card-top"><span className={`material-icon${isVideo ? ' video' : ''}`}>{isVideo ? <Film size={19} /> : <FileText size={19} />}</span><div className="material-file-meta"><strong>{material.file_name ?? material.title}</strong><small>{readableSize(material.file_size)} · {material.mime_type?.split('/').pop()?.toUpperCase() ?? 'FILE'}</small></div>{editable && <button className="icon-button danger-icon" onClick={() => void deleteResource(material)} aria-label={`Delete ${material.title}`}><Trash2 size={15} /></button>}</div>
              <div className="material-card-copy"><h2>{material.title}</h2><p>{material.description || 'No description added.'}</p></div>
              <div className="material-tags"><span>{material.subject?.name ?? 'No subject'}</span><span>{material.school_class?.name ?? 'No class'}</span>{material.topic && <span>{material.topic}</span>}</div>
              <div className="material-card-footer"><span className={`status-pill ${material.is_published ? 'status-active' : 'status-muted'}`}>{material.is_published ? 'Published' : 'Draft'} · {material.visibility === 'school' ? 'School' : 'Class'}</span><div className="material-actions">
                {(material.mime_type === 'application/pdf' || material.mime_type === 'text/plain' || isVideo || material.mime_type?.startsWith('image/')) && <button className="icon-button" onClick={() => void openPreview(material)} aria-label={`Preview ${material.title}`}><Eye size={16} /></button>}
                <button className="icon-button" onClick={() => void download(material)} aria-label={`Download ${material.title}`}><Download size={16} /></button>
                {editable && <button className="icon-button" onClick={() => editMaterial(material)} aria-label={`Edit ${material.title}`}><Pencil size={15} /></button>}
                {editable && material.is_uploaded && <button className="material-publish" onClick={() => void togglePublished(material)}>{material.is_published ? 'Unpublish' : 'Publish'}</button>}
              </div></div>
            </article>;
          })}</div>
        )}
      </section>
      {showUpload && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !uploading) setShowUpload(false); }}>
        <section className="modal-card material-upload-modal" role="dialog" aria-modal="true" aria-labelledby="material-upload-title">
          <div className="modal-heading"><div><span className="eyebrow">Learning library</span><h2 id="material-upload-title">Upload learning material</h2></div><button className="icon-button" onClick={() => setShowUpload(false)} disabled={uploading} aria-label="Close upload dialog"><X size={18} /></button></div>
          <form className="modal-form" onSubmit={(event) => void upload(event)}>
            <label className="field"><span>Resource title</span><input required minLength={2} maxLength={160} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
            <div className="form-row"><label className="field"><span>Subject</span><select required value={form.subject_id} onChange={(event) => setForm({ ...form, subject_id: event.target.value })}><option value="">Select subject</option>{subjects.map((subject) => <option value={subject.id} key={subject.id}>{subject.name}</option>)}</select></label><label className="field"><span>Class</span><select required value={form.class_id} onChange={(event) => setForm({ ...form, class_id: event.target.value })}><option value="">Select class</option>{classes.map((schoolClass) => <option value={schoolClass.id} key={schoolClass.id}>{schoolClass.name}</option>)}</select></label></div>
            <label className="field"><span>Topic or unit <small>(optional)</small></span><input maxLength={160} value={form.topic} onChange={(event) => setForm({ ...form, topic: event.target.value })} placeholder="e.g. Fractions and decimals" /></label>
            <label className="field"><span>Description <small>(optional)</small></span><textarea maxLength={2000} rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
            <label className="field"><span>File <small>PDF, Word, PowerPoint, Excel, text, MP4, WebM, or MOV · max 500 MB</small></span><input required name="resource_file" type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.mp4,.webm,.mov,application/pdf,video/mp4,video/webm,video/quicktime" /></label>
            <label className="field"><span>Store this file in</span><select value={form.storage_connection_id} onChange={(event) => setForm({ ...form, storage_connection_id: event.target.value })}><>{managedStorageAvailable && <option value="">Campus Connect managed R2</option>}{storageConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.label}</option>)}</></select></label>
            <label className="field"><span>Who can access it?</span><select value={form.visibility} onChange={(event) => setForm({ ...form, visibility: event.target.value as UploadForm['visibility'] })}><option value="class">Assigned class only</option><option value="school">All school members</option></select></label>
            <label className="checkbox-field"><input type="checkbox" checked={form.is_published} onChange={(event) => setForm({ ...form, is_published: event.target.checked })} /><span>Publish for the selected audience after upload</span></label>
            <div className="modal-actions"><button className="button button-quiet" type="button" onClick={() => setShowUpload(false)} disabled={uploading}>Cancel</button><button className="button button-primary" type="submit" disabled={uploading || !classes.length || !subjects.length || (!managedStorageAvailable && !storageConnections.length)}>{uploading ? 'Uploading and verifying…' : 'Upload resource'}</button></div>
            {canUpload && (!classes.length || !subjects.length) && <p className="quiet-note">Your profile needs an assigned class and subject before you can upload materials.</p>}
            {!managedStorageAvailable && !storageConnections.length && <p className="quiet-note">No storage provider is available. Ask your school administrator to connect an R2 bucket, or contact Campus Connect to request managed storage.</p>}
          </form>
        </section>
      </div>}
      {editingMaterial && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingMaterial(null); }}>
        <section className="modal-card material-upload-modal" role="dialog" aria-modal="true" aria-labelledby="material-edit-title">
          <div className="modal-heading"><div><span className="eyebrow">Learning library</span><h2 id="material-edit-title">Edit resource details</h2></div><button className="icon-button" onClick={() => setEditingMaterial(null)} aria-label="Close edit dialog"><X size={18} /></button></div>
          <form className="modal-form" onSubmit={(event) => void saveMaterialDetails(event)}>
            <label className="field"><span>Resource title</span><input required minLength={2} maxLength={160} value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} /></label>
            <div className="form-row"><label className="field"><span>Subject</span><select value={editForm.subject_id} onChange={(event) => setEditForm({ ...editForm, subject_id: event.target.value })}><option value="">No subject selected</option>{subjects.map((subject) => <option value={subject.id} key={subject.id}>{subject.name}</option>)}</select></label><label className="field"><span>Class</span><select required value={editForm.class_id} onChange={(event) => setEditForm({ ...editForm, class_id: event.target.value })}><option value="">Select class</option>{classes.map((schoolClass) => <option value={schoolClass.id} key={schoolClass.id}>{schoolClass.name}</option>)}</select></label></div>
            <label className="field"><span>Topic or unit <small>(optional)</small></span><input maxLength={160} value={editForm.topic} onChange={(event) => setEditForm({ ...editForm, topic: event.target.value })} /></label>
            <label className="field"><span>Description <small>(optional)</small></span><textarea maxLength={2000} rows={3} value={editForm.description} onChange={(event) => setEditForm({ ...editForm, description: event.target.value })} /></label>
            <label className="field"><span>Who can access it?</span><select value={editForm.visibility} onChange={(event) => setEditForm({ ...editForm, visibility: event.target.value as UploadForm['visibility'] })}><option value="class">Assigned class only</option><option value="school">All school members</option></select></label>
            <label className="checkbox-field"><input type="checkbox" checked={editForm.is_published} onChange={(event) => setEditForm({ ...editForm, is_published: event.target.checked })} /><span>Published and available to this audience</span></label>
            <div className="modal-actions"><button className="button button-quiet" type="button" onClick={() => setEditingMaterial(null)}>Cancel</button><button className="button button-primary" type="submit">Save changes</button></div>
          </form>
        </section>
      </div>}
      {preview && <div className="modal-backdrop preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(null); }}>
        <section className="modal-card material-preview-modal" role="dialog" aria-modal="true" aria-labelledby="material-preview-title">
          <div className="modal-heading"><div><span className="eyebrow">{preview.material.subject?.name ?? 'Learning material'}</span><h2 id="material-preview-title">{preview.material.title}</h2></div><div className="course-actions"><button className="icon-button" onClick={() => void download(preview.material)} aria-label="Download resource"><Download size={16} /></button><button className="icon-button" onClick={() => setPreview(null)} aria-label="Close preview"><X size={18} /></button></div></div>
          {preview.material.mime_type === 'application/pdf'
            ? <iframe className="material-pdf-preview" src={preview.url} title={`Preview ${preview.material.title}`} />
            : preview.material.mime_type === 'text/plain'
              ? <iframe className="material-pdf-preview" src={preview.url} title={`Preview ${preview.material.title}`} />
            : preview.material.mime_type?.startsWith('video/')
              ? <video className="material-video-preview" src={preview.url} controls preload="metadata">Your browser does not support embedded video. Download the file to view it.</video>
              : <div className="materials-empty"><span><FileText size={22} /></span><strong>Preview is not available for this file type</strong><p>Download the resource to open it in a compatible application.</p><button className="button button-primary" onClick={() => void download(preview.material)}><Download size={15} /> Download</button></div>}
        </section>
      </div>}
    </div>
  );
}
