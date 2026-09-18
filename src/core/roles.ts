/**
 * What a role may do — in one place, on purpose.
 *
 * Every screen that offers a button asks this module whether the signed-in account
 * may press it, so "can a viewer change a job?" has one answer that a test can pin,
 * instead of one answer per screen that drifts. Roles are a shop-floor control: they
 * stop the wrong hands changing the board. They are not a secrecy control — see the
 * note in `docs/accounts.md` about what the shared state document means for that.
 */
import type { AccountRole } from './types';

export type Capability =
  /** Add, rename, disable, delete people; set and reset their passcodes. */
  | 'people.manage'
  /** Change how the shop works: cure days, MYOB entry day, planning, colours. */
  | 'settings.manage'
  /** Point this device at a repository and store its token. */
  | 'connection.manage'
  /** Edit the product list: units, yields, targets, cure days, enable/disable. */
  | 'products.edit'
  /** The work itself: log a make, move a batch, record shotblast, write off. */
  | 'production.record'
  /** Move stock into the Friday MYOB queue and mark it entered. */
  | 'myob.enter'
  /** Commit an import of the MYOB exports on this device. */
  | 'sources.import'
  /** Save a table layout under their own name. Everyone signed in may. */
  | 'views.own'
  /** Change their own passcode. Everyone signed in may, and only their own — see
   *  `mayEditOwn`. Resetting a code should not mean finding the owner in person. */
  | 'self.passcode';

const MATRIX: Record<AccountRole, readonly Capability[]> = {
  owner: [
    'people.manage',
    'settings.manage',
    'connection.manage',
    'products.edit',
    'production.record',
    'myob.enter',
    'sources.import',
    'views.own',
    'self.passcode',
  ],
  maker: ['products.edit', 'production.record', 'myob.enter', 'sources.import', 'views.own', 'self.passcode'],
  // A viewer changes nothing but their own table layout and their own passcode, so a
  // borrowed phone with the foreman's view saved cannot bend the numbers anyone else
  // is reading.
  viewer: ['views.own', 'self.passcode'],
};

export function can(role: AccountRole | null, capability: Capability): boolean {
  if (role === null) return false;
  return MATRIX[role].includes(capability);
}

/** Anything that writes production data. Used to grey out whole flows at once. */
export function isWriter(role: AccountRole | null): boolean {
  return can(role, 'production.record');
}

export const ROLE_LABEL: Record<AccountRole, string> = {
  owner: 'Owner',
  maker: 'Maker',
  viewer: 'Viewer',
};

export const ROLE_SUMMARY: Record<AccountRole, string> = {
  owner: 'Everything, including the people who can sign in.',
  maker: 'Production, curing, shotblast, products and imports.',
  viewer: 'Reads the board and the numbers. Changes nothing.',
};

/** Roles an owner may hand out. Only one owner exists, and that is set at creation. */
export const ASSIGNABLE_ROLES: readonly Exclude<AccountRole, 'owner'>[] = ['maker', 'viewer'];

/**
 * Whether `actor` may manage `target` — rename it, change its role, disable it,
 * delete it, or set its passcode. Only the owner manages anyone, and no one manages
 * an owner: there is exactly one, and the owner's own changes happen through
 * `mayEditOwn`, so there is never a moment where nobody can get back in.
 */
export function mayManage(actorRole: AccountRole | null, targetRole: AccountRole): boolean {
  return can(actorRole, 'people.manage') && targetRole !== 'owner';
}

/**
 * What a person may change about their own account. Anyone may change their own
 * passcode, so nobody has to hand a phone across the yard to get a code reset. The
 * owner may also rename themselves; a maker's or viewer's name belongs to the shop,
 * so the owner changes it — that keeps names stable enough to be the thing stamped
 * on work.
 */
export function mayEditOwn(
  role: AccountRole | null,
  field: 'passcode' | 'name',
): boolean {
  if (role === null) return false;
  return field === 'passcode' || role === 'owner';
}
