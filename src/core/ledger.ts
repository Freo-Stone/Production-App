import { dayStart, diffDays, formatDayFull, weekdayShort } from './dates';
import type { EventAction, EventLog } from './types';

/**
 * The production log, as pure functions.
 *
 * The ledger has been filling up since the first import — eighteen places in the app
 * write a line and nothing had ever read one. Reading is a different job from
 * writing: a person comes here with a question ("who moved this rack", "what did we
 * key last Friday", "why does stock not match the floor"), and they want the answer
 * out of the list without scrolling the list. So this file names lines, groups them
 * into days, and filters them. It does not format clocks or write anything.
 *
 * The action map is **exhaustive on `EventAction` on purpose**. A new action in the
 * ledger fails to compile here until somebody has said which part of the shop it
 * belongs to and what it should be called, rather than turning up on screen as a row
 * with no words in it.
 */

/** Which part of the shop a line belongs to. Five groups, all readable at a glance. */
export type LedgerFamily = 'floor' | 'myob' | 'stock' | 'shop' | 'people';

export interface LedgerFamilyMeta {
  key: LedgerFamily;
  /** The word on the filter chip. */
  label: string;
  /** What the group holds, for the chip's tooltip and the empty state. */
  hint: string;
}

export const LEDGER_FAMILIES: LedgerFamilyMeta[] = [
  {
    key: 'floor',
    label: 'On the floor',
    hint: 'Making logged, racks moved, parts parted off, blasts, and write-offs.',
  },
  {
    key: 'myob',
    label: 'MYOB',
    hint: 'Stock keyed into MYOB, and racks taken back out of a run.',
  },
  {
    key: 'stock',
    label: 'Products',
    hint: 'Exports loaded, product settings changed, and products reordered.',
  },
  {
    key: 'people',
    label: 'People',
    hint: 'Accounts, passcodes, devices, and who signed in on what.',
  },
  {
    key: 'shop',
    label: 'Shop setup',
    hint: 'Published views and anything the sync loop had to say about it.',
  },
];

const FAMILY_BY_KEY = new Map(LEDGER_FAMILIES.map((f) => [f.key, f]));

export interface LedgerActionMeta {
  family: LedgerFamily;
  /** Three or four words. The detail line carries the rest. */
  label: string;
}

export const LEDGER_ACTIONS: Record<EventAction, LedgerActionMeta> = {
  'batch.create': { family: 'floor', label: 'Making logged' },
  'batch.move': { family: 'floor', label: 'Rack moved' },
  'batch.split': { family: 'floor', label: 'Part parted off' },
  'batch.blast': { family: 'floor', label: 'Through the blaster' },
  'batch.writeOff': { family: 'floor', label: 'Written off' },
  'batch.undo': { family: 'floor', label: 'Taken back' },
  'batch.enterMyob': { family: 'myob', label: 'Keyed into MYOB' },
  'import.commit': { family: 'stock', label: 'Export loaded' },
  'export.import': { family: 'stock', label: 'Export picked up' },
  'export.failed': { family: 'stock', label: 'Export could not be used' },
  'product.update': { family: 'stock', label: 'Product changed' },
  'rank.change': { family: 'stock', label: 'Products reordered' },
  'account.create': { family: 'people', label: 'Account created' },
  'account.update': { family: 'people', label: 'Account changed' },
  'account.disable': { family: 'people', label: 'Account switched off' },
  'account.enable': { family: 'people', label: 'Account switched back on' },
  'account.passcode': { family: 'people', label: 'Passcode changed' },
  'account.delete': { family: 'people', label: 'Account deleted' },
  'auth.signin': { family: 'people', label: 'Signed in' },
  'auth.signout': { family: 'people', label: 'Signed out' },
  'device.label': { family: 'people', label: 'Device renamed' },
  'device.revoke': { family: 'people', label: 'Device changed' },
  'view.setDefault': { family: 'shop', label: 'View published' },
  'sync.conflict': { family: 'shop', label: 'Sync conflict' },
};

export function familyOf(action: EventAction): LedgerFamily {
  return LEDGER_ACTIONS[action].family;
}

export function labelOf(action: EventAction): string {
  return LEDGER_ACTIONS[action].label;
}

