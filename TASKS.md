# Build plan

The plan of record for the production app. Status is written from the code and
the test run, not from intention — if it says done, the checks below pass.

Commands (all from the project root):

```
pnpm run typecheck    # tsc on the app and the node config
pnpm test             # vitest, jsdom + fake-indexeddb, 260 tests
pnpm run build        # typecheck + vite build into dist/
pnpm run e2e          # playwright: desktop, phone, firefox against a preview build
```

`pnpm run e2e` needs `dist/` from `pnpm run build`; the config starts
`vite preview --port 4173 --strictPort` itself and reuses one already running.

## Working order from here

Chosen so each step ends with something you can use, and nothing leans on work
that has not happened yet.

1. **Device connect** (first slice of M8) — **done**, see M8 below. Settings holds
   the repository, the branch and a token, and Test connection answers with a real
   reason. The token has its own IndexedDB key, never a field inside `Settings`, so
   it cannot travel into `state/state.json` and into the shared history.
   **Hosting** — also **done**: `https://freo-stone.github.io/Production-App/`
   publishes from `main`, with the tests gating the build and a build check that
   resolves everything the page and manifest point at.
2. **Sync loop** — start `createSyncEngine` when a token exists, feed its status
   to the header pill, flush on Save and on reconnect. Two devices then share
   production without either overwriting the other.
3. **Live exports** — **done** (M11): the app pulls `exports/location.xlsx` and
   `exports/future.xlsx` from the repository while it is open, compares the blob
   sha, and imports whichever changed.
4. **Matrix (M4)** — **done**: the product × day view, which production entry
   builds on. See M4 below.
5. **Production entry (M5)**, then **curing and shotblast (M6)**, then the
   **Friday MYOB queue (M7)**, then the rest of Settings.

Each one is finished with unit tests, a jsdom test where there is a screen, an
e2e test where only a browser can tell the truth, and a page in `docs/screens/`.

---


## M0 — Shell · done

Vite 6 + React 19 + TypeScript strict, Tailwind v4, hash router, PWA precache.

- `src/app/nav.ts` is one navigation model for the desktop rail and the mobile
  tab bar, so the two cannot disagree about what exists.
- `Shell.tsx` (rail, tab bar, More sheet, sync pill, theme flip), `router.ts`,
  `session.ts`, `theme.ts`, `uiState.ts`, `useView.ts`, `useMediaQuery.ts`.
- Verified by `e2e/shell.spec.ts` (rail navigates, theme survives a reload).

## M1 — Local data and sync · done

IndexedDB is the source of truth; GitHub is the shared copy. Nothing waits on
the network before the screen is usable.

- `src/data/db.ts` Dexie schema + `seedIfEmpty`; `events.ts` audit trail.
- `merge.ts` state document, dirty queue, three-way merge, event log merge.
- `github.ts` Contents API client, compare-and-set on the blob sha, 409 → reread.
- `syncEngine.ts` pull → merge → push with injected clock and fetch.
- Verified by `test/merge.test.ts`, `test/github.test.ts`, `test/syncEngine.test.ts`.

## M2 — MYOB exports in, tables that behave · done

- `src/lib/myob/*` parses `location.xlsx` (stock) and `future.xlsx` (open sales
  orders). Real fixtures in `test/fixtures/real/` with the counts pinned in
  `test/fixtures/verifiedNumbers.json`.
- `importFlow.ts` + `merge.ts` decide what replaces what on a re-import.
- `src/ui/DataTable` is the table engine both tables use: virtual rows, sticky
  columns, per-column sort (multi-key with shift), width drag + keyboard nudge,
  hide/pin, row drag-and-drop, personal-vs-shared views through `useView`.
- Verified by `test/data.import.test.ts`, `test/table.render.test.tsx`,
  `e2e/import.spec.ts` (including width and hidden-column persistence).

## M3 — Products: which codes are ours · done

The exports carry ~2,300 codes and no idea which ones this shop makes. Products
is where that gets answered, and where the making details live — MYOB owns the
description, the shop owns everything else.

- `src/screens/Products.tsx`, `src/screens/ProductDrawer.tsx`,
  `src/data/productRepo.ts`, `src/ui/cellEditors.tsx`.
- Opt-in: an import never enables a code. `seenInJobs` marks what is in an open
  order; `enabled` is the shop's decision.
- Per code: route (make only / make + blast), unit (m2, lm, pieces…), whether it
  counts against the 10,000 baseline, tray yield, target, cure days, notes.
- Bulk edit by picking rows; CSV out and back in for the whole set of decisions;
  drag order as a personal or shared view.
