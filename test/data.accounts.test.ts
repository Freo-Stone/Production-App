// Accounts, sign-in and devices, at the layer where the rules actually live.
//
// The order of the imports matters here: `principal.ts` reads the device id when the
// module is first evaluated, so a storage stub has to exist before it is imported.
// Hence the dynamic imports below rather than the usual header.
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Account } from '@/core/types';

const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
} as unknown as Storage;

const {
  accountById,
  accountByName,
  accountsExist,
  changeRole,
  createAccount,
  createOwner,
  COOLDOWN_MS,
  deleteAccount,
  demoteExtraOwners,
  listAccounts,
  listDevices,
  MAX_ATTEMPTS,
  needsOwnerSetup,
  recordDevice,
  renameAccount,
  renameDevice,
  revokeDevice,
  setDisabled,
  setPasscode,
  signIn,
  signInWaitMs,
  signOut,
} = await import('@/data/accounts');
const { db, seedIfEmpty } = await import('@/data/db');
const { currentPrincipal, deviceId, PermissionError, signedInAs, signedOut } = await import('@/data/principal');
const crypto = webcrypto as unknown as Parameters<typeof createOwner>[2];

/** The digest cost a test can afford. The real default is proved in core.passcode. */
const FAST = { crypto, now: 1_700_000_000_000 };

async function reset(): Promise<void> {
  store.clear();
  store.set('freo.deviceId', 'dev-shop');
  await Promise.all([db.users.clear(), db.devices.clear(), db.events.clear(), db.meta.clear(), db.products.clear()]);
  await seedIfEmpty();
  signedOut();
}

async function makeOwner(name = 'Mik', passcode = 'trap door'): Promise<Account> {
  const result = await createOwner(name, passcode, crypto);
  if (!result.ok) throw new Error(`owner setup failed: ${result.reason}`);
  signedInAs({ id: result.account.id, name: result.account.name }, 'owner');
  return result.account;
}

async function addMaker(name = 'Sam', passcode = 'curing rack'): Promise<Account> {
  const result = await createAccount({ name, role: 'maker', passcode }, crypto);
  if (!result.ok) throw new Error(`maker setup failed: ${result.reason}`);
  return result.account;
}

const ledger = async () => (await db.events.toArray()).sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));

/** One ledger row by action: rows written in the same millisecond have no order. */
async function findEvent(action: string) {
  const rows = (await db.events.toArray()).filter((r) => r.action === action);
  expect(rows, `no ${action} in the ledger`).toHaveLength(1);
  return rows[0];
}

describe('the first account', () => {
  beforeEach(reset);

  it('is the owner, and nothing can sign in before it exists', async () => {
    expect(await accountsExist()).toBe(false);
    expect(await needsOwnerSetup()).toBe(true);
    const owner = await makeOwner();
    expect(owner.role).toBe('owner');
    expect(owner.createdBy).toBeNull();
    expect(await needsOwnerSetup()).toBe(false);
  });

  it('cannot be created twice, from any screen', async () => {
    await makeOwner();
    // A second device booting from empty must join by signing in, not by making
    // itself an owner. Reusing 'name-taken' deliberately says nothing useful.
    expect(await createOwner('Someone Else', 'second owner', crypto)).toEqual({ ok: false, reason: 'name-taken' });
  });

  it('refuses a name that is blank and a passcode that is too short', async () => {
    expect(await createOwner('   ', 'trap door', crypto)).toEqual({ ok: false, reason: 'name-blank' });
    expect(await createOwner('Mik', '123', crypto)).toEqual({ ok: false, reason: 'passcode-weak' });
    expect(await accountsExist()).toBe(false);
  });

  it('stores no trace of the passcode that was typed', async () => {
    const owner = await makeOwner('Mik', 'trap door');
    const stored = await db.users.get(owner.id);
    expect(JSON.stringify(stored)).not.toContain('trap door');
    expect(stored?.passcode.iterations).toBe(210_000);
  });
});

