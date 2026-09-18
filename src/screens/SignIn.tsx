/**
 * The screen in front of everything else.
 *
 * Nobody reaches the board without a passcode, and a device that has been here
 * before comes straight back in — the session is remembered until someone signs out
 * or the owner takes the device off the list. Two situations need a screen rather
 * than a dialog, so neither is one: the shop's first account, and a device that has
 * not been pointed at the shop's data yet.
 *
 * The honest limit, stated on the screen because it is the user's to know: the
 * passcodes are checked on this device against digests that travel in the shop's
 * data file. It stops the shop floor reading each other's work and stops a stranger
 * using a found phone. It does not hide the data from someone who has the file and
 * patience — see docs/accounts.md.
 */
import { useCallback, useEffect, useState } from 'react';

import { BrandLogo } from '@/app/Brand';
import { legacyName, useSession } from '@/app/session';
import { passcodeAccepted, passcodeAdvice } from '@/core/passcode';
import { ROLE_SUMMARY } from '@/core/roles';
import type { Account } from '@/core/types';
import {
  accountFailureText,
  accountsExist,
  createOwner,
  listAccounts,
  signIn,
  signInWaitMs,
  type SignInFailure,
} from '@/data/accounts';
import { getDeviceToken, setDeviceToken, clientForDevice } from '@/data/auth';
import { db, getSettings, saveSettings, seedIfEmpty } from '@/data/db';
import { applyDocumentToDb } from '@/data/merge';
import { Icon } from '@/ui/Icon';
import { Button, Card, Field, Spinner, TextInput, toast } from '@/ui/primitives';

type Phase = 'loading' | 'pick' | 'passcode' | 'owner' | 'connect' | 'failed';

export function SignIn(): React.ReactElement {
  const [phase, setPhase] = useState<Phase>('loading');
  const [people, setPeople] = useState<Account[]>([]);
  const [chosen, setChosen] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wait, setWait] = useState(0);
  // Bumped by the retry button; the load effect depends on it.
  const [attempt, setAttempt] = useState(0);

  const refresh = useCallback(async () => {
    setPeople(await listAccounts());
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // Anything that goes wrong reading the shop's own storage lands on the 'failed'
      // screen with the reason on it. The alternative is this screen sitting on
      // "Opening the shop…" forever, which is what a rejected seed used to do, and a
      // person standing in a yard with a phone has no way to tell that from a slow app.
      await seedIfEmpty();
      if (!alive) return;
      const exists = await accountsExist();
      if (!alive) return;
      if (!exists) {
        setPhase('owner');
        return;
      }
      setPeople(await listAccounts());
      // A device left locked by five wrong codes stays locked across a reload —
      // otherwise reloading the page would be the way round the wait.
      setWait(await signInWaitMs());
      setPhase('pick');
    })().catch((reason: unknown) => {
      if (!alive) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase('failed');
    });
    return () => {
      alive = false;
    };
  }, [attempt]);

  // The cool-down counts itself down so the person can see it ending rather than
  // tapping a dead button to find out.
  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setInterval(() => setWait((ms) => Math.max(0, ms - 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [wait]);

  async function submit(name: string, passcode: string): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const settings = await getSettings();
      const result = await signIn({ name, passcode, deviceLabel: settings.deviceName });
      if (!result.ok) {
        setError(signInFailureText(result.reason, name, result.retryAfterMs));
        setWait(result.retryAfterMs ?? 0);
        return;
      }
      useSession.getState().adopt({ id: result.account.id, name: result.account.name, role: result.account.role });
      await refresh();
      // Nothing else to do: App.tsx renders the sign-in screen only while the session
      // store has no account, so adopting it swaps the app in behind this screen.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in did not work.');
    } finally {
      setBusy(false);
    }
  }

  if (phase === 'loading') {
    return (
      <Frame>
        <div className="flex items-center gap-2 text-sm text-ink3">
          <Spinner /> Opening the shop…
        </div>
      </Frame>
    );
  }

  if (phase === 'failed') {
    return (
      <Frame>
        <Card
          title="This device cannot open its own copy"
          subtitle="Nothing is lost. The shop's data is still wherever it was left."
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink2">
              The app reads its data out of this browser before it will show you anything, and
              that read failed. Usually it means another copy of the app has the database open,
              or the browser is in private mode and will not keep one.
            </p>
            <p className="text-xs text-ink2 break-all">{error}</p>
            <div>
              <Button icon="refresh" variant="primary" onClick={() => setAttempt((a) => a + 1)}>
                Try again
              </Button>
            </div>
          </div>
        </Card>
      </Frame>
    );
  }

  if (phase === 'connect') {
    return (
      <Frame>
        <ConnectDevice
          onDone={() => {
            void refresh();
          }}
          onBack={() => setPhase('pick')}
        />
      </Frame>
    );
  }

  if (phase === 'owner') {
    return (
      <Frame>
        <OwnerSetup
          onDone={async (name, passcode) => {
            await submit(name, passcode);
          }}
          error={error}
        />
      </Frame>
    );
  }

  if (phase === 'passcode' && chosen !== null) {
    return (
      <Frame>
        <PasscodePrompt
          person={chosen}
          busy={busy}
          error={error}
          waitMs={wait}
          onBack={() => {
            setChosen(null);
            setError('');
            setWait(0);
            setPhase('pick');
          }}
          onSubmit={(code) => void submit(chosen.name, code)}
        />
      </Frame>
    );
  }

  return (
    <Frame>
      <div className="w-full max-w-sm space-y-4">
        <BrandLogo />
        <p className="text-sm text-ink3">Who is on this device?</p>
        <div className="space-y-2">
          {people.map((person) => (
            <button
              key={person.id}
              type="button"
              onClick={() => {
                setChosen(person);
                setError('');
                setWait(0);
                setPhase('passcode');
              }}
              className="flex w-full items-center gap-3 rounded-[var(--radius-md)] border border-line bg-surface2 px-3 py-2.5 text-left hover:border-accent/50"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-full border border-line bg-surface3 text-sm font-700">
                {person.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-650">{person.name}</span>
                <span className="block truncate text-xs text-ink3">
                  {ROLE_SUMMARY[person.role]}
                  {person.disabled ? ' — switched off' : ''}
                </span>
              </span>
              <Icon name="chevronRight" size={16} className="text-ink3" />
            </button>
          ))}
        </div>
        <button
          type="button"
          className="text-xs text-ink3 underline decoration-line underline-offset-2"
          onClick={() => setPhase('connect')}
        >
          This device is not set up yet
        </button>
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas px-4 py-8 text-ink">
      {children}
    </div>
  );
}

