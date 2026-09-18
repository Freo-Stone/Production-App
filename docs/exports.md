# The MYOB exports arrive on their own

Two files carry the shop's numbers: `location.xlsx` (stock on hand) and
`future.xlsx` (what is promised). Until now they had to be found on a disk and
dropped onto the Sources screen. Now a device that is open, signed in as a maker
or the owner, and holding the repository token goes and gets them.

`docs/power-automate.md` covers how the files get **into** the repository, and
`docs/folder-watch.md` covers the way that needs no repository round trip at all: the
computer that exports MYOB watches its own folder, and is a minute ahead of everyone.
This page is the half that matters on every other computer: how the files get from
the repository onto the screen.

## How it decides that anything changed

One number: the **blob sha** GitHub's Contents API returns for the file's
content.

- Same sha as the last import → nothing is parsed, nothing is written, and the
  line says *Up to date*. An unchanged week costs one request per file.
- Different sha → parse it, import it, remember the new sha.
- The sha is only recorded when the import **succeeded**. A file that could not
  be read — a mirror interrupted halfway through an upload, an export saved as
  the wrong report — keeps the sha it had before, so the next check tries it
  again. Marking a file that failed as already seen would leave the shop running
  on old numbers with a green tick on the screen.

The report is identified by the title inside the workbook, never by the file
name, which is why the shop's `location.xlsx` being a Sales report (it has
happened) is caught and reported rather than quietly imported as stock.

## What a check does

```
is automatic import switched on?          → if not, stop and say so
is this device a maker or the owner?      → if not, stop and say so
does this device have a repository token?  → if not, stop and say so
read exports/location.xlsx  → sha differs? → parse → import → record
read exports/future.xlsx    → sha differs? → parse → import → record
```

The two files are read **one after the other**, on purpose. Each import rewrites
one mirror and then reads *both* mirrors to work out which codes the shop makes;
run together, each would see the other's half-written state. Concurrent callers
share one run, so a laptop that wakes from sleep and fires its timer and its
"tab is visible again" handler at the same moment still imports once.

An import is the same code path as dropping the file on the Sources screen:
`commitImport`. The automatic route has no special rules, which means there is
only one set of rules to reason about.

## When it runs

- a few seconds after the app is opened,
- then about every `intervalMinutes` (the line: 5, 10, 15, 30, hourly),
- when the device finds a signal again,
- and when a tab that was in the background comes back to the front and the last
  look has gone stale.

The interval is read from Settings on every tick rather than used to size the
timer, so changing it takes effect without a reload.

## The limit, said plainly

There is no server. Nothing runs when the app is closed.

A laptop that stayed shut all weekend does not import on Saturday; it imports
within seconds of being opened on Monday. A phone that never gets switched on has
no idea what it is missing. The mirror in `docs/power-automate.md` keeps the
repository current whether or not anyone is looking, so the newest numbers are
always waiting — but the last metre is done by an open app.

That is the whole of what "when changed" can mean in a shop that pays nobody to
host a server, and it is written under Details on the line as well as here.

## Every device imports for itself

Each device compares the file's sha against **its own** last import, so the
feature works today, before the sync loop that carries the shared state document
between devices exists. A device does not have to wait for another device to
fetch the exports, and a device that was offline simply catches up when it
returns.

Once the sync loop is running this stays correct: two devices importing the same
file produce the same rows, and a merge of identical content changes nothing.

## Switching it off, and pointing it somewhere else

The line at the top right of **Data sources** holds the switch and the interval;
**Details** opens the two paths and each file's fuller line.
Off means what it says: the manual drop tray on the same screen is the only way
in, and the subtitle says so rather than leaving it to be guessed.

The paths are editable because the mirror's output name is the shop's to choose —
`exports/stock this week.xlsx` works as well as the default. What is not editable
is which report is which, because that is decided by the file's own title.

A viewer's device reads the board and imports nothing. The refusal happens in the
data layer, at `commitImport`'s `assertCan`, not by hiding a button.

## What the ledger says

A run that imported something writes one `export.import` line naming which file
came in, from where, with how many rows — stamped with the person signed in on
that device. A run that could not use a file writes `export.failed` with the
reason. The ledger is the shop's own account of when the numbers moved, and it
does not distinguish a file a person dropped from a file that arrived on its own,
which is what you want when the question is "what was stock on Tuesday?".

## Checks

| Layer | File | What it proves |
| --- | --- | --- |
| unit | `test/data.exportSync.test.ts` | first import, unchanged skip, only-the-changed-file, retry after a bad file, a file that goes missing, the viewer and switched-off declines, no-token decline, one run shared by concurrent callers, the persisted state |
| unit | `test/myob.parsers.test.ts` | the reports themselves, and that a mislabelled file is refused |
| jsdom | `test/ui.autoImport.test.tsx` | the line's wiring: what a change writes into Settings, the Check now call, and what a viewer is shown |
| browser | `e2e/exports.spec.ts` | the line in Chromium, Firefox and a phone viewport, including a check with nothing to reach and settings that survive a reload |

```bash
pnpm exec vitest run test/data.exportSync.test.ts test/ui.autoImport.test.tsx
pnpm exec playwright test e2e/exports.spec.ts
```

The fetch against GitHub itself is not in these checks: it needs a repository and
a token, and a test suite must not hold either. What is checked is every decision
made around the fetch, with a stand-in repository in `test/data.exportSync.test.ts`.