describe('creating people', () => {
  beforeEach(reset);

  it('refuses anyone who is not the owner', async () => {
    await makeOwner();
    const sam = await addMaker();
    signedInAs({ id: sam.id, name: 'Sam' }, 'maker');
    await expect(createAccount({ name: 'Nia', role: 'viewer', passcode: 'long enough' }, crypto)).rejects.toThrow(PermissionError);
    signedInAs({ id: 'ann', name: 'Ann' }, 'viewer');
    await expect(createAccount({ name: 'Nia', role: 'viewer', passcode: 'long enough' }, crypto)).rejects.toThrow(PermissionError);
    // Nobody was created by either attempt.
    expect((await listAccounts()).map((a) => a.name)).toEqual(['Mik', 'Sam']);
  });

  it('hands out makers and viewers, and never a second owner', async () => {
    await makeOwner();
    expect((await addMaker('Sam')).role).toBe('maker');
    const office = await createAccount({ name: 'Office', role: 'viewer', passcode: 'read only' }, crypto);
    if (!office.ok) throw new Error('the office viewer should have been created');
    expect(office.account.role).toBe('viewer');
    expect(await createAccount({ name: 'Boss', role: 'owner', passcode: 'long enough' }, crypto)).toEqual({
      ok: false,
      reason: 'role-not-assignable',
    });
  });

  it('refuses a name someone else already has, however it is spelled', async () => {
    await makeOwner();
    await addMaker('Sam');
    expect(await createAccount({ name: ' sam ', role: 'viewer', passcode: 'long enough' }, crypto)).toEqual({
      ok: false,
      reason: 'name-taken',
    });
  });

  it('lists the owner first, then makers, then viewers, never a deleted account', async () => {
    await makeOwner();
    const sam = await addMaker('Sam');
    await createAccount({ name: 'Ann', role: 'viewer', passcode: 'read only' }, crypto);
    // Role before name: the owner is the person to call, then the people who make.
    expect((await listAccounts()).map((a) => a.name)).toEqual(['Mik', 'Sam', 'Ann']);
    await deleteAccount(sam.id);
    expect((await listAccounts()).map((a) => a.name)).toEqual(['Mik', 'Ann']);
    expect(await accountById(sam.id)).toBeNull();
    // The row is still there: the ledger and the merge both need to know it existed.
    expect((await db.users.get(sam.id))?.deleted).toBe(true);
  });
});