- Verified: `test/data.products.test.ts` (12), `test/ui.cellEditors.test.tsx` (8),
  `test/ui.products.test.tsx` (5), `e2e/products.spec.ts` (6, desktop + phone +
  firefox) — including row reorder by pointer and by keyboard.

Fixed along the way, and worth keeping in mind for the screens still to come:
two edits a moment apart used to lose one of them. `patchProduct` read the row,
changed one field and wrote the row back, so target and tray yield typed in
quick succession both started from the same original and the slower write erased
the faster one. Every read-modify-write in the app (products, ranks, settings)
now runs inside one IndexedDB transaction, guarded by the concurrency tests in
`test/data.products.test.ts` and `test/data.settings.test.ts`.

Open thread: the drawer's earliest-supply date is passed as `null` — the
earliest-ready-date maths does not exist yet and belongs with curing (M5/M6).

## M4 — Matrix: product against day · done

The main view: a row per current product, a column per calendar day, one number per
product-day, and the colour of the row saying whether it needs making.

- `src/core/matrix.ts` (the arithmetic) and `src/screens/Matrix.tsx` (the board),
  wired to `/#/` in `src/App.tsx`.
- **Two rules hold the whole thing up.** MYOB's *Units On Hand* is already net of the
  open jobs, so a day cell adds up promises and never re-subtracts them — adding a
  400-unit job leaves the stock columns untouched, and a test says so. And "needs
  making" comes from the product's **target**, not from the sum of its jobs, which is
  what decides red or green. Both are written into the header of `matrix.ts` and
  pinned by name in `test/core.matrix.test.ts`.
- Code and product pinned to the left; days scroll under them. Horizon 1 / 2 / 4 / 6
  weeks on the person's own view, so it comes back after a reload and does not
  move anyone else's board. Day columns are generated, and `resolveColumns` keeps a
  saved view sane across that — widths for keys that still exist, new keys appended,
  vanished keys dropped.
- Short / needs curing / at target as row colour, `!` on a day whose last startable
  date has passed, `·` on an empty day, **Beyond** for promises outside the view and
  placeholder dates (4/04/2040) left out of the cells altogether.
- Tap a day → that number and every job line behind it; tap the row → the whole
  product, day by day inside the view. Both reach **Open in Products**, and
  `Products.tsx` now honours `?code=` so the jump lands on the drawer, not at the
  top of 2,365 codes.
- Phone: the product, where it stands, and the next four days. Forty-two columns
  sideways on a 390px screen is not a board.
- Verified: `test/core.matrix.test.ts` (15), `test/ui.matrix.test.tsx` (11),
  `e2e/matrix.spec.ts` (5 over desktop + phone + firefox), `docs/screens/matrix.md`.
  The browser tests name no volume — they sort the board to find the row carrying
  demand, so they still pass the week the numbers change.

Two things the tests caught, both now fixed, both worth remembering:

* **A phone board with no days on it.** The short list a phone shows is matched
  against the column keys, and the two sides spelled them differently — the list
  said `2026-09-18`, the columns said `d1789689600000`. Every day column silently
  vanished. `matrixDayKey()` in `src/core/matrix.ts` now says it once.
* **A button that picked nothing.** `Pick all N` on Products fires while the board's
  four live queries are still answering, and in that moment `shown` is empty: the
  click set the selection to nothing and the label blinked to `Pick all 0`. The
  control now appears only when there is something to pick, and the table's spinner
  waits for all four queries instead of two, so a board that is still arriving does
  not read as an empty one.

Open thread: entering production from here. The matrix is a reading of the exports;
the numbers typed into it come with M5.

## M5 — Production entry

Five lines (three machines, handmade, shotblast), trays of a per-product size,
curing clock starting at entry. `qtyFromTrays`/`traysFromQty` and
`readyAt`/`isCureComplete` already exist in `calc.ts`.

## M6 — Curing and shotblast views

What is curing and until when, what is waiting to be blasted, and what becomes
ready. `blastingCompletesCure` in settings decides whether blasting ends curing
early.

## M7 — MYOB entry queue

One weekday a week, **Friday** — confirmed, and it is already the default in
`core/defaults.ts` with a cut-off time. Ready stock is dated to that run, copied out as
CSV/TSV/XLSX for keying, and marked entered so it leaves the queue until the
next export replaces it.

## M8 — Settings · started

**Done — device connect and the weekly run** (`/#/settings`, `docs/screens/settings.md`):

- Repository owner, name and branch, pre-filled with the private data repository;
  a new device needs a token and nothing else.
