// The digest is the only thing standing between a copied state document and someone
// reading the shop's numbers, so its behaviour is pinned here rather than trusted to
// a browser API being what we think it is.
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  hashPasscode,
  MAX_PASSCODE,
  MIN_PASSCODE,
  PASSCODE_ITERATIONS,
  passcodeAccepted,
  passcodeAdvice,
  normalisePasscode,
  verifyPasscode,
  type PasscodeCrypto,
} from '@/core/passcode';
import type { PasscodeDigest } from '@/core/types';

// jsdom's crypto has getRandomValues but no subtle; node's has both, and it is the
// same PBKDF2 the browser runs.
const crypto = webcrypto as unknown as PasscodeCrypto;

/** Tests use a cheap cost. The production default is asserted separately. */
const FAST = 2_000;

describe('hashPasscode', () => {
  it('produces a salted digest with the iterations it was given', async () => {
    const digest = await hashPasscode('quartz paver', crypto, FAST);
    expect(digest.iterations).toBe(FAST);
    expect(atob(digest.salt)).toHaveLength(16);
    expect(atob(digest.hash)).toHaveLength(32);
  });

  it('salts each account, so two people with the same passcode share no bytes', async () => {
    const a = await hashPasscode('quartz paver', crypto, FAST);
    const b = await hashPasscode('quartz paver', crypto, FAST);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('does not store the passcode in any recognisable form', async () => {
    const digest = await hashPasscode('quartz paver', crypto, FAST);
    const blob = `${digest.salt} ${digest.hash} ${JSON.stringify(digest)}`;
    expect(blob).not.toContain('quartz');
    expect(blob.toLowerCase()).not.toContain('paver');
  });
});

describe('verifyPasscode', () => {
  it('accepts the right passcode and refuses a wrong one', async () => {
    const digest = await hashPasscode('quartz paver', crypto, FAST);
    expect(await verifyPasscode('quartz paver', digest, crypto)).toBe(true);
    expect(await verifyPasscode('Quartz paver', digest, crypto)).toBe(false);
    expect(await verifyPasscode('quartz pave', digest, crypto)).toBe(false);
    expect(await verifyPasscode('', digest, crypto)).toBe(false);
  });

  it('reads the iterations back out of the digest', async () => {
    // A digest written by an older build must keep working after the default moves.
    const digest = { ...(await hashPasscode('trap', crypto, 500)), iterations: 500 } satisfies PasscodeDigest;
    expect(await verifyPasscode('trap', digest, crypto)).toBe(true);
    const tampered: PasscodeDigest = { ...digest, iterations: 501 };
    expect(await verifyPasscode('trap', tampered, crypto)).toBe(false);
  });

  it('reads a damaged digest as a wrong code rather than throwing', async () => {
    // A corrupt record must leave the sign-in screen standing; the owner resets it.
    const broken = [
      undefined,
      { salt: '', hash: '', iterations: FAST },
      { salt: 'not base64 at all 🙃', hash: 'also not', iterations: FAST },
      { salt: btoa('short'), hash: btoa('too short'), iterations: FAST },
      { salt: btoa('0123456789abcdef'), hash: btoa('0123456789abcdef'), iterations: 0 },
    ] as (PasscodeDigest | undefined)[];
    for (const digest of broken) {
      expect(await verifyPasscode('anything', digest, crypto), JSON.stringify(digest)).toBe(false);
    }
  });

  it('works at the iterations the app actually uses', async () => {
    // 210,000 is the whole point of the design, so at least one test pays for it.
    const started = performance.now();
    const digest = await hashPasscode('curing rack', crypto, PASSCODE_ITERATIONS);
    expect(await verifyPasscode('curing rack', digest, crypto)).toBe(true);
    expect(performance.now() - started, 'one derive plus one verify').toBeLessThan(4_000);
  }, 30_000);
});

describe('passcodeAdvice', () => {
  it('says nothing about a code that needs no comment', () => {
    expect(passcodeAdvice('quartz paver')).toBeNull();
    expect(passcodeAdvice('S3!shotblast')).toBeNull();
  });

  it('refuses a code too short to bother guessing', () => {
    expect(passcodeAdvice('abc')).toMatch(/at least 4/i);
  });

  it('is straight about a short number instead of pretending it is strong', () => {
    expect(passcodeAdvice('4917')).toMatch(/copy of the data file/i);
  });

  it('catches the codes that are not codes', () => {
    expect(passcodeAdvice('aaaa')).toMatch(/same character/i);
    expect(passcodeAdvice('12345678')).toMatch(/obvious run/i);
    expect(passcodeAdvice('abcfghij')).toBeNull();
  });

  it('will not derive a pasted novel', () => {
    expect(passcodeAdvice('x'.repeat(MAX_PASSCODE + 1))).toMatch(/under 128/i);
  });
});

describe('passcodeAccepted', () => {
  it('sets the hard floor and ceiling', () => {
    expect(passcodeAccepted('123')).toBe(false);
    expect(passcodeAccepted('1234')).toBe(true);
    expect(passcodeAccepted(' '.repeat(MIN_PASSCODE))).toBe(false);
    expect(passcodeAccepted('x'.repeat(MAX_PASSCODE))).toBe(true);
    expect(passcodeAccepted('x'.repeat(MAX_PASSCODE + 1))).toBe(false);
  });

  it('trims, so a trailing space from a phone keyboard is not a wrong code', () => {
    expect(normalisePasscode('  quartz paver  ')).toBe('quartz paver');
    expect(passcodeAccepted('  abcd  ')).toBe(true);
  });
});
