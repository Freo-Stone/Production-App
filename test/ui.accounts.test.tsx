// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import { useSession } from '@/app/session';
import { signedOut } from '@/data/principal';
import type { Account } from '@/core/types';
import { createAccount, createOwner } from '@/data/accounts';
import { db } from '@/data/db';
import { People } from '@/screens/People';
import { SignIn } from '@/screens/SignIn';
import {
  buttonNamed,
  byText,
  click,
  fieldByLabel,
  render,
  settle,
  type Rendered,
  typeInto,
  waitUntil,
} from './support/render';
import { signInForTests, signOutForTests } from './support/who';

/**
 * The screen in front of the app, driven from the outside: what is on it, what a
 * person types, and what the device ends up believing. The rules themselves are
 * proved in test/data.accounts.test.ts — this is about the wiring between them and
 * the buttons.
 *
 * Real passcode hashing runs here. The screen uses the app's own cost, so the test
 * does too: about a fifth of a second per try, which is the point of the cost.
 */

async function reset(): Promise<void> {
  localStorage.clear();
  await Promise.all([db.users.clear(), db.devices.clear(), db.events.clear(), db.meta.clear()]);
  useSession.getState().drop();
  signedOut();
}

async function renderSignIn(): Promise<Rendered> {
  const h = render(<SignIn />);
  await settle();
  return h;
}

async function makeOwner(name = 'Test Person', passcode = 'shop floor'): Promise<Account> {
  const result = await createOwner(name, passcode);
  if (!result.ok) throw new Error(`owner setup failed: ${result.reason}`);
  return result.account;
}

