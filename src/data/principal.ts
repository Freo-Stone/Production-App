/**
 * Who is on this device right now, and what that person may do.
 *
 * Deliberately module state rather than a React value, because the data layer has to
 * read it too. Greying out a button is a courtesy to the person using the app; the
 * refusal that counts happens at the write, because someone with a keyboard and a
 * browser console is not waiting for a disabled button. `src/app/session.ts` owns the
 * persisted session and keeps this in step at sign-in, at sign-out and when a sync
 * reveals that the account has gone away — so `src/data` never has to import from
 * `src/app`.
 */
import { deviceStorageKey } from '@/core/ids';
import { can as roleAllows, type Capability } from '@/core/roles';
import type { AccountRole, Actor } from '@/core/types';

export interface Principal {
  /** The signed-in account, or null when nobody is. */
  account: Actor | null;
  role: AccountRole | null;
}

/** Thrown by `assertCan`. A distinct type so a screen can say "that is not yours to
 *  change" without matching on a message. */
export class PermissionError extends Error {
  override name = 'PermissionError';

  constructor(readonly capability: Capability, readonly role: AccountRole | null) {
    super(DESCRIPTIONS[capability](role));
  }
}

const DESCRIPTIONS: Record<Capability, (role: AccountRole | null) => string> = {
  'people.manage': () => 'Only the owner manages accounts.',
  'settings.manage': () => 'Only the owner changes how the shop is set up.',
  'connection.manage': () => 'Only the owner points a device at the shop data.',
  'products.edit': () => 'Only the owner and makers change products.',
  'production.record': () => 'Only the owner and makers log production.',
  'myob.enter': () => 'Only the owner and makers move the MYOB queue.',
  'sources.import': () => 'Only the owner and makers commit an import.',
  'views.own': () => 'Nobody is signed in.',
  'self.passcode': () => 'Nobody is signed in.',
};

/**
 * This machine's id, read when asked rather than once at import. A device id is
 * created on first use and then never changes, but reading it at import meant a
 * module loaded before storage was available — a test, or a browser that has not
 * unlocked storage yet — kept an id nothing else agrees with.
 */
export function deviceId(): string {
  try {
    return deviceStorageKey();
  } catch {
    // No localStorage at all. The ledger still needs to say *somewhere* the write
    // came from, and 'device' is at least honest about not knowing.
    return 'device';
  }
}

let current: Principal = { account: null, role: null };

export function currentPrincipal(): Principal {
  return current;
}

/** Called by the session layer once a passcode has checked out. */
export function signedInAs(account: Actor, role: AccountRole): void {
  current = { account, role };
}

export function signedOut(): void {
  current = { account: null, role: null };
}

export function currentRole(): AccountRole | null {
  return current.role;
}

export function can(capability: Capability): boolean {
  return roleAllows(current.role, capability);
}

/** The gate a write goes through. Throws rather than returning false, so a caller
 *  cannot forget the check the way it can forget an `if`. */
export function assertCan(capability: Capability): void {
  if (!can(capability)) throw new PermissionError(capability, current.role);
}

/**
 * Stamp for the audit ledger. `actor` is a name so a ledger row still reads years
 * later; `actorId` is the id so a rename does not make the same person look like two.
 */
export function actorStamp(): { device: string; actor: string; actorId?: string } {
  const { account } = current;
  if (account === null) return { device: deviceId(), actor: '' };
  return { device: deviceId(), actor: account.name, actorId: account.id };
}

/** Test seam: a fixture that needs a role without a sign-in flow. */
export function __setPrincipalForTests(principal: Partial<Principal>): void {
  current = { ...current, ...principal };
}
