import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  base64ToText,
  bytesToBase64,
  ConflictError,
  GitHubClient,
  GitHubError,
  PROBE_PATH,
  STATE_PATH,
  textToBase64,
  type FetchInit,
  type FetchLike,
} from '@/data/github';
import { emptyDocument, type StateDocument } from '@/data/merge';
import type { Product } from '@/core/types';

/* ── Hand-written fake fetch: no network, no mocks, no monkey-patching ─────── */

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

interface Stub {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

function harness(respond: (call: Call, index: number) => Stub) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url: string, init: FetchInit = {}) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    const stub = respond(call, calls.length - 1);
    const headers = new Map(Object.entries(stub.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: stub.status ?? 200,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => stub.body ?? '',
    };
  };
  return { calls, fetchImpl };
}

function clientFor(fetchImpl: FetchLike): GitHubClient {
  const options = { owner: 'freo-stone', repo: 'production-state', branch: 'main', token: 'tok_secret', fetchImpl };
  return new GitHubClient(options);
}

const SHA_OLD = 'a'.repeat(40);
const SHA_NEW = 'b'.repeat(40);

function product(code: string, description: string): Product {
  return {
    code,
    description,
    enabled: true,
    route: 'manufacture',
    usesBaseline10000: false,
    unit: 'm2',
    trayYield: 1.44,
    target: 4752,
    cureDays: 2,
    notes: '',
    rank: 1000,
    seenInJobs: false,
    updatedAt: 1000,
  };
}

function sampleDocument(): StateDocument {
  const doc = emptyDocument('dev-floor', 1000);
  doc.products = [product('S3', 'SUPER PAVER 600x600x48mm — 1.44 m²')];
  return doc;
}

const stateJson = (doc: StateDocument): string => JSON.stringify(doc);

const envelopeOf = (doc: StateDocument, sha: string): string =>
  JSON.stringify({ name: 'state.json', sha, encoding: 'base64', content: textToBase64(stateJson(doc)) });

/** 40-hex ids of both sides, so a test can pin which one the client picked. */
async function conflictShaOf(put: (client: GitHubClient) => Promise<unknown>, message: string): Promise<string | null> {
  const { fetchImpl } = harness(() => ({ status: 409, body: JSON.stringify({ message }) }));
  const error = await put(clientFor(fetchImpl)).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConflictError);
  return (error as ConflictError).serverSha;
}

describe('getState', () => {
  it('reads the raw file and picks up the blob sha from the metadata call', async () => {
    // The raw media type carries no sha, and the sha is what makes the next push
    // a compare-and-set, so a second (cheap) GET supplies it.
    const doc = sampleDocument();
    // Answered by media type: the client's metadata re-read uses the same URL as
    // the raw read, only with the JSON Accept.
    const { calls, fetchImpl } = harness((call) =>
      call.headers.Accept === 'application/vnd.github.raw+json' ? { body: stateJson(doc) } : { body: envelopeOf(doc, SHA_OLD) },
    );

    const state = await clientFor(fetchImpl).getState();

    expect(state?.sha, 'the sha comes from the envelope, never guessed').toBe(SHA_OLD);
    expect(state?.content.products?.[0]?.description).toContain('m²');
    const paths = calls.map((c) => c.url.split('?')[0]);
    expect(paths).toEqual([
      `https://api.github.com/repos/freo-stone/production-state/contents/${STATE_PATH}`,
      `https://api.github.com/repos/freo-stone/production-state/contents/${STATE_PATH}`,
    ]);
    expect(calls[0]?.headers.Accept).toBe('application/vnd.github.raw+json');
    expect(calls[1]?.headers.Accept).toBe('application/vnd.github+json');
  });

  it('decodes the base64 envelope when the server ignores the raw media type', async () => {
    const doc = sampleDocument();
    const { calls, fetchImpl } = harness(() => ({ body: envelopeOf(doc, SHA_NEW) }));

    const state = await clientFor(fetchImpl).getState();

    expect(state?.content.products).toHaveLength(1);
    expect(state?.sha).toBe(SHA_NEW);
    expect(calls, 'the envelope already carries the sha, so no second round-trip').toHaveLength(1);
  });

  it('resolves a missing state.json to null instead of throwing', async () => {
    // An empty repository is the normal state on a device's first sync.
    const { fetchImpl } = harness(() => ({ status: 404, body: '{"message":"Not Found"}' }));
    await expect(clientFor(fetchImpl).getState()).resolves.toBeNull();
  });

  it('treats an empty blob as no state', async () => {
    const { fetchImpl } = harness(() => ({ body: '   ' }));
    await expect(clientFor(fetchImpl).getState()).resolves.toBeNull();
  });

  it('refuses a document from an unreadable schema version', async () => {
    const doc = { ...sampleDocument(), version: 99 } as unknown as StateDocument;
    const { fetchImpl } = harness(() => ({ body: envelopeOf(doc, SHA_OLD) }));
    await expect(clientFor(fetchImpl).getState()).rejects.toThrow(/version 99/);
  });
});