describe('signing in', () => {
  beforeEach(reset);

  it('accepts the right passcode and makes that person the principal', async () => {
    await makeOwner();
    const sam = await addMaker('Sam', 'curing rack');
    signedOut();
    const result = await signIn({ name: 'Sam', passcode: 'curing rack', deviceLabel: 'Shop phone' }, FAST);
    expect(result.ok).toBe(true);
    expect(currentPrincipal().account).toEqual({ id: sam.id, name: 'Sam' });
    expect(currentPrincipal().role).toBe('maker');
    expect(deviceId()).toBe('dev-shop');
  });

  it('remembers the device that signed in, with who was on it', async () => {
    await makeOwner();
    await signIn({ name: 'Mik', passcode: 'trap door', deviceLabel: 'Office computer' }, FAST);
    const devices = await listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ id: 'dev-shop', label: 'Office computer', revoked: false });
    expect(devices[0]?.userName).toBe('Mik');
  });

  it('is not fussed about the case someone typed', async () => {
    await makeOwner('Mik');
    signedOut();
    expect((await signIn({ name: ' MIK ', passcode: 'trap door' }, FAST)).ok).toBe(true);
  });

  it('trims a passcode, so a phone keyboard space is not a wrong code', async () => {
    await makeOwner();
    signedOut();
    expect((await signIn({ name: 'Mik', passcode: ' trap door ' }, FAST)).ok).toBe(true);
  });

  it('says the same thing about a wrong code and a name that does not exist', async () => {
    await makeOwner();
    signedOut();
    const wrong = await signIn({ name: 'Mik', passcode: 'nothing right' }, FAST);
    const ghost = await signIn({ name: 'Nobody', passcode: 'nothing right' }, FAST);
    // Telling someone which names work here is a reward for guessing.
    expect(wrong).toEqual(ghost);
    expect(wrong).toMatchObject({ ok: false, reason: 'wrong-passcode' });
    expect(currentPrincipal().account).toBeNull();
  });

  it('refuses a disabled account without touching its history', async () => {
    await makeOwner();
    const sam = await addMaker('Sam');
    await setDisabled(sam.id, true, 'left in March');
    signedOut();
    expect(await signIn({ name: 'Sam', passcode: 'curing rack' }, FAST)).toMatchObject({ ok: false, reason: 'disabled' });
    expect((await db.users.get(sam.id))?.name).toBe('Sam');
  });

  it('waits thirty seconds after five wrong codes, then lets you try again', async () => {
    await makeOwner();
    signedOut();
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      expect(await signIn({ name: 'Mik', passcode: 'wrong' }, FAST)).toMatchObject({ reason: 'wrong-passcode' });
    }
    expect(await signInWaitMs(FAST.now)).toBe(0);
    const locked = await signIn({ name: 'Mik', passcode: 'wrong' }, FAST);
    expect(locked).toMatchObject({ ok: false, reason: 'cooling-down', retryAfterMs: COOLDOWN_MS });
    expect(await signInWaitMs(FAST.now)).toBe(COOLDOWN_MS);
    // Still refused on the right code while locked: the wait is the point.
    expect((await signIn({ name: 'Mik', passcode: 'trap door' }, FAST)).ok).toBe(false);

    const later = { crypto, now: FAST.now + COOLDOWN_MS + 1 };
    expect(await signInWaitMs(later.now)).toBe(0);
    expect((await signIn({ name: 'Mik', passcode: 'trap door' }, later)).ok).toBe(true);
  });

  it('clears the wait as soon as the right code arrives', async () => {
    await makeOwner();
    signedOut();
    await signIn({ name: 'Mik', passcode: 'wrong' }, FAST);
    expect(await signIn({ name: 'Mik', passcode: 'trap door' }, FAST)).toMatchObject({ ok: true });
    expect(await signInWaitMs(FAST.now)).toBe(0);
  });

  it('signs out without inventing a person in the ledger', async () => {
    await makeOwner();
    await signOut();
    expect(currentPrincipal().account).toBeNull();
    expect(await findEvent('auth.signout')).toMatchObject({
      actor: 'Mik',
      actorId: (await accountByName('Mik'))?.id,
    });
  });
});

