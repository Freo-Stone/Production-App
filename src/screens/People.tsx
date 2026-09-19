/**
 * People and devices — the owner's screen.
 *
 * Two lists, both real tables: who can sign in, and which machines have been used.
 * They are ordinary semantic tables rather than the `DataTable` grid because that
 * engine exists for the shop's own long lists — saved column widths, sorting and
 * drag order for hundreds of rows. A handful of accounts and a handful of devices
 * want the opposite: everything visible at once, nothing to configure.
 *
 * Every action here goes through the same data layer the buttons call, which is also
 * where the permission is checked. Rendering this route at all is gated on
 * `people.manage` in `App.tsx`, but the gate that counts is the one under the button.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';

import { navigate } from '@/app/router';
import { signOutLocally, useCan } from '@/app/session';
import { passcodeAccepted, passcodeAdvice } from '@/core/passcode';
import { ASSIGNABLE_ROLES, ROLE_LABEL, ROLE_SUMMARY } from '@/core/roles';
import type { Account, AccountRole, DeviceRecord } from '@/core/types';
import {
  accountFailureText,
  changeRole,
  createAccount,
  deleteAccount,
  renameAccount,
  renameDevice,
  revokeDevice,
  setDisabled,
  setPasscode,
  type AccountFailure,
} from '@/data/accounts';
import { db } from '@/data/db';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Field,
  IconButton,
  Modal,
  Select,
  Spinner,
  TextInput,
  toast,
} from '@/ui/primitives';

/** Longest wait between a device being used and this list admitting it has not been. */
function lastSeen(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 8) return `${days} d ago`;
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

type Dialog =
  | { kind: 'add' }
  | { kind: 'rename'; account: Account }
  | { kind: 'role'; account: Account }
  | { kind: 'passcode'; account: Account }
  | { kind: 'note'; account: Account }
  | { kind: 'delete'; account: Account }
  | { kind: 'device-label'; id: string; label: string }
  | null;

