/**
 * Accounts: who may sign in, what they may do, and which machines they do it from.
 *
 * Accounts live in IndexedDB like everything else, and travel in the shared state
 * document. That is what makes "I deleted Sam on my phone" true on the office
 * computer by the next sync, without anyone running a server. The document carries a
 * PBKDF2 digest rather than a passcode — see `src/core/passcode.ts` for what that
 * does and does not protect.
 *
 * Every write here goes through the same three checks: may this account do it, is the
 * account it targets in a state to be changed, and is the shop left with a way to
 * manage itself afterwards. The third one is why an owner cannot be demoted, deleted
 * or disabled while they are the last one.
 */
import { hashPasscode, passcodeAccepted, normalisePasscode, verifyPasscode, type PasscodeCrypto } from '@/core/passcode';
import { uid } from '@/core/ids';
import { ASSIGNABLE_ROLES, mayManage, type Capability } from '@/core/roles';
import type { Account, AccountRole, DeviceRecord } from '@/core/types';
import { db } from '@/data/db';
import { logEvent } from '@/data/events';
import { assertCan, can, currentPrincipal, deviceId, signedInAs, signedOut } from '@/data/principal';

/** The browser's own WebCrypto, which is what the shop's devices will use. */
function browserCrypto(): PasscodeCrypto {
  return globalThis.crypto as unknown as PasscodeCrypto;
}

/** Live accounts, owner first, then by name. Tombstones are never listed. */
export async function listAccounts(): Promise<Account[]> {
  const rank: Record<AccountRole, number> = { owner: 0, maker: 1, viewer: 2 };
  const all = await db.users.toArray();
  return all
    .filter((a) => a.deleted !== true)
    .sort((a, b) => rank[a.role] - rank[b.role] || a.name.localeCompare(b.name));
}

export async function accountById(id: string): Promise<Account | null> {
  const row = await db.users.get(id);
  return row && row.deleted !== true ? row : null;
}

/** Case-insensitive, because "Mik" and "mik" have to be the same person. */
export async function accountByName(name: string): Promise<Account | null> {
  const wanted = name.trim().toLowerCase();
  if (wanted === '') return null;
  const all = await db.users.toArray();
  return all.find((a) => a.deleted !== true && a.name.trim().toLowerCase() === wanted) ?? null;
}

/** Whether anyone can sign in at all — false only on a device that has never been set up. */
export async function accountsExist(): Promise<boolean> {
  return (await listAccounts()).length > 0;
}

export type AccountFailure =
  | 'name-taken'
  | 'name-blank'
  | 'passcode-weak'
  | 'role-not-assignable'
  | 'last-owner'
  | 'not-manageable';

export type AccountResult<T> = { ok: true; account: T } | { ok: false; reason: AccountFailure };

const message = {
  'name-taken': 'Someone already goes by that name.',
  'name-blank': 'A name is needed.',
  'passcode-weak': 'That passcode is too short.',
  'role-not-assignable': 'That role cannot be handed out.',
  'last-owner': 'The shop needs one owner who can sign in.',
  'not-manageable': 'Only the owner changes that account.',
} as const;

export function accountFailureText(reason: AccountFailure): string {
  return message[reason];
}

/**
 * The first account, which is the owner. Refuses if any account already exists:
 * whoever gets there first owns the shop, and everything after that is handed out by
 * that owner. That is also why a new device joins by signing in, never by creating
 * itself an account.
 */
export async function createOwner(
  name: string,
  passcode: string,
  crypto: PasscodeCrypto = browserCrypto(),
): Promise<AccountResult<Account>> {
  if (await accountsExist()) return { ok: false, reason: 'name-taken' };
  const clean = name.trim();
  if (clean === '') return { ok: false, reason: 'name-blank' };
  const code = normalisePasscode(passcode);
  if (!passcodeAccepted(code)) return { ok: false, reason: 'passcode-weak' };

  const now = Date.now();
  const account: Account = {
    id: uid('acct'),
    name: clean,
    role: 'owner',
    passcode: await hashPasscode(code, crypto),
    disabled: false,
    note: '',
    createdAt: now,
    createdBy: null,
    updatedAt: now,
  };
  await db.transaction('rw', db.users, db.events, async () => {
    await db.users.add(account);
    await logEvent('account.create', { detail: `${clean} — owner, created on this device` });
  });
  return { ok: true, account };
}

