# Settings

`/#/settings` — what is built here today is the part that decides whether this is
one computer or a shop: the connection to the shared repository. Plus the two
figures that drive the weekly MYOB run.

## The four tiles

| Tile | Means |
| --- | --- |
| Device | The name stamped on every change in the log, so a shared screen shows who did it |
| Repository | Where the shop's data lives: the **private** `Freo-Stone/Production-App-Data`. Not the repository the app is served from, which is public |
| Token | Whether *this browser* holds a credential. It reports what is **stored**, not what is being typed, so it is the signal that a Save or a Clear actually landed |
| Pulled / pushed | The last time this device talked to GitHub, and whether it does so on its own |

## Connecting a device

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained
   token**.
2. Only select repositories → `Freo-Stone/Production-App-Data`. The app's own repository is public and must never be the target.
3. Permissions → **Contents: Read and write**. Nothing else. Set an expiry.
2. Paste it into the Token field and press **Test connection**. Tick **Test
   writing too** the first time: it writes one scratch file to `state/` and
   deletes it, which is the only check a browser can really make (below).
4. **Save**. The token belongs to this browser; the repository belongs to the app.

A new device needs the token and nothing else — owner, repository and branch come
pre-filled, so a fresh phone is connectable in under a minute.

### Why the write test has to write

GitHub reports a token's abilities in an `X-OAuth-Scopes` response header. That
header is not CORS-exposed, and this app reads the API from a different origin, so
**a browser cannot see it** — the response arrives and the header list is simply
empty. Fine-grained tokens do not send scopes at all anyway. So the honest check
is the one that attempts the write: `Test writing too` puts a scratch document at
`state/sync-probe.json` and deletes it again. A read-only token answers 403 and
the screen says so.

### Why the token is not a setting

Everything in `Settings` is merged into `state/state.json` and committed to the
repository — that is how devices share state. A token in there would be published
into the git history, visible to anyone the shop is later given access to, and
permanent in every copy ever made. So it has its own key in IndexedDB
(`github.token`), which the document builder does not read. Two tests hold that
line: `test/data.auth.test.ts` fails if the token ever appears in a document, and
`test/ui.settings.test.tsx` fails if the screen ever puts it into settings.

It also means the token does not follow the device: a new browser, a cleared site
storage, or an incognito window all need it pasted in again. That is the cost of
not storing secrets on someone else's server.

## Weekly MYOB entry

- **Entry day** — the weekday cured, blasted stock is keyed into MYOB. Friday by
  default, because that is how the shop runs it.
- **Cut-off** — an hour, 0 to 23. Stock becoming ready after that time on the
  entry day rolls to the following week's run rather than being claimed as ready
  half a day early.

Changing these changes which batches appear in the Friday list; it does not touch
anything already marked as entered.

## Not here yet

Cure defaults by line, the tray sizes, the job filters and the theme all still
live in defaults rather than on screen; they arrive with the milestones that need
them (`TASKS.md`). Nor does anything push yet: the token gets you a *tested*
connection, and the sync loop that uses it is the next step in the working order.

## Checks

- `test/data.auth.test.ts` — 6 tests: the token round-trips, an empty one forgets
  the device, it never reaches the pushed document, and every failure from GitHub
  arrives as a sentence (401, 404, 403, no scopes, no network).
- `test/ui.settings.test.tsx` — 6 tests: the repository is pre-filled, a saved
  token stays out of settings, a refusal is shown, a dead network is named,
  clearing leaves the repository alone, the entry day moves.
- `e2e/settings.spec.ts` — 6 tests × desktop, phone, Firefox. These are the tests
  that found a real defect: the client handed the browser a bare `fetch`
  reference, which Chrome and Firefox refuse to call as a method
  (`TypeError: Illegal invocation`), so every GitHub call would have failed on a
  real device while every Node-based test passed.
