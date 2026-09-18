/**
 * The session: which account is on this device right now, remembered until it is not.
 *
 * Sign-in is not a timeout here. A device in the shop is signed in until somebody
 * signs out, the owner revokes the device, or the account is disabled or deleted —
 * in which case the next sync settles it and this device signs itself out. That is
 * what "remembered indefinitely" has to mean when the app runs on a phone in a shed
 * with no server to ask.
 *
 * The persisted record is only a claim. `reconcileSession()` checks it against the
 * accounts actually in the database before anything is trusted, so a device that
 * boots with a name nothing recognises reads as signed out rather than as a person
 * with an id it made up.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { can as roleAllows, type Capability } from '@/core/roles';
import type { AccountRole } from '@/core/types';
import { accountById } from '@/data/accounts';
import { deviceId } from '@/data/principal';
import { signedInAs, signedOut } from '@/data/principal';

interface SessionState {
  name: string;
  userId: string | null;
  role: AccountRole | null;
  signedInAt: number | null;
  /** Set by the sign-in screen once a passcode has checked out. */
  adopt: (account: { id: string; name: string; role: AccountRole }) => void;
  /** Clears the claim and the principal. */
  drop: () => void;
}

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      name: '',
      userId: null,
      role: null,
      signedInAt: null,
      adopt: (account) =>
        set({ name: account.name, userId: account.id, role: account.role, signedInAt: Date.now() }),
      drop: () => set({ name: '', userId: null, role: null, signedInAt: null }),
    }),
    {
      name: 'freo.session',
      // Version 1 was `{ name, deviceId }`: a name somebody typed, with no account
      // behind it and no way to check it. The old name is deliberately not carried
      // across as a signed-in state — it is used only to prefill the owner setup.
      version: 2,
      migrate: (state) => ({
        name: '',
        userId: null,
        role: null,
        signedInAt: null,
        ...((state ?? {}) as Partial<SessionState>),
      }),
    },
  ),
);

/** The name typed before accounts existed, for the owner-setup form to offer. */
export function legacyName(): string {
  try {
    const raw = localStorage.getItem('freo.session');
    const parsed = raw ? (JSON.parse(raw) as { state?: { name?: string } }) : null;
    return parsed?.state?.name?.trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * Puts the principal back after a page load, and takes it away if the account it
 * claims is no longer one that can sign in. Safe to call more than once, and called
 * after every pull for exactly that reason.
 */
export async function reconcileSession(): Promise<'signed-in' | 'signed-out'> {
  const { userId, name, role } = useSession.getState();
  if (userId === null || role === null) {
    signedOut();
    return 'signed-out';
  }
  const account = await accountById(userId);
  if (!account || account.disabled || account.role !== role || account.name !== name) {
    // Gone, disabled, renamed or moved to another role since this device last knew.
    // The claim is stale; the person has to sign in again with what is now true.
    useSession.getState().drop();
    signedOut();
    return 'signed-out';
  }
  signedInAs({ id: account.id, name: account.name }, account.role);
  return 'signed-in';
}

/** Whether this device believes it is signed in, without consulting the database. */
export function hasSessionClaim(): boolean {
  const { userId, role } = useSession.getState();
  return userId !== null && role !== null;
}

export function signOutLocally(): void {
  useSession.getState().drop();
  signedOut();
}

/** Reads the role out of the session, so screens can grey themselves out. */
export function useCan(capability: Capability): boolean {
  const role = useSession((s) => s.role);
  return roleAllows(role, capability);
}

/** For display: whose device is this, according to the last sign-in. */
export function signedInLabel(): string {
  const { name, userId } = useSession.getState();
  return userId === null ? 'nobody' : name;
}

export function thisDeviceId(): string {
  return deviceId();
}

/**
 * View ownership key. Unnamed sessions read the shared default rather than
 * silently creating a throwaway view under a random device id.
 */
export function ownerKey(name = useSession.getState().name): 'shared' | string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug === '' ? 'shared' : slug;
}

export function viewKey(screen: string, owner: string): string {
  return `${screen}|${owner}`;
}