/** The owner adding someone. Makers and viewers only — the owner role is not handed out. */
export async function createAccount(
  input: { name: string; role: AccountRole; passcode: string; note?: string },
  crypto: PasscodeCrypto = browserCrypto(),
): Promise<AccountResult<Account>> {
  assertCan('people.manage');
  if (!ASSIGNABLE_ROLES.includes(input.role as Exclude<AccountRole, 'owner'>)) {
    return { ok: false, reason: 'role-not-assignable' };
  }
  const clean = input.name.trim();
  if (clean === '') return { ok: false, reason: 'name-blank' };
  if (await accountByName(clean)) return { ok: false, reason: 'name-taken' };
  const code = normalisePasscode(input.passcode);
  if (!passcodeAccepted(code)) return { ok: false, reason: 'passcode-weak' };

  const actor = currentPrincipal().account;
  const now = Date.now();
  const account: Account = {
    id: uid('acct'),
    name: clean,
    role: input.role,
    passcode: await hashPasscode(code, crypto),
    disabled: false,
    note: input.note?.trim() ?? '',
    createdAt: now,
    createdBy: actor?.id ?? null,
    updatedAt: now,
  };
  await db.transaction('rw', db.users, db.events, async () => {
    await db.users.add(account);
    await logEvent('account.create', { detail: `${clean} — ${account.role}` });
  });
  return { ok: true, account };
}

async function edit(
  id: string,
  capability: Capability,
  patch: Partial<Account>,
  action: 'account.update' | 'account.disable' | 'account.enable' | 'account.passcode' | 'account.delete',
  detail: string,
  guard?: (target: Account) => AccountFailure | null | Promise<AccountFailure | null>,
): Promise<AccountResult<Account>> {
  assertCan(capability);
  const target = await accountById(id);
  if (!target) return { ok: false, reason: 'not-manageable' };
  const blocked = guard ? await guard(target) : null;
  if (blocked) return { ok: false, reason: blocked };

  const next: Account = { ...target, ...patch, updatedAt: Date.now() };
  await db.transaction('rw', db.users, db.events, async () => {
    await db.users.put(next);
    await logEvent(action, { detail });
  });
  return { ok: true, account: next };
}

/** True when `id` is the only live, enabled owner. Losing that leaves nobody able to manage accounts. */
async function isLastUsableOwner(id: string): Promise<boolean> {
  const live = await listAccounts();
  return live.some((a) => a.id === id && a.role === 'owner' && !a.disabled);
}

export async function renameAccount(id: string, name: string): Promise<AccountResult<Account>> {
  assertCan('people.manage');
  const target = await accountById(id);
  if (!target) return { ok: false, reason: 'not-manageable' };
  const clean = name.trim();
  if (clean === '') return { ok: false, reason: 'name-blank' };
  const taken = await accountByName(clean);
  if (taken && taken.id !== id) return { ok: false, reason: 'name-taken' };
  return edit(id, 'people.manage', { name: clean }, 'account.update', `${target.name} is now ${clean}`);
}

export function changeRole(id: string, role: AccountRole): Promise<AccountResult<Account>> {
  if (!ASSIGNABLE_ROLES.includes(role as Exclude<AccountRole, 'owner'>)) {
    return Promise.resolve({ ok: false, reason: 'role-not-assignable' });
  }
  return edit(id, 'people.manage', { role }, 'account.update', `role set to ${role}`, (target) =>
    mayManage(currentPrincipal().role, target.role) ? null : 'not-manageable',
  );
}

export function setPasscode(
  id: string,
  passcode: string,
  crypto: PasscodeCrypto = browserCrypto(),
): Promise<AccountResult<Account>> {
  return setPasscodeInner(id, passcode, crypto);
}

/** Split out so the capability check can be the owner's or the account holder's own. */
async function setPasscodeInner(
  id: string,
  passcode: string,
  crypto: PasscodeCrypto,
): Promise<AccountResult<Account>> {
  const code = normalisePasscode(passcode);
  if (!passcodeAccepted(code)) return { ok: false, reason: 'passcode-weak' };
  const target = await accountById(id);
  if (!target) return { ok: false, reason: 'not-manageable' };
  const mine = currentPrincipal().account?.id === id;
  // Own code: `self.passcode`, which every signed-in role holds. Someone else's:
  // `people.manage`, which only the owner holds. The owner role can never be reset
  // by anyone but the owner themselves, whoever they happen to be signed in as.
  if (!mine && target.role === 'owner') return { ok: false, reason: 'not-manageable' };
  const capability: Capability = mine ? 'self.passcode' : 'people.manage';
  if (!can(capability)) return { ok: false, reason: 'not-manageable' };

  return edit(
    id,
    capability,
    { passcode: await hashPasscode(code, crypto) },
    'account.passcode',
    `${target.name}'s passcode was ${mine ? 'changed' : 'reset'}`,
  );
}

