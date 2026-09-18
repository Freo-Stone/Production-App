# MYOB entry

`src/screens/MyobEntry.tsx`, route `/#/myob`. Rules in `src/core/myobQueue.ts`,
writers (`markEntered`, `unmarkEntered`, `keyedRacks`, `stockCapturedAt`) in
`src/data/batchRepo.ts`. Read together with [the curing screen](curing.md), which is
what feeds this queue, and [the settings screen](settings.md), which holds the entry
weekday, the cut-off and the columns.

## What it is for

Once a week somebody sits down with everything that has come off the racks and keys
it into MYOB. The app cannot do that typing — MYOB is a program on another machine —
so this screen's job is to make the run unambiguous:

- which racks belong to **this** week and which to a later one,
- what the totals are **per item code**, in the shape MYOB wants,
- what to paste or download, and
- what has been keyed already but is not in the stock figures yet.

Then, when the typing is done, to take those racks off the shop's books.

## The run date is worked out, never remembered

This is the load-bearing decision on the screen.

A rack belongs to the entry weekday that comes on or after the day it became ready —
unless it came ready **after that day's cut-off**, in which case it belongs to the
following week. Both inputs are read, not written: the day and the cut-off come from
Settings (`myobEntry.entryWeekday`, `cutoffHours`), and the moment it became ready is
`readyAt`'s answer, the same function the Curing screen reads.

On the shop's defaults — Friday, cut-off midday:

| A rack came ready | It is in the run dated |
| --- | --- |
| Wednesday | that Friday |
| Friday at 11am | that Friday |
| Friday at 2pm | the Friday a week later |
| Thursday a fortnight ago | that Thursday's Friday — and it is overdue |

Nothing here writes a date until the racks are actually keyed. A date *remembered*
from last week is precisely what goes stale when a cure day is corrected, a blast is
recorded late, or the cut-off moves in Settings: the queue re-sorts itself the moment
the underlying facts change, and nobody has to hunt for a stale field.

The only time a run date is stored is as evidence on the rack that was keyed —
`myobRunDate`, written by `markEntered` next to `enteredAt` so the ledger and the
rack agree.

## What is in the queue

A rack is in the queue when it is not deleted, has not been keyed into MYOB, and its
stage is `ready` — and its own rules say it is ready.

That last part is why a rack can be on the ready pile and *not* in this run. A stage
of `ready` with a cure date still in the future comes from an imported row, a
corrected cure day, or a blast recorded after the fact. It cannot be keyed —
`enterProblem` would refuse every one — so it is left out of the run and the screen
**names it**: a chip reads `2 still curing` and the paragraph lists the numbers. A
queue that was quietly shorter than the ready pile is the kind of discrepancy that
ends with somebody trusting MYOB over the app.

Racks are grouped under their run and, within a run, oldest make first. Each heading
says which run it is — `This run — Fri 18/09/2026`, `Next run — …`, and
`Overdue — …` for a week that has already been keyed, with a chip counting them in
the header.

## The tick is the only per-rack decision

Everything in the queue is in the run by default. Unticking is for the week one order
goes out ahead of the rest.

The whole row is the tick, not a small box at its edge — on a phone a 20px target at
the end of a list is a miss every time, and in-or-out is the only decision a rack
offers here. The ticks are a moment's selection, deliberately not a record: reload
and everything is in the run again, because a half-remembered selection is a worse
surprise than a full one.

**What is copied out and what gets marked entered are the same set of racks.** The
header says `1 of 2 racks ticked · 8 trays · 8.00 m²`, the copy-out drops the
unticked racks, and the confirm button counts what it is about to write. There is no
way to key one thing and copy another.

The menu badge counts the whole queue, not the ticks — it answers "how many racks are
waiting to be keyed", which is a fact about the shop rather than about the last
selection someone made.

## What gets copied out

One line per item code, per run, with the racks' quantities added together, because
that is what MYOB is keyed in as. The columns are the shop's (`myobEntry.exportColumns`:
item number, description, quantity, unit, memo by default), and their order is
respected on the way out. An unknown column key prints an empty cell rather than
disappearing, so a mis-set Settings page shows up as a blank column instead of a
missing one.

The memo comes from `myobEntry.memoTemplate`, with `{runDate}` replaced by the run's
date as `18/09/2026`. Any other text in the template is left exactly as written.

Two ways to get it out, because the clipboard is not a given on a shop floor tablet:

- **Copy for MYOB** — tab-separated text, ready to paste into the MYOB grid. If
  `navigator.clipboard` is missing (plain-http origins) or rejects (the page is not
  focused), and the older `execCommand` route fails too, the text is put on the
  screen in a selectable box and the toast says what happened. A press that quietly
  does nothing is the one failure mode this screen may not have.
- **CSV** — a download named `freo-myob-run-2026-09-18.csv`, quoted the way Excel
  wants it.

Neither one changes anything. The subtitle says so, and the toast after a copy says
it again: *nothing has been marked entered yet*.

## Marking it entered, and taking it back

**Mark entered** asks first, in a dialog that says what it is about to do
(*"This says they are in MYOB. It does not type anything in for you"*) and offers an
optional **MYOB reference** — the invoice or batch number it was keyed under, which
goes into the ledger line.

