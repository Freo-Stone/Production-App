/**
 * Put a test behind a login.
 *
 * Writes go through the permission check in `src/data/principal.ts`, so a test that
 * exercises a write has to be somebody. The default is a maker: enough to log
 * production and edit the range, which is what most of these tests are about. Tests
 * that are *about* the gate pass a viewer, or sign out and expect the refusal.
 *
 * No real name is used here, in any test file: this suite's fixtures are synthetic.
 */
import { useSession } from '@/app/session';
import type { AccountRole } from '@/core/types';
import { __setPrincipalForTests, signedOut } from '@/data/principal';

/**
 * Signs a test in, in both places the app keeps the answer. Screens read the role
 * from the session store because they have to re-render when it changes; the data
 * layer reads the principal because it runs outside React. A helper that set only
 * one would let a test pass with the app in a state it can never be in.
 */
export function signInForTests(role: AccountRole = 'maker', name = 'Test Person', id = `acct-${role}`): void {
  __setPrincipalForTests({ account: { id, name }, role });
  useSession.setState({ name, userId: id, role, signedInAt: Date.now() });
}

export function signOutForTests(): void {
  signedOut();
  useSession.getState().drop();
}