- Token storage in `data/auth.ts` under `meta/github.token`, deliberately outside
  `Settings`: settings are merged into the state document and committed, so a token
  in there would be published into git history. Asserted both ways — the document
  built from the database must not contain it, and the screen must not put it there.
- Test connection, with GitHub's refusals translated (`401` re-authorise, `404` not
  visible to this token, `403` cannot read, thrown fetch = no network).
- **Test writing too**: a browser cannot read `X-OAuth-Scopes` — not CORS-exposed,
  and the API is another origin — so write access is proven by writing
  `state/sync-probe.json` and deleting it.
- Entry day (Friday) and cut-off hour.
- 6 unit + 6 jsdom + 6 × 3 browser tests.

**Still to do:** the sync loop that uses a tested connection, the export pull, and
the rest of the keys — cure defaults, the five lines and tray sizes, which stock
locations count, default view per screen. Most already exist in
`core/defaults.ts`; the screen does not.

## M9 — Hosting · done. The mirrored exports · still a manual drop

Two repositories, because free hosting and private data do not share a box:
`Freo-Stone/Production-App` is **public** (source, tests, deploy workflow, the
Pages site) and `Freo-Stone/Production-App-Data` is **private** (the state
document and the mirrored exports) and is the default in `core/defaults.ts`, so a
device only ever needs a token.

GitHub Pages on a private organisation repository is not available on this plan —
the choice was paid hosting, the shop's own server, or a public source repository,
and a public source repository it is. That made one thing a real risk: writing the
state document into the public repository, which would publish the order book for
good. So `testConnection` reads the repository's `private` flag and refuses a
public one before it probes the write (unit, jsdom and browser tests, the last one
counting that no PUT is attempted). Everything derived from the real exports —
`test/local/` and `test/fixtures/real/` — is gitignored, because the numbers in
them are the shop's actual stock and sales; the published suite is built entirely
from synthetic workbooks and is green with those folders absent (157 tests), and
green with them present (170).

Done:

- `.github/workflows/deploy.yml` — tests gate the build, `scripts/check-build.mjs`
  checks the output, then `dist/` goes to Pages under the repository's own base path.
  Live and verified: page, bundle, stylesheet, manifest, service worker and every
  icon fetch over HTTPS from the published site, and no `state/`, `exports/` or
  spreadsheet reachable through the site URL.
- `docs/sync.md` — the repo layout, the fine-grained token a device needs, what
  each failure means, and the check steps for deployment and for two devices
  syncing.
- `docs/power-automate.md` — mirroring the two MYOB exports into `exports/`,
  starting from "drop them in by hand", with the Power Automate expressions and a
  check for each step.

Still to do:

- The sync loop (working order 2), then Sources pulling the exports (working
  order 3). Until then the spreadsheets are dropped into the data repository by
  hand and the app never pushes.
- Power Automate mirroring the exports, once the pull exists to consume them.
- The first push: this working copy has no `.git` yet.

## M10 — Logins, roles and devices · done, with one thread

Asked for as: *"can we have a login for each user, as i do not want anyone
accessing. My account can be the account that can edit all logins and change.
delete etc. i want each device to be able to be remembered indefinately."*
Decided with the shop first: accounts live **in the app** (not Cloudflare Access,
not a token per person), three roles — **owner, maker, viewer** — and every entry
in the ledger stamped with who did it.

- `src/core/roles.ts` — one capability matrix, checked role by role in a test.
  `src/core/passcode.ts` — PBKDF2-SHA256, 210,000 iterations, per-account salt,
  verified on the device; 27–31 ms in Chromium and 39–46 ms in Firefox on the
  development machine.
- `src/data/principal.ts` — who is signed in, and the gate. `assertCan()` throws
  `PermissionError` and sits as the first statement of every write in `src/data`
  that a viewer must not make. This is module state rather than React state on
  purpose: `src/data` may import `src/core` but never `src/app`, and the
  signed-in person is not something the data layer should have to be told.
- `src/data/accounts.ts` — accounts, passcodes, devices, the sign-in throttle
  (five tries, thirty seconds, survives a reload), and `demoteExtraOwners`,
  which settles two owners created on two devices at once on the
  earliest-created one, so the merge stays commutative.
- `users` and `devices` are collections in the shared document: merged, tombstoned
  and read through `withCollections`, so the `state.json` sitting in the
  repository today — written before accounts existed — still reads.
- `src/app/session.ts` version 2 — the claim this browser remembers, re-checked
  against the account list every time the app opens: missing, switched off,
  renamed or re-roled means the claim goes. Nothing expires, which is what
  "remembered indefinitely" asked for.
