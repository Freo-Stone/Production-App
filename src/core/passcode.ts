/**
 * Turning a passcode into something safe to store, and back again for a check.
 *
 * PBKDF2-SHA256, per-account salt, 210,000 iterations. The iterations matter more
 * than they look: the digest travels in the shared state document, so anyone holding
 * a copy of that file — a backup, a laptop left open — can guess at it offline at
 * whatever speed their machine allows. 210,000 iterations costs a phone about a fifth
 * of a second to check one guess, and the same to check a million.
 *
 * That is also the honest limit of this design, spelled out in `docs/accounts.md`:
 * a four-digit code is 10,000 guesses, which no number of iterations makes slow
 * enough. A short phrase is not guessable, and still takes seconds to type on a
 * shop-floor keyboard.
 */
import type { PasscodeDigest } from './types';

/** Roughly 150–250ms on the phones in the shop. Verified, not assumed: see test/core.passcode.test.ts. */
export const PASSCODE_ITERATIONS = 210_000;

/** Floor usability versus a guessable digest. Four is the least that is worth having. */
export const MIN_PASSCODE = 4;
/** PBKDF2 cost is linear in the input; a cap keeps a paste of a novel from being derived. */
export const MAX_PASSCODE = 128;

const KEY_BYTES = 32;
const SALT_BYTES = 16;

/** The slice of WebCrypto this module needs, so a test can hand it node's own. */
export interface PasscodeCrypto {
  subtle: {
    importKey(format: 'raw', keyMaterial: Uint8Array, algorithm: 'PBKDF2', extractable: false, keyUsages: ['deriveBits']): Promise<unknown>;
    deriveBits(algorithm: { name: 'PBKDF2'; salt: Uint8Array; iterations: number; hash: 'SHA-256' }, key: unknown, length: number): Promise<ArrayBuffer>;
  };
  getRandomValues<T extends Uint8Array>(buffer: T): T;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function derive(passcode: string, salt: Uint8Array, iterations: number, crypto: PasscodeCrypto): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Byte-for-byte comparison that does not stop at the first difference. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Leading and trailing space is a keyboard accident, never part of a code. */
export function normalisePasscode(input: string): string {
  return input.trim();
}

export function hashPasscode(
  passcode: string,
  crypto: PasscodeCrypto,
  iterations = PASSCODE_ITERATIONS,
): Promise<PasscodeDigest> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return derive(passcode, salt, iterations, crypto).then((hash) => ({
    salt: toBase64(salt),
    hash: toBase64(hash),
    iterations,
  }));
}

/**
 * Checks a passcode against a stored digest. Returns false rather than throwing for
 * a digest that will not parse: a corrupt record should read as "wrong code" on the
 * floor, and the owner can reset it — it should not take the sign-in screen down.
 */
export async function verifyPasscode(
  passcode: string,
  digest: PasscodeDigest | undefined,
  crypto: PasscodeCrypto,
): Promise<boolean> {
  if (!digest || !passcode) return false;
  const salt = fromBase64(digest.salt);
  const expected = fromBase64(digest.hash);
  if (salt === null || expected === null || expected.length !== KEY_BYTES) return false;
  const iterations = Number.isFinite(digest.iterations) && digest.iterations > 0
    ? Math.min(Math.trunc(digest.iterations), 10_000_000)
    : PASSCODE_ITERATIONS;
  const actual = await derive(passcode, salt, iterations, crypto);
  return equalBytes(actual, expected);
}

/**
 * Nothing here is a password policy. It is the shop being straight about what a code
 * protects: what this app can stop is a person at a device, and a four-digit code
 * stops that fine — it is the copy of the state document that a short code cannot
 * defend. Returns null when there is nothing to say.
 */
export function passcodeAdvice(passcode: string): string | null {
  const value = normalisePasscode(passcode);
  if (value.length < MIN_PASSCODE) return `Use at least ${String(MIN_PASSCODE)} characters.`;
  if (value.length > MAX_PASSCODE) return `Keep it under ${String(MAX_PASSCODE)} characters.`;
  if (/^\d{4,6}$/.test(value)) {
    return 'That works on the shop floor. A short number like this can be guessed by anyone holding a copy of the data file — a couple of words is stronger and barely slower to type.';
  }
  if (/^(.)\1+$/.test(value)) return 'That is the same character over and over.';
  if (/^(0123|1234|2345|3456|4567|5678|6789|abcd|qwer)/i.test(value)) return 'Avoid an obvious run like that.';
  return null;
}

/** Whether a code is good enough to store at all — the hard rule, not the advice. */
export function passcodeAccepted(passcode: string): boolean {
  const value = normalisePasscode(passcode);
  return value.length >= MIN_PASSCODE && value.length <= MAX_PASSCODE;
}