describe('changing an account', () => {
  beforeEach(reset);

  it('renames, and refuses a name already in use', async () => {
    const owner = await makeOwner();
    const sam = await addMaker();
    expect(await renameAccount(sam.id, 'Samuel')).toMatchObject({ ok: true });
    expect((await accountById(sam.id))?.name).toBe('Samuel');
    expect(await renameAccount(sam.id, owner.name)).toEqual({ ok: false, reason: 'name-taken' });
    expect(await renameAccount(sam.id, '  ')).toEqual({ ok: false, reason: 'name-blank' });
    expect(await renameAccount(sam.id, 'Samuel')).toMatchObject({ ok: true });
  });

  it('keeps the work stamped with the id, so a rename is not a new person', async () => {
    const owner = await makeOwner();
    const sam = await addMaker();
    const { logEvent } = await import('@/data/events');

    await signIn({ name: 'Sam', passcode: 'curing rack' }, FAST);
    await logEvent('rank.change', { detail: 'as Sam' });

    signedInAs({ id: owner.id, name: owner.name }, 'owner');
    await renameAccount(sam.id, 'Samuel');
    await signIn({ name: 'Samuel', passcode: 'curing rack' }, FAST);
    await logEvent('rank.change', { detail: 'as Samuel' });

    const rows = (await ledger()).filter((r) => r.action === 'rank.change').reverse();
    // Same id, two names: which is exactly why the ledger carries both. A row keeps
    // the name that was in force when it was written.
    expect(rows[0]).toMatchObject({ detail: 'as Sam', actor: 'Sam', actorId: sam.id });
    expect(rows[1]).toMatchObject({ detail: 'as Samuel', actor: 'Samuel', actorId: sam.id });
  });

  it('changes roles but never into an owner', async () => {
    await makeOwner();
    const sam = await addMaker();
    expect(await changeRole(sam.id, 'viewer')).toMatchObject({ ok: true });
    expect((await accountById(sam.id))?.role).toBe('viewer');
    expect(await changeRole(sam.id, 'owner')).toEqual({ ok: false, reason: 'role-not-assignable' });
  });

  it('lets anyone change their own passcode', async () => {
    await makeOwner();
    const sam = await addMaker('Sam', 'curing rack');
    signedInAs({ id: sam.id, name: 'Sam' }, 'maker');
    expect(await setPasscode(sam.id, 'a new code', crypto)).toMatchObject({ ok: true });
    signedOut();
    expect((await signIn({ name: 'Sam', passcode: 'a new code' }, FAST)).ok).toBe(true);
  });

  it('refuses a maker resetting anyone else, including the owner', async () => {
    const owner = await makeOwner();
    const sam = await addMaker('Sam');
    const ann = await createAccount({ name: 'Ann', role: 'viewer', passcode: 'read only' }, crypto);
    if (!ann.ok) throw new Error('Ann should have been created');
    signedInAs({ id: sam.id, name: 'Sam' }, 'maker');
    expect(await setPasscode(owner.id, 'take over', crypto)).toEqual({ ok: false, reason: 'not-manageable' });
    expect(await setPasscode(ann.account.id, 'take over', crypto)).toEqual({ ok: false, reason: 'not-manageable' });
    // Their own code is the one thing a maker may change.
    expect(await setPasscode(sam.id, 'my own code', crypto)).toMatchObject({ ok: true });
  });

  it('lets the owner reset someone else, and the old code stops working', async () => {
    await makeOwner();
    const sam = await addMaker('Sam', 'curing rack');
    expect(await setPasscode(sam.id, 'reset by owner', crypto)).toMatchObject({ ok: true });
    signedOut();
    expect((await signIn({ name: 'Sam', passcode: 'curing rack' }, FAST)).ok).toBe(false);
    expect((await signIn({ name: 'Sam', passcode: 'reset by owner' }, FAST)).ok).toBe(true);
  });

  it('will not disable or delete the only owner', async () => {
    const owner = await makeOwner();
    expect(await setDisabled(owner.id, true)).toEqual({ ok: false, reason: 'last-owner' });
    expect(await deleteAccount(owner.id)).toEqual({ ok: false, reason: 'last-owner' });
    expect((await accountById(owner.id))?.disabled).toBe(false);
  });

  it('disables and re-enables a maker, and says who did it', async () => {
    await makeOwner();
    const sam = await addMaker();
    await setDisabled(sam.id, true, 'not on the tools');
    expect((await accountById(sam.id))?.note).toBe('not on the tools');
    expect(await findEvent('account.disable')).toMatchObject({
      actor: 'Mik',
      actorId: (await accountByName('Mik'))?.id,
    });
    await setDisabled(sam.id, false);
    expect((await accountById(sam.id))?.disabled).toBe(false);
    expect(await signIn({ name: 'Sam', passcode: 'curing rack' }, FAST)).toMatchObject({ ok: true });
  });
});

describe('two owners created at once', () => {
  beforeEach(reset);

  it('settles on the earlier one, whichever order they arrive', async () => {
    await makeOwner();
    const early = (await listAccounts()).find((a) => a.role === 'owner')!;
    // Simulate what a merge delivers when a second device bootstrapped its own owner.
    const late: Account = {
      ...early,
      id: 'acct-later',
      name: 'Other Shop',
      createdAt: early.createdAt + 1000,
      updatedAt: early.updatedAt + 1000,
    };
    await db.users.put(late);
    const demoted = await demoteExtraOwners();
    expect(demoted.map((a) => a.id)).toEqual(['acct-later']);
    expect((await accountById('acct-later'))?.role).toBe('maker');
    expect((await accountById(early.id))?.role).toBe('owner');

    // And the other order: the record that arrives second but was created first wins.
    await db.users.put({ ...late, role: 'owner', createdAt: 10 });
    const second = await demoteExtraOwners();
    expect(second.map((a) => a.id)).toEqual([early.id]);
    expect((await accountById('acct-later'))?.role).toBe('owner');
  });

  it('does nothing when there is only one', async () => {
    await makeOwner();
    expect(await demoteExtraOwners()).toEqual([]);
  });
});

