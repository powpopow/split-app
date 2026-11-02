// SplitApp — timezone-safe date filtering.
// All operations use YYYY-MM-DD string slices + integer month arithmetic — never
// `new Date(...).toISOString()`, which is the UTC+7 off-by-one trap behind #67/#106.

export const monthKeyOf = (dateStr) => (dateStr || '').slice(0, 7);
export const yearOf = (dateStr) => (dateStr || '').slice(0, 4);

const pad = (n) => String(n).padStart(2, '0');
export function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
// Add days to a YYYY-MM-DD via a noon anchor (timezone-safe).
export function addDaysStr(dateStr, delta) {
  const d = new Date(dateStr + 'T12:00:00'); d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function thisMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export const thisYear = () => String(new Date().getFullYear());

// The N most recent month keys ending at `endKey` (inclusive), e.g. recentMonthKeys('2026-07',3)
// → ['2026-05','2026-06','2026-07']. Integer arithmetic → no timezone shift (#106).
export function recentMonthKeys(endKey, n) {
  const [y, m] = endKey.split('-').map(Number); // m: 1-12
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    let mm = m - 1 - i, yy = y;
    while (mm < 0) { mm += 12; yy -= 1; }
    keys.push(`${yy}-${String(mm + 1).padStart(2, '0')}`);
  }
  return keys;
}

// filter: { type: 'all' | 'month' | '3m' | 'year', key?: 'YYYY-MM' | 'YYYY' }
export function filterBills(bills, filter) {
  if (!filter || filter.type === 'all') return bills;
  if (filter.type === 'week') {
    const end = filter.end || todayStr();
    const start = addDaysStr(end, -6);
    return bills.filter((b) => b.date >= start && b.date <= end);
  }
  if (filter.type === 'month') return bills.filter((b) => monthKeyOf(b.date) === filter.key);
  if (filter.type === 'year') return bills.filter((b) => yearOf(b.date) === filter.key);
  if (filter.type === '3m') {
    const keys = new Set(recentMonthKeys(filter.key, 3));
    return bills.filter((b) => keys.has(monthKeyOf(b.date)));
  }
  return bills;
}