describe('every request is authenticated and versioned', () => {
  it('sends Bearer, Accept and X-GitHub-Api-Version on each call', async () => {
    const doc = sampleDocument();
    const { calls, fetchImpl } = harness((call) =>
      call.url.includes('/commits?')
        ? { body: '[]' }
        : call.headers.Accept === 'application/vnd.github.raw+json'
          ? { body: stateJson(doc) }
          : { body: envelopeOf(doc, SHA_OLD) },
    );
    const client = clientFor(fetchImpl);
    await client.listCommitsFor(STATE_PATH, 5);
    await client.getState();

    for (const call of calls) {
      // An anonymous request spends the shared 60/hour IP quota, which is how a
      // shop PWA ends up locked out mid-shift.
      expect(call.headers.Authorization, call.url).toBe('Bearer tok_secret');
      expect(call.headers['X-GitHub-Api-Version'], call.url).toBe('2022-11-28');
      expect(call.headers.Accept, call.url).toContain('application/vnd.github');
    }
    expect(calls[0]?.url).toContain('per_page=5');
    expect(calls.map((c) => c.url).join(), 'the token never travels in a URL').not.toContain('tok_secret');
  });
});

/* ── base64 ────────────────────────────────────────────────────────────────── */

describe('base64 is UTF-8 safe', () => {
  it('round-trips the characters this app actually stores', () => {
    // `m²` is U+00B2 (two UTF-8 bytes); a naive btoa of the string throws on it.
    const text = 'SUPER PAVER 600x600x48mm — 1.44 m² · "quotes" · 400×400 · 🧱';
    expect(base64ToText(textToBase64(text))).toBe(text);
    expect(textToBase64('m²')).toBe('bcKy');
  });

  it('round-trips arbitrary bytes and tolerates GitHub line wrapping', () => {
    const bytes = Uint8Array.from(Array.from({ length: 300 }, (_unused, i) => i % 256));
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
    expect(base64ToText('YWJj\nZGVm\r\n'), 'GitHub wraps base64 every 60 chars').toBe('abcdef');
  });

  it('writes state.json as UTF-8 base64 that reads back identically', async () => {
    const doc = sampleDocument();
    const { calls, fetchImpl } = harness(() => ({ body: JSON.stringify({ content: { sha: SHA_NEW } }) }));
    await clientFor(fetchImpl).putState(doc, SHA_OLD, 'sync');

    const sent = String(calls[0]?.body?.content);
    expect(base64ToText(sent)).toBe(stateJson(doc));
    expect(base64ToText(sent)).toContain('m²');
  });
});

/* ── Writes ────────────────────────────────────────────────────────────────── */