export function People(): React.ReactElement {
  const canManage = useCan('people.manage');
  const accounts = useLiveQuery(() => db.users.toArray(), [], []);
  const devices = useLiveQuery(() => db.devices.toArray(), [], []);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);

  const live = accounts.filter((a) => a.deleted !== true).sort(byRoleThenName);
  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));
  const deviceCount = new Map<string, number>();
  for (const d of devices.filter((d) => d.deleted !== true)) {
    if (d.userId) deviceCount.set(d.userId, (deviceCount.get(d.userId) ?? 0) + 1);
  }

  if (!canManage) {
    return (
      <Card title="People">
        <p className="text-sm text-ink3">
          Only the owner changes who can sign in. Sign out and ask them, or go back to the
          <button type="button" className="underline decoration-line underline-offset-2" onClick={() => navigate('/')}>
            {' '}
            board
          </button>
          .
        </p>
      </Card>
    );
  }

  async function run(action: () => Promise<{ ok: boolean; reason?: AccountFailure } | void>, done: string): Promise<void> {
    setBusy(true);
    try {
      const result = await action();
      if (result && !result.ok) {
        toast('short', 'Not changed', accountFailureText((result.reason ?? 'not-manageable') as AccountFailure));
        return;
      }
      toast('info', done);
      setDialog(null);
    } catch (e) {
      toast('short', 'Not changed', e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Card
        title="People"
        actions={
          <Button icon="plus" variant="primary" onClick={() => setDialog({ kind: 'add' })}>
            Add a person
          </Button>
        }
      >
        <p className="text-xs text-ink3">
          {ROLE_LABEL.owner.toUpperCase()} hands out logins.{' '}
          {ASSIGNABLE_ROLES.map((role) => `${ROLE_LABEL[role]}s ${ROLE_SUMMARY[role].toLowerCase()}`).join('; ')}.
        </p>
        {/* The honest state of play, said on the screen rather than buried in a doc:
            logins are real on this device today. They travel inside the shop's shared
            state file, and the loop that carries that file between devices is the next
            piece of work — so a person added here is not yet on the phone. */}
        <p className="mt-1 max-w-[70ch] text-xs text-warn">
          This list lives on this device until the shop's sync loop is wired up. To give
          somebody a login on another machine, add them there too — or sign that machine
          in through &ldquo;This device is not set up yet&rdquo; once this one has been
          pushed to the repository.
        </p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink3">
                <th className="py-1.5 pr-3 font-600">Name</th>
                <th className="py-1.5 pr-3 font-600">Role</th>
                <th className="py-1.5 pr-3 font-600">Status</th>
                <th className="py-1.5 pr-3 font-600">Devices</th>
                <th className="py-1.5 pr-3 font-600">Changed</th>
                <th className="py-1.5 text-right font-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {live.map((account) => (
                <tr key={account.id} className="border-b border-line/60 last:border-0">
                  <td className="py-2 pr-3">
                    <span className="font-650">{account.name}</span>
                    {account.note !== '' ? <span className="block text-xs text-ink3">{account.note}</span> : null}
                  </td>
                  <td className="py-2 pr-3">
                    <Chip tone={account.role === 'owner' ? 'accent' : account.role === 'maker' ? 'info' : 'neutral'}>
                      {ROLE_LABEL[account.role]}
                    </Chip>
                  </td>
                  <td className="py-2 pr-3">
                    {account.disabled ? <Chip tone="short">switched off</Chip> : <Chip tone="curing">active</Chip>}
                  </td>
                  <td className="py-2 pr-3 text-ink3">{deviceCount.get(account.id) ?? 0}</td>
                  <td className="py-2 pr-3 text-xs text-ink3">
                    {lastSeen(account.updatedAt)}
                    {account.createdBy && nameOf.has(account.createdBy)
                      ? ` · added by ${nameOf.get(account.createdBy)}`
                      : account.createdBy === null
                        ? ' · first account'
                        : ''}
                  </td>
                  <td className="py-2">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton
                        icon="pencil"
                        label={`Rename ${account.name}`}
                        onClick={() => setDialog({ kind: 'rename', account })}
                      />
                      {account.role !== 'owner' ? (
                        <>
                          <IconButton
                            icon="settings"
                            label={`Change ${account.name}'s role`}
                            onClick={() => setDialog({ kind: 'role', account })}
                          />
                          <IconButton
                            icon="refresh"
                            label={`Reset ${account.name}'s passcode`}
                            onClick={() => setDialog({ kind: 'passcode', account })}
                          />
                          <IconButton
                            icon={account.disabled ? 'play' : 'pause'}
                            label={account.disabled ? `Switch ${account.name} back on` : `Switch ${account.name} off`}
                            onClick={() =>
                              void run(
                                () => setDisabled(account.id, !account.disabled, account.note),
                                account.disabled ? `${account.name} switched back on` : `${account.name} switched off`,
                              )
                            }
                          />
                          <IconButton
                            icon="trash"
                            label={`Delete ${account.name}`}
                            onClick={() => setDialog({ kind: 'delete', account })}
                          />
                        </>
                      ) : (
                        <span className="pr-1 text-xs text-ink3" title="The owner role is not handed out or taken back">
                          owner
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {live.length === 0 ? <EmptyState title="No accounts yet" body="The first one is created on the sign-in screen." /> : null}
        </div>
      </Card>

      <DeviceList
        devices={devices.filter((d) => d.deleted !== true)}
        nameOf={nameOf}
        onRename={(id, label) => setDialog({ kind: 'device-label', id, label })}
        onRevoke={(id, revoke) =>
          void (async () => {
            try {
              const { signedOutThisDevice } = await revokeDevice(id, revoke);
              if (signedOutThisDevice) {
                // The owner just took the machine they are standing at off the list.
                // The data layer has already dropped the principal; this drops the
                // saved claim, so the app falls back to the sign-in screen rather than
                // showing a board nobody is signed in to.
                signOutLocally();
                toast('warn', 'This device is off the list', 'Sign in again to carry on here.');
                return;
              }
              toast('info', revoke ? 'Device taken off the list' : 'Device allowed again');
            } catch (e) {
              toast('short', 'Not changed', e instanceof Error ? e.message : 'That did not work.');
            }
          })()
        }
      />

      {dialog?.kind === 'add' ? (
        <AddPerson
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(input) => void run(() => createAccount(input), `${input.name} can sign in`)}
        />
      ) : null}

      {dialog?.kind === 'rename' ? (
        <NameDialog
          title={`Rename ${dialog.account.name}`}
          busy={busy}
          initial={dialog.account.name}
          onClose={() => setDialog(null)}
          onSubmit={(name) => void run(() => renameAccount(dialog.account.id, name), 'Name changed')}
        />
      ) : null}

      {dialog?.kind === 'role' ? (
        <RoleDialog
          account={dialog.account}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(role) => void run(() => changeRole(dialog.account.id, role), 'Role changed')}
        />
      ) : null}

      {dialog?.kind === 'passcode' ? (
        <PasscodeDialog
          title={`${dialog.account.name}'s new passcode`}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(code) =>
            void run(() => setPasscode(dialog.account.id, code), 'Passcode reset — tell them the new one')
          }
        />
      ) : null}

      {dialog?.kind === 'delete' ? (
        <Modal
          open
          onClose={() => setDialog(null)}
          title={`Delete ${dialog.account.name}?`}
          width="sm"
          footer={
            <div className="flex gap-2">
              <Button onClick={() => setDialog(null)}>Keep them</Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void run(() => deleteAccount(dialog.account.id), `${dialog.account.name} deleted`)}
              >
                Delete
              </Button>
            </div>
          }
        >
          <p className="text-sm text-ink3">
            Their logins stop working. What they logged stays in the production log with their name on it —
            deleting an account does not delete their work.
          </p>
        </Modal>
      ) : null}

      {dialog?.kind === 'device-label' ? (
        <NameDialog
          title="Label this device"
          busy={busy}
          initial={dialog.label}
          onClose={() => setDialog(null)}
          onSubmit={async (label) => {
            await renameDevice(dialog.id, label);
            setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}

function byRoleThenName(a: Account, b: Account): number {
  const rank: Record<AccountRole, number> = { owner: 0, maker: 1, viewer: 2 };
  return rank[a.role] - rank[b.role] || a.name.localeCompare(b.name);
}

function DeviceList({
  devices,
  nameOf,
  onRename,
  onRevoke,
}: {
  devices: DeviceRecord[];
  nameOf: Map<string, string>;
  onRename: (id: string, label: string) => void;
  onRevoke: (id: string, revoke: boolean) => void;
}): React.ReactElement {
  const rows = [...devices].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return (
    <Card title="Devices">
      <p className="text-xs text-ink3">
        A device stays signed in until it signs out or is taken off the list. Taking one off stops it signing
        in again; it acts on that the next time it reaches the shop data, so an offline phone keeps what it
        already showed until then.
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink3">
              <th className="py-1.5 pr-3 font-600">Label</th>
              <th className="py-1.5 pr-3 font-600">Last signed in by</th>
              <th className="py-1.5 pr-3 font-600">Last seen</th>
              <th className="py-1.5 pr-3 font-600">Status</th>
              <th className="py-1.5 text-right font-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((device) => (
              <tr key={device.id} className="border-b border-line/60 last:border-0">
                <td className="py-2 pr-3">
                  <span className="font-650">{device.label}</span>
                  <span className="block font-mono text-xs text-ink3">{device.id}</span>
                </td>
                <td className="py-2 pr-3">{device.userId ? (nameOf.get(device.userId) ?? 'an account since deleted') : 'nobody yet'}</td>
                <td className="py-2 pr-3 text-ink3">{lastSeen(device.lastSeenAt)}</td>
                <td className="py-2 pr-3">
                  {device.revoked ? <Chip tone="short">off the list</Chip> : <Chip tone="curing">allowed</Chip>}
                </td>
                <td className="py-2">
                  <div className="flex items-center justify-end gap-1">
                    <IconButton icon="pencil" label={`Label ${device.id}`} onClick={() => onRename(device.id, device.label)} />
                    <IconButton
                      icon={device.revoked ? 'play' : 'trash'}
                      label={device.revoked ? `Allow ${device.label} again` : `Take ${device.label} off the list`}
                      onClick={() => onRevoke(device.id, !device.revoked)}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <EmptyState title="No devices yet" body="A device appears here the first time someone signs in on it." />
        ) : null}
      </div>
    </Card>
  );
}

/* ── Dialogs ───────────────────────────────────────────────────────────────── */

function AddPerson({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; role: AccountRole; passcode: string; note: string }) => void;
}): React.ReactElement {
  const [name, setName] = useState('');
  const [role, setRole] = useState<AccountRole>('maker');
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const advice = passcodeAdvice(code);
  const ready = name.trim() !== '' && passcodeAccepted(code);
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a person"
      width="sm"
      footer={
        <Button
          variant="primary"
          disabled={!ready || busy}
          onClick={() => onSubmit({ name: name.trim(), role, passcode: code, note })}
        >
          {busy ? <Spinner /> : 'Add'}
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Name" hint="What appears on the sign-in screen and on everything they log.">
          <TextInput autoFocus value={name} placeholder="e.g. Sam" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Role" hint={ROLE_SUMMARY[role]}>
          <Select
            value={role}
            options={ASSIGNABLE_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
            onChange={(e) => setRole(e.target.value as AccountRole)}
          />
        </Field>
        <Field label="Passcode" hint={advice ?? 'They can change it themselves once signed in.'}>
          <TextInput type="password" value={code} placeholder="••••••" onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Note" hint="Optional. Where they work, or why they have a login at all.">
          <TextInput value={note} placeholder="e.g. line 2, day shift" onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function NameDialog({
  title,
  initial,
  busy,
  onClose,
  onSubmit,
}: {
  title: string;
  initial: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (value: string) => void;
}): React.ReactElement {
  const [value, setValue] = useState(initial);
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      width="sm"
      footer={
        <Button variant="primary" disabled={value.trim() === '' || busy} onClick={() => onSubmit(value)}>
          {busy ? <Spinner /> : 'Save'}
        </Button>
      }
    >
      <Field label="Name">
        <TextInput autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
    </Modal>
  );
}

function RoleDialog({
  account,
  busy,
  onClose,
  onSubmit,
}: {
  account: Account;
  busy: boolean;
  onClose: () => void;
  onSubmit: (role: AccountRole) => void;
}): React.ReactElement {
  const [role, setRole] = useState<AccountRole>(account.role);
  return (
    <Modal
      open
      onClose={onClose}
      title={`${account.name}'s role`}
      width="sm"
      footer={
        <Button variant="primary" disabled={busy || role === account.role} onClick={() => onSubmit(role)}>
          {busy ? <Spinner /> : 'Change role'}
        </Button>
      }
    >
      <div className="space-y-3">
        {(['owner', ...ASSIGNABLE_ROLES] as AccountRole[]).map((r) => (
          <label key={r} className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="radio"
              name="role"
              className="mt-1"
              disabled={r === 'owner'}
              checked={role === r}
              onChange={() => setRole(r)}
            />
            <span>
              <span className="block font-650">{ROLE_LABEL[r]}</span>
              <span className="block text-xs text-ink3">
                {ROLE_SUMMARY[r]}
                {r === 'owner' ? ' — the owner role is not handed out.' : ''}
              </span>
            </span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

function PasscodeDialog({
  title,
  busy,
  onClose,
  onSubmit,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (passcode: string) => void;
}): React.ReactElement {
  const [code, setCode] = useState('');
  const advice = passcodeAdvice(code);
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      width="sm"
      footer={
        <Button variant="primary" disabled={!passcodeAccepted(code) || busy} onClick={() => onSubmit(code)}>
          {busy ? <Spinner /> : 'Set passcode'}
        </Button>
      }
    >
      <Field label="New passcode" hint={advice ?? 'Give it to them in person. Their old one stops working at once.'}>
        <TextInput autoFocus type="password" value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>
    </Modal>
  );
}
