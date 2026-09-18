# Build plan

The plan of record for the production app. Status is written from the code and
the test run, not from intention — if it says done, the checks below pass.

Commands (all from the project root):

```
pnpm run typecheck    # tsc on the app and the node config
pnpm test             # vitest, jsdom + fake-indexeddb, 150 tests
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
3. **Live exports** — Sources pulls `exports/location.xlsx` and
   `exports/future.xlsx` from the repository on a schedule, so the figures on
   screen are MYOB's current ones rather than the last time someone found a file.
4. **Matrix (M4)** — the product × day view, which production entry builds on.
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

## M4 — Matrix: product against day · next

The main view. A row per product, a column per day, one cell per product-day.

- Freeze product, code, stock and unit columns; days scroll sideways.
- Horizon picker 1 / 2 / 4 / 6 weeks, plus an overflow chip for jobs past it.
- Cell colour: short (not enough stock), enough with stock still curing, enough
  and ready. Baseline-10000 codes flagged.
- Tap a cell → popup listing every job for that product that day.
- Numbers come from `calc.ts`: `productPosition`, `demandByCodeAndDay`,
  `stockOnHand`, `isFarFuture`.
- Data to enter here is production, so it lands with the same row/pick idiom as
  this screen.

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
