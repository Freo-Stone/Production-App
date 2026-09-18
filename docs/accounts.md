# Logins, roles and devices

Three roles, one owner, and a device that remembers who was using it. The reason
is the shop's own: the board is on a phone and an office PC that several people
reach for, and the answer to "I don't want anyone accessing it" has to be a
passcode at the door, not a conversation.

There is no server. That single fact decides the shape of everything below, so
it is worth being exact about what a login like this is worth.

## What it keeps out, and what it does not

Passcodes are checked **on the device**, against a digest that travels inside
the shop's shared state file. No request goes anywhere when you sign in.

That means it does keep out:

- whoever picks up the phone or the office keyboard and starts changing numbers,
  production entries or the product range, without a passcode;
- a browsing session by somebody who should only ever be reading.

It does not keep out, and cannot:

- **anybody who can read the private repository.** They hold `state.json`, which
  contains the account names and the digests. Hashes are not a wall — with the
  file and patience, a weak passcode falls. Nothing here hides the shop's data
  from that person either, because the app has to be able to read that same file
  on a device to draw a screen at all.
- a person with the access token, a repository collaborator, or GitHub itself.

So treat a passcode as the shop's deadbolt, not its safe. The safe is the
private repository, and the token that reaches it. If the board ever has to be
secret from the account holder, that belongs in front of the whole site —
Cloudflare Access, a VPN, or hosting with access control — all of which cost
money or a server, and neither of which is this.

## Roles

| Capability | Owner | Maker | Viewer |
| --- | --- | --- | --- |
| Read the board, the ledger, their own views | yes | yes | yes |
| Change their own passcode | yes | yes | yes |
| Record production | yes | yes | no |
| Change the product range | yes | yes | no |
| Key stock into the MYOB queue | yes | yes | no |
| Import the MYOB exports | yes | yes | no |
| Change the shop's settings | yes | no | no |
| Add, rename, switch off or delete accounts; manage devices | yes | no | no |

The matrix is one table in `src/core/roles.ts` and is checked in a test, so a
capability cannot be added to one role by accident.

Two things follow from that table, and both are deliberate:

- **Hiding a screen is a courtesy; the write is the gate.** Every write in
  `src/data` calls `assertCan()` first and throws `PermissionError` if the role
  cannot do it. A viewer who types the settings address into the browser gets a
  refusal screen, and a viewer who gets a product patch into the console gets
  the same refusal from the code that would have written it. The nav simply does
  not offer what the role cannot open.
- **A viewer's board is the same board with nothing to click.** The pick column
  and the editable cells are replaced by the plain text an unedited cell shows a
  writer, so nothing looks broken or missing — there is just nothing to change.

## Accounts

- **One owner**, created on the device that is switched on first. It records
  `createdBy: null`, and nothing on the screen can delete it or demote it: the
  checks answer `last-owner` and `role-not-assignable`. An ownerless shop cannot
  hand out logins, so it cannot be allowed to happen.
- **Maker** is the shop-floor role and **viewer** is read-only. The owner role is
  not assignable — it cannot be handed out by accident.
- Renaming a person keeps their id, so the work they logged stays theirs.
- **Switching off** stops the sign-in and keeps the history; that is the one for
  somebody who has gone. **Deleting** writes a tombstone so other devices do not
  bring the account back.
- Anyone may change **their own** passcode, from the header menu. Changing
  somebody else's is the owner's.

## Passcodes

PBKDF2-SHA256, 210,000 iterations, a random salt per account, verified on the
device. Measured on the development machine (Windows, Chromium and Firefox):
27–31 ms and 39–46 ms per sign-in. A shop phone will take longer; the wait is
still a blink, and it is the only thing standing between a copied digest and
the passcode.

There is **no length rule**, and that is a decision rather than an omission.
`passcodeAdvice` says out loud what a short code costs — the digests are in the
shared file, so a four-digit PIN is a matter of minutes of someone's afternoon —
and then lets the owner choose anyway. A shop that wants "1234" on the yard phone
is entitled to that trade, and pretending it would be secure is the only
dishonest option available.

Guessing is slow and visible:

- five wrong attempts on a device, then a thirty-second wait, counted down on
  the button;
- the wait survives a reload, because otherwise reloading would be the way
  round it;
- an unknown name and a wrong passcode give the **same** message, so the list
  cannot be probed for who exists.

### If the owner's passcode is lost

There is no reset, and no way to build one without a back door that anyone else
could use too.

- If any device is still signed in as the owner, change it there, from the
  account menu.
- Otherwise the login list has to start again: delete the `users` and `devices`
  keys from `state/state.json` in the private repository, then clear this app's
  site data on each device (clearing storage is what removes a local copy — the
  merge protects a local account a pull has never seen, on purpose, so deleting
  accounts remotely does not reach a device by itself). The next device to open
  the app asks who the shop's owner is. Products, batches, imports and the
  ledger are untouched; only the logins go.

## Devices

A device is a browser on a machine, remembered by an id in its own storage plus
a session claim next to it. **Remembered indefinitely** is literal: nothing
expires. It lasts until the site data is cleared, or until the owner takes it off
the list.

The People screen lists every device the shop has seen — its label, who signed in
on it last, when it was last seen — and lets the owner take it off the list. Two
honest edges:

- Taking off **the device you are standing at** fires you immediately. There is
  no other sensible reading of the button.
- Taking off **another device** takes effect when that device next pulls the
  shared file. A phone that has been left in a shed with no signal keeps its
  signed-in screen until it talks to the shop again. Any app that claimed
  otherwise would be lying about a network it does not have.

Signing out from the header menu records the fact in the ledger with the name and
the device, and puts the login screen back.

## What travels where

`users` and `devices` are collections in `state/state.json` in the private
repository, merged by the same last-write-wins, tombstone, order-independent
rules as everything else (`docs/sync.md`). Two devices that each added a person
end up with both, in either order; two devices that booted from nothing at the
same moment each create an owner, and both settle on the earliest-created one
without talking to each other.

The digests travel in that file, and the file is private. Neither of those facts
makes the other one unnecessary.

## Until the sync loop runs

The mechanism is finished — the collections, the merge, the on-device checks,
the screens. What is not finished is the loop that carries `state.json` between
devices: nothing in the app pushes it yet (see the sync milestone in
`TASKS.md`). So today:

- a login created on the office PC lives on the office PC;
- a fresh device can read the logins that are already in the repository through
  the sign-in screen's "This device is not set up yet";
- the People screen says this out loud rather than letting it be discovered.

## How it is tested

| Layer | File | What it proves |
| --- | --- | --- |
| unit | `test/core.roles.test.ts` | the capability matrix, role by role |
| unit | `test/core.passcode.test.ts` | digest shape, verify, advice, constant-time compare |
| unit | `test/data.accounts.test.ts` | every account and device rule, throttling, the ledger stamp |
| unit | `test/merge.test.ts` | accounts and devices merge both ways; a `state.json` with no `users` key |
| jsdom | `test/ui.accounts.test.tsx` | the sign-in screen: owner setup, pick a person, wrong code, lockout, switched-off account; the People screen |
| browser | `e2e/accounts.spec.ts` | the whole thing in Chromium, Firefox and a phone viewport |
| browser | `e2e/dialog.spec.ts` | the account dialog's geometry, and typing without churn |

```bash
pnpm exec vitest run
pnpm exec playwright test e2e/accounts.spec.ts
```
