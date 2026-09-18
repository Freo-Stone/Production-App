# Where the data lives, and how a device joins

Two repositories, because free hosting and private data do not fit in the same
one. GitHub Pages on an organisation repository is a paid feature, so the app is
published from a **public** repository while everything about the shop stays in a
**private** one:

```
Freo-Stone/Production-App          public — the app
└── src/ …                         the source, the tests, the deploy workflow

Freo-Stone/Production-App-Data     private — the shop
├── state/state.json               the shared production state   ← written by the app
└── exports/
    ├── location.xlsx              stock on hand, from MYOB      ← written by the mirror
    └── future.xlsx                open sales orders, from MYOB  ← written by the mirror
```

Settings points at the **data** repository, and the app refuses to write one that
reports itself public — see "Why a public repository is refused" below. Pages
serves the built output only (`dist/`, as a workflow artifact): no state document,
no spreadsheets, nothing from the data repository ever reaches the site.

### Why a public repository is refused

The order book is not a thing to publish by accident, and typing the app's own
name into the data-repository field is the likeliest way to do it now that the two
sit side by side. The connection test reads the repository's `private` flag from
the same call that proves the token can see it, and refuses outright:

> `Freo-Stone/Production-App` is a PUBLIC repository, so writing it would publish
> the shop's orders to the internet. Point this at the private repository that
> holds the data.

It refuses *before* the write probe, so not even the scratch file is committed.
And it only refuses what it can see: if GitHub ever changes the shape of that
response the app treats visibility as unknown rather than assuming the worst, so
a device is never locked out of a good repository by a guess.

## What is where

| Thing | Lives in | Why |
| --- | --- | --- |
| Everything entered on a device | that browser's IndexedDB (`freo-production`) | the app must work with the network down |
| The shared copy of that state | `state/state.json` | a git commit is the audit trail, and a blob sha is a free optimistic lock |
| Stock and open jobs | the two `.xlsx` files MYOB produces | MYOB is the authority for those numbers |
| Settings, product decisions, views | IndexedDB, then the state document | yours, not MYOB's |

A write is local first. The sync engine then pushes when there is a moment:
after an idle window, at most once per rate-limit window, immediately on
reconnect or when you press Sync. A push that collides comes back as **409**,
which is not an error — it means someone else committed first, so the engine
rereads, merges, and pushes again. No device ever overwrites another's work.

## Connecting a device

A device needs one thing the app cannot guess: permission to write to the
repository. That is a **fine-grained personal access token**.

1. GitHub → your avatar → **Settings** → **Developer settings** →
   **Personal access tokens** → **Fine-grained token** → Generate new token.
2. Repository access: **Only select repositories** → `Freo-Stone/Production-App-Data`. Not the app repository — a device never writes source.
3. Permissions: **Contents → Read and write**. Nothing else. No
   `delete_repo`, no administration, no user-level permissions.
4. Expiry: set one, and diarise it. An expired token shows up as a 401.
5. Paste the token into the app's Settings screen on that device. It is stored
   in that browser only — never in the build, never in `state.json`, never in
   the git history.

Owner and repository default to `Freo-Stone` / `Production-App-Data`, so a new device
normally needs the token and nothing else.

> **Status:** the Settings screen takes the token and tests it against GitHub
> (`docs/screens/settings.md`), but nothing pushes yet — the sync loop that uses a
> tested connection is the next step in `TASKS.md`. Until it runs, each device
> keeps its data to itself, and the checks below describe the intended behaviour.

A browser cannot read GitHub's `X-OAuth-Scopes` response header — it is not
CORS-exposed, and this app calls the API from another origin. So write access is
proven by attempting a write, which is what **Test writing too** does: one scratch
file at `state/sync-probe.json`, written and deleted.

## Hosting

1. Repository → **Settings** → **Pages** → Build and deployment → **Source:
   GitHub Actions**. Once, and only once.
2. Push to `main`. The `Deploy` workflow runs the tests, builds with the right
   base path, and publishes.
3. The site is `https://freo-stone.github.io/Production-App/`.

Install it on the shop devices (browser menu → Install). The installed app and
the URL are the same program; the service worker updates it by itself, so a
device that was off when you deployed picks up the change on the next visit
with a connection.

**Know this about privacy.** Pages from a private repository gives you a URL
that is not listed anywhere, but it is not behind your login unless the plan
includes Pages access control. Treat the *app* as public-but-obscure — which is
safe, because the bundle contains no data and no token. The *data* in
`state/state.json` and `exports/` is genuinely private, and stays that way as
long as the Pages artifact remains `dist/`. Do not change the workflow to
publish the repository contents.

## How to check it is working

**Deployment**

1. Repository → **Actions** → Deploy → the newest run should be green, with
   `Unit tests` and `Built page points at the site base` both passing.
2. Open the site and hard-reload (Ctrl+Shift+R). Import screen appears; the
   version in Settings matches the commit you pushed.
3. If the page is blank, open the console. Asset URLs beginning `/assets/`
   rather than `/Production-App/assets/` mean the build lost its base path.

**Sync between two devices** — once the loop is wired:

1. On device A, change something small — tick a product Current.
2. Repository → commits: a new commit touching `state/state.json` within about
   fifteen seconds.
3. On device B, press Sync (or wait for the pull interval). The tick appears.
4. Settings shows the last pull and push times. Both should be recent on a
   device with a connection.

**What each failure means**

| Symptom | Meaning | Fix |
| --- | --- | --- |
| 401 | token expired, revoked or wrong | issue a new token, paste it again |
| 404 on the repository | token cannot see this repo | repository access on the token does not include `Production-App-Data` |
| 403 | token is valid but Contents is read-only | set Contents to Read and write |
| Stays "offline" | no network, or the browser blocked storage | check the connection; do not use private browsing mode |
| The other device never updates | it never pushed | check its last-push time and its token |

Two devices editing the **same product field** at the same moment: the merge
takes the later change per field, and the audit log keeps both lines, so nothing
is silently lost.