- Screens: `SignIn.tsx` (owner setup on a clean device, person list, passcode,
  cool-down, connect-a-device, and a real failure screen), `People.tsx` (two
  ordinary tables, deliberately not the grid engine, with the reason in the
  header comment), the account menu in the header replacing the old name dialog.
- `src/App.tsx` refuses gated routes by role with a plain "Not this screen", and
  the nav does not offer them at all. A viewer's Products board has no pick
  column and no editable cells — the same text an unedited cell shows a writer.
- Verified: 248 unit tests (accounts 33, roles 10, passcode 14, accounts-and-
  devices merge 5, sign-in and People screens in jsdom 9, settings and seeding 5
  new), 118 browser tests across desktop, phone and firefox — 9 of them
  `e2e/accounts.spec.ts`, which drives the whole feature through the screens:
  owner setup, a wrong code and the lockout, handing out a viewer login, the
  smaller app that viewer gets, a typed-in `/settings` address, the read-only
  board, a maker's own passcode changed and the old one refused, and this device
  taken off the list under its own feet.

Two real bugs came out of building it, both first seen as test failures:

- **`signOut()` logged nobody.** It cleared the principal before writing the
  ledger row, so every `auth.signout` line said an anonymous device had signed
  out. It writes the line first now.
- **A brand-new device never got past its loading screen.** `seedIfEmpty()`
  counted the production lines, found none, and `bulkAdd`ed the five defaults —
  and both the app shell and the sign-in screen behind it asked for that in the
  same tick, so both passed the count and the second add failed with
  `ConstraintError`. The promise rejected, nothing was listening, and the
  spinner spun. 243 unit tests passed because they await one call at a time. It
  coalesces concurrent callers now, adds only ids that are genuinely absent, and
  a loser in a race with a second window checks the outcome instead of throwing.
  The three tests in *first-run seeding* call it two and three ways at once.

Thread, said on the People screen as well as here: **nothing pushes the shared
file yet**, so a login created on one device is not on another one until the sync
loop (working order 2) runs. The collections, the merge and the read path are
finished; the loop is not.

## M11 — The exports arrive on their own · done

Asked for as: *"i want these spreadsheets to auto import when changed"*, with the
Data sources screen as the picture. The limit that had to be said out loud first
is the one the whole design rests on: there is no server, so "when changed" means
the next time an app is open and online on a device holding the token. A closed
laptop notices nothing.

- `src/data/exportSync.ts` — the check. GitHub's Contents API hands back a blob
  sha, so an unchanged file costs one request and writes nothing; a different sha
  is parsed and pushed through the **same** `commitImport` a hand-drop uses, so
  there is one set of import rules rather than two. The sha is only recorded when
  the import succeeded, which is what makes an interrupted mirror upload retry
  itself instead of being marked seen and lost. The two files are read one after
  the other because each import rewrites one mirror and then reads both.
  Concurrent callers share one run, the same way first-run seeding does.
- `src/app/exportWatch.ts` — the timer: a few seconds after opening, then on the
  interval, on reconnect, and when a backgrounded tab comes back stale. The
  interval is read from Settings each tick, so changing it needs no reload.
- `src/screens/SourcesAutoImport.tsx` — the card: the switch, the interval, the
  two paths, and per file whether it is up to date, when it came in with how many
  rows, or what went wrong. `Check now` skips the sha shortcut.
- Declines are reasons, not exceptions: switched off, signed in as a viewer, no
  token, offline. A timer that logged a refusal every fifteen minutes would be
  noise, so `exportWatchBlocker` answers the question in the words the card
  shows, and `commitImport` still asserts for real.
- Every device imports for itself against its own last sha, which is why this
  works today without the sync loop — and stays correct once it exists, because
  two devices importing one file produce identical rows and a merge of identical
  content changes nothing.
- Verified: 260 unit tests (12 new in `test/data.exportSync.test.ts` — first
  import, unchanged skip, only-the-changed-file, retry after an unreadable file,
  a file that goes missing, the viewer / switched-off / no-token declines, one run
  shared by concurrent callers, the persisted state), 6 in
  `test/ui.autoImport.test.tsx`, and `e2e/exports.spec.ts` (4) across desktop,
  phone and firefox.

Two things the browser caught that the unit tests could not:

- **The toast host was inside the shell.** `Toaster` is mounted by `Shell`, and
  the sign-in screen is rendered *instead of* the shell — so every toast raised
  while the login was on screen was pushed into a host that was not there,
  including the service worker's "new version available". `pnpm run check:worker`
  failed on exactly that, and the host is mounted in `main.tsx` above the app now.