function signInFailureText(reason: SignInFailure, name: string, retryAfterMs?: number): string {
  switch (reason) {
    case 'wrong-passcode':
      return `That passcode is not right for ${name.trim() || 'that name'}.`;
    case 'disabled':
      return 'That account is switched off. The owner can switch it back on.';
    case 'device-revoked':
      return 'This device has been taken off the shop list. An owner can allow it again.';
    case 'cooling-down':
      return `Too many tries. Wait ${Math.ceil((retryAfterMs ?? 0) / 1000)} seconds and try again.`;
    case 'unknown':
      return 'Something went wrong reading the accounts on this device.';
  }
}

function PasscodePrompt({
  person,
  busy,
  error,
  waitMs,
  onBack,
  onSubmit,
}: {
  person: Account;
  busy: boolean;
  error: string;
  waitMs: number;
  onBack: () => void;
  onSubmit: (passcode: string) => void;
}): React.ReactElement {
  const [code, setCode] = useState('');
  const locked = waitMs > 0;
  return (
    <div className="w-full max-w-sm space-y-4">
      <div className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full border border-line bg-surface3 text-base font-700">
          {person.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="truncate text-base font-700">{person.name}</p>
          <p className="truncate text-xs text-ink3">{ROLE_SUMMARY[person.role]}</p>
        </div>
      </div>
      <Field label="Passcode" hint="Checked on this device. Nothing is sent anywhere.">
        <TextInput
          autoFocus
          type="password"
          value={code}
          autoComplete="off"
          placeholder="••••••"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && code.trim() !== '' && !busy && !locked) onSubmit(code);
          }}
        />
      </Field>
      {error !== '' ? (
        <p role="status" className="text-xs text-short">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button icon="chevronLeft" onClick={onBack} disabled={busy}>
          Someone else
        </Button>
        <Button
          variant="primary"
          className="ml-auto"
          disabled={code.trim() === '' || busy || locked}
          onClick={() => onSubmit(code)}
        >
          {busy ? <Spinner /> : locked ? `Wait ${Math.ceil(waitMs / 1000)}s` : 'Sign in'}
        </Button>
      </div>
      <p className="text-[0.7rem] leading-snug text-ink3">
        This device stays signed in until you sign out, so a passcode is typed once per shift at most.
      </p>
    </div>
  );
}

