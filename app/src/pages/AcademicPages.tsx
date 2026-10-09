import { useEffect, useState } from 'react';
import { BookOpenText, CalendarDays } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { requireSupabase } from '../lib/supabase';
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback';

type AcademicKind = 'learning' | 'calendar';
const content: Record<AcademicKind, { title: string; description: string; table: string; icon: typeof BookOpenText }> = {
  learning: { title: 'Learning', description: 'Assignments and learning resources connected to your school.', table: 'assignments', icon: BookOpenText },
  calendar: { title: 'School calendar', description: 'Upcoming school events and academic dates.', table: 'events', icon: CalendarDays },
};

export function AcademicPages({ kind }: { kind: AcademicKind }) {
  const { activeMembership } = useAuth();
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const meta = content[kind];
  const Icon = meta.icon;
  const schoolId = activeMembership?.school_id;
  useEffect(() => {
    if (!schoolId) return;
    let alive = true;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const client = requireSupabase();
        const { count: rowCount, error: queryError } = await client.from(meta.table).select('id', { count: 'exact', head: true }).eq('school_id', schoolId);
        if (queryError) throw queryError;
        if (alive) setCount(rowCount ?? 0);
      } catch (loadError) {
        if (alive) setError(loadError instanceof Error ? loadError.message : `Could not load ${meta.title.toLowerCase()}.`);
      } finally {
        if (alive) setLoading(false);
      }
    }
    void load();
    return () => { alive = false; };
  }, [schoolId, meta.table, meta.title]);
  return <div className="page-stack"><div className="page-heading"><div><span className="eyebrow">{activeMembership?.school.name}</span><h1>{meta.title}</h1><p>{meta.description}</p></div></div>{error && <ErrorState message={error} />}{loading ? <LoadingState label={`Loading ${meta.title.toLowerCase()}…`} /> : <section className="content-card module-state"><span className="module-icon"><Icon size={22} /></span><span className="eyebrow">Live school data</span><h2>{meta.title}</h2><p>{count} {count === 1 ? 'record' : 'records'} currently belong to this school.</p>{count === 0 && <EmptyState title={`No ${meta.title.toLowerCase()} records yet`} detail="When records are added to your school's database, they will appear in this workspace." />}</section>}</div>;
}
