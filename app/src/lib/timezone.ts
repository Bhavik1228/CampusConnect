export function normalizeTimeZone(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return 'UTC';

  const offset = candidate.match(/^(?:(?:GMT|UTC)\s*)?([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i);
  if (offset) {
    const hours = Number(offset[2]);
    const minutes = Number(offset[3] ?? 0);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
    const normalized = minutes === 0
      ? hours === 0 ? 'UTC' : `Etc/GMT${offset[1] === '+' ? '-' : '+'}${hours}`
      : `${offset[1]}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: normalized });
      return normalized;
    } catch {
      return null;
    }
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return null;
  }
}

export function resolveTimeZone(value: string | null | undefined): string {
  return normalizeTimeZone(value) ?? 'UTC';
}
