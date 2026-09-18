/** Identity helpers. Ids must be device-unique because two devices can create
 *  records while both offline and then merge. */

export function uid(prefix = ''): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : fallbackUuid();
  return prefix ? `${prefix}_${raw}` : raw;
}

function fallbackUuid(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

/**
 * Batch numbers are human-facing and printed on the curing rack, so they read
 * `YYYY-MM-DD-nn`. Tokens: `yyyy`, `mm`, `dd`, `nnn` (zero-padded sequence).
 */
export function formatBatchNo(dateMs: number, sequence: number, pattern = 'yyyy-mm-dd-nn'): string {
  const d = new Date(dateMs);
  const pad = (n: number, len: number) => String(n).padStart(len, '0');
  return pattern
    .replace('yyyy', String(d.getFullYear()))
    .replace('mm', pad(d.getMonth() + 1, 2))
    .replace('dd', pad(d.getDate(), 2))
    .replace('nnn', pad(sequence, 3))
    .replace('nn', pad(sequence, 2));
}

/** Deterministic job id: the export genuinely repeats (item, customer, order)
 *  combinations, so those parts cannot form the key alone. */
export function jobId(itemCode: string, orderNo: string, rowNumber: number): string {
  return `${itemCode}|${orderNo}|${rowNumber}`;
}

export function deviceStorageKey(): string {
  const KEY = 'freo.deviceId';
  const existing = localStorage.getItem(KEY);
  if (existing) return existing;
  const created = uid('dev');
  localStorage.setItem(KEY, created);
  return created;
}
