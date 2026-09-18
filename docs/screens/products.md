# Products

`src/screens/Products.tsx`, route `/#/products`.

## What it is for

The MYOB exports hand over roughly 2,300 item codes and no indication of which
ones this shop actually makes. This screen is where that gets answered, and
where the making details get attached — how a code is made, what it is counted
in, how many fit on a tray, how long it cures.

Nothing here changes MYOB. The figures on screen are read-only views of the last
import; the editable columns are this app's own settings.

## Who owns each field

| Field | Written by |
| --- | --- |
| code, description | the import (MYOB's copy wins on description) |
| enabled, route, unit, usesBaseline10000, trayYield, target, cureDays, notes, rank | this screen |

An import never enables a code. A code that appears in an open job gets
`seenInJobs = true`, which is what the default **In open jobs** filter shows;
ticking **Current** is the shop's decision, and it survives every later import.

## The line along the top, and the filters

Four counts on one line: **Codes known** (both exports), **Current range**,
**Needs setting** (current but missing route, unit or tray yield), **Current, no
demand** (enabled but no open job line — the ones to consider switching off).
They were four tiles, which cost a fifth of the screen to say four numbers; the
board underneath is where the work is, and it now runs to the bottom of the
window (`useFillBelow`, and `docs/screens/sources.md` for the whole contract).

Filters: In open jobs (default), Current range, Needs setting, Shotblast, All
codes. The filter box matches code, description or note.

## The four stock figures

Read-only, straight from `calc.productPosition`:

- **On hand** — real stock, with the phantom 10,000 removed if the code counts
  against the baseline.
- **+ curing/blast** — including batches still curing or waiting to be blasted.
- **To target** — how much more is needed to reach the target level.
- **Open demand** — quantity promised in open jobs from `future.xlsx`.

## Editing

A cell writes when it loses focus (Tab, Enter or a click away). Escape abandons
the edit without writing. A cleared number writes zero — these columns are
numbers, not blanks — so Escape is how an edit is called off.

Every write raises a toast naming the field and the new value, and appends a
`product.update` line to the audit log. A write that changes nothing stays
silent: no toast, no log line. Clearing a number writes nothing rather
than a stray zero, except tray yield, where zero is the honest "not set".

Picking rows opens a bulk strip: set route, unit or cure days for everything
ticked, or mark/unmark the current range in one go. One audit line per bulk
action, not one per row.

## Order

Rows are in manual order (`Product.rank`) so the screen can be arranged the way
the shop thinks about the range. Dragging the handle writes a rank between the
neighbours; when the gap between two ranks gets too small to split, the whole
list is re-spaced and the log records it as `Re-spaced N products after a
reorder`. Order is part of the view, so it can be personal or published as the
default for everyone.

The handle is a button, so the same move works from the keyboard: Tab to it,
Space to pick the row up, arrow keys to walk it, Space to put it down. Each step
is measured against the list as it has settled, so the arrows need to be pressed
one at a time.

## CSV

**Export CSV** writes `freo-products.csv` — the settings only, never stock:

```
code,description,enabled,route,unit,baseline10000,trayYield,target,cureDays,notes
```

`enabled` and `baseline10000` are `yes`/`no`; route is `unset | make | shotblast`.

**Import CSV** accepts a subset of those columns, in any order, with BOM and
CRLF tolerated. Unknown codes are reported and skipped; a malformed line is
reported by number and skipped, and the rest of the file still applies. When a
`notes` column is present its value is taken literally, so a blank cell clears a
note — the only way to clear notes from a spreadsheet.

## Checks

- `test/data.products.test.ts` — repo writes, audit lines, rank midpoints and
  re-spacing, CSV round trip including quoted notes and bad lines.
- `test/ui.cellEditors.test.tsx` — commit-on-blur, empty means null, a click in a
  cell does not open the row, arrow keys stay in the field.
- `test/ui.products.test.tsx` — the screen ticks, types and bulk-edits against
  IndexedDB.
- `e2e/products.spec.ts` (6) — real browser: a tick that survives a reload,
  figures that survive a reload, bulk edit, pointer drag that survives a reload,
  the same reorder by keyboard, and the CSV header and a row's contents.
  Desktop, phone and Firefox.

## Open

The drawer's earliest-supply date shows nothing: `calc.ts` has no
earliest-ready-date function yet, so `Products.tsx` passes `null` rather than a
guessed day. It belongs with the curing work in M5/M6, where `readyAt` and
`latestStartDate` meet the open job lines.
