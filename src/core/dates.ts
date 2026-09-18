/**
 * Dates.
 *
 * The MYOB exports write dates as *text* in `d/mm/yyyy` (`9/09/2026`, not
 * `09/09/2026`), and openpyxl/SheetJS will hand that back as a string. Some
 * exports do carry real date cells, so every parser here accepts text, `Date`,
 * and Excel serial numbers, and always returns local-midnight epoch ms so that
 * "which day" bucketing is stable across the app.
 */

const MS_PER_DAY = 86_400_000;
/** Excel's epoch (1899-12-30) offset from the Unix epoch, in days. */
const EXCEL_EPOCH_OFFSET_DAYS = 25_569;

/** Local midnight for a calendar day. */
export function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + Math.trunc(days));
  // Step over a DST boundary by re-normalising to local midnight.
  return dayStart(d.getTime());
}

/** Whole calendar days from `a` to `b` (positive when `b` is later). */
export function diffDays(a: number, b: number): number {
  return Math.round((dayStart(b) - dayStart(a)) / MS_PER_DAY);
}

export function startOfDay(ms: number): number {
  return dayStart(ms);
}

/**
 * The sheet draws a heavy rule after every Thursday, so its blocks run
 * Friday -> Thursday. The block containing today starts at today whatever
 * weekday that is — which is why the screenshot shows eight columns first
 * (Thu 17/09 -> Thu 24/09) and sevens after it.
 */
export const WEEK_ANCHOR_WEEKDAY = 5; // Fri

export function startOfWeek(ms: number, anchorWeekday = WEEK_ANCHOR_WEEKDAY): number {
  const d = new Date(dayStart(ms));
  const delta = (d.getDay() - anchorWeekday + 7) % 7;
  return addDays(d.getTime(), -delta);
}

export function isSameDay(a: number, b: number): boolean {
  return dayStart(a) === dayStart(b);
}

/** `9/09/2026`, `2026-09-09`, `2026-09-09T00:00:00`, Date, Excel serial. */
export function parseDate(value: unknown): number | null {
  if (value == null || value === '') return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : dayStart(value.getTime());
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Excel serial dates are small positive numbers; a real epoch ms is huge.
    if (value > 0 && value < 200_000) {
      return dayStart((value - EXCEL_EPOCH_OFFSET_DAYS) * MS_PER_DAY);
    }
    if (value > 1e11) return dayStart(value);
    return null;
  }

  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  // Year-first must be tested BEFORE the day-first shape, otherwise the `-`
  // separator lets `2026-09-17` fall into the d/m/y branch and read as month
  // 2026, which fails to a silent null.
  const ymd = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?:[T ].*)?$/.exec(text);
  if (ymd) return build(Number(ymd[3]), Number(ymd[2]), normaliseYear(Number(ymd[1])));

  // d/mm/yyyy or dd/mm/yy — the MYOB shape, day first.
  const dmy = /^(\d{1,2})[/](\d{1,2})[/](\d{2,4})$/.exec(text) ?? /^(\d{1,2})[.](\d{1,2})[.](\d{4})$/.exec(text);
  if (dmy) {
    return build(Number(dmy[1]), Number(dmy[2]), normaliseYear(Number(dmy[3])));
  }

  // Last resort — but only for strings that do not look like d/m/y, because
  // Date() would read 9/09/2026 as US m/d/y on some engines.
  if (!/\//.test(text)) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : dayStart(parsed.getTime());
  }
  return null;
}

function normaliseYear(y: number): number {
  if (y < 100) return y < 70 ? 2000 + y : 1900 + y;
  return y;
}

/** Strict constructor: 31/02/2026 returns null instead of rolling to March. */
function build(day: number, month: number, year: number): number | null {
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  d.setHours(0, 0, 0, 0);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d.getTime();
}

/* ── Formatting ────────────────────────────────────────────────────────────── */

const pad2 = (n: number) => String(n).padStart(2, '0');

export function formatDayNum(ms: number | null): string {
  if (ms == null) return '';
  const d = new Date(ms);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
}

export function formatDayFull(ms: number | null): string {
  if (ms == null) return '';
  const d = new Date(ms);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function weekdayShort(ms: number): string {
  return WEEKDAYS[new Date(ms).getDay()] ?? '';
}

/** Stable bucket key for grouping a product's jobs by promised day. */
export function dayKey(ms: number): string {
  const d = new Date(dayStart(ms));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function isoDate(ms: number): string {
  return dayKey(ms);
}

/** `3 days ago`, `in 5 days`, `today` — for export-age and cure countdowns. */
export function relativeDays(target: number, now = Date.now()): string {
  const n = diffDays(now, target);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${Math.abs(n)} days ago`;
}

/** `10:42` — when a file was pulled, when the shop last checked. */
export function formatClock(ms: number | null): string {
  if (ms == null) return '';
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * `just now`, `4 min ago`, `2 h ago`, `yesterday`, `5 days ago`. Short enough for a
 * status line that has to fit beside a chip on a phone.
 */
export function formatSince(ms: number | null, now = Date.now()): string {
  if (ms == null) return 'never';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = diffDays(ms, now);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return formatDayNum(ms);
}

export function weekdayName(weekday: number): string {
  return WEEKDAYS[((weekday % 7) + 7) % 7] ?? '';
}

/** Next occurrence of `weekday` (0=Sun) strictly after `from`, at local midnight. */
export function nextWeekday(from: number, weekday: number): number {
  const start = dayStart(from);
  const current = new Date(start).getDay();
  const delta = (weekday - current + 7) % 7;
  return delta === 0 ? start : addDays(start, delta);
}
