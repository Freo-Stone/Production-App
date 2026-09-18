# Daily entry

`src/screens/Entry.tsx`, route `/#/entry`. Writers in `src/data/batchRepo.ts`,
rules in `src/core/batches.ts`.

## What it is for

This is where a number typed on the floor becomes a rack. It is the only screen
in the app that creates a batch, and until it existed, nothing did — the board
could show what was promised and what was in stock, but the make side had no
record to read from.

One line, one day, as many product rows as that line ran. The quantity is never
typed: the floor counts **trays**, and trays × that product's tray yield is the
quantity that goes into MYOB. The one number a person types is the one number
they can actually count.

## The three rules the whole screen rests on

1. **The cure clock starts when the make starts.** A batch's due date is fixed at
   entry from `madeAt + cureDays` and is never recomputed.
2. **The product's settings are copied onto the batch, not referenced.**
   `cureDaysSnapshot` and `routeSnapshot` exist so that moving a product to a
   three-day cure next month cannot rewrite what a rack made today was.
3. **Blasting runs beside curing, not after it.** A shotblast make is born in the
   blaster's queue *and* on the cure clock. Whether it is ready is decided by
   `calc.readyAt` alone, so the rule lives in one place.

## The sheet

- **Which line.** Five buttons, the shop's own lines from Settings. The last one
  this device used is remembered, so the next shift lands in the right place.
- **Which day.** Arrows either side of the date, and a *Today* button when you
  are not on today. Forward is refused — you cannot log a day that has not
  happened. Back-dating is allowed, because a night shift writes it up in the
  morning; a back-dated make is timed to **midday**, because nobody remembers the
  hour and the hour must not decide when a rack is due. The screen says so.
- **The rows.** A product picker (current codes only), trays, and the quantity
  those trays make — shown *before* anything is written down, so the number that
  will reach MYOB can be compared where it was typed.
- **The button.** Reads *Log 12 trays on Line 1*, so it is obvious what is about
  to happen. It is disabled while any row is unusable, and the row says why.

After it is pressed the sheet clears, because the list underneath is the record
of it now: batch number, code, trays, quantity, stage, and the day the cure is
due.

## What it refuses

A row is refused, never guessed at. No defaulting a route, no assuming a yield:

| Row | Says |
| --- | --- |
| no product | pick a product |
| no trays, or zero | how many trays? |
| half a tray | trays are whole ones |
| route not set | `S7 has no route — set it on Products` |
| yield not set | `S8 has no tray yield — set it on Products` |

A row that cannot be logged stops the button. If something changes underneath a
sheet that was fine when it was typed — a yield cleared in another window — the
good rows are written and the bad ones come back in the receipt with the same
sentence, so nothing is dropped without being said out loud.

Logging is one transaction per sheet. A day that is half logged is worse than a
day that was refused.

## Batch numbers

`2026-09-18-03`, from `production.batchNumberFormat`. The sequence counts **the
day**, because the number is printed on the rack and read out over a running
machine: `-03` has to mean the third make of the 18th. Two devices logging the
same day may both choose `-03`; the number is a label and the id is the identity.

## Taking a make back

A mis-typed entry can be taken back **while it has gone nowhere** — not blasted,
not put on a MYOB run, not keyed into MYOB. Taking back leaves a tombstone, not
an erasure (other devices have to hear that it went away) and one ledger line.

Past that point the row is evidence: a pallet has been moved on the strength of
it. Those are corrected by writing off, which keeps both records and says why —
and that screen is not built yet, so the row says *past taking back* and what it
means, rather than offering a button that would lie.

## Who can do it

`production.record` — owner and maker. A viewer can open the screen and read the
day, with the button disabled and no take-back, because seeing what the shift
made is not a privileged thing to do.

## On a phone

The card heading is the line and the day rather than the words "Daily entry",
which the shell header already says — a long title truncates on a phone, and
counting for the wrong line is exactly what a truncated heading causes. Rows
stack: the picker full width, then trays, then the quantity. The log button is a
touch target, and the page does not scroll sideways.

`Curing` in the bottom tab bar counts the racks on the clock, and it only became
a real number when this screen existed.

## What it does not do

- No editing a logged rack's trays. Take it back and log it again — one action
  either way, and the ledger keeps both.
- No writing off, yet. That belongs with the curing and shotblast screens.
- No operator box. Who logged it is whoever is signed in; the ledger has always
  held that, and a name typed into a box is a name that can be wrong.
- The cure period is honoured in hours if `production.cureTimeUnit` says so, but
  nothing edits that setting yet — see `docs/screens/settings.md`.

## Where it is tested

- `test/core.batches.test.ts` — the cure clock, the starting stage, the row
  refusals, trays × yield, the day's sequence, snapshots, what may be taken back,
  and what is due to come off the racks.
- `test/data.batches.test.ts` — the writer: what it stores, what it refuses, the
  ledger line it leaves, and that a viewer cannot write at all.
- `test/ui.entry.test.tsx` — the sheet in the DOM, including that the quantity on
  screen is the quantity in the database afterwards, and that one screen at a
  time owns the address it arrived with.
- `e2e/entry.spec.ts` — the real build, on desktop, phone and Firefox: a code
  that is not set up stops the sheet and names the screen that fixes it; a logged
  day survives a reload and wakes the menu's curing count; a shotblast make waits
  for the blaster; two products are two numbered racks and a wrong one comes
  back; the board hands the product over; nothing hangs off the edge of a phone.