describe('the sign-in screen', () => {
  beforeEach(reset);

  it('asks for the shop owner on a device that has never been set up', async () => {
    const h = await renderSignIn();
    expect(byText(h.host, 'Set up the shop')).toBeTruthy();
    expect(fieldByLabel(h.host, 'Passcode').type).toBe('password');
    h.unmount();
  });

  it('will not create an owner on a passcode it has warned about', async () => {
    const h = await renderSignIn();
    typeInto(fieldByLabel(h.host, 'Your name'), 'Test Person');
    typeInto(fieldByLabel(h.host, 'Passcode'), '123');
    typeInto(fieldByLabel(h.host, 'Type it again'), '123');
    await settle(2);

    const submit = buttonNamed(h.host, 'Create the owner');
    expect(submit.disabled).toBe(true);
    expect((await db.users.toArray()).length).toBe(0);
    h.unmount();
  });

  it('creates the owner, signs the device in, and puts the name on the ledger', async () => {
    const h = await renderSignIn();
    typeInto(fieldByLabel(h.host, 'Your name'), 'Test Person');
    typeInto(fieldByLabel(h.host, 'Passcode'), 'shop floor');
    typeInto(fieldByLabel(h.host, 'Type it again'), 'shop floor');
    await settle(2);

    click(buttonNamed(h.host, 'Create the owner'));
    await waitUntil(() => useSession.getState().userId !== null, 'the device to sign itself in');

    const account = (await db.users.toArray())[0];
    if (!account) throw new Error('no account was created');
    expect(account).toMatchObject({ name: 'Test Person', role: 'owner', disabled: false });
    expect(useSession.getState()).toMatchObject({ name: 'Test Person', userId: account.id, role: 'owner' });

    const devices = await db.devices.toArray();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ userId: account.id, revoked: false });

    const signedIn = (await db.events.toArray()).find((e) => e.action === 'auth.signin');
    expect(signedIn).toMatchObject({ actor: 'Test Person', actorId: account.id });
    h.unmount();
  });

  it('lists the people who can sign in, and signs the one you pick in', async () => {
    const owner = await makeOwner();
    signInForTests('owner', owner.name, owner.id);
    const sam = await createAccount({ name: 'Test Maker', role: 'maker', passcode: 'mixing bench' });
    if (!sam.ok) throw new Error('the maker should have been created');
    signOutForTests();

    const h = await renderSignIn();
    expect(byText(h.host, 'Test Person').textContent).toContain('Test Person');
    expect(byText(h.host, 'Test Maker').textContent).toContain('Test Maker');

    click(buttonNamed(h.host, 'Test Maker'));
    await settle(2);
    typeInto(fieldByLabel(h.host, 'Passcode'), 'mixing bench');
    click(buttonNamed(h.host, 'Sign in'));
    await waitUntil(() => useSession.getState().userId === sam.account.id, 'Test Maker to be signed in');

    expect(useSession.getState()).toMatchObject({ name: 'Test Maker', userId: sam.account.id, role: 'maker' });
    h.unmount();
  });

  it('says the passcode is wrong and stays signed out', async () => {
    await makeOwner();
    signOutForTests();

    const h = await renderSignIn();
    click(buttonNamed(h.host, 'Test Person'));
    await settle(2);
    typeInto(fieldByLabel(h.host, 'Passcode'), 'not the code');
    click(buttonNamed(h.host, 'Sign in'));
    await waitUntil(
      () => (h.host.textContent ?? '').includes('That passcode is not right'),
      'the wrong-passcode message',
    );

    expect(byText(h.host, 'That passcode is not right').textContent).toContain('Test Person');
    expect(useSession.getState().userId).toBeNull();
    h.unmount();
  });

  it('locks the device after five wrong goes and counts the wait out loud', async () => {
    await makeOwner();
    signOutForTests();

    const h = await renderSignIn();
    click(buttonNamed(h.host, 'Test Person'));
    await settle(2);
    // Between attempts the screen returns to an editable field; while the passcode is
    // being checked the button shows a spinner and has no label at all, so "answered"
    // means either the field is back or the lock message has arrived.
    const answered = (): boolean => {
      const text = h.host.textContent ?? '';
      if (text.includes('Too many tries')) return true;
      return [...h.host.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('Sign in'));
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      typeInto(fieldByLabel(h.host, 'Passcode'), `wrong ${attempt}`);
      click(buttonNamed(h.host, 'Sign in'));
      // The screen settles back to an editable field between attempts; the fifth one
      // leaves the wait showing instead, which is what the assertions below read.
      await waitUntil(answered, `attempt ${attempt} to be answered`);
      if ((h.host.textContent ?? '').includes('Too many tries')) break;
    }
    const sign_in = buttonNamed(h.host, 'Wait');
    expect(sign_in.disabled).toBe(true);
    // Counting down from the app's own thirty seconds, not a made-up number.
    expect(sign_in.textContent).toMatch(/Wait (2[5-9]|30)s/);
    h.unmount();
  });

  it('refuses a switched-off account without letting anyone in', async () => {
    const owner = await makeOwner();
    signInForTests('owner', owner.name, owner.id);
    const sam = await createAccount({ name: 'Test Maker', role: 'maker', passcode: 'mixing bench' });
    if (!sam.ok) throw new Error('the maker should have been created');
    const { setDisabled } = await import('@/data/accounts');
    await setDisabled(sam.account.id, true, 'left in March');
    signOutForTests();

    const h = await renderSignIn();
    click(buttonNamed(h.host, 'Test Maker'));
    await settle(2);
    typeInto(fieldByLabel(h.host, 'Passcode'), 'mixing bench');
    click(buttonNamed(h.host, 'Sign in'));
    await waitUntil(() => (h.host.textContent ?? '').includes('switched off'), 'the switched-off message');

    expect(byText(h.host, 'switched off')).toBeTruthy();
    expect(useSession.getState().userId).toBeNull();
    h.unmount();
  });
});

describe('the people screen', () => {
  beforeEach(reset);

  it('shows the owner who can sign in and who is on which device', async () => {
    const owner = await makeOwner();
    signInForTests('owner', owner.name, owner.id);
    await db.devices.put({
      id: 'dev-test',
      label: 'Shop phone',
      userId: owner.id,
      signedInAt: Date.now(),
      lastSeenAt: Date.now(),
      revoked: false,
      updatedAt: Date.now(),
    });

    const h = render(<People />);
    await waitUntil(() => (h.host.textContent ?? '').includes('Shop phone'), 'the device list to arrive');

    expect(byText(h.host, 'Shop phone')).toBeTruthy();
    expect(byText(h.host, 'Test Person')).toBeTruthy();
    expect(h.host.querySelectorAll('table')).toHaveLength(2);
    h.unmount();
  });

  it('refuses anybody who is not the owner, in its own words', async () => {
    signInForTests('maker');
    const h = render(<People />);
    await settle();
    expect(byText(h.host, 'Only the owner changes who can sign in')).toBeTruthy();
    expect(h.host.querySelectorAll('table')).toHaveLength(0);
    h.unmount();
  });
});