- **A test that reloads before a write lands proves nothing.** Asserting the
  persisted interval after a reload passed while the switch did not: the click
  resolves before the IndexedDB transaction commits, and the reload arrived in
  between. The e2e now waits for the switch to come back through Settings — the
  round trip, not the widget remembering its own click.

## The screens got out of the way of the table · fixed

Reported from the live site: *"i cant scroll when the spreadsheets are open. also
there is too much of the screen taken up by the upload and things above the
important information above the spreadsheet information."* Both halves were real,
and the first was worse than it looked.

**The table could not be scrolled at all.** `Sources` (and `Products`) wrapped the
grid in a box of a guessed height and left `DataTable` to fill it, but a
`DataTable` with no `height` prop was sized by its *content*: its scroll box grew to
the full height of the list — measured, 91,673px for 1,102 job lines — the
virtualiser measured that as the visible window and rendered everything, and the
card around it clipped the rest. So the rows past about the twelfth belonged to no
scroll on the page: the wheel moved the document and the table never moved. The
root is `flex h-full min-h-0 flex-col` when no height is given, which is what the
prop's own documentation always claimed it did.

**Everything above the table was too tall.** Four tiles, a framed automatic-import
card, a full drop zone and a wall of 23 location chips put the first row at 684px
of a 720px window. Now — and the counts themselves went next, on the same
complaint one round later, see below:

- the automatic-import answer is one line at the top right — the switch, the
  interval, and per file what it did and how long ago — with the paths, the interval
  control and the fuller lines under **Details**;
- *Import by hand* and *Locations counted as stock* are `Disclosure` lines, closed
  by default (a `DataTable`-sized screen should not spend 200px on a tray nobody
  is using), and choosing files opens the tray by itself so *Load* is never hidden;
- the empty tables offer **Choose the files** rather than saying "drop it above";
- the grid's box is measured to the bottom of the window by `useFillBelow`,
  re-measured on resize, on a phone's URL bar, and whenever anything *above* it
  changes size — every element ahead of it at every level is watched, because when
  the line above grows by 12px and the table shrinks by 12px the document is
  exactly as tall as it was, and an observer on the document never hears about it.
  The guess (`min(62vh,620px)`) could only ever be wrong for whichever window it
  was not drawn for.
- toasts no longer swallow the pointer. They sit over the bottom of the window,
  which the table now occupies: a toast covering a column's resize handle read as a
  broken table. The card is click-through; its own two buttons are not.

Measured in the browser, both mirrors loaded, panels closed: at 1280×720 the stock
table runs 378→704 with 1px of page scroll left in the whole screen; on a phone
(390×839) the table takes its 240px floor at 517→757 and the document has nothing
left to scroll at all. Before, the first row started at 684px of that 720px window.

Proven by `e2e/layout.spec.ts` (fill, no page scroll, the last row reachable
inside the table by scroll and by wheel, and a closed panel keeping its content out
of the DOM — desktop, phone, firefox), 3 new tests in `test/ui.disclosure.test.tsx`
and the reworked `e2e/exports.spec.ts`. Two existing specs needed to say what a
person now does first — open the tray, open the locations line — and one, *clicking
a header sorts the table*, had been reading the row immediately after a click and
capturing the order from the click before; it waits for the arrow to move now, the
same round-trip rule that caught the interval assertion in M11.

## The numbers went too · removed from every page

One round later, from the new screen: *"remove this from all pages, i do not need to
see this"*, the red circle round the strip of counts. So the counts are gone from
**Data sources** (rows, lines, location groups, placeholder dates) and from
**Products** (codes known, current range, needs setting, current with no demand),
and the `FactBar`/`Fact` primitives they needed went with them rather than staying
as something nothing uses.

Nothing that was read is lost, which is the only reason removing it was safe: the
tab over a mirror says `Stock (n)`, the chip in the header says how old the data
is, the locations line says `n of m counted`, and Products says how many rows are
on screen out of how many are known in the line under the table. What a number is
for, it sits beside — not in a summary above the thing it describes. **Settings**
keeps its four tiles (device, repository, token, last pull/push), because those
report the state of *this device* and there is nowhere else to read them; said so
rather than assumed, in case that is next.

The table moved up again: 342→704 of a 720px window on Data sources, 249→664 on
Products, and 408→747 of a 390×839 phone. `e2e/layout.spec.ts` now demands the
card starts in the top third of the window on any device, so chrome cannot creep
back above it unnoticed. `test/ui.products.test.tsx` no longer asserts a count
that no longer exists, and `e2e/import.spec.ts` reads the counts off the tabs and
proves the placeholder switch by the *change* it makes — the shop's export volumes
are not this file's business, and they had no business being in a public
repository either.



