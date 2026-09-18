/**
 * Thin GitHub Contents API client for the shared state document.
 *
 * The repository is the merge server: `state/state.json` is written with a
 * compare-and-set on the blob sha, so a concurrent push comes back as a 409 and
 * the sync engine re-reads instead of overwriting. Exports mirrored to git
 * (xlsx) go through the same client as base64 blobs.
 *
 * Browser-only: no `Buffer`, no Node APIs. `fetchImpl` is injectable so the
 * tests can drive the whole surface without a network.
 */
import { DEFAULT_SETTINGS } from '@/core/defaults';
import { emptyDocument, STATE_DOC_VERSION, type StateDocument } from './merge';

export const STATE_PATH = 'state/state.json';
/** Scratch path for the optional write probe: one shared file, never a new one
 *  per device, so probing cannot litter the repository. */
export const PROBE_PATH = 'state/_write-check.json';

const API_VERSION = '2022-11-28';
const DEFAULT_BASE = 'https://api.github.com';
/** btoa takes a string; String.fromCharCode(...bytes) blows the argument limit
 *  on a multi-megabyte state document, so encode in 32 KiB slices. */
const B64_CHUNK = 0x8000;

/* ── Injectable fetch ──────────────────────────────────────────────────────── */

/** Deliberately narrower than `typeof fetch`: the client only needs these parts,
 *  and a fake response object can be written without Request/Response classes.
 *  The global `fetch` satisfies it. */
export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>;

/**
 * The real `fetch`, wrapped rather than handed out as a reference.
 *
 * `fetch` has to run with the window as its receiver. Stored on a class as a
 * bare reference and called as `this.fetchImpl(url)`, Chrome and Firefox throw
 * `TypeError: Illegal invocation` before the request leaves the device — which
 * reads on screen as "could not reach GitHub", on every call, forever. Node's
 * fetch does not check its receiver, so every test that injects a fake (all of
 * them, on purpose) passes while the shipped app cannot sync at all. A browser
 * test is the only thing that can see this, and it did.
 */
export const globalFetch: FetchLike = (url, init) => fetch(url, init as RequestInit | undefined);

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchResponse {
  readonly status: number;
  readonly ok?: boolean;
  readonly headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

/* ── Errors ────────────────────────────────────────────────────────────────── */

export type GitHubErrorKind = 'http' | 'unauthorized' | 'rate-limit' | 'network';

export class GitHubError extends Error {
  readonly status: number;
  readonly kind: GitHubErrorKind;
  readonly body: string;
  /** Only set for a rate limit: how long to wait before the next attempt. */
  readonly retryAfterMs: number | null;

  constructor(message: string, init: { status: number; kind: GitHubErrorKind; body?: string; retryAfterMs?: number | null }) {
    super(message);
    this.name = 'GitHubError';
    this.status = init.status;
    this.kind = init.kind;
    this.body = init.body ?? '';
    this.retryAfterMs = init.retryAfterMs ?? null;
  }
}

/** 409 on a conditional write: somebody else pushed first. `serverSha` is the
 *  sha to re-read and re-merge against. */
export class ConflictError extends GitHubError {
  readonly serverSha: string | null;

  constructor(message: string, serverSha: string | null, body: string) {
    super(message, { status: 409, kind: 'http', body });
    this.name = 'ConflictError';
    this.serverSha = serverSha;
  }
}

/* ── base64, UTF-8 safe ────────────────────────────────────────────────────── */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + B64_CHUNK, bytes.length)));
  }
  return btoa(binary);
}

/** TextEncoder first: `btoa` alone mangles anything above U+00FF — and `m²` is
 *  in almost every product description in this app. */
export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function base64ToBytes(base64: string): Uint8Array {
  // GitHub wraps base64 every 60 characters.
  const binary = atob(base64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64ToText(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64));
}

export function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/* ── Response helpers ──────────────────────────────────────────────────────── */

const isOk = (res: FetchResponse): boolean => res.ok ?? (res.status >= 200 && res.status < 300);

