// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Settings } from '@/core/types';
import { getDeviceToken, setDeviceToken, testConnection } from '@/data/auth';
import { db, seedIfEmpty } from '@/data/db';
import { DEFAULT_SETTINGS } from '@/core/defaults';
import { documentFromDb } from '@/data/merge';
import type { FetchLike } from '@/data/github';

/** One canned answer per call, in the shape the GitHub client reads. */
function respondWith(...stubs: Array<{ status?: number; headers?: Record<string, string>; body?: string }>): FetchLike {
  let index = 0;
  return async () => {
    const stub = stubs[Math.min(index, stubs.length - 1)] ?? {};
    index += 1;
    const headers = new Map(Object.entries(stub.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: stub.status ?? 200,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => stub.body ?? '',
    };
  };
}

function settingsWith(over: Partial<Settings['sync']> = {}): Settings {
  return { ...DEFAULT_SETTINGS, sync: { ...DEFAULT_SETTINGS.sync, ...over } };
}

async function reset(): Promise<void> {
  await Promise.all([db.products.clear(), db.events.clear(), db.meta.clear(), db.views.clear()]);
  await seedIfEmpty();
}

describe('device token', () => {
  beforeEach(reset);

  it('round-trips a token and treats an empty one as forgetting', async () => {
    expect(await getDeviceToken()).toBe('');

    await setDeviceToken('  github_pat_123  ');
    expect(await getDeviceToken()).toBe('github_pat_123');

    await setDeviceToken('   ');
    expect(await getDeviceToken()).toBe('');
    expect(await db.meta.get('github.token')).toBeUndefined();
  });

  it('refuses a public repository without writing one byte to it', async () => {
    // The app now lives in a public repository while the data lives in a private
    // one. Typing the app's own name into the data field would publish the order
    // book, so it is refused — and refused before the write probe, not after.
    await setDeviceToken('github_pat_public_repo');
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ full_name: 'Freo-Stone/Production-App', private: false }),
      };
    };

    const result = await testConnection(settingsWith(), { probe: true, fetchImpl });
    expect(result.ok, 'a public repository is never an acceptable target').toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/PUBLIC repository/);
    // The store question comes first, then one look at the repository, and never a
    // write. Something else answering `/api/health` is not a shop server either —
    // it has to say so — which is why the probe appears here at all.
    expect(calls.filter((c) => c.startsWith('PUT'))).toEqual([]);
    expect(calls[0]).toBe('GET /api/health');
    expect(calls.filter((c) => c.includes('repos/'))).toHaveLength(1);
  });

  it('accepts a private repository and goes on to probe the write', async () => {
    await setDeviceToken('github_pat_private_repo');
    const methods: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      return {
        status: 200,
        headers: { get: () => null },
        text: async () =>
          method === 'GET'
            ? JSON.stringify({ full_name: 'Freo-Stone/Production-App-Data', private: true })
            : JSON.stringify({ commit: { sha: 'abc123' }, content: { sha: 'def456' } }),
      };
    };

    const result = await testConnection(settingsWith(), { probe: true, fetchImpl });
    expect(result.ok).toBe(true);
    expect(methods.filter((m) => m === 'PUT').length, 'the probe wrote once').toBe(1);
  });

  it('never appears in the document that gets pushed to GitHub', async () => {
    // The whole reason the token is not a field in Settings: settings are merged
    // into the state document, and that document is committed to the repository
    // and kept forever. A token in there is a published secret.
    const token = 'github_pat_shall_not_be_published';
    await setDeviceToken(token);
    await db.products.put({
      code: 'S3',
      description: 'S3 paver',
      enabled: true,
      route: 'manufacture',
      usesBaseline10000: false,
      unit: 'm2',
      trayYield: 1,
      target: 0,
      cureDays: 2,
      notes: '',
      rank: 1000,
      seenInJobs: false,
      updatedAt: 1,
    });

    const doc = await documentFromDb(db, { device: 'Shop floor PC', now: 1 });
    const wire = JSON.stringify(doc);

    expect(wire).not.toContain(token);
    expect(wire).not.toContain('github.token');
    // …while the settings that *are* synced still travel.
    expect(doc.settings.sync.githubRepo).toBe('Production-App-Data');
  });
});

describe('test connection', () => {
  beforeEach(reset);

  it('says what is missing before it calls anything', async () => {
    let called = 0;
    const counting: FetchLike = async () => {
      called += 1;
      return { status: 200, headers: { get: () => null }, text: async () => '' };
    };

    expect(await testConnection(settingsWith({ githubRepo: '' }), { fetchImpl: counting })).toEqual({
      ok: false,
      reason: 'No repository set. Fill in the owner and repository first.',
    });

    const noToken = await testConnection(settingsWith(), { fetchImpl: counting });
    expect(noToken.ok).toBe(false);
    expect(!noToken.ok ? noToken.reason : '').toContain('No token on this device');
    expect(called).toBe(0);
  });

  it('saves the token, then reports what GitHub said', async () => {
    await setDeviceToken('tok');

    const rejected = await testConnection(settingsWith(), {
      fetchImpl: respondWith({ status: 401, body: 'Bad credentials' }),
    });
    expect(!rejected.ok && rejected.reason).toContain('401');

    const invisible = await testConnection(settingsWith(), { fetchImpl: respondWith({ status: 404 }) });
    expect(!invisible.ok && invisible.reason).toContain('not visible to this token');

    const forbidden = await testConnection(settingsWith(), { fetchImpl: respondWith({ status: 403 }) });
    expect(!forbidden.ok && forbidden.reason).toContain('cannot read Freo-Stone/Production-App-Data');
  });

  it('distinguishes a token that can read from one that can write', async () => {
    await setDeviceToken('tok');

    const classic = await testConnection(settingsWith(), {
      fetchImpl: respondWith({ status: 200, headers: { 'x-oauth-scopes': 'read:user' } }),
    });
    expect(classic).toMatchObject({ ok: true, canWrite: false });
    expect(classic.ok && classic.detail).toContain('cannot write');

    // A fine-grained token sends no scopes header, so absence is not a failure.
    const fine = await testConnection(settingsWith(), { fetchImpl: respondWith({ status: 200 }) });
    expect(fine).toMatchObject({ ok: true, canWrite: true });
    expect(fine.ok && fine.detail).toContain('Freo-Stone/Production-App-Data');
  });

  it('calls a network failure a network failure', async () => {
    await setDeviceToken('tok');
    const down: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };

    const result = await testConnection(settingsWith(), { fetchImpl: down });
    expect(!result.ok && result.reason).toContain('Could not reach GitHub from this device');
  });
});