describe('devices', () => {
  beforeEach(reset);

  it('refuses to revoke anything for anyone but the owner', async () => {
    await makeOwner();
    const sam = await addMaker();
    await recordDevice({ label: 'Shop phone', userId: sam.id });
    signedInAs({ id: sam.id, name: 'Sam' }, 'maker');
    await expect(revokeDevice(deviceId())).rejects.toThrow(PermissionError);
  });

  it('stops a revoked device, and lets the owner allow it back from elsewhere', async () => {
    const owner = await makeOwner();
    await recordDevice({ label: 'Shop phone', userId: owner.id });
    const shopDevice = deviceId();

    await revokeDevice(shopDevice);
    // Revoking the machine you are standing at signs you out on the spot.
    expect(currentPrincipal().account).toBeNull();
    expect(await signIn({ name: 'Mik', passcode: 'trap door' }, FAST)).toMatchObject({
      ok: false,
      reason: 'device-revoked',
    });

    // Allowing it back has to happen on another machine — the revoked one cannot
    // sign in to un-revoke itself. That is what the lock means.
    store.set('freo.deviceId', 'dev-office');
    expect((await signIn({ name: 'Mik', passcode: 'trap door' }, FAST)).ok).toBe(true);
    await revokeDevice(shopDevice, false);

    store.set('freo.deviceId', shopDevice);
    expect((await signIn({ name: 'Mik', passcode: 'trap door' }, FAST)).ok).toBe(true);
  });

  it('signs this device out the moment it is revoked here', async () => {
    await makeOwner();
    await signIn({ name: 'Mik', passcode: 'trap door' }, FAST);
    await revokeDevice(deviceId());
    expect(currentPrincipal().account).toBeNull();
  });

  it('labels a device and keeps the newest first', async () => {
    await makeOwner();
    await db.devices.bulkAdd([
      { id: 'dev-old', label: 'Old tablet', userId: null, signedInAt: null, lastSeenAt: 100, revoked: false, updatedAt: 100 },
      { id: 'dev-shop', label: '', userId: null, signedInAt: null, lastSeenAt: 200, revoked: false, updatedAt: 200 },
    ]);
    await renameDevice('dev-shop', 'Shop phone');
    const devices = await listDevices();
    expect(devices.map((d) => d.label)).toEqual(['Shop phone', 'Old tablet']);
    expect(devices[1]?.userName).toBe('nobody yet');
  });
});

describe('the audit ledger under accounts', () => {
  beforeEach(reset);

  it('names the account and the device behind every account write', async () => {
    const owner = await makeOwner();
    await addMaker('Sam');
    const created = (await db.events.toArray()).find((r) => r.action === 'account.create' && r.detail.startsWith('Sam'));
    expect(created).toMatchObject({ actor: 'Mik', actorId: owner.id, device: 'dev-shop' });
    // The device field used to read localStorage['freo.device'] while the app wrote
    // 'freo.deviceId', so every row said the word "device". Not any more.
    expect(created?.device).not.toBe('device');
  });

  it('says nothing was done by nobody when a write happens signed out', async () => {
    await makeOwner();
    signedOut();
    const { logEvent } = await import('@/data/events');
    await logEvent('rank.change', { detail: 'signed out' });
    const row = (await ledger())[0];
    expect(row?.actor).toBe('');
    // No key at all rather than a key holding an empty string: the ledger should not
    // claim an id for someone whose id is unknown.
    expect(row && 'actorId' in row).toBe(false);
  });
});
