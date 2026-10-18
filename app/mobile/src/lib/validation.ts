import type { MobileMembership, MobileModule } from './types';

export function normalizeIsbn(value: string) {
  return value.replace(/[-\s]/g, '').toUpperCase();
}

export function isValidIsbn(value: string) {
  const isbn = normalizeIsbn(value);
  if (/^\d{9}[\dX]$/.test(isbn)) {
    const sum = [...isbn].reduce((total, character, index) =>
      total + (character === 'X' ? 10 : Number(character)) * (10 - index), 0);
    return sum % 11 === 0;
  }
  if (/^\d{13}$/.test(isbn)) {
    const sum = [...isbn].reduce((total, character, index) =>
      total + Number(character) * (index % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0;
  }
  return false;
}

export function canUseModule(membership: MobileMembership | null, module: MobileModule) {
  return Boolean(
    membership?.eligible
    && membership.mobile_enabled
    && membership.platform_enabled
    && membership.school_active !== false
    && membership.accessible_modules.includes(module)
  );
}

export function classifyScan(value: string) {
  const trimmed = value.trim();
  const visitorId = trimmed.match(/(?:visitors\/verify\/|visitor:)([0-9a-f]{8}-[0-9a-f-]{27})/i)?.[1];
  if (visitorId) return { type: 'visitor' as const, value: visitorId };
  const normalized = normalizeIsbn(trimmed);
  if (isValidIsbn(normalized)) return { type: 'isbn' as const, value: normalized };
  if (/^LIB-[A-Z0-9-]{4,80}$/i.test(trimmed)) return { type: 'library-barcode' as const, value: trimmed };
  const returnCode = trimmed.replace(/[^A-Z0-9]/gi, '');
  if (/^[A-Z0-9]{16}$/i.test(returnCode)) return { type: 'library-return' as const, value: returnCode.toUpperCase() };
  return { type: 'unknown' as const, value: trimmed };
}