function headerOf(res: FetchResponse, name: string): string | null {
  return res.headers?.get(name) ?? null;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function summarise(body: string): string {
  const json = tryJson(body) as { message?: unknown } | undefined;
  const message = typeof json?.message === 'string' ? json.message : body;
  return message.slice(0, 180);
}

const isRateLimit = (res: FetchResponse, body: string): boolean =>
  headerOf(res, 'x-ratelimit-remaining') === '0' || /rate limit/i.test(body);

/** GitHub has never settled on one 409 body for a stale sha. Try an explicit
 *  `sha` field, then a bare 40-char object id anywhere in the message ("sha
 *  <oid> was not supplied", "SHA does not match"), then the documented
 *  `Link: rel="conflict"` header. */
function extractServerSha(body: string, res: FetchResponse): string | null {
  const OID = /[0-9a-f]{40}/;
  const json = tryJson(body) as { sha?: unknown } | undefined;
  const fromField = typeof json?.sha === 'string' ? json.sha.match(OID)?.[0] : undefined;
  if (fromField) return fromField;
  const fromMessage = body.match(OID)?.[0];
  if (fromMessage) return fromMessage;
  return headerOf(res, 'link')?.match(/\/commits\/([0-9a-f]{40})[^>]*>;\s*rel="conflict"/)?.[1] ?? null;
}

/** state.json is the only file this app merges, so refuse a document whose shape
 *  or version is not understood rather than merging half of it. */
export function decodeStateDocument(text: string): StateDocument {
  const raw = tryJson(text) as Partial<StateDocument> | undefined;
  if (!raw || typeof raw !== 'object') {
    throw new GitHubError('state.json is not a JSON object', { status: 200, kind: 'http', body: text.slice(0, 200) });
  }
  if (raw.version !== STATE_DOC_VERSION) {
    throw new GitHubError(`state.json version ${String(raw.version)} is not readable by this build`, {
      status: 200,
      kind: 'http',
      body: text.slice(0, 200),
    });
  }
  // A hand-edited file missing a collection reads as empty, never undefined:
  // the merge engine indexes every collection unconditionally.
  const list = <T,>(rows: T[] | undefined): T[] => rows ?? [];
  return {
    ...raw,
    version: STATE_DOC_VERSION,
    updatedAt: Number(raw.updatedAt ?? 0),
    products: list(raw.products), lines: list(raw.lines), batches: list(raw.batches),
    events: list(raw.events), planItems: list(raw.planItems), views: list(raw.views),
    users: list(raw.users), devices: list(raw.devices),
    settings: raw.settings ?? structuredClone(DEFAULT_SETTINGS),
    device: String(raw.device ?? ''),
  };
}

interface Envelope {
  sha: string;
  /** Decoded file text. */
  body: string;
}

/** The JSON envelope GitHub returns when a media type is not honoured. */
function asEnvelope(text: string): Envelope | null {
  const json = tryJson(text) as { sha?: unknown; content?: unknown; encoding?: unknown } | undefined;
  if (!json || typeof json.content !== 'string') return null;
  const encoded = json.encoding === 'base64' || (json.sha !== undefined && json.encoding === undefined);
  return {
    sha: typeof json.sha === 'string' ? json.sha : '',
    body: encoded ? base64ToText(json.content) : json.content,
  };
}

/* ── Client ────────────────────────────────────────────────────────────────── */

export interface GitHubClientOptions {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  /** Injectable for tests and for a custom `User-Agent`/retry wrapper. */
  fetchImpl?: FetchLike;
  /** GitHub Enterprise base, e.g. https://github.acme.com/api/v3 */
  baseUrl?: string;
}

export interface CommitInfo {
  sha: string;
  date: string;
  message: string;
}

export type TokenCheck =
  | { ok: true; canWrite: boolean; /** `false` means anyone on the internet can read this repository. */
      repoIsPrivate?: boolean }
  | { ok: false; reason: string };

export class GitHubClient {
  private readonly owner: string;
  private readonly repo: string;
  readonly branch: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly base: string;

  constructor(options: GitHubClientOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.branch = options.branch;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalFetch;
    this.base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  }

  /** Sent on every call, including the reads: an anonymous request spends the
   *  shared 60/hour IP quota instead of the token's, which is how a PWA ends up
   *  locked out mid-shift. */
  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      ...extra,
    };
  }

  private contentsUrl(path: string, ref: string | null): string {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const url = `${this.base}/repos/${this.owner}/${this.repo}/contents/${encoded}`;
    return ref === null ? url : `${url}?ref=${encodeURIComponent(ref)}`;
  }

  private async send(url: string, init: FetchInit): Promise<FetchResponse> {
    try {
      return await this.fetchImpl(url, init);
    } catch (cause) {
      throw new GitHubError(`could not reach GitHub at ${new URL(url).pathname}: ${String(cause)}`, { status: 0, kind: 'network' });
    }
  }

  /** 401 and the rate limit get their own kinds: the first needs a human to
   *  re-authorise, the second only needs waiting. */
  private async raise(res: FetchResponse, url: string): Promise<never> {
    const body = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new GitHubError('GitHub rejected the token (401). Re-authorise this device.', { status: 401, kind: 'unauthorized', body });
    }
    if (res.status === 403 && isRateLimit(res, body)) {
      // x-ratelimit-reset is epoch *seconds*.
      const reset = Number(headerOf(res, 'x-ratelimit-reset') ?? '');
      const retryAfterMs = Number.isFinite(reset) && reset > 0 ? reset * 1000 - Date.now() : null;
      throw new GitHubError('GitHub rate limit reached. Sync will retry on its own.', { status: 403, kind: 'rate-limit', body, retryAfterMs });
    }
    throw new GitHubError(`GitHub ${String(res.status)} on ${new URL(url).pathname}: ${summarise(body)}`, {
      status: res.status,
      kind: 'http',
      body,
    });
  }

  private async getEnvelope(path: string, ref: string | null): Promise<Envelope | null> {
    const url = this.contentsUrl(path, ref);
    const res = await this.send(url, { method: 'GET', headers: this.headers() });
    if (res.status === 404) return null;
    if (!isOk(res)) return this.raise(res, url);
    return asEnvelope(await res.text());
  }


  /**
   * Read the shared document. `null` means "nothing stored yet", which is the
   * normal state of a repository on the first sync — not an error.
   *
   * Raw media type first so a large document does not arrive base64-inflated; if
   * the server answers with the JSON envelope, that is the fallback path. A true
   * raw body carries no blob sha, and the sha is what makes putState a
   * compare-and-set, so one metadata GET supplies it.
   */
  async getState(path: string = STATE_PATH): Promise<{ sha: string; content: StateDocument } | null> {
    const url = this.contentsUrl(path, this.branch);
    const res = await this.send(url, { method: 'GET', headers: this.headers({ Accept: 'application/vnd.github.raw+json' }) });
    if (res.status === 404) return null;
    if (!isOk(res)) return this.raise(res, url);
    const text = await res.text();
    if (text.trim() === '') return null;
    const envelope = asEnvelope(text);
    if (envelope) return { sha: envelope.sha, content: decodeStateDocument(envelope.body) };
    const meta = await this.getEnvelope(path, this.branch);
    if (!meta) return null;
    return { sha: meta.sha, content: decodeStateDocument(text) };
  }

  /** Compare-and-set write. `sha: null` creates the file. */
  async putState(
    content: StateDocument,
    sha: string | null,
    message: string,
    path: string = STATE_PATH,
  ): Promise<{ sha: string }> {
    const url = this.contentsUrl(path, null);
    const payload: Record<string, unknown> = {
      message,
      branch: this.branch,
      content: textToBase64(JSON.stringify(content)),
    };
    // Omitted rather than null: there is nothing to compare against on the
    // first write, and a null sha is a validation error.
    if (sha) payload.sha = sha;
    const res = await this.send(url, {
      method: 'PUT',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (res.status === 409) {
      const body = await res.text().catch(() => '');
      throw new ConflictError(`state.json changed on ${this.branch} since it was read`, extractServerSha(body, res), body);
    }
    if (!isOk(res)) return this.raise(res, url);
    const written = tryJson(await res.text()) as { content?: { sha?: string }; commit?: { sha?: string } } | undefined;
    return { sha: written?.content?.sha ?? written?.commit?.sha ?? '' };
  }

  private async getBase64(path: string, ref: string | null): Promise<{ sha: string; bytes: Uint8Array } | null> {
    const url = this.contentsUrl(path, ref);
    const res = await this.send(url, { method: 'GET', headers: this.headers({ Accept: 'application/vnd.github.base64+json' }) });
    if (res.status === 404) return null;
    if (!isOk(res)) return this.raise(res, url);
    const json = tryJson(await res.text()) as { sha?: unknown; content?: unknown } | undefined;
    // A server that ignored the media type gives us text we cannot tell bytes
    // from, so report "no file" instead of decoding garbage into the sheet.
    if (!json || typeof json.content !== 'string') return null;
    return { sha: typeof json.sha === 'string' ? json.sha : '', bytes: base64ToBytes(json.content) };
  }

  /** Mirrored xlsx exports and other binary artifacts. */
  getBinaryFile(path: string): Promise<{ sha: string; bytes: Uint8Array } | null> {
    return this.getBase64(path, this.branch);
  }

  /**
   * What a file is worth on the server right now — its sha, without its bytes.
   *
   * A folder watch needs this before it can compare-and-set a workbook, and it must
   * not fetch the current copy to do it: that is several megabytes pulled down on
   * the shop's link to prove a file it is holding is different. The plain Contents
   * response is metadata for anything over a megabyte, so this is one small request.
   */
  async getEntrySha(path: string): Promise<string | null> {
    const envelope = await this.getEnvelope(path, this.branch);
    return envelope == null ? null : envelope.sha;
  }

  /**
   * Compare-and-set write of a binary file — the mirrored workbook.
   *
   * Same shape as `putState`, and deliberately a separate method: a workbook is
   * base64 of raw bytes, not JSON, and the two must not be confused in a call
   * signature. `sha: null` creates the file; a wrong sha comes back as
   * {@link ConflictError}, which for an export means another computer published a
   * different workbook first — a thing the shop needs to hear about, not paper
   * over.
   */
  async putBinaryFile(
    path: string,
    bytes: Uint8Array,
    sha: string | null,
    message: string,
  ): Promise<{ sha: string }> {
    const url = this.contentsUrl(path, null);
    const payload: Record<string, unknown> = {
      message,
      branch: this.branch,
      content: bytesToBase64(bytes),
    };
    if (sha) payload.sha = sha;
    const res = await this.send(url, {
      method: 'PUT',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (res.status === 409) {
      const body = await res.text().catch(() => '');
      throw new ConflictError(`${path} changed on ${this.branch} since it was read`, extractServerSha(body, res), body);
    }
    if (!isOk(res)) return this.raise(res, url);
    const written = tryJson(await res.text()) as { content?: { sha?: string }; commit?: { sha?: string } } | undefined;
    return { sha: written?.content?.sha ?? written?.commit?.sha ?? '' };
  }

  /** History of one path, newest first — the "restore from this commit" list. */
  async listCommitsFor(path: string, perPage = 20): Promise<CommitInfo[]> {
    const params = new URLSearchParams({ path, sha: this.branch, per_page: String(perPage) });
    const url = `${this.base}/repos/${this.owner}/${this.repo}/commits?${params.toString()}`;
    const res = await this.send(url, { method: 'GET', headers: this.headers() });
    if (res.status === 404) return [];
    if (!isOk(res)) return this.raise(res, url);
    const list = tryJson(await res.text()) as
      | Array<{ sha?: unknown; commit?: { message?: unknown; author?: { date?: unknown }; committer?: { date?: unknown } } }>
      | undefined;
    if (!Array.isArray(list)) return [];
    return list
      .map((c) => ({
        sha: typeof c.sha === 'string' ? c.sha : '',
        // The committer date is what moves on a rebase, and it is the order the
        // restore list is displayed in.
        date: String(c.commit?.committer?.date ?? c.commit?.author?.date ?? ''),
        message: String(c.commit?.message ?? ''),
      }))
      .filter((c) => c.sha !== '');
  }

  /** One path at an arbitrary revision. */
  getCommitFile(path: string, sha: string): Promise<{ sha: string; bytes: Uint8Array } | null> {
    return this.getBase64(path, sha);
  }

  async getCommitState(sha: string, path: string = STATE_PATH): Promise<{ sha: string; content: StateDocument } | null> {
    const file = await this.getCommitFile(path, sha);
    return file ? { sha: file.sha, content: decodeStateDocument(bytesToText(file.bytes)) } : null;
  }

  /**
   * Reachability plus a write verdict. `X-OAuth-Scopes` is only sent for classic
   * tokens, so its absence (a fine-grained PAT) is not a failure — in that case
   * only `probe: true` can answer for sure.
   */
  async validateToken(probe = false): Promise<TokenCheck> {
    const url = `${this.base}/repos/${this.owner}/${this.repo}`;
    const res = await this.send(url, { method: 'GET', headers: this.headers() });
    if (res.status === 401) return { ok: false, reason: 'Token rejected (401). Re-authorise this device.' };
    if (res.status === 403) {
      const body = await res.text().catch(() => '');
      return isRateLimit(res, body)
        ? { ok: false, reason: 'GitHub rate limit reached. Try again later.' }
        : { ok: false, reason: `Token cannot read ${this.owner}/${this.repo} (403).` };
    }
    if (res.status === 404) return { ok: false, reason: `${this.owner}/${this.repo} is not visible to this token (404).` };
    if (!isOk(res)) return { ok: false, reason: `Repository check failed with HTTP ${String(res.status)}.` };

    // The call that proves the token can see this repository also says whether
    // anybody else can. The shared state document holds customer orders, so a
    // public repository here is not a preference to be respected — see
    // `testConnection` in auth.ts, which refuses it. Left undefined when the
    // response carries no `private` field, because "unknown" must not be
    // reported as "public" or a shape change would look like a disaster.
    const body = await res.text().catch(() => '');
    let repoIsPrivate: boolean | undefined;
    try {
      const info: unknown = JSON.parse(body);
      if (
        typeof info === 'object' &&
        info !== null &&
        typeof (info as { private?: unknown }).private === 'boolean'
      ) {
        repoIsPrivate = (info as { private: boolean }).private;
      }
    } catch {
      // Not JSON, or a proxy page. Unknown is fine; the rest of the check stands.
    }
    const known = repoIsPrivate === undefined ? {} : { repoIsPrivate };

    const scopes = headerOf(res, 'x-oauth-scopes');
    // `public_repo` is not enough: state.json holds the shop's own numbers and
    // lives in a private repository, so only the full `repo` scope can write it.
    const canWrite = scopes === null ? true : scopes.split(',').some((s) => s.trim().toLowerCase() === 'repo');
    if (probe && canWrite) {
      const probed = await this.probeWrite();
      return probed.ok ? { ...probed, ...known } : probed;
    }
    return { ok: true, canWrite, ...known };
  }

  /** Last-resort answer for fine-grained tokens: write, then clean up. */
  private async probeWrite(): Promise<TokenCheck> {
    let written: { sha: string } | undefined;
    try {
      written = await this.putState(emptyDocument('probe') as StateDocument, null, 'freo: write permission probe', PROBE_PATH);
      return { ok: true, canWrite: true };
    } catch (cause) {
      const status = cause instanceof GitHubError ? cause.status : 0;
      if (status === 401) return { ok: false, reason: 'Token rejected (401). Re-authorise this device.' };
      if (status !== 0 && status < 500) return { ok: false, reason: `Token cannot write to ${this.owner}/${this.repo} (HTTP ${String(status)}).` };
      throw cause;
    } finally {
      if (written) await this.deleteQuietly(PROBE_PATH, written.sha);
    }
  }

  private async deleteQuietly(path: string, sha: string): Promise<void> {
    try {
      await this.send(this.contentsUrl(path, null), {
        method: 'DELETE',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message: 'freo: remove write permission probe', branch: this.branch, sha }),
      });
    } catch {
      // A leftover probe file is cosmetic; it must never fail the token check.
    }
  }
}
