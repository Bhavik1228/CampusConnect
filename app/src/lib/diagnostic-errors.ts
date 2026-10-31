export type DiagnosticFeature = {
  key: string;
  code: string;
  name: string;
  path: string;
};

const features: DiagnosticFeature[] = [
  { key: 'academic-planning', code: 'APL', name: 'Academic planning', path: '/academic-planning' },
  { key: 'academic-calendar', code: 'ACL', name: 'Academic calendar', path: '/academic-calendar' },
  { key: 'calendar', code: 'CAL', name: 'Calendar', path: '/calendar' },
  { key: 'timetable', code: 'TMT', name: 'Timetable', path: '/timetable' },
  { key: 'attendance', code: 'ATT', name: 'Attendance', path: '/attendance' },
  { key: 'assessment', code: 'ASM', name: 'Assessments and results', path: '/grades-results' },
  { key: 'finance', code: 'FIN', name: 'Finance', path: '/finance' },
  { key: 'admissions', code: 'ADM', name: 'Admissions', path: '/admissions' },
  { key: 'students', code: 'STU', name: 'Student records', path: '/students' },
  { key: 'staff', code: 'STF', name: 'Staff and teachers', path: '/staff' },
  { key: 'teachers', code: 'STF', name: 'Staff and teachers', path: '/teachers' },
  { key: 'library', code: 'LIB', name: 'Library', path: '/library' },
  { key: 'health', code: 'HLT', name: 'Student health', path: '/health' },
  { key: 'visitors', code: 'VIS', name: 'Visitor management', path: '/visitors' },
  { key: 'assignments', code: 'ASN', name: 'Assignments', path: '/assignments' },
  { key: 'learning-materials', code: 'LMT', name: 'Learning materials', path: '/learning-materials' },
  { key: 'courses-lessons', code: 'CRS', name: 'Courses and lessons', path: '/courses-lessons' },
  { key: 'learning', code: 'LRN', name: 'Learning and assessments', path: '/learning' },
  { key: 'messaging', code: 'MSG', name: 'Messaging', path: '/messaging' },
  { key: 'automations', code: 'AUT', name: 'Automations', path: '/automations' },
  { key: 'setup-health', code: 'SET', name: 'Setup and data health', path: '/setup-health' },
  { key: 'permissions', code: 'PER', name: 'Roles and permissions', path: '/permissions' },
  { key: 'audit-log', code: 'AUD', name: 'Audit log', path: '/audit-log' },
  { key: 'settings', code: 'CFG', name: 'School settings', path: '/settings' },
  { key: 'dashboard', code: 'DSH', name: 'Dashboard', path: '/dashboard' },
  { key: 'support', code: 'SUP', name: 'Support Bot', path: '/support' },
  { key: 'workspace', code: 'WSP', name: 'School workspace', path: '/dashboard' },
  { key: 'platform-owner', code: 'OWN', name: 'Platform owner tools', path: '/system-owner' },
];

export function getDiagnosticFeature(pathname: string): DiagnosticFeature {
  const feature = features.find((candidate) =>
    pathname === candidate.path || pathname.startsWith(`${candidate.path}/`));
  if (pathname.startsWith('/system-owner')) return features.find((item) => item.key === 'platform-owner')!;
  if (pathname.startsWith('/school/') && pathname.split('/')[3] === 'library') {
    return { key: 'public-library', code: 'LIB', name: 'Public library', path: pathname.split('/').slice(0, 5).join('/') };
  }
  if (pathname.startsWith('/classes') || pathname.startsWith('/subjects')) {
    return { key: 'academics-directory', code: 'ACD', name: 'Classes and subjects', path: pathname.split('/').slice(0, 2).join('/') };
  }
  if (pathname.startsWith('/website-management')) {
    return { key: 'website-management', code: 'WEB', name: 'Website management', path: '/website-management' };
  }
  if (pathname.startsWith('/admin-workflows')) {
    return { key: 'administrative-workflows', code: 'WRK', name: 'Administrative workflows', path: '/admin-workflows' };
  }
  if (pathname.startsWith('/accounting-staff')) {
    return { key: 'accounting-staff', code: 'AST', name: 'Accounting staff', path: '/accounting-staff' };
  }
  if (pathname.startsWith('/account-security')) {
    return { key: 'account-security', code: 'SEC', name: 'Account security', path: '/account-security' };
  }
  if (pathname.startsWith('/verify/document')) {
    return { key: 'document-verification', code: 'DOC', name: 'Document verification', path: '/verify/document' };
  }
  if (pathname.startsWith('/school/')) {
    return { key: 'public-school-website', code: 'PBL', name: 'Public school website', path: pathname.split('/').slice(0, 3).join('/') };
  }
  if (pathname.startsWith('/book/')) {
    return { key: 'public-library', code: 'LIB', name: 'Public library', path: pathname.split('/').slice(0, 3).join('/') };
  }
  return feature ?? features.find((item) => item.key === 'workspace')!;
}

function fingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

function classifyDiagnosticMessage(message: string) {
  const value = message.toLocaleLowerCase();
  if (/jwt|token|session|not authenticated|unauthorized/.test(value)) return 'AUTH';
  if (/permission|not allowed|forbidden|42501|403/.test(value)) return 'ACCESS';
  if (/network|fetch|timeout|timed out|connection|offline/.test(value)) return 'NETWORK';
  if (/23505|duplicate|already exists/.test(value)) return 'DUPLICATE';
  if (/23503|foreign key|related record/.test(value)) return 'RELATED';
  if (/maintenance|temporarily disabled|read.only/.test(value)) return 'MAINTENANCE';
  if (/invalid|required|must be|choose |enter |between \d|at least|maximum|too large|unsupported/.test(value)) return 'INPUT';
  return 'UNEXPECTED';
}

export function createDiagnosticError(pathname: string, message: string) {
  const feature = getDiagnosticFeature(pathname);
  const normalizedMessage = message.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const kind = classifyDiagnosticMessage(message);
  return {
    feature,
    code: `CC-${feature.code}-${kind}-${fingerprint(`${feature.key}:${kind}:${normalizedMessage}`)}`,
  };
}

export function explainDiagnosticError(message: string) {
  const value = message.toLocaleLowerCase();
  if (/jwt|token|session|not authenticated|unauthorized/.test(value)) {
    return 'Your sign-in may have expired, so the app could not confirm your access to this feature.';
  }
  if (/permission|not allowed|forbidden|42501|403/.test(value)) {
    return 'Your account may not have permission for this action, or the feature may be restricted for your school role.';
  }
  if (/network|fetch|timeout|timed out|connection|offline/.test(value)) {
    return 'The app did not receive a response. A save may still have reached the service, so check the record before repeating the change.';
  }
  if (/23505|duplicate|already exists/.test(value)) {
    return 'A record with the same unique value already exists, so the app could not save a duplicate.';
  }
  if (/23503|foreign key|related record/.test(value)) {
    return 'A related record required for this action could not be found. The app did not complete the change.';
  }
  if (/maintenance|temporarily disabled|read.only/.test(value)) {
    return 'This feature is temporarily unavailable or read-only while maintenance is active.';
  }
  return 'The feature could not confirm the result. Check the record before repeating a change.';
}

export function makeSupportErrorLink(
  pathname: string,
  code: string,
  from = pathname,
  retryFailed = false,
) {
  const feature = getDiagnosticFeature(pathname);
  const target = feature.key === 'platform-owner' ? '/system-owner/support' : '/support';
  const params = new URLSearchParams({
    code,
    feature: feature.name,
    from,
  });
  if (retryFailed) params.set('retryFailed', '1');
  return `${target}?${params.toString()}`;
}

export const supportRetryStorageKey = 'campus-connect-support-retry';
export const supportDiagnosticContextKey = 'campus-connect-diagnostic-context';

export function saveSupportDiagnosticContext(code: string, message: string) {
  try {
    sessionStorage.setItem(`${supportDiagnosticContextKey}:${code}`, JSON.stringify({
      message: message.slice(0, 1000),
      createdAt: Date.now(),
    }));
    return true;
  } catch (error) {
    console.error('Could not save diagnostic details for Support Bot.', error);
    return false;
  }
}
