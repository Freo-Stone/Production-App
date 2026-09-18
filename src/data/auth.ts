/**
 * This device's credentials for the shared repository.
 *
 * A token is not a setting. Everything in `Settings` is merged into the state
 * document and pushed to GitHub, so a token kept there would end up in the
 * repository's history — copied into every `state/state.json` ever written, and
 * visible to anyone the shop is later given access to. It gets its own key in
 * `meta`, which the document builder deliberately does not read; the test in
 * `test/data.auth.test.ts` fails if that ever stops being true.
 */
import type { Settings } from '@/core/types';
import { db } from '@/data/db';
import { GitHubClient, type FetchLike, type TokenCheck } from '@/data/github';

export const TOKEN_KEY = 'github.token';

export type ConnectionTest = { ok: true; canWrite: boolean; detail: string } | { ok: false; reason: string };

export async function getDeviceToken(): Promise<string> {
  const row = await db.meta.get(TOKEN_KEY);
  return typeof row?.value === 'string' ? row.value : '';
}

/** Saving an empty token forgets this device rather than storing an empty string. */
export async function setDeviceToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (trimmed === '') {
    await db.meta.delete(TOKEN_KEY);
    return;
  }
  await db.meta.put({ key: TOKEN_KEY, value: trimmed });
}

/**
 * A client for the repository in `settings`, or null when the device has not
 * been pointed at one yet — which is the normal state on a fresh install, not an
 * error. `fetchImpl` is the GitHub client's own narrow fetch shape, injected by
 * tests so nothing reaches the network.
 */
export async function clientForDevice(
  settings: Settings,
  fetchImpl?: FetchLike,
): Promise<GitHubClient | null> {
  const { githubOwner, githubRepo, githubBranch } = settings.sync;
  const token = await getDeviceToken();
  if (!token || !githubOwner.trim() || !githubRepo.trim()) return null;
  return new GitHubClient({
    owner: githubOwner.trim(),
    repo: githubRepo.trim(),
    branch: githubBranch.trim() || 'main',
    token,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/**
 * Asks GitHub whether this device can actually reach the repository, and
 * translates the failure into something a person can act on. `probe` writes a
 * scratch file to prove write access — worth doing when a token is first pasted
 * in, not on every pull.
 */
export async function testConnection(
  settings: Settings,
  options: { probe?: boolean; fetchImpl?: FetchLike } = {},
): Promise<ConnectionTest> {
  const token = await getDeviceToken();
  const { githubOwner, githubRepo } = settings.sync;
  if (!githubOwner.trim() || !githubRepo.trim()) {
    return { ok: false, reason: 'No repository set. Fill in the owner and repository first.' };
  }
  if (!token) {
    return { ok: false, reason: 'No token on this device yet. Paste one in, then test again.' };
  }

  const client = await clientForDevice(settings, options.fetchImpl);
  if (!client) return { ok: false, reason: 'Could not build a client from these settings.' };

  let check: TokenCheck;
  try {
    // Asked without the write probe first. If the repository turns out to be
    // public, nothing should be written into it — not even the probe file.
    check = await client.validateToken(false);
    if (check.ok && check.canWrite && check.repoIsPrivate !== false && options.probe === true) {
      check = await client.validateToken(true);
    }
  } catch (error) {
    // A thrown fetch means the network, not the token: the shop floor loses
    // its connection far more often than GitHub revokes a token.
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `Could not reach GitHub from this device. ${detail}` };
  }

  if (!check.ok) return { ok: false, reason: check.reason };

  // The state document is the shop's order book — customer names, quantities,
  // dates. A public repository publishes every push to the whole internet, and
  // publishes it permanently, in the history of every clone ever made. The app is
  // now served from a public repository of its own while the data lives in a
  // private one, so typing the wrong name into this field is a realistic mistake.
  // Refuse it rather than warn: a warning gets clicked past.
  if (check.repoIsPrivate === false) {
    return {
      ok: false,
      reason: `${githubOwner}/${githubRepo} is a PUBLIC repository, so writing it would publish the shop's orders to the internet. Point this at the private repository that holds the data.`,
    };
  }

  return {
    ok: true,
    canWrite: check.canWrite,
    detail: check.canWrite
      ? `${githubOwner}/${githubRepo} is reachable and this token can write to it.`
      : `${githubOwner}/${githubRepo} is readable, but this token cannot write. Set Contents to Read and write.`,
  };
}