describe('putState', () => {
  it('does a compare-and-set with the sha it read', async () => {
    const { calls, fetchImpl } = harness(() => ({
      status: 201,
      body: JSON.stringify({ content: { sha: SHA_NEW }, commit: { sha: 'c' } }),
    }));

    const written = await clientFor(fetchImpl).putState(sampleDocument(), SHA_OLD, 'sync(dev): 3 records');

    expect(written.sha).toBe(SHA_NEW);
    const call = calls[0]!;
    expect(call.method).toBe('PUT');
    expect(call.url, 'the branch travels in the body, not ?ref=').not.toContain('?ref=');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.body?.branch).toBe('main');
    expect(call.body?.message).toBe('sync(dev): 3 records');
    expect(call.body?.sha).toBe(SHA_OLD);
  });

  it('omits the sha key entirely on the first write', async () => {
    // A null sha is a body-validation error, not "create this file".
    const { calls, fetchImpl } = harness(() => ({ status: 201, body: JSON.stringify({ content: { sha: SHA_NEW } }) }));
    await clientFor(fetchImpl).putState(sampleDocument(), null, 'seed');
    expect(Object.keys(calls[0]?.body ?? {})).not.toContain('sha');
  });

  it('surfaces a 409 as a ConflictError carrying the server sha', async () => {
    const message = `sha ${SHA_NEW} was not supplied or invalid SHA for branch main`;
    const { fetchImpl } = harness(() => ({ status: 409, body: JSON.stringify({ message }) }));

    const error = await clientFor(fetchImpl).putState(sampleDocument(), SHA_OLD, 'sync').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictError);
    expect(error, 'the engine catches the base type as well').toBeInstanceOf(GitHubError);
    expect((error as ConflictError).serverSha).toBe(SHA_NEW);
    expect((error as ConflictError).status).toBe(409);
  });

  it('still finds the server sha when GitHub only says SHA does not match', async () => {
    const sha = await conflictShaOf(
      (client) => client.putState(sampleDocument(), SHA_NEW, 'sync'),
      `SHA does not match current HEAD ${SHA_OLD} of branch main`,
    );
    expect(sha).toBe(SHA_OLD);
  });

  it('reports 401 as an expired token, not as missing state', async () => {
    const { fetchImpl } = harness(() => ({ status: 401, body: '{"message":"Bad credentials"}' }));
    const error = await clientFor(fetchImpl).getState().catch((e: unknown) => e);
    expect((error as GitHubError).kind).toBe('unauthorized');
    expect((error as GitHubError).message).toMatch(/re-authorise/i);
  });

  it('reports a rate limit separately, with how long to wait', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 600;
    const { fetchImpl } = harness(() => ({
      status: 403,
      body: '{"message":"API rate limit exceeded for 203.0.113.4."}',
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) },
    }));

    const error = await clientFor(fetchImpl).getState().catch((e: unknown) => e);

    expect((error as GitHubError).kind).toBe('rate-limit');
    expect((error as GitHubError).retryAfterMs).toBeGreaterThan(500_000);
  });

  it('does not mistake a permissions 403 for a rate limit', async () => {
    const { fetchImpl } = harness(() => ({ status: 403, body: '{"message":"Resource not accessible by personal access token"}' }));
    const error = await clientFor(fetchImpl).getState().catch((e: unknown) => e);
    expect((error as GitHubError).kind).toBe('http');
    expect((error as GitHubError).status).toBe(403);
  });

  it('turns a transport failure into a network error', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    const error = await clientFor(fetchImpl).getState().catch((e: unknown) => e);
    expect((error as GitHubError).kind).toBe('network');
    expect((error as GitHubError).status).toBe(0);
  });
});

describe('mirrored exports and history', () => {
  const xlsx = bytesToBase64(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x7f]));

  it('decodes a mirrored xlsx back to bytes', async () => {
    const { calls, fetchImpl } = harness(() => ({ body: JSON.stringify({ sha: SHA_OLD, encoding: 'base64', content: xlsx }) }));
    const file = await clientFor(fetchImpl).getBinaryFile('exports/future.xlsx');

    expect([...(file?.bytes ?? [])]).toEqual([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x7f]);
    expect(file?.sha).toBe(SHA_OLD);
    expect(calls[0]?.headers.Accept).toBe('application/vnd.github.base64+json');
  });

  it('reads the same path at an older revision for restore', async () => {
    const doc = sampleDocument();
    const { calls, fetchImpl } = harness(() => ({ body: JSON.stringify({ sha: SHA_OLD, encoding: 'base64', content: textToBase64(stateJson(doc)) }) }));

    const restored = await clientFor(fetchImpl).getCommitState(SHA_OLD);

    expect(calls[0]?.url.endsWith(`?ref=${SHA_OLD}`), 'the commit sha is the ref').toBe(true);
    expect(restored?.content.products?.[0]?.code).toBe('S3');
  });

  it('returns null for a binary file that is not there yet', async () => {
    const { fetchImpl } = harness(() => ({ status: 404, body: '{"message":"Not Found"}' }));
    await expect(clientFor(fetchImpl).getBinaryFile('exports/location.xlsx')).resolves.toBeNull();
  });

  it('lists the commits that touched a path, newest first', async () => {
    const { calls, fetchImpl } = harness(() => ({
      body: JSON.stringify([
        {
          sha: SHA_NEW,
          commit: {
            message: 'sync(dev-b): 2 record(s)',
            author: { date: '2026-09-17T01:00:00Z' },
            committer: { date: '2026-09-17T01:02:00Z' },
          },
        },
        { commit: { message: 'entry with no sha cannot be restored, so it is dropped' } },
        { sha: SHA_OLD, commit: { message: 'sync(dev-a): 1 record(s)', author: { date: '2026-09-16T23:00:00Z' } } },
      ]),
    }));

    const commits = await clientFor(fetchImpl).listCommitsFor(STATE_PATH, 10);

    expect(commits.map((c) => c.sha)).toEqual([SHA_NEW, SHA_OLD]);
    expect(commits[0]?.date, 'the committer date is what the list is ordered by').toBe('2026-09-17T01:02:00Z');
    expect(commits[1]?.date, 'falls back to the author date').toBe('2026-09-16T23:00:00Z');
    expect(calls[0]?.url).toContain('path=state%2Fstate.json');
    expect(calls[0]?.url, 'history is scoped to the sync branch').toContain('sha=main');
  });
});