export function setDisabled(
  id: string,
  disabled: boolean,
  note = '',
): Promise<AccountResult<Account>> {
  return edit(
    id,
    'people.manage',
    { disabled, note: note.trim() },
    disabled ? 'account.disable' : 'account.enable',
    `${disabled ? 'disabled' : 'enabled'}`,
    async (target) => (disabled && target.role === 'owner' && (await isLastUsableOwner(id)) ? 'last-owner' : null),
  );
}

/**
 * A tombstone, not a removal: the work they logged keeps its `actorId`, and the
 * merge must be able to tell "deleted" from "never seen it".
 */
export function deleteAccount(id: string): Promise<AccountResult<Account>> {
  return edit(
    id,
    'people.manage',
    { deleted: true, disabled: true },
    'account.delete',
    'deleted',
    (target) => (target.role === 'owner' ? 'last-owner' : null),
  );
}

/* ── Signing in ────────────────────────────────────────────────────────────── */

export type SignInFailure =
  | 'unknown'
  | 'disabled'
  | 'wrong-passcode'
  | 'device-revoked'
  | 'cooling-down';

export type SignInResult = { ok: true; account: Account } | { ok: false; reason: SignInFailure; retryAfterMs?: number };

export const MAX_ATTEMPTS = 5;
export const COOLDOWN_MS = 30_000;
const THROTTLE_KEY = 'signin.throttle';

interface Throttle {
  failures: number;
  lockedUntil: number;
}

/**
 * A wait after five wrong codes, remembered on the device. It does not make the
 * digest harder to crack — only a long passcode does that — it stops a thumb working
 * through codes at the till.
 */
async function readThrottle(): Promise<Throttle> {
  const row = await db.meta.get(THROTTLE_KEY);
  const value = row?.value as Partial<Throttle> | undefined;
  return { failures: Number(value?.failures ?? 0), lockedUntil: Number(value?.lockedUntil ?? 0) };
}

async function noteFailure(now: number): Promise<Throttle> {
  const current = await readThrottle();
  const next: Throttle =
    current.failures + 1 >= MAX_ATTEMPTS
      ? { failures: 0, lockedUntil: now + COOLDOWN_MS }
      : { failures: current.failures + 1, lockedUntil: 0 };
  await db.meta.put({ key: THROTTLE_KEY, value: next });
  return next;
}

async function clearThrottle(): Promise<void> {
  await db.meta.delete(THROTTLE_KEY);
}

/** How long a sign-in attempt has to wait, for the sign-in screen to say so. */
export async function signInWaitMs(now = Date.now()): Promise<number> {
  const { lockedUntil } = await readThrottle();
  return Math.max(0, lockedUntil - now);
}

export async function signIn(
  input: { name: string; passcode: string; deviceLabel?: string },
  options: { crypto?: PasscodeCrypto; now?: number } = {},
): Promise<SignInResult> {
  const crypto = options.crypto ?? browserCrypto();
  const now = options.now ?? Date.now();

  const wait = await signInWaitMs(now);
  if (wait > 0) return { ok: false, reason: 'cooling-down', retryAfterMs: wait };

  const device = await db.devices.get(deviceId());
  if (device?.revoked === true) {
    // The owner said this machine is done. It reads the order out of the shared
    // document, so the phone has to have synced once since — see docs/accounts.md.
    return { ok: false, reason: 'device-revoked' };
  }

  const account = await accountByName(input.name);
  if (!account) {
    // Say "wrong passcode", not "no such person": a list of who works here should not
    // be the reward for guessing a name.
    const throttle = await noteFailure(now);
    await logEvent('auth.signin', { detail: `failed sign-in as ${input.name.trim()}${throttle.lockedUntil > now ? ' (locked)' : ''}` });
    return throttle.lockedUntil > now
      ? { ok: false, reason: 'cooling-down', retryAfterMs: throttle.lockedUntil - now }
      : { ok: false, reason: 'wrong-passcode' };
  }
  if (account.disabled) return { ok: false, reason: 'disabled' };

  if (!(await verifyPasscode(normalisePasscode(input.passcode), account.passcode, crypto))) {
    const throttle = await noteFailure(now);
    await logEvent('auth.signin', { detail: `wrong passcode for ${account.name}${throttle.lockedUntil > now ? ' (locked)' : ''}` });
    return throttle.lockedUntil > now
      ? { ok: false, reason: 'cooling-down', retryAfterMs: throttle.lockedUntil - now }
      : { ok: false, reason: 'wrong-passcode' };
  }

  await clearThrottle();
  signedInAs({ id: account.id, name: account.name }, account.role);
  await recordDevice({ label: input.deviceLabel ?? device?.label ?? '', userId: account.id, signedInAt: now });
  await logEvent('auth.signin', { detail: `${account.name} signed in as ${account.role}` });
  return { ok: true, account };
}

