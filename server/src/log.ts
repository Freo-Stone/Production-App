/**
 * One line per request, and nothing else.
 *
 * A shop box is looked at when something is wrong, by someone who is tired, so the
 * log has to be readable in `tail` and greppable in `journalctl` without a parser.
 * One line per request is also the only way to keep the write trail honest: a
 * request that logged twice would look like two writes to whoever is working out
 * why the shop has two of something.
 *
 * What never appears here: a request body, a device token, or a setup code after
 * the first-run line. The log file outlives the incident, and on this box it holds
 * the shop's numbers.
 */

export type LogFn = (line: string) => void;

/** Anything a person should read that is not a request line: the setup code, startup. */
export type PrintFn = (line: string) => void;

export const stdoutLog: LogFn = (line) => {
  process.stdout.write(`${line}\n`);
};

export const stdoutPrint: PrintFn = (line) => {
  process.stdout.write(`${line}\n`);
};

/** The extras a write adds to its line. Absent on reads, which is the point. */
export interface WriteNote {
  sha?: string;
  bytes?: number;
  device?: string;
}

/**
 * The single request line.
 *
 * `elapsed` is on every line rather than only on writes because "the shop is slow"
 * is answered by the reads: a state document that takes 900 ms to read is the same
 * complaint as a slow write, and there is no second line to look at.
 *
 * A request the client gave up on answers 499 — no status code for it exists, and
 * nginx has been using that number for long enough that everyone recognises it.
 */
export function requestLine(fields: {
  method: string;
  path: string;
  status: number;
  startedAt: bigint;
  note?: WriteNote;
  now?: number;
}): string {
  const elapsedMs = Number(process.hrtime.bigint() - fields.startedAt) / 1e6;
  const at = new Date(fields.now ?? Date.now()).toISOString();
  const parts = [at, fields.method, safeToken(fields.path, 300), String(fields.status)];
  const note = fields.note ?? {};
  if (note.sha !== undefined) parts.push(`sha=${note.sha}`);
  if (note.bytes !== undefined) parts.push(`bytes=${note.bytes}`);
  if (note.device !== undefined) parts.push(`device=${safeToken(note.device, 60)}`);
  parts.push(`elapsed=${elapsedMs.toFixed(1)}ms`);
  return parts.join(' ');
}

/**
 * Make a value safe to put in a log line.
 *
 * Device names are typed by whoever is holding the device, so without this a
 * device called `shop\n2099-01-01 00:00:00.000Z PUT /api/state 200` would add a
 * write to the log that never happened. Control characters go, spaces become
 * underscores, and the length is capped so one pathological name cannot stretch a
 * line to a kilobyte.
 */
export function safeToken(value: string, max = 80): string {
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"']/g, '')
    .replace(/\s+/g, '_')
    .trim();
  if (cleaned === '') return '-';
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}