## The shop's own colours are in the app · done

The logo arrived with one instruction: *"this is our logo, use this and the colours
throughout the app"*. It is kept in the repository at
`brand/freo-stone-paving.jpg`, and `scripts/make-brand.py` measures it rather than
copying it around — the four colours that are actually in it (block blue `#0076C0`
at 17% of the artwork, corner red `#EF3E34` at 2.3%, the charcoal of the PAVING foot
at 7.8%, the card white at 19.6%) and the eight rectangles the device is made of.
`docs/brand.md` is the reference; this is what changed and how it is held.

The rule the whole thing hangs on: **a logo is ink on white paper and an app is light
on dark in daylight, so lightness moves and hue does not.** Every blue in
`src/styles/theme.css` is within 4° of the logo's blue and every red within 4° of its
red; the lightness steps are where a screen needs them, and each one is written down
beside the colour with the ratio it was measured at — the logo's blue is 3.9:1 on the
dark canvas, so the dark accent is the same hue lifted to 6.2:1; the logo's blue is
4.45:1 on this light canvas, so the light accent is one step darker at 4.8:1; the
logo's red reads at 4.9:1 on dark and is used exactly there, and comes down to
`#C22B22` at 5.3:1 on paper. Anything carrying text clears 4.5:1 on the canvas it
actually sits on, which caught the light theme's faintest grey at 3.4:1 and brought
it to 4.9:1. The stage colours and the neutrals are deliberately *not* brand: seven
production stages in two brand colours would be unreadable, and the board that uses
them is not built yet.

What it looks like: the sign-in screen carries the logo itself at 64px — the one
place the lettering has room to be read — and every other surface carries the block
device without lettering, at 28px in the header and in the tab, and as the icons an
installed app is built from. The launcher icons are the logo's white card with the
device inside it rather than blocks bleeding to an edge, so no launcher and no
rounding can cut one in half; the maskable pair sits at 56% of the canvas, which is
where a square device's corners stay inside the safe circle (at the 62% this started
at, the red corner blocks lost their points). The strip the app sits in — a tab's
frame, an installed window's title bar, a phone's status bar — is the shop's blue in
both themes, in the page and in the manifest; the splash stays the canvas the app
opens on.

