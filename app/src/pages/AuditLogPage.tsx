import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Printer, ShieldCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';
import { requireSupabase } from '../lib/supabase';

interface AuditLog {
  id: string;
  actor_id: string | null;
  actor_name?: string | null;
  action: string;
  target_table: string;
  target_id: string | null;
  metadata: { changed_columns?: string[]; outcome?: string };
  created_at: string;
}

const pageSize = 50;

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
}

export function AuditLogPage() {
  const { activeMembership } = useAuth();
  const schoolId = activeMembership?.school_id;
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [action, setAction] = useState('');
  const [targetTable, setTargetTable] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [printedAt, setPrintedAt] = useState('');
  const canView = activeMembership?.role === 'school_admin';

  const loadLogs = useCallback(async () => {
    if (!schoolId || !canView) {
      setLogs([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    setLogs([]);
    setTotal(0);
    try {
      let query = requireSupabase().from('audit_logs')
        .select('id, actor_id, action, target_table, target_id, metadata, created_at', { count: 'exact' })
        .eq('school_id', schoolId)
        .order('created_at', { ascending: false })
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (action) query = query.eq('action', action);
      if (targetTable) query = query.eq('target_table', targetTable);
      const { data, count, error: queryError } = await query;
      if (queryError) throw queryError;
      const rows = (data ?? []) as AuditLog[];
      const actorIds = [...new Set(rows.flatMap((log) => log.actor_id ? [log.actor_id] : []))];
      let actorNames = new Map<string, string>();
      if (actorIds.length) {
        const { data: actors, error: actorError } = await requireSupabase()
          .from('profiles')
          .select('id, full_name')
          .in('id', actorIds);
        if (actorError) throw actorError;
        actorNames = new Map((actors ?? []).map((actor) => [actor.id, actor.full_name]));
      }
      setLogs(rows.map((log) => ({
        ...log,
        actor_name: log.actor_id ? actorNames.get(log.actor_id) ?? null : null,
      })));
      setTotal(count ?? 0);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load this school’s audit history.');
    } finally {
      setLoading(false);
    }
  }, [action, canView, page, schoolId, targetTable]);

  useEffect(() => { void loadLogs(); }, [loadLogs]);

  function printLogs() {
    setPrintedAt(formatDate(new Date().toISOString()));
    window.setTimeout(() => window.print(), 0);
  }

  return (
    <div className="page-stack audit-page">
      <div className="page-heading">
        <div><span className="eyebrow">School administration</span><h1>Audit log</h1><p>Review recorded changes made in this school, including its public website and messaging.</p></div>
        <ShieldCheck size={22} className="muted-icon" />
      </div>
      {!canView && <ErrorState message="Only this school’s administrator can view its audit history." />}
      {error && <ErrorState message={error} />}
      {canView && <section className="content-card">
        <header className="audit-print-heading">
          <span>School activity report</span>
          <h1>{activeMembership.school.name}</h1>
          <p>Audit log{action ? ` · ${action.replace(/_/g, ' ')}` : ''}{targetTable ? ` · ${targetTable.replace(/_/g, ' ')}` : ''}</p>
          <small>Generated {printedAt || formatDate(new Date().toISOString())} · Page {page + 1} · Showing {logs.length} of {total.toLocaleString()} matching actions</small>
        </header>
        <div className="audit-filters">
          <label className="field"><span>Action</span><select value={action} onChange={(event) => { setAction(event.target.value); setPage(0); }}>
            <option value="">All actions</option><option value="insert">Created</option><option value="update">Updated</option><option value="delete">Deleted</option><option value="public_result_lookup">Public result lookup</option>
          </select></label>
          <label className="field"><span>Record type</span><input value={targetTable} onChange={(event) => { setTargetTable(event.target.value.trim()); setPage(0); }} placeholder="Filter by table name" maxLength={80} /></label>
          <span className="audit-count">{total.toLocaleString()} recorded actions</span>
          <button className="button button-quiet audit-print-button" type="button" onClick={printLogs} disabled={loading || logs.length === 0}><Printer size={16} />Print page</button>
        </div>
        {loading ? <LoadingState label="Loading the school audit history…" /> : logs.length === 0
          ? <EmptyState title="No matching activity" detail="Changes made in this school will appear here when recorded." />
          : <div className="audit-table-wrap"><table className="audit-table">
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Area</th><th>Changed fields</th><th>Record</th></tr></thead>
            <tbody>{logs.map((log) => <tr key={log.id}>
              <td>{formatDate(log.created_at)}</td>
              <td>{log.actor_name || (log.actor_id ? `${log.actor_id.slice(0, 8)}…` : 'System / public')}</td>
              <td><span className={`audit-action audit-action-${log.action}`}>{log.action === 'public_result_lookup' ? 'Public result lookup' : log.action}</span></td>
              <td>{log.target_table.replace(/_/g, ' ')}</td>
              <td>{log.metadata?.outcome ? log.metadata.outcome.replace(/_/g, ' ') : (log.metadata?.changed_columns ?? []).join(', ') || '—'}</td>
              <td>{log.target_id ? `${log.target_id.slice(0, 8)}…` : '—'}</td>
            </tr>)}</tbody>
          </table></div>}
        <div className="audit-pagination">
          <span>Page {page + 1} of {Math.max(1, Math.ceil(total / pageSize))}</span>
          <div><button className="button button-quiet" type="button" onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={page === 0 || loading}><ChevronLeft size={16} />Previous</button>
            <button className="button button-quiet" type="button" onClick={() => setPage((current) => current + 1)} disabled={(page + 1) * pageSize >= total || loading}>Next<ChevronRight size={16} /></button></div>
        </div>
      </section>}
    </div>
  );
}
