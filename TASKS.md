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

## M9 — Hosting and the mirrored exports · partly done

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

- `.github/workflows/deploy.yml` — tests gate the build, then `dist/` goes to
  Pages under the repository's own base path. The five checks the workflow makes
  on the built page were each run against a real `VITE_BASE=/Production-App/`
  build before being written down.
- `docs/sync.md` — the repo layout, the fine-grained token a device needs, what
  each failure means, and the check steps for deployment and for two devices
  syncing.
- `docs/power-automate.md` — mirroring the two MYOB exports into `exports/`,
  starting from "drop them in by hand", with the Power Automate expressions and a
  check for each step.

Still to do:

- **M8 first.** Nothing in the app asks for a token yet, so no device can push
  or pull — the sync engine is only exercised by tests. Settings needs: token
  entry with a connection test, the repo fields, the sync interval, the weekly
  MYOB day and cut-off, and a "pull exports" button on Sources.
- One manual step on GitHub: Settings → Pages → Source: **GitHub Actions**.
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