/* ── Token check ───────────────────────────────────────────────────────────── */

describe('validateToken', () => {
  const repo = (scopes?: string): Stub => ({
    body: JSON.stringify({ full_name: 'freo-stone/production-state', default_branch: 'main' }),
    headers: scopes === undefined ? {} : { 'x-oauth-scopes': scopes },
  });

  it('reports whether the repository is world-readable', async () => {
    // The app is served from a public repository; the data must not be. This is
    // the only call that knows the difference, so it has to say so.
    const pub = harness(() => ({ body: JSON.stringify({ full_name: 'freo/Production-App', private: false }) }));
    await expect(clientFor(pub.fetchImpl).validateToken()).resolves.toEqual({
      ok: true,
      canWrite: true,
      repoIsPrivate: false,
    });

    const priv = harness(() => ({ body: JSON.stringify({ full_name: 'freo/Production-App-Data', private: true }) }));
    await expect(clientFor(priv.fetchImpl).validateToken()).resolves.toEqual({
      ok: true,
      canWrite: true,
      repoIsPrivate: true,
    });
  });

  it('leaves visibility unknown instead of guessing, so a shape change is not a disaster', async () => {
    // A proxy page or a body without `private` must not read as "public", which
    // would lock every device out of a perfectly good private repository.
    const h = harness(() => ({ body: '<html>corporate proxy</html>' }));
    await expect(clientFor(h.fetchImpl).validateToken()).resolves.toEqual({ ok: true, canWrite: true });
  });

  it('accepts a classic token that can write contents', async () => {
    const { calls, fetchImpl } = harness(() => repo('repo, gist'));
    await expect(clientFor(fetchImpl).validateToken()).resolves.toEqual({ ok: true, canWrite: true });
    expect(calls[0]?.url).toBe('https://api.github.com/repos/freo-stone/production-state');
  });

  it('says a read-only token cannot write', async () => {
    // `public_repo` writes public repos only; this one is the shop's private
    // state, so only `repo` counts.
    for (const scopes of ['gist', 'public_repo']) {
      const { fetchImpl } = harness(() => repo(scopes));
      await expect(clientFor(fetchImpl).validateToken()).resolves.toEqual({ ok: true, canWrite: false });
    }
  });

  it('does not fail a fine-grained token just because it hides its scopes', async () => {
    // Fine-grained PATs send no X-OAuth-Scopes header at all: absence is not a
    // negative answer.
    const { fetchImpl } = harness(() => repo());
    await expect(clientFor(fetchImpl).validateToken()).resolves.toEqual({ ok: true, canWrite: true });
  });

  it('reports a revoked token as not ok', async () => {
    const { fetchImpl } = harness(() => ({ status: 401, body: '{"message":"Bad credentials"}' }));
    const result = await clientFor(fetchImpl).validateToken();
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/401/) });
  });

  it('reports a repository the token cannot see', async () => {
    const { fetchImpl } = harness(() => ({ status: 404, body: '{"message":"Not Found"}' }));
    const result = await clientFor(fetchImpl).validateToken();
    expect(result.ok === false && result.reason).toMatch(/not visible/);
  });

  it('probes with a real write only when asked, then cleans up', async () => {
    const { calls, fetchImpl } = harness((call) => {
      if (call.method === 'PUT') return { status: 201, body: JSON.stringify({ content: { sha: SHA_NEW } }) };
      if (call.method === 'DELETE') return { status: 200, body: '{}' };
      return repo('repo');
    });

    await expect(clientFor(fetchImpl).validateToken(true)).resolves.toEqual({ ok: true, canWrite: true });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'DELETE']);
    expect(calls[1]?.url).toContain(PROBE_PATH);
    expect(calls[2]?.body?.sha, 'the probe file is deleted again, not left behind').toBe(SHA_NEW);
  });

  it('turns a refused probe write into a clear reason', async () => {
    const { calls, fetchImpl } = harness((call) =>
      call.method === 'PUT' ? { status: 403, body: '{"message":"Resource not accessible"}' } : repo(),
    );

    const result = await clientFor(fetchImpl).validateToken(true);

    expect(result.ok === false && result.reason).toMatch(/cannot write/i);
    expect(calls.map((c) => c.method), 'nothing to delete when the write failed').toEqual(['GET', 'PUT']);
  });
});