export function familyMeta(key: LedgerFamily): LedgerFamilyMeta {
  const meta = FAMILY_BY_KEY.get(key);
  if (meta === undefined) throw new Error(`no ledger family called ${key}`);
  return meta;
}

/**
 * The sentence to put on the row.
 *
 * Writers are asked to leave a plain sentence in `detail`, and the good ones do —
 * `2026-09-14-01 keyed into MYOB — run 18/09/2026 · 8 trays · 16.00 GL4 · ref INV-42`.
 * Where a writer left it empty the row still has to say something, so the action's
 * name and whatever numbers are on the line stand in. A row that reads as blank text
 * is the one thing a log may never do.
 */
export function ledgerLine(event: EventLog): string {
  const detail = event.detail.trim();
  if (detail !== '') return detail;
  const label = labelOf(event.action);
  const parts: string[] = [];
  if (event.trays > 0) parts.push(`${event.trays} trays`);
  if (event.qty > 0) parts.push(`${event.qty} ${event.code ?? ''}`.trim());
  if (event.code !== null && event.code !== '' && event.qty === 0) parts.push(event.code);
  return parts.length === 0 ? label : `${label} — ${parts.join(' · ')}`;
}

/**
 * A device id shortened for a line that has to fit on a phone.
 *
 * The ledger stores the device's id, and a device only gets a friendly name when
 * somebody renames it in People. Until then the id is the only true thing there is
 * to say, so it is shown — trimmed, because `dev_8f4c1a2e-3b77-…` across every line
 * makes the log unreadable on a small screen.
 */
export function shortDevice(id: string): string {
  if (id === '' || id === 'device') return 'an unnamed device';
  const bare = id.startsWith('dev_') ? id.slice(4) : id;
  // A slug somebody typed is short enough to show whole; a uuid is not, and its
  // first eight characters are as much of it as a line has room for.
  return bare.length <= 12 ? bare : `${bare.slice(0, 8)}…`;
}

/** A line that is about a rack, as opposed to a setting or a sign-in. */
export function isRackLine(event: EventLog): boolean {
  return event.batchId !== null && event.batchId !== '';
}

export interface LedgerDay {
  /** Midnight at the start of the day these lines happened. */
  day: number;
  /** `Today`, `Yesterday`, or `Fri 18/09/2026`. */
  label: string;
  /** Newest line first. */
  items: EventLog[];
}

/**
 * Group lines into days, newest day first, newest line first inside each.
 *
 * Days are calendar days on the device — a shop reads "Tuesday" the same whoever is
 * holding the tablet, and a rolling 24 hours would cut a night shift in half.
 */
export function groupDays(events: EventLog[], now = Date.now()): LedgerDay[] {
  const sorted = [...events].sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  const days: LedgerDay[] = [];
  let current: LedgerDay | null = null;
  for (const event of sorted) {
    const day = dayStart(event.at);
    if (current === null || current.day !== day) {
      current = { day, label: dayLabel(day, now), items: [] };
      days.push(current);
    }
    current.items.push(event);
  }
  return days;
}

