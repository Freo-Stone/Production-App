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
   GitHub Actions**. Once, and only once. (Done for `Production-App`. A brand-new
   repository needs it again, and the deploy job fails until someone does — it is
   the only step in the whole setup a token cannot do.)
2. Push to `main`. The `Deploy` workflow runs the tests, builds with the right base
   path, checks the build output, and publishes. A red `main` never reaches a phone.
3. The site is `https://freo-stone.github.io/Production-App/`.

### What the build check actually does

`scripts/check-build.mjs` resolves references instead of grepping for strings: every
`src` and `href` in the built page, every icon and the `start_url` in the manifest,
and the service worker. It also asserts what an installer asks for — a PNG of at
least 192px and one of at least 512px, plus a maskable icon — and finally that the
build output contains no state document, no spreadsheet and no CSV.

It also checks that a script the page itself loads registers the service worker, and
that the page does not ask for a registration script the build no longer emits. The
first version of that check searched every emitted file, and `sw.js` contains the
string "sw.js" in its own sourcemap comment — so a build whose page registered
nothing at all passed it. Checks that scan everything tend to pass by accident.

It is here because the manifest shipped for a day listing only an SVG and a 180px
iOS icon. The page loaded, the manifest returned 200, every old grep passed, and a
phone would simply never have offered the install. Everything the manifest lists is
drawn by `scripts/make-brand.py` from the shop's own logo file, so the icon set
cannot drift from the mark in the tab — and the script stops if the logo it is given
has different colours in it than the ones it draws.

### Installing it on the shop devices

Browser menu → Install. The installed app and the URL are the same program.

**A new version is offered, never applied from under you.** When the app changes, a
device that is open at the time gets a *New version available* toast with a Reload
button, and carries on running the version it has until somebody taps it. The
alternative is a device reloading itself in the middle of someone's entry — which is
what the previous configuration did, about a second after the page opened. A device
that was off when you deployed picks the new files up on its next visit with a
connection: the toast appears, and simply closing and reopening the app is enough on
its own, because a waiting worker takes over once nothing is using the old one.
`pnpm run check:worker` checks both halves — that the app never reloads itself, and
that an update is still offered and still applies when asked for.

**Know this about privacy.** This repository is public, deliberately: free hosting
on an organisation account is not available, and a public *source* repository is the
cheapest way to have the app at all. That is only safe because nothing in it is
yours — no state document, no exports, no token, and the fixtures the parsers are
tested against are synthetic workbooks built by `test/support/buildWorkbook.ts`.
Everything derived from the real exports is gitignored, so a clone cannot contain it
by accident. Treat the app as public: anyone who reads the code learns how the shop
works, and nothing about what it sold or to whom. The data in the private
`Production-App-Data` repository stays private, and the artifact rule — only `dist/`
is ever published — is what keeps the two apart even if someone later moves a file
about.

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
