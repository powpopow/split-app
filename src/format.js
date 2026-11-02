// 1-2 letter avatar initials. Uses the DB-configured override (Config tab person_a_initials/
// person_b_initials, e.g. "CJ"/"PP") when set, else derives from the name (#157).
export function initials(name, override) {
  const ov = (override || '').trim();
  if (ov) return ov.toUpperCase().slice(0, 2);
  const clean = (name || '').replace(/[^a-zA-Z ]/g, '').trim();
  if (!clean) return '?';
  const parts = clean.split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : clean.slice(0, 2)).toUpperCase();
}

// SplitApp — display formatters. Money is 2-dp (fixes #107; the old app used 3-dp).
export function fmtMoney(n, sym = '฿') {
  return sym + Math.abs(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmtSigned(n, sym = '฿') {
  return (n >= 0 ? '+' : '-') + fmtMoney(n, sym);
}
// Local-timezone safe date label (no UTC shift — #67/#106 class).
export function fmtDate(d) {
  if (!d) return '—';
  const s = String(d).trim();
  const dt = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date(s);
  return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
// Month key (YYYY-MM) → "June 2026", timezone-safe.
export function monthLabel(key) {
  if (!key) return 'Unknown';
  const dt = new Date(key + '-01T12:00:00');
  return isNaN(dt.getTime()) ? key : dt.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}