**They are in MYOB** then, in one transaction: sets each rack to `entered_myob`,
writes `enteredAt`, `enteredRef` and the run date derived for that rack, and leaves
one ledger line per rack:

```text
2026-09-14-01 keyed into MYOB — run 18/09/2026 · 8 trays · 16.00 GL4 · ref INV-42
```

That sentence is the shop's only record of what was keyed and under what
reference, so it is worth knowing it can be read back: the
[production log](production-log.md) is the screen that reads the ledger, and it
can pull one rack's whole story out of a month of other work.

It is a bulk write, so one bad rack does not stop the run. Anything the rules refuse
is left where it is and reported by name — *"Left in the queue — 2026-09-10-02 is
still curing — due in 3 days."* — while the rest are keyed. The rule is re-checked
inside the transaction, so a button that was right when it was drawn can only be
refused for something that happened in between.

Taking a rack back is one press, no dialog, because nothing physically happened: the
rack goes back to `ready`, its three entry fields are cleared, and the ledger says

```text
2026-09-14-01 taken out of the MYOB run — it was not keyed after all
```

### What it refuses

| Situation | The sentence |
| --- | --- |
| Keyed already | `2026-09-16-01 is already keyed into MYOB for 18/09/2026. Take it back out first if that was a mistake.` |
| Taken back / deleted | That rack has been taken back, so there is nothing to put into MYOB. |
| Still owing a blast | `2026-09-16-01 still has 10 to go through the blaster.` |
| Still on the cure | `2026-09-16-01 is still curing — due in 2 days.` |
| Written off | The write-off sentence, with the reason and who wrote it off. |
| Marked in MYOB with no entry time | `2026-09-16-01 is marked in MYOB but has no entry time on it. Put it back on the racks and bring it through again.` |
| Taking back something never keyed | `2026-09-16-01 has not been keyed into MYOB, so there is nothing to take back.` |

## Keyed, not in the export yet

Once stock is keyed into MYOB it stops being visible to the app: the next MYOB export
is what tells the shop it has gone. So keyed racks do not vanish from this screen.
They sit under **Keyed, not in the export yet**, with the reference, the run they were
keyed against, and how long ago — and the subtitle spells out the consequence: *until
a new export arrives, they are missing from every stock figure*.

The list is everything keyed since the stock export on this device was taken
(`stockSnapshots.capturedAt`), and a keying older than four weeks is dropped on the
assumption some export has accounted for it by then. One press — **It was not keyed** —
puts the rack back in the run.

## Who can press what

| | Viewer | Maker | Owner |
| --- | --- | --- | --- |
| Read the run, see the copy-out | yes | yes | yes |
| Copy for MYOB, CSV | no | yes | yes |
| Mark entered, take a rack back | no | yes | yes |

The copy-out buttons are gated with the write, because copying a run out is the first
half of keying it and a viewer reading the queue should see one consistent screen.
The gate is `myob.enter`, and `markEntered` / `unmarkEntered` both go through
`assertCan` before anything is read.

## On a phone

`/myob` is one of the four tabs on the phone bar. The row is one thumb-height and the
whole row is the tick; the copy-out table scrolls inside its own frame rather than
stretching the page; the confirm dialog's sheet is measured to stop at the bottom of
the screen rather than behind the home bar. The three header buttons wrap onto a
second line instead of being clipped by the card edge — the browser test asserts each
button's right edge is inside the viewport.

## What it does not do

- **It does not type into MYOB.** There is no MYOB API in this app, and pretending
  otherwise would be worse than the ten minutes it saves.
- **No XLSX.** Copy-out is TSV and CSV. A spreadsheet of a run is one File → Save
  away in whatever program the shop keys MYOB from.
- **No partial quantities.** A rack is keyed or it is not. Half a pallet is a
  different thing — that is what a part blast and a new batch number are for.
- **No editing of run dates.** The date is derived; to move a rack between runs you
  change the fact that made it ready (its cure day, its blast, its stage), which is
  what the ledger is for.
- **No automatic import of the new export.** Picking up the MYOB export that proves
  these racks are gone is still a job on the [Data sources](sources.md) screen.

## Where it is tested

Rules in `test/core.myobqueue.test.ts` (run dates either side of the cut-off, queue
order and grouping, per-unit totals, one line per code with `{runDate}` substituted,
TSV and CSV shapes, every refusal sentence, the keyed pile's window). Writes in
`test/data.myob.test.ts` (the keying and its ledger line, the run date derived per
rack rather than stamped over the lot, a refused rack left exactly as it was and the
run continuing past it, a rack handed over twice counted once, the viewer gate, taking
it back). The screen in `test/ui.myob.test.tsx` (the entry day in words and *
interpolated*, the held-back rack named, ticks moving a rack out of both the copy-out
and the count, the clipboard fallback, the mark-entered press, the take-back). End to
end in `e2e/myob.spec.ts` on desktop, Pixel 7 and Firefox: a rack logged on Daily
entry, taken off the cure, listed in the run, two racks of one code copied out as one
line, unticking, keying in with a reference and taking one back, a clipboard forced to
fail, a CSV download, and thumb targets on the phone.