/** `Today`, `Yesterday`, or the weekday and date for anything older. */
export function dayLabel(at: number, now = Date.now()): string {
  // `diffDays(a, b)` counts forward, so the line is the first argument: a line from
  // yesterday is one day *before* now, and a device whose clock is running ahead is
  // still today, not yesterday.
  const days = diffDays(at, now);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${weekdayShort(at)} ${formatDayFull(at)}`;
}

// The words here name the same groups as the chips above them, so a day's summary and
// the filter that would show it read the same way.
const SUMMARY_WORDS: Record<LedgerFamily, (n: number) => string> = {
  floor: (n) => `${n} on the floor`,
  myob: (n) => `${n} keyed into MYOB`,
  stock: (n) => (n === 1 ? '1 product or export' : `${n} products or exports`),
  people: (n) => (n === 1 ? '1 person or device' : `${n} people or devices`),
  shop: (n) => (n === 1 ? '1 setting or sync' : `${n} settings or sync`),
};

/**
 * What a day was made of, in the order the chips are shown.
 *
 * The count of a group, not the count of lines: "4 on the floor" is the thing a
 * person wants before they open the day, and it is what makes a Friday look busy in
 * one line without reading forty of them.
 */
/**
 * What a day was made of, in the order the chips are shown.
 *
 * Two styles, because the same sentence has to work in two widths. `words` reads as
 * English on a desktop; `terse` is the counters without the connective tissue, for a
 * phone header where the sentence is cut off at "4 products or e…" and tells you
 * nothing. Which families are present, and how many of each, is the whole point —
 * the wording is not.
 */
export type SummaryStyle = 'words' | 'terse';

const TERSE_WORDS: Record<LedgerFamily, string> = {
  floor: 'floor',
  myob: 'MYOB',
  stock: 'products',
  people: 'people',
  shop: 'setup',
};

/**
 * The group's short name, for a sentence that has to name it in a few characters —
 * "only floor, MYOB" reads; "only On the floor, MYOB" does not.
 */
export function groupWord(key: LedgerFamily): string {
  return TERSE_WORDS[key];
}

export function summariseDay(items: EventLog[], style: SummaryStyle = 'words'): string[] {
  const counts = new Map<LedgerFamily, number>();
  for (const item of items) {
    const family = familyOf(item.action);
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return LEDGER_FAMILIES.filter((f) => (counts.get(f.key) ?? 0) > 0).map((f) =>
    style === 'terse'
      ? `${TERSE_WORDS[f.key]} ${counts.get(f.key) ?? 0}`
      : SUMMARY_WORDS[f.key](counts.get(f.key) ?? 0),
  );
}

export interface LedgerFilter {
  /** Families to keep. Empty or missing keeps all of them. */
  families?: LedgerFamily[];
  /** Only lines about this rack. */
  batchId?: string | null;
  /** Only lines by this person or device. */
  actor?: string | null;
  /** Free text, matched against the line, the item code and who did it. */
  query?: string;
}

/**
 * Whether a line survives the filter.
 *
 * The query is matched against the words on the row and the item code, not against
 * action keys: somebody searching types `2026-09-14-01`, or `INV-42`, or a person's
 * name — they do not type `batch.enterMyob`.
 */
export function matches(event: EventLog, filter: LedgerFilter): boolean {
  if (filter.batchId != null && event.batchId !== filter.batchId) return false;
  if (filter.actor != null && filter.actor !== '' && event.actor !== filter.actor) return false;
  const families = filter.families ?? [];
  if (families.length > 0 && !families.includes(familyOf(event.action))) return false;
  const query = (filter.query ?? '').trim().toLowerCase();
  if (query === '') return true;
  const haystack = [ledgerLine(event), event.code ?? '', event.actor, labelOf(event.action)]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

export function filterLedger(events: EventLog[], filter: LedgerFilter): EventLog[] {
  return events.filter((e) => matches(e, filter));
}

export interface LedgerActor {
  name: string;
  count: number;
}

/**
 * Who is in this window of the log, most recently seen first.
 *
 * Names come off the lines themselves rather than the account list, because the
 * account list can be renamed or deleted and the log has to keep saying who did it.
 */
export function actorsIn(events: EventLog[]): LedgerActor[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const event of [...events].sort((a, b) => b.at - a.at)) {
    const name = event.actor.trim() === '' ? 'nobody signed in' : event.actor.trim();
    if (!counts.has(name)) order.push(name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return order.map((name) => ({ name, count: counts.get(name) ?? 0 }));
}

/** How many lines of each family are in the window, for the filter chips. */
export function familyCounts(events: EventLog[]): Map<LedgerFamily, number> {
  const counts = new Map<LedgerFamily, number>();
  for (const event of events) {
    const family = familyOf(event.action);
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return counts;
}

/**
 * The span the window covers, oldest first. A window of nothing has no span, and the
 * header says "nothing logged yet" instead of printing two invented dates.
 */
export function spanOf(events: EventLog[]): { from: number; to: number } | null {
  if (events.length === 0) return null;
  let from = events[0]?.at ?? 0;
  let to = from;
  for (const event of events) {
    if (event.at < from) from = event.at;
    if (event.at > to) to = event.at;
  }
  return { from, to };
}