function OwnerSetup({
  onDone,
  error,
}: {
  onDone: (name: string, passcode: string) => Promise<void>;
  error: string;
}): React.ReactElement {
  const [name, setName] = useState(() => legacyName());
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const advice = passcodeAdvice(code);
  const ready = name.trim() !== '' && passcodeAccepted(code) && code === confirm;

  return (
    <div className="w-full max-w-sm space-y-4">
      <BrandLogo />
      <div>
        <h1 className="text-lg font-700">Set up the shop</h1>
        <p className="text-sm text-ink3">
          The first account owns the setup: it hands out the other logins, changes roles, and takes devices
          off the list. Make it the person who does that — usually you.
        </p>
      </div>
      <Field label="Your name" hint="Shown on everything you log.">
        <TextInput autoFocus value={name} placeholder="e.g. Sam" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Passcode" hint={advice ?? 'At least four characters, and no one else needs to know it.'}>
        <TextInput type="password" value={code} placeholder="••••••" onChange={(e) => setCode(e.target.value)} />
      </Field>
      <Field label="Type it again">
        <TextInput
          type="password"
          value={confirm}
          placeholder="••••••"
          onChange={(e) => setConfirm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ready && !busy) void submit();
          }}
        />
      </Field>
      {localError !== '' || error !== '' ? (
        <p role="status" className="text-xs text-short">
          {localError || error}
        </p>
      ) : null}
      <Button
        variant="primary"
        className="w-full"
        disabled={!ready || busy}
        onClick={() => void submit()}
      >
        {busy ? <Spinner /> : 'Create the owner and sign in'}
      </Button>
      <p className="text-[0.7rem] leading-snug text-ink3">
        The passcode is stored as a one-way digest. Anyone holding a copy of the shop's data file can
        check guesses against it offline, so do not use a number you would write on a whiteboard.
      </p>
    </div>
  );

  async function submit(): Promise<void> {
    setBusy(true);
    setLocalError('');
    try {
      const result = await createOwner(name, code);
      if (!result.ok) {
        setLocalError(accountFailureText(result.reason));
        return;
      }
      await onDone(name.trim(), code);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }
}

/**
 * A new device with nothing on it cannot list anyone to sign in as — it has to pull
 * the shop's data first, which needs the repository and a token. Owner's job, once
 * per machine. Refuses to run over a device that already has accounts, because
 * "I typed the token in and my shop disappeared" is not a mistake to leave available.
 */
function ConnectDevice({ onDone, onBack }: { onDone: () => void; onBack: () => void }): React.ReactElement {
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [blocked, setBlocked] = useState('');

  useEffect(() => {
    void (async () => {
      const settings = await getSettings();
      setOwner(settings.sync.githubOwner);
      setRepo(settings.sync.githubRepo);
      setBranch(settings.sync.githubBranch || 'main');
      setToken(await getDeviceToken());
      if (await accountsExist()) {
        setBlocked('This device already has accounts, so there is nothing to pull over the top of.');
      }
    })();
  }, []);

  async function connect(): Promise<void> {
    setBusy(true);
    setMessage('');
    try {
      const settings = await saveSettings({
        sync: { githubOwner: owner.trim(), githubRepo: repo.trim(), githubBranch: branch.trim() || 'main' },
      });
      if (token.trim() !== '') await setDeviceToken(token.trim());
      const client = await clientForDevice(settings);
      if (!client) {
        setMessage('A repository and a token are both needed.');
        return;
      }
      const remote = await client.getState();
      if (!remote) {
        setMessage('That repository has no state yet. Open the app once on the device that has the data and push it.');
        return;
      }
      await applyDocumentToDb(db, remote.content);
      toast('info', 'Shop data pulled', 'Sign in with your own passcode.');
      await onDone();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not reach the repository.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm space-y-4">
      <div>
        <h1 className="text-lg font-700">Connect this device</h1>
        <p className="text-sm text-ink3">
          Points this machine at the shop's data so it knows who to let in. The token lives on this device
          only — it is never written into the data file.
        </p>
      </div>
      {blocked !== '' ? (
        <p role="status" className="text-xs text-warn">
          {blocked}
        </p>
      ) : null}
      <Field label="Repository owner">
        <TextInput value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="freo-stone" />
      </Field>
      <Field label="Repository">
        <TextInput value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="Production-App-Data" />
      </Field>
      <Field label="Branch">
        <TextInput value={branch} onChange={(e) => setBranch(e.target.value)} />
      </Field>
      <Field label="Token" hint="A fine-grained token that can read and write that repository's contents.">
        <TextInput type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" />
      </Field>
      {message !== '' ? (
        <p role="status" className="text-xs text-short">
          {message}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button icon="chevronLeft" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button variant="primary" className="ml-auto" disabled={busy || blocked !== ''} onClick={() => void connect()}>
          {busy ? <Spinner /> : 'Pull the shop data'}
        </Button>
      </div>
    </div>
  );
}
