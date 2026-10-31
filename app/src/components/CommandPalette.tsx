import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowUp, ArrowDown, BookOpen, Check, Clock3, Command, FileText, GraduationCap,
  Search, Settings, Star, UsersRound, X, type LucideIcon,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { requireSupabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import type { AppRole } from '../types/database';

const openEventName = 'campus-connect:open-command-palette';
const recentStorageKey = 'campus-connect-command-recent';

export function openCommandPalette() {
  window.dispatchEvent(new Event(openEventName));
}

export type PaletteRoute = {
  path: string;
  label: string;
  icon: LucideIcon;
  description?: string;
};

type Category = 'pages' | 'actions' | 'settings' | 'students' | 'classes' | 'subjects' | 'books' | 'invoices';
type PaletteItem = {
  id: string;
  key: string;
  title: string;
  subtitle: string;
  category: Category;
  icon: LucideIcon;
  route: string;
  keywords: string[];
  favoriteable?: boolean;
  recordId?: string;
};
type SearchRecord = { category: 'students' | 'classes' | 'subjects' | 'books' | 'invoices'; record_id: string; title: string; subtitle: string; relevance: number };
type RecentItem = { key: string; category?: Category; recordId?: string; at: number };
type Props = { routes: PaletteRoute[]; schoolId: string; profileId: string; canAccessSettings: boolean; role: AppRole };

const synonymMap: Record<string, string[]> = {
  '/attendance': ['register', 'roll call', 'mark present', 'attendance sheet', 'take attendance'],
  '/finance': ['fees', 'payments', 'invoice', 'invoices', 'outstanding fees', 'billing'],
  '/grades-results': ['report', 'reports', 'results', 'performance', 'exam', 'examination', 'assessment', 'test'],
  '/library': ['books', 'catalogue', 'catalog', 'titles', 'isbn'],
  '/students': ['pupils', 'learners', 'student records'],
  '/classes': ['groups', 'year groups', 'streams'],
  '/staff': ['teachers', 'educators', 'employees'],
  '/timetable': ['schedule', 'lessons', 'periods'],
  '/admissions': ['admission', 'enrolment', 'enrollment', 'applications'],
  '/subjects': ['courses', 'curriculum'],
  '/academic-calendar': ['calendar', 'term dates'],
};

const settingsItems: Array<{ key: string; title: string; detail: string; tab: string; terms: string[] }> = [
  { key: 'profile', title: 'School profile settings', detail: 'School identity, contact details and branding', tab: 'profile', terms: ['school name', 'branding', 'contact details'] },
  { key: 'campuses', title: 'Campus settings', detail: 'Manage campuses and campus access', tab: 'campuses', terms: ['campus', 'branches', 'locations'] },
  { key: 'academics', title: 'Academic settings', detail: 'Academic policies and year configuration', tab: 'academics', terms: ['academic year', 'grading', 'terms'] },
  { key: 'attendance', title: 'Attendance settings', detail: 'Register defaults, attendance rules and statuses', tab: 'attendance', terms: ['register', 'attendance', 'absence'] },
  { key: 'portals', title: 'Portal settings', detail: 'Student and parent portal access', tab: 'portals', terms: ['parent portal', 'student portal'] },
  { key: 'modules', title: 'Module settings', detail: 'Enable or disable school modules', tab: 'modules', terms: ['features', 'modules', 'availability'] },
  { key: 'security', title: 'Security settings', detail: 'School security and account policies', tab: 'security', terms: ['password', 'mfa', 'two factor', 'security'] },
  { key: 'website', title: 'Website settings', detail: 'Public school website settings', tab: 'website', terms: ['public website', 'school website'] },
  { key: 'storage', title: 'Storage settings', detail: 'School storage connections', tab: 'storage', terms: ['storage', 'files'] },
];

const actionsForRole: (role: AppRole, availablePaths: Set<string>) => PaletteItem[] = (role, availablePaths) => {
  const actions: PaletteItem[] = [];
  const add = (item: Omit<PaletteItem, 'category' | 'favoriteable'>) => actions.push({ ...item, category: 'actions', favoriteable: true });
  if (availablePaths.has('/attendance') && ['school_admin', 'academic_coordinator', 'teacher'].includes(role)) add({ id: 'action:take-register', key: 'action:take-register', title: 'Take a register', subtitle: 'Open attendance entry', icon: Check, route: '/attendance?command=register', keywords: ['register', 'roll call', 'mark present'] });
  if (availablePaths.has('/students') && role === 'school_admin') add({ id: 'action:add-student', key: 'action:add-student', title: 'Add student', subtitle: 'Open student creation form', icon: GraduationCap, route: '/students?command=create', keywords: ['new student', 'pupil', 'learner'] });
  if (availablePaths.has('/classes') && role === 'school_admin') add({ id: 'action:add-class', key: 'action:add-class', title: 'Add class', subtitle: 'Open class creation form', icon: UsersRound, route: '/classes?command=create', keywords: ['new class', 'create class', 'group'] });
  if (availablePaths.has('/subjects') && ['school_admin', 'academic_coordinator'].includes(role)) add({ id: 'action:add-subject', key: 'action:add-subject', title: 'Add subject', subtitle: 'Open subject creation form', icon: BookOpen, route: '/subjects?command=create', keywords: ['new subject', 'create subject'] });
  if (availablePaths.has('/library') && ['school_admin', 'academic_coordinator', 'librarian'].includes(role)) add({ id: 'action:add-book', key: 'action:add-book', title: 'Add book', subtitle: 'Open library book creation form', icon: BookOpen, route: '/library?command=create', keywords: ['new book', 'add title'] });
  if (availablePaths.has('/finance')) {
    add({ id: 'action:find-invoice', key: 'action:find-invoice', title: 'Find invoice', subtitle: 'Open invoice search', icon: FileText, route: '/finance?tab=invoices', keywords: ['invoice number', 'find bill'] });
    add({ id: 'action:view-fees', key: 'action:view-fees', title: 'View fees', subtitle: 'Open fee management', icon: FileText, route: '/finance?tab=overview', keywords: ['school fees', 'payments'] });
    if (['school_admin', 'finance_manager', 'accountant', 'bursar'].includes(role)) add({ id: 'action:create-invoice', key: 'action:create-invoice', title: 'Create invoice', subtitle: 'Open invoice creation', icon: FileText, route: '/finance?tab=invoices&command=create', keywords: ['issue invoice', 'new invoice', 'bill'] });
  }
  if (availablePaths.has('/grades-results')) add({ id: 'action:view-reports', key: 'action:view-reports', title: 'View reports', subtitle: 'Open reports and results', icon: FileText, route: '/grades-results', keywords: ['report', 'results', 'performance'] });
  if (availablePaths.has('/timetable')) add({ id: 'action:open-timetable', key: 'action:open-timetable', title: 'Open timetable', subtitle: 'View the school schedule', icon: Clock3, route: '/timetable', keywords: ['schedule', 'lessons', 'periods'] });
  if (availablePaths.has('/settings')) add({ id: 'action:open-settings', key: 'action:open-settings', title: 'Settings', subtitle: 'Open school settings', icon: Settings, route: '/settings', keywords: ['configure', 'preferences'] });
  return actions;
};

function normalize(value: string) {
  return value.toLocaleLowerCase().trim().replace(/\s+/g, ' ');
}

function matchScore(query: string, title: string, detail: string, keywords: string[]) {
  const needle = normalize(query);
  const normalizedTitle = normalize(title);
  if (normalizedTitle === needle) return 1;
  if (normalizedTitle.startsWith(needle)) return 0.94;
  if (normalizedTitle.includes(needle)) return 0.84;
  const matchingKeyword = keywords.map(normalize).find((word) => word === needle);
  if (matchingKeyword) return 0.78;
  const allText = normalize(`${title} ${detail} ${keywords.join(' ')}`);
  const queryTokens = needle.split(' ');
  const matchedTokens = queryTokens.filter((token) => allText.split(' ').some((part) => part.startsWith(token)));
  return matchedTokens.length === queryTokens.length ? 0.62 : 0;
}

function recordRoute(record: SearchRecord) {
  const parameter = `commandRecord=${encodeURIComponent(record.record_id)}`;
  if (record.category === 'students') return `/students?${parameter}`;
  if (record.category === 'classes') return `/classes?${parameter}`;
  if (record.category === 'subjects') return `/subjects?${parameter}`;
  if (record.category === 'books') return `/library?${parameter}`;
  return `/finance?tab=invoices&${parameter}`;
}

function safeRecentItems(userId: string, schoolId: string): RecentItem[] {
  try {
    const stored = JSON.parse(localStorage.getItem(`${recentStorageKey}:${userId}:${schoolId}`) ?? '[]') as unknown;
    if (!Array.isArray(stored)) return [];
    return stored.filter((item): item is RecentItem => {
      if (!item || typeof item !== 'object' || typeof (item as RecentItem).at !== 'number') return false;
      const recent = item as RecentItem;
      const staticEntry = typeof recent.key === 'string' && /^(page|action|setting):[a-z0-9_-]+$/.test(recent.key);
      const recordEntry = typeof recent.recordId === 'string'
        && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(recent.recordId)
        && ['students', 'classes', 'subjects', 'books', 'invoices'].includes(recent.category ?? '');
      return staticEntry || recordEntry;
    }).slice(0, 12);
  } catch (error) {
    console.error('Could not read recent command palette items.', error);
    return [];
  }
}

export function CommandPalette({ routes, schoolId, profileId, canAccessSettings, role }: Props) {
  const { activeMembership } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [records, setRecords] = useState<SearchRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [preferenceError, setPreferenceError] = useState('');
  const [analyticsError, setAnalyticsError] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [retryKey, setRetryKey] = useState(0);
  const [favourites, setFavourites] = useState<string[]>([]);
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [searchCorrelation, setSearchCorrelation] = useState('');
  const [searchStartedAt, setSearchStartedAt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const activeRequestRef = useRef(0);

  const availablePaths = useMemo(() => new Set(routes.map((route) => route.path)), [routes]);
  const activeRole = activeMembership?.role ?? role;
  const pageItems = useMemo<PaletteItem[]>(() => routes.map((route) => ({
    id: `page:${route.path}`,
    key: `page:${route.path.replace(/^\//, '').replace(/\//g, '-') || 'home'}`,
    title: route.label,
    subtitle: route.description ?? 'Open page',
    category: 'pages',
    icon: route.icon,
    route: route.path,
    keywords: synonymMap[route.path] ?? [],
    favoriteable: true,
  })), [routes]);
  const actionItems = useMemo(() => actionsForRole(activeRole, availablePaths), [activeRole, availablePaths]);
  const settingPaletteItems = useMemo<PaletteItem[]>(() => canAccessSettings
    ? settingsItems.filter((setting) => setting.key !== 'website' || activeRole === 'school_admin')
      .filter((setting) => setting.key !== 'storage' || ['school_admin', 'academic_coordinator', 'teacher'].includes(activeRole))
      .map((setting) => ({
      id: `setting:${setting.key}`,
      key: `setting:${setting.key}`,
      title: setting.title,
      subtitle: setting.detail,
      category: 'settings',
      icon: Settings,
      route: `/settings?tab=${setting.tab}`,
      keywords: setting.terms,
      favoriteable: true,
    }))
    : [], [canAccessSettings, activeRole]);
  const localItems = useMemo(() => [...pageItems, ...actionItems, ...settingPaletteItems], [pageItems, actionItems, settingPaletteItems]);
  const localResults = useMemo(() => {
    if (!query.trim()) return [];
    return localItems.map((item) => ({ item, score: matchScore(query, item.title, item.subtitle, item.keywords) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
      .map((entry) => entry.item);
  }, [localItems, query]);
  const recordItems = useMemo<PaletteItem[]>(() => records.map((record) => ({
    id: `${record.category}:${record.record_id}`,
    key: '',
    title: record.title,
    subtitle: record.subtitle || `Open ${record.category.slice(0, -1)}`,
    category: record.category,
    icon: record.category === 'students' ? GraduationCap
      : record.category === 'classes' ? UsersRound
        : record.category === 'subjects' ? BookOpen
          : FileText,
    route: recordRoute(record),
    keywords: [],
    recordId: record.record_id,
  })), [records]);
  const favoriteItems = useMemo(() => favourites.map((key) => localItems.find((item) => item.key === key))
    .filter((item): item is PaletteItem => Boolean(item)), [favourites, localItems]);
  const recentDisplayItems = useMemo<PaletteItem[]>(() => recentItems.flatMap((recent) => {
    if (recent.recordId && recent.category && ['students', 'classes', 'subjects', 'books', 'invoices'].includes(recent.category)) {
      const category = recent.category as SearchRecord['category'];
      return [{
        id: `recent:${category}:${recent.recordId}`,
        key: '',
        title: `Recently opened ${category.slice(0, -1)}`,
        subtitle: 'Reopen this record in its school workspace',
        category,
        icon: FileText,
        route: recordRoute({ category, record_id: recent.recordId, title: '', subtitle: '', relevance: 0 }),
        keywords: [],
        recordId: recent.recordId,
      }];
    }
    const item = localItems.find((entry) => entry.key === recent.key);
    return item ? [item] : [];
  }).filter((item, index, items) => items.findIndex((other) => other.id === item.id) === index
    && !favoriteItems.some((favorite) => favorite.key && favorite.key === item.key)), [recentItems, localItems, favoriteItems]);
  const suggestedItems = useMemo(() => actionItems.slice(0, 6).filter((item) =>
    !favoriteItems.some((favorite) => favorite.key === item.key)
    && !recentDisplayItems.some((recent) => recent.key === item.key)), [actionItems, favoriteItems, recentDisplayItems]);
  const displayedItems = useMemo(() => {
    if (!query.trim()) return [...favoriteItems, ...recentDisplayItems, ...suggestedItems];
    return [...localResults, ...recordItems].slice(0, 30);
  }, [query, favoriteItems, recentDisplayItems, suggestedItems, localResults, recordItems]);

  const recordEvent = useCallback(async (
    eventType: string,
    correlationId: string = crypto.randomUUID(),
    category: Category | null = null,
    resultCount: number | null = null,
    duration: number | null = null,
    success: boolean | null = null,
  ) => {
    if (!schoolId) return;
    const { error } = await requireSupabase().rpc('record_command_search_event', {
      target_school: schoolId,
      target_correlation_id: correlationId,
      target_event_type: eventType,
      target_category: category,
      target_result_count: resultCount,
      target_duration_ms: duration,
      target_success: success,
    });
    if (error) throw error;
  }, [schoolId]);
  const recordEventSafely = useCallback(async (...args: Parameters<typeof recordEvent>) => {
    try {
      await recordEvent(...args);
    } catch (error) {
      console.error('Could not record command palette analytics.', error);
      setAnalyticsError('Search analytics could not be recorded.');
    }
  }, [recordEvent]);
  const recordNoResultTermSafely = useCallback(async (term: string) => {
    try {
      const { error } = await requireSupabase().rpc('record_command_no_result_term', {
        target_school: schoolId,
        target_term: term,
      });
      if (error) throw error;
    } catch (error) {
      console.error('Could not record a no-result search term.', error);
      setAnalyticsError('Search analytics could not be recorded.');
    }
  }, [schoolId]);

  useEffect(() => {
    function onOpen() {
      restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQuery('');
      setRecords([]);
      setSearchError('');
      setAnalyticsError('');
      setSelectedIndex(0);
      setOpen(true);
      const correlation = crypto.randomUUID();
      setSearchCorrelation(correlation);
      setSearchStartedAt(0);
      void recordEventSafely('command_palette_opened', correlation);
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      const target = event.target;
      const isTyping = target instanceof HTMLElement
        && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !isTyping) {
        event.preventDefault();
        onOpen();
      } else if (open && event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener(openEventName, onOpen);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener(openEventName, onOpen);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, recordEventSafely]);

  useEffect(() => {
    if (!open) {
      restoreFocusRef.current?.focus();
      return;
    }
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || !schoolId || !profileId) return;
    setPreferenceError('');
    setRecentItems(safeRecentItems(profileId, schoolId));
    let active = true;
    void (async () => {
      try {
        const { data, error } = await requireSupabase().from('command_palette_favourites')
          .select('entry_key,sort_order')
          .eq('school_id', schoolId)
          .eq('profile_id', profileId)
          .order('sort_order');
        if (error) throw error;
        if (active) setFavourites((data ?? []).map((item) => item.entry_key));
      } catch (error) {
        console.error('Could not load command palette favourites.', error);
        if (active) setPreferenceError('Favourites could not be loaded. You can still search and navigate.');
      }
    })();
    return () => { active = false; };
  }, [open, schoolId, profileId]);

  useEffect(() => {
    const normalizedQuery = query.trim();
    if (!open || normalizedQuery.length < 2 || !schoolId) {
      setRecords([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setSearchError('');
    const requestId = ++activeRequestRef.current;
    const correlation = crypto.randomUUID();
    const startedAt = performance.now();
    setSearchCorrelation(correlation);
    setSearchStartedAt(startedAt);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await recordEventSafely('search_started', correlation);
          const { data, error } = await requireSupabase().rpc('search_school_command_records', {
            target_school: schoolId,
            search_query: normalizedQuery,
            requested_categories: ['students', 'classes', 'subjects', 'books', 'invoices'],
            requested_per_category: 8,
            requested_limit: 30,
          });
          if (error) throw error;
          if (requestId !== activeRequestRef.current) return;
          const found = (data ?? []) as SearchRecord[];
          setRecords(found);
          const count = Math.min(30, found.length + localResults.length);
          const duration = Math.round(performance.now() - startedAt);
          await recordEventSafely('search_completed', correlation, null, count, duration, true);
          if (count === 0) {
            await recordEventSafely('search_no_results', correlation, null, 0, duration, true);
            await recordNoResultTermSafely(normalizedQuery);
          }
          setRecentSearches((current) => [normalizedQuery, ...current.filter((term) => term !== normalizedQuery)].slice(0, 5));
        } catch (error) {
          if (requestId !== activeRequestRef.current) return;
          console.error('Command palette search failed.', error);
          setSearchError(error instanceof Error ? error.message : 'Search failed. Retry the request.');
          await recordEventSafely('search_failed', correlation, null, null, Math.round(performance.now() - startedAt), false);
        } finally {
          if (requestId === activeRequestRef.current) setLoading(false);
        }
      })();
    }, 220);
    return () => {
      window.clearTimeout(timer);
      activeRequestRef.current += 1;
    };
  }, [open, query, schoolId, retryKey, recordEventSafely, recordNoResultTermSafely, localResults.length]);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, displayedItems.length - 1)));
  }, [displayedItems.length]);

  const activateItem = useCallback(async (item: PaletteItem) => {
    try {
    if (item.recordId) {
      const next = [{ key: '', category: item.category, recordId: item.recordId, at: Date.now() }, ...recentItems]
        .filter((entry, index, all) => all.findIndex((other) => other.category === entry.category && other.recordId === entry.recordId && other.key === entry.key) === index)
        .slice(0, 12);
      setRecentItems(next);
      localStorage.setItem(`${recentStorageKey}:${profileId}:${schoolId}`, JSON.stringify(next));
    } else if (item.key) {
      const next = [{ key: item.key, at: Date.now() }, ...recentItems.filter((entry) => entry.key !== item.key)].slice(0, 12);
      setRecentItems(next);
      localStorage.setItem(`${recentStorageKey}:${profileId}:${schoolId}`, JSON.stringify(next));
    }
    } catch (error) {
      console.error('Could not update recent command palette history.', error);
      setPreferenceError('Recent history could not be saved in this browser.');
    }
    const correlation = searchCorrelation || crypto.randomUUID();
    const category = item.category;
    await recordEventSafely('search_result_selected', correlation, category, displayedItems.length, searchStartedAt ? Math.round(performance.now() - searchStartedAt) : null, true);
    if (item.category === 'actions') {
      await recordEventSafely('search_action_executed', correlation, category, displayedItems.length, null, true);
    }
    setOpen(false);
    const invoiceTerm = query.trim().replace(/^(?:find|search)\s+(?:an?\s+)?invoices?\s*/i, '').trim();
    const destination = item.id === 'action:find-invoice' && invoiceTerm
      ? `${item.route}&search=${encodeURIComponent(invoiceTerm)}`
      : item.route;
    navigate(destination);
  }, [displayedItems.length, navigate, profileId, query, recentItems, recordEventSafely, schoolId, searchCorrelation, searchStartedAt]);

  async function toggleFavourite(item: PaletteItem) {
    if (!item.favoriteable || !schoolId || !profileId) return;
    setPreferenceError('');
    const isFavorite = favourites.includes(item.key);
    try {
      const change = isFavorite
        ? requireSupabase().from('command_palette_favourites').delete().eq('school_id', schoolId).eq('profile_id', profileId).eq('entry_key', item.key)
        : requireSupabase().from('command_palette_favourites').insert({ school_id: schoolId, profile_id: profileId, entry_key: item.key });
      const { error } = await change;
      if (error) throw error;
      setFavourites((current) => isFavorite ? current.filter((key) => key !== item.key) : [...current, item.key]);
      await recordEventSafely(isFavorite ? 'favourite_removed' : 'favourite_added', crypto.randomUUID(), item.category, null, null, true);
    } catch (error) {
      console.error('Could not update command palette favourite.', error);
      setPreferenceError(error instanceof Error ? error.message : 'Could not update this favourite.');
    }
  }

  async function removeStaleFavourites() {
    const stale = favourites.filter((key) => !localItems.some((item) => item.key === key));
    if (!stale.length) return;
    try {
      const { error } = await requireSupabase().from('command_palette_favourites').delete()
        .eq('school_id', schoolId).eq('profile_id', profileId).in('entry_key', stale);
      if (error) throw error;
      setFavourites((current) => current.filter((key) => !stale.includes(key)));
    } catch (error) {
      console.error('Could not remove stale command palette favourites.', error);
      setPreferenceError(error instanceof Error ? error.message : 'Could not remove unavailable favourites.');
    }
  }

  function onPaletteKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab' && event.target !== inputRef.current) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((current) => displayedItems.length ? (current + 1) % displayedItems.length : 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((current) => displayedItems.length ? (current - 1 + displayedItems.length) % displayedItems.length : 0);
    } else if (event.key === 'Enter' && displayedItems[selectedIndex]) {
      event.preventDefault();
      void activateItem(displayedItems[selectedIndex]);
    } else if (event.key === 'Tab' && modalRef.current) {
      const focusable = Array.from(modalRef.current.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled),[tabindex="0"]'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  function clearHistory() {
    setRecentItems([]);
    setRecentSearches([]);
    try {
      localStorage.removeItem(`${recentStorageKey}:${profileId}:${schoolId}`);
    } catch (error) {
      console.error('Could not clear recent command palette history.', error);
      setPreferenceError('Recent history could not be cleared in this browser.');
    }
  }

  if (!open) return null;

  const queryTooShort = query.trim().length === 1;
  const renderItem = (item: PaletteItem, index: number) => {
    const Icon = item.icon;
    return <div className={`command-palette-result${selectedIndex === index ? ' selected' : ''}`} key={item.id}>
      <button id={`command-result-${index}`} type="button" className="command-palette-result-main" onMouseEnter={() => setSelectedIndex(index)} onClick={() => void activateItem(item)}>
        <Icon size={17} aria-hidden="true" />
        <span><strong>{item.title}</strong><small>{item.subtitle}</small></span>
        <small className="command-palette-category">{item.category}</small>
      </button>
      {item.favoriteable && <button type="button" className={`command-palette-favourite${favourites.includes(item.key) ? ' active' : ''}`} aria-label={`${favourites.includes(item.key) ? 'Remove' : 'Add'} ${item.title} ${favourites.includes(item.key) ? 'from' : 'to'} favourites`} onClick={() => void toggleFavourite(item)}><Star size={15} fill={favourites.includes(item.key) ? 'currentColor' : 'none'} /></button>}
    </div>;
  };
  const itemRows = displayedItems.map(renderItem);
  const favoriteRows = favoriteItems.map((item) => renderItem(item, displayedItems.indexOf(item)));
  const recentRows = recentDisplayItems.map((item) => renderItem(item, displayedItems.indexOf(item)));
  const suggestedRows = suggestedItems.map((item) => renderItem(item, displayedItems.indexOf(item)));

  return <div className="command-palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
    <div className="command-palette-dialog" role="dialog" aria-modal="true" aria-labelledby="command-palette-title" ref={modalRef} onKeyDown={onPaletteKeyDown}>
      <h2 id="command-palette-title" className="visually-hidden">Search Campus Connect</h2>
      <div className="command-palette-search">
        <Search size={19} aria-hidden="true" />
        <input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0); setSearchError(''); }} placeholder="Search pages, actions, settings, students, books…" aria-label="Search pages, actions, settings and school records" aria-controls="command-palette-results" autoComplete="off" />
        {loading && <span className="command-palette-loading" role="status">Searching…</span>}
        <kbd>ESC</kbd>
        <button type="button" className="icon-button" aria-label="Close command palette" onClick={() => setOpen(false)}><X size={17} /></button>
      </div>
      {preferenceError && <p className="command-palette-message" role="status">{preferenceError}</p>}
      {analyticsError && <p className="command-palette-message" role="status">{analyticsError}</p>}
      {searchError && <div className="command-palette-error" role="alert"><span>{searchError}</span><button type="button" className="button button-quiet" onClick={() => setRetryKey((current) => current + 1)}>Retry</button></div>}
      <div id="command-palette-results" className="command-palette-results" role="region" aria-label="Search results" aria-busy={loading}>
        {!query.trim() && <>
          {favourites.length > 0 && <section><h3><Star size={14} />Favourites</h3>{favoriteRows}{favourites.length > favoriteItems.length && <div className="command-palette-stale"><span>Some favourites are unavailable</span><button type="button" onClick={() => void removeStaleFavourites()}>Remove stale</button></div>}</section>}
          {recentSearches.length > 0 && <section><h3><Search size={14} />Recent searches</h3>{recentSearches.map((term) => <button type="button" className="command-palette-simple-item" key={term} onClick={() => { setQuery(term); setSelectedIndex(0); }}><Search size={15} /><span>{term}</span></button>)}</section>}
          {recentDisplayItems.length > 0 && <section><h3><Clock3 size={14} />Recent</h3>{recentRows}</section>}
          <section><h3><Command size={14} />Suggested actions</h3>{suggestedItems.length ? suggestedRows : <p className="command-palette-empty">No suggested actions are available for this role.</p>}</section>
          <div className="command-palette-history"><span>History is limited to this user and school.</span><button type="button" onClick={clearHistory} disabled={!recentItems.length && !recentSearches.length}>Clear recent history</button></div>
        </>}
        {query.trim() && itemRows}
        {queryTooShort && <p className="command-palette-empty">Enter at least 2 characters to search records.</p>}
        {query.trim().length >= 2 && !loading && !searchError && displayedItems.length === 0 && <p className="command-palette-empty">No matching pages, actions, settings, or records. Try another term.</p>}
        <div className="visually-hidden" aria-live="polite">{query.trim() ? `${displayedItems.length} search results${loading ? ', searching' : ''}${displayedItems[selectedIndex] ? `, ${displayedItems[selectedIndex].title} selected` : ''}` : ''}</div>
      </div>
      <footer className="command-palette-footer"><span><kbd><ArrowUp size={10} /></kbd><kbd><ArrowDown size={10} /></kbd> Navigate</span><span><kbd>ENTER</kbd> Open</span><span><kbd>CTRL K</kbd> Search anywhere</span></footer>
    </div>
  </div>;
}
