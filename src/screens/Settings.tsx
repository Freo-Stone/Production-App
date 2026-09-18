import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getDeviceToken, setDeviceToken, testConnection, type ConnectionTest } from '@/data/auth';
import { getSettings, saveSettings } from '@/data/db';
import { Button, Card, Chip, Field, NumberInput, Select, TextInput, Tile, Toggle, toast } from '@/ui/primitives';

/**
 * Settings, starting with the part that decides whether this app is one device
 * or a shop: the connection to the shared repository.
 *
 * Two rules shape the screen. The token is kept apart from `Settings` (see
 * `data/auth.ts`) because settings are pushed to GitHub, so a token in there
 * would be published to the shop's own history. And nothing here is saved behind
 * your back — the fields are a draft until you press Save, because a stray
 * keystroke in a repository name silently points a device at the wrong shop.
 */

const WEEKDAYS = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '0', label: 'Sunday' },
];

function ago(ms: number | null): string {
  if (ms == null) return 'never';
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${String(mins)} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  return new Date(ms).toLocaleDateString('en-AU');
}

export function Settings() {
  const settings = useLiveQuery(() => getSettings(), []);
  const [token, setToken] = useState('');
  // What is actually stored, so "unsaved changes" can be worked out honestly.
  const [storedToken, setStoredToken] = useState('');
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [probing, setProbing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ConnectionTest | null>(null);

  // The settings row arrives a tick after the first paint, so the draft is
  // seeded once it lands. `dirty` then compares against the same baseline.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!settings || seeded) return;
    setOwner(settings.sync.githubOwner);
    setRepo(settings.sync.githubRepo);
    setBranch(settings.sync.githubBranch);
    void getDeviceToken().then((stored) => {
      setToken(stored);
      setStoredToken(stored);
      setSeeded(true);
    });
  }, [settings, seeded]);

  const repoDirty =
    settings != null &&
    (owner !== settings.sync.githubOwner ||
      repo !== settings.sync.githubRepo ||
      branch !== settings.sync.githubBranch ||
      token.trim() !== storedToken);

  const saved = useMemo(
    () => (settings ? `${ago(settings.sync.lastPulledAt)} / ${ago(settings.sync.lastPushedAt)}` : '—'),
    [settings],
  );

  if (!settings) return null;
  // Past the guard, so the render below can read the settings it needs without
  // asking whether they exist forty times.
  const sync = settings.sync;

  const saveRepository = async (): Promise<void> => {
    await saveSettings({
      sync: { githubOwner: owner.trim(), githubRepo: repo.trim(), githubBranch: branch.trim() || 'main' },
    });
    await setDeviceToken(token);
    setStoredToken(token.trim());
    setResult(null);
    toast('info', 'Repository saved', `${owner.trim()}/${repo.trim()} on ${branch.trim() || 'main'}`);
  };

  const runTest = async (): Promise<void> => {
    setChecking(true);
    // Test against what is on screen, not what was saved, so a typo is caught
    // before it becomes the repository this device keeps failing to reach.
    const against = {
      ...settings,
      sync: {
        ...settings.sync,
        githubOwner: owner.trim(),
        githubRepo: repo.trim(),
        githubBranch: branch.trim() || 'main',
      },
    };
    const stored = await getDeviceToken();
    const current = token.trim();
    if (current !== stored) await setDeviceToken(current);
    const test = await testConnection(against, { probe: probing });
    setResult(test);
    setChecking(false);
  };

  const forgetDevice = async (): Promise<void> => {
    await setDeviceToken('');
    setToken('');
    setStoredToken('');
    setResult(null);
    toast('info', 'Token cleared from this device', 'The repository and everything in it are untouched.');
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Tile label="Device" value={settings.deviceName} sub="shown on every change in the log" />
        <Tile
          label="Repository"
          value={sync.githubOwner && sync.githubRepo ? `${sync.githubOwner}/${sync.githubRepo}` : 'Not set'}
          sub={`branch ${sync.githubBranch}`}
          tone={sync.githubOwner && sync.githubRepo ? 'curing' : 'short'}
        />
        {/* Reports what is *stored*, not what is being typed: this tile is the
            signal that a save or a clear actually reached this device. */}
        <Tile
          label="Token"
          value={storedToken ? 'On this device' : 'Not set'}
          sub="kept locally — never sent anywhere but GitHub"
          tone={storedToken ? 'curing' : 'short'}
        />
        <Tile label="Pulled / pushed" value={saved} sub={sync.autoPush ? 'auto-push on' : 'auto-push off'} />
      </div>

      <Card
        title="This device"
        subtitle="What the shop sees when something changes, and whether this device pushes on its own."
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Device name" className="w-64">
            <TextInput
              value={settings.deviceName}
              onChange={(e) => void saveSettings({ deviceName: e.target.value })}
              placeholder="Shop floor PC"
            />
          </Field>
          <Toggle
            checked={settings.sync.autoPush}
            onChange={(autoPush) => void saveSettings({ sync: { autoPush } })}
            label="Push changes on its own"
            hint="Off means nothing leaves this device until you press Sync."
          />
        </div>
      </Card>

      <Card
        title="Shared repository"
        subtitle="Private, and not the one the app is served from. It holds the shop's state and the MYOB exports."
        actions={
          <Button size="sm" variant="primary" disabled={!repoDirty} onClick={() => void saveRepository()}>
            Save
          </Button>
        }
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Owner" className="w-44">
            <TextInput value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Freo-Stone" />
          </Field>
          <Field label="Repository" className="w-52">
            <TextInput value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="Production-App-Data" />
          </Field>
          <Field label="Branch" className="w-32">
            <TextInput value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
          </Field>
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field
            label="Token"
            className="w-80"
            hint="Fine-grained, this repository only, Contents: Read and write."
          >
            <TextInput
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="github_pat_…"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Toggle
            checked={probing}
            onChange={setProbing}
            label="Test writing too"
            hint="Writes one scratch file to state/. Proves the token before a real push."
          />
          <Button size="sm" icon="cloud" loading={checking} onClick={() => void runTest()}>
            Test connection
          </Button>
        </div>

        {result ? (
          <div className="mt-3">
            <Chip tone={result.ok ? (result.canWrite ? 'curing' : 'warn') : 'short'}>
              {result.ok ? result.detail : result.reason}
            </Chip>
          </div>
        ) : null}

        <p className="mt-3 text-xs text-ink3">
          The token lives in this browser only. It is not part of the settings that sync, so it never reaches the
          repository or its history — but it is also why each device has to be given one.
        </p>
      </Card>

      <Card
        title="Weekly MYOB entry"
        subtitle="The run of cured and blasted stock that gets keyed into MYOB."
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Entry day" className="w-44" hint="Stock becomes ready for this day's run.">
            <Select
              value={String(settings.myobEntry.entryWeekday)}
              options={WEEKDAYS}
              onChange={(e) => void saveSettings({ myobEntry: { entryWeekday: Number(e.target.value) } })}
            />
          </Field>
          <Field label="Cut-off" className="w-32" hint="Later than this rolls to the following week.">
            <NumberInput
              value={settings.myobEntry.cutoffHours}
              min={0}
              max={23}
              unit="hrs"
              onValueChange={(cutoffHours) =>
                void saveSettings({ myobEntry: { cutoffHours: cutoffHours ?? settings.myobEntry.cutoffHours } })
              }
            />
          </Field>
        </div>
      </Card>

      <Card title="Forget this device" subtitle="For a shared or borrowed machine.">
        <Button size="sm" icon="trash" onClick={() => void forgetDevice()}>
          Clear the token
        </Button>
      </Card>
    </div>
  );
}