Held by `test/brand.test.ts` (8 tests: the logo measures as four colours, both themes
stay on those hues, the lightness moves the way the rule says, every text colour
clears AA on its own canvas, the artwork files exist, the tab icon is drawn in the
logo's colours and nothing else, the header tile and the tab icon are byte-identical
drawings), `e2e/brand.spec.ts` (3 tests × 3 projects: the logo *decodes* rather than
merely being present, the header mark decodes too, and everything the browser and an
installer are told over HTTP is the shop's blue), and 6 new checks in
`scripts/check-build.mjs`, which now runs 33. The old `scripts/make-icons.py` is
gone; `pnpm run brand` is the one command, and it stops with what it measured if the
logo it is handed has different colours in it than the ones it draws.


## M12 — The sync loop · planned, not built

`src/data/syncEngine.ts` is finished and tested — pull, merge, protect local
work, push with compare-and-swap on the blob sha, retry, offline queue, conflict
notes in the ledger. Nothing in `src/app` has ever called it, which is why
accounts, People and Settings are still per-device facts. This is the milestone
that makes the multi-user design real, and the one the caveats in
`docs/accounts.md`, `docs/exports.md` and the People screen are about.

Decisions taken before writing code, so they are not made twice under pressure:

1. **Dirt is declared, not overheard.** The obvious wiring is
   `db.on('changes').subscribe(...)` → `markDirty`, and it is wrong: a pull
   writes rows through `applyDocumentToDb`, which would mark everything dirty and
   make every device push the whole document back after every pull. The engine's
   own API says so — `markDirty` is called *after a local write commits*. So:
   `src/data/dirty.ts` holds a sink the app installs (the same shape as
   `principal.ts`: data layer owns the state, app owns the wiring), and every
   write helper in the data layer calls `markLocal(collection, key)` on its way
   out. Forgetting one is a real risk, so the checks name the helpers they cover.
2. **Every signed-in device syncs, whatever its role.** Gating pushes by role
   breaks the bootstrap: a viewer's own device record has to reach the shared
   document or that person can never sign in on a second machine. Roles keep
   their meaning at the write — `assertCan` in the data layer — and the honest
   statement is that the last metre of trust is the private repository's token,
   which is already written in `docs/accounts.md`.
3. **Mirrors stay local.** The stock and job mirrors are not in the shared
   document: every device imports the exports for itself, so pushing a few thousand rows
   of somebody else's MYOB report through a text file on GitHub would be pure
   cost. Product *identity* rows created by an import are shared, and marked.
4. **The token never travels**, and a public repository is refused on write. Both
   already exist; the sync loop is the first thing that would prove them, so they
   get tests at this layer rather than in principle.
5. **Status belongs on screen.** A header pill and a Settings card: pending
   count, last pull, last push, the engine's own plain-language message, and the
   last failure with its HTTP status. A device that has never synced must say so
   rather than look idle.

Sketch of the work, each line a committable slice:

- [ ] `src/data/dirty.ts` + `markLocal` in every write helper, with a test per
      helper asserting the collection it marks.
- [ ] `src/app/sync.ts`: one engine per device, built from settings and the
      device token, `browserConnection()` for connectivity, a status store for the
      UI, start on sign-in when a token exists, stop on sign-out, re-create when
      the repository changes.
- [ ] Pull on open, on reconnect, and when a backgrounded app comes back; push on
      the idle window, on `flush()` after a Save, and on reconnect.
- [ ] Settings: a sync card that shows the truth, including "this device has no
      repository token" and the public-repository refusal.
- [ ] The header pill: pending changes, syncing, offline, conflict.
- [ ] Tests: the engine already has 541 lines of its own; this milestone adds the
      wiring — faked transport and timers in node, the Settings card in jsdom, and
      a browser test for the pill and the honest no-token state. Real
      two-device proof is manual: two browsers, two tokens, one row entered on
      each, and both screens showing both rows.
- [ ] Then retire the caveats: the note on the People screen, the "until the sync
      loop runs" section in `docs/accounts.md`, the line in `docs/exports.md`, and
      `docs/sync.md` rewritten from intent to what the code does.

## The one a browser had to catch

`GitHubClient` stored the global `fetch` as a bare reference and called it as
`this.fetchImpl(url)`. Chrome and Firefox require `fetch` to run with the window as
its receiver, so every call threw `TypeError: Illegal invocation` before leaving
the device — on screen, "could not reach GitHub", on every device, forever. All
153 unit tests passed, because they inject a fake and Node's fetch does not check
its receiver. `src/data/github.ts` now wraps it: `globalFetch = (url, init) =>
fetch(url, init)`.

The lesson is about test layers, not fetch: a fake is only evidence about the code
around it. Anything that depends on *how the platform behaves* — a receiver, a
CORS-exposed header, an IndexedDB transaction, a keyboard interaction — needs a
test that runs in the browser. The write-scope check above is the same story:
the header is there, and a browser still cannot see it.

## Two interface corrections worth remembering

**A hint is a description, not part of a name.** `Field` used to render its label,
its control and its hint inside one `<label>`, which folds the hint into the
control's accessible name: "Cut-off, later than this rolls to the following week".
It also made name-based lookup ambiguous — asking for a field called *Repository*
matched the token box, whose hint mentions the repository. `Field` now renders a
`<div>` with the label wrapping only the caption and the control, and the hint sits
below, linked with `aria-describedby` (`FieldDescription` context, picked up by
`TextInput`, `NumberInput` and `Select`). `Toggle` got the same treatment.

**A keyboard drag needs the rectangles before it needs the key.** The phone
variant of the reorder test failed on and off: after Space, dnd-kit announces the
row it is over — itself — and an arrow key pressed before the droppable rectangles
have been measured is swallowed without a trace. The test now waits for the
announcement to mention the item, then presses ArrowDown and lets `expect` retry
the read, so a slow announcement is never mistaken for a missed keypress (which
would overshoot). Run four times on the throttled phone project after the change;
four passes. It is also a small product truth: the first arrow key after a pick-up
can be lost on a slow device, for everyone, not only in tests.

## The one that went out before it was scrubbed

Publishing the repository was itself a mistake waiting to happen, and it happened.
The command that was supposed to point `main` at the scrubbed history failed —
`git reset --hard public` refused because `public` names both a branch and the
`public/` asset directory — and because the failure was not checked, the `git push`
that followed published the *old* history to the new public repository. That history
held the real stock quantities, the trading name, the legal entity, the street
address, a customer name and a staff name: everything the scrub a few minutes later
had removed from the tip. Three minutes, then deleted and recreated, and GitHub
dropped the objects with the repository — verified by fetching the same URLs at the
same SHAs and getting 404, against control fetches that returned 200.

Two rules come out of it, both worth keeping:

- **A publishable tree is not the same thing as a publishable history.** Checking the
  working copy proves nothing about the commits underneath it. Anything that goes
  out as source gets its *history* checked too, or starts from a fresh commit built
  from the tree that was checked.
- **Never chain a git command whose failure can be swallowed.** Ambiguous names are
  the trap: `main` and `public` both resolve, so git guesses and the guess is wrong
  quietly. Refuses are cheap; a swallowed one costs what this cost.

Also true and worth saying plainly: the check that would have caught the *content*
was a cross-check of every string in both real exports against every tracked file.
It found things nobody had thought to look for, including a real row quoted in a
source comment. That cross-check is the thing to re-run before any publication, not
a skim of the diff.

## The name box that lagged, and what was under it

Reported as one thing — a delay between every letter typed into the first-run name
box — and it turned out to be four, only two of which were about typing. Measuring
came first: `scripts/probe-typing.mjs` profiles the page while it types, and the CPU
profile said `focus` was 9.8% of every sample taken while typing in the dialog, and
nothing at all while typing in a plain Settings field. React was not the cost —
script was 0.1–1.2ms per keystroke — so the time was going somewhere else entirely.

**A dialog positioned against the window has to be rendered outside the app.** The
`Modal` rendered where it was invoked, which for the name box was inside the header,
and the header carries `backdrop-filter: blur(8px)`. A filtered ancestor becomes the
containing block for `position: fixed`, so the dialog's `fixed inset-0` box was
2672×47 — the header, not the viewport. The panel was centred inside that strip, at
`y = −44`, its title above the top of the screen and its dim covering only the
header, and every keystroke repainted inside a blurred region. `Modal` and `Popover`
now render into `document.body`. The box is `1230,604` on a 2880×1440 window with the
scrim the full viewport, which `e2e/dialog.spec.ts` asserts rather than describes.

**An inline arrow in a dependency list is a per-render effect.** The scroll lock,
the Escape listener and the call to `focus()` lived in one effect that listed
`onClose` — an inline arrow at every call site, so a new function every render, so
the effect tore down and re-ran **on every keystroke**: `document.body.style.overflow`
flipped (layout thrown away for the whole page) and `focus()` was called again, which
takes the caret out of the field being typed in. The latest callback now sits in a
ref and the effect depends on `open` alone. `scripts/probe-keystroke-churn.mjs`
counts these document touches — twenty keystrokes, and after the fix: no focus calls,
no overflow writes, no listeners added, no forced layouts.

**The app was reloading itself, a second after it opened.** The dialog came back
after Escape with the typed name gone, which is how this surfaced: `registerType:
'autoUpdate'` makes the worker claim the open page, and `main.tsx` reloaded on
`controlling` without asking why. So the page reloaded itself shortly after load,
mid-typing, and asked for the name again. The comment in that file already said
updates are offered, never forced; the config did the opposite. Updates are offered
now, and reload happens only when the toast is tapped — `pnpm run check:worker`
checks both halves, including that an update still reaches the shop. This was also
the firefox e2e failure I had been chasing as a flake: the page reloaded between the
keystrokes and the field was empty.

**A dismissed dialog must stop being in the way at once.** Exiting inherited the
entry spring, so the panel — and its full-screen scrim — stayed in the tree for the
better part of a second after Escape, transparent, on top of everything: 700ms of
swallowed taps, measured by hit-testing the middle of the window. Exit is a 120ms
fade now, and the same measurement reads 153ms.

Two of these are general enough to keep:

- **Anything that positions itself against the viewport is rendered at the document
  root.** `backdrop-filter`, `filter`, `transform` and `will-change` on any ancestor
  quietly re-own `position: fixed`. Nothing in a browser console shows this; the
  dialog simply appears in the wrong place and paints expensively.
- **Never list an inline arrow in an effect's dependencies.** If an effect should run
  when a *state* changes, depend on the state and read the callback through a ref.

Evidence: 174 unit tests, of which the four in `test/ui.modal.test.tsx` include three
that were confirmed to fail against the previous `primitives.tsx` by stashing it; 82
browser tests across desktop, phone and firefox, 5 wide-layout skips; 25 build checks
at both bases; and the worker probe's four checks. The build checker's new worker
check found its own false positive while being written — it scanned every emitted
file, and `sw.js` contains the string "sw.js" in its own sourcemap comment, so a build
that registered nothing passed it. Narrowed to the scripts the page actually loads.