export async function signOut(): Promise<void> {
  const account = currentPrincipal().account;
  // Logged before the principal is cleared: written afterwards the row would say
  // somebody signed out without saying who, which is the whole point of the row.
  if (account) await logEvent('auth.signout', { detail: `${account.name} signed out` });
  signedOut();
}

/* ── Devices ───────────────────────────────────────────────────────────────── */

export interface DeviceRow extends DeviceRecord {
  /** The account name, resolved for display. */
  userName: string;
}

export async function listDevices(): Promise<DeviceRow[]> {
  const accounts = await db.users.toArray();
  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));
  const rows = await db.devices.toArray();
  return rows
    .filter((d) => d.deleted !== true)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map((d) => ({ ...d, userName: nameOf.get(d.userId ?? '') ?? 'nobody yet' }));
}

/** Called on sign-in, and on app start so "last seen" means last seen. */
export async function recordDevice(
  input: { id?: string; label: string; userId: string | null; signedInAt?: number },
): Promise<DeviceRecord> {
  const id = input.id ?? deviceId();
  const now = Date.now();
  const existing = await db.devices.get(id);
  const next: DeviceRecord = {
    id,
    label: input.label || existing?.label || 'Unlabelled device',
    userId: input.userId ?? existing?.userId ?? null,
    signedInAt: input.signedInAt ?? existing?.signedInAt ?? null,
    lastSeenAt: now,
    revoked: existing?.revoked ?? false,
    updatedAt: now,
  };
  await db.devices.put(next);
  return next;
}

export function renameDevice(id: string, label: string): Promise<void> {
  assertCan('people.manage');
  return db.devices.get(id).then(async (existing) => {
    if (!existing) return;
    await db.devices.put({ ...existing, label: label.trim() || existing.label, updatedAt: Date.now() });
    await logEvent('device.label', { detail: `${existing.label} renamed ${label.trim()}` });
  });
}

/**
 * Marks a device as no longer allowed to sign in. The device acts on it when it next
 * pulls the shared document — an offline phone cannot be recalled, which is stated
 * plainly in docs/accounts.md rather than glossed over.
 *
 * Revoking the device you are standing on fires you, so the result says whether this
 * screen should drop its own saved session. It has to be the caller's job: the
 * persisted claim lives in `src/app/session.ts`, which imports this module, and data
 * reaching up into app would be the wrong direction for the arrow.
 */
export async function revokeDevice(
  id: string,
  revoke = true,
): Promise<{ signedOutThisDevice: boolean }> {
  assertCan('people.manage');
  const existing = await db.devices.get(id);
  if (!existing) return { signedOutThisDevice: false };
  await db.transaction('rw', db.devices, db.events, async () => {
    await db.devices.put({ ...existing, revoked: revoke, updatedAt: Date.now() });
    await logEvent('device.revoke', { detail: `${existing.label} ${revoke ? 'revoked' : 'allowed again'}` });
  });
  if (revoke && id === deviceId()) {
    signedOut();
    return { signedOutThisDevice: true };
  }
  return { signedOutThisDevice: false };
}

/* ── Settling a tie ────────────────────────────────────────────────────────── */

/**
 * Two devices booted from empty at the same moment can each create an owner, and
 * last-write-wins cannot know which was meant. The earliest created wins, ties broken
 * by id, so both devices settle on the same answer without talking to each other.
 * Returns the accounts it demoted.
 */
export async function demoteExtraOwners(): Promise<Account[]> {
  const owners = (await listAccounts())
    .filter((a) => a.role === 'owner')
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (owners.length <= 1) return [];
  const [, ...extras] = owners;
  const now = Date.now();
  for (const extra of extras) {
    await db.users.put({ ...extra, role: 'maker', updatedAt: now });
    await logEvent('account.update', { detail: `${extra.name} became a maker: two owners were created at once, the earlier one keeps the role` });
  }
  return extras;
}

/** Whether this device should show the sign-in screen or the create-the-owner screen. */
export async function needsOwnerSetup(): Promise<boolean> {
  return !(await accountsExist());
}
