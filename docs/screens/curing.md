# Curing

`src/screens/Curing.tsx`, route `/#/curing`. Rules in `src/core/curing.ts`, the
only writers in `src/data/batchRepo.ts`.

## What it is for

This is the screen that gets used at the end of the afternoon, standing up: what
came off the cure today, what is coming off tomorrow, and what can go into the
next MYOB run. Three questions, asked in a minute, with the racks in front of you.

That is a decision, not a report, so the screen is a list of racks with a button
on the ones that are ready to come off, and a sentence on the ones that are not.
It is arranged by when each rack is needed, soonest first, so the answer to "what
can go into the next MYOB run" is what is at the top.

## What is on the clock

A rack is on the clock from the moment it is logged until somebody takes it off,
writes it off, or it is keyed into MYOB. In stage terms: `green`, `curing`,
`awaiting_shotblast` and `blasting`. A rack that has been taken back on Daily
entry is not here — it never became a rack.

Racks are only ever read here and on the [Shotblast screen](shotblast.md); nothing on this screen
changes how long a rack takes. The cure clock was fixed when the make was logged
(`cureDaysSnapshot`, `routeSnapshot`), so changing a product's cure days in
Products cannot re-age a rack that is already sitting on the floor.

## When it is ready

`readyAt` decides, and only `readyAt` — the same function the matrix and the
counts use. For a make-only rack that is the end of the cure. For a shotblast
make it is the **later** of the end of the cure and the moment its blast is
finished, because blasting runs beside curing, not after it.

Two consequences that look odd until you have stood in front of the racks:

- A shotblast rack that still owes its blast has **no plan date at all**. It is
  not "due today", it is waiting for something that has not happened yet, so it
  sits under *Waits for something* with the reason on it. No amount of curing
  makes it ready on its own.
- A rack that has been blasted but is still curing is not ready either. It shows
  the day the cure finishes, like any other.

## The headings

Buckets, in the order the screen lists them, with the names a person reads rather
than the ones in the code:

| In the code | On screen | Means |
| --- | --- | --- |
| `waiting` | Waits for something | It owes a blast, so there is no date to plan around |
| `now` | Off the racks now | The time has passed and nobody has moved it yet |
| `today` | Still on today | It comes off later today |
| `tomorrow` | Tomorrow | Tomorrow's job |
| `week` | Later this week | Due within the week |
| `later` | Further out | Beyond the week |

Within a bucket the soonest rack comes first, and within *Off the racks now* the
one that has waited longest is at the top: that is the one holding up an invoice.

## Taking a rack off

*Take it off* moves the rack to **Ready**, which is the pile the
[MYOB entry queue](myob-entry.md) works through. It writes one stage change and one ledger line —
`A3 off the racks — 6 trays ready` — with who did it and from what to what. It
does not touch stock, does not create a MYOB run, and does not promise a date.

A rack that has come off the cure is also **offered in a sentence** above the
list, with a single *Move them to Ready* button for all of them at once. That is
an offer, not a timer: the setting behind it
(`production.autoAdvanceCuring`) means "the shop moves racks off the cure when
they are due", and this is where it is honoured. Nothing moves a rack by itself
while nobody is looking. A shop that wants the clocks left alone until somebody
decides can switch that off in Settings, and the offer disappears with it.

## The ready pile, and putting one back

Racks that have come off are listed underneath, *Off the racks, not entered yet*,
oldest make first, until they are keyed into MYOB. They are counted in the MYOB
badge the whole time, and the run they belong to is worked out on the
[MYOB entry screen](myob-entry.md) — this screen never dates a rack itself.

That list exists because *Take it off* is a button on a rack, and sooner or later
somebody presses it on the wrong one. A rack that goes somewhere nobody can see
is a rack that gets lost; here it is on the screen with a *Put it back* button
that returns it to the cure clock with its own due date, and says so in the
ledger.

## Writing one off

Every rack on the clock can be written off, with a reason that has to be typed.
Write-off keeps the rack and the reason in the record and takes it off the clock
— it is not a delete, because a pallet has been counted on the strength of that
rack and somebody has to be able to explain the difference afterwards.

*Take it back* belongs to Daily entry and only works while a make has gone
nowhere. Once a rack has been taken off the cure, taken back is no longer on the
table: writing it off is the honest correction, and the ledger keeps both moves.

## What it refuses

The same function answers for the screen and for the writer
(`moveProblem`), so a button that appears can only be refused by something that
changed after it was drawn, and the sentence you would have been told is the one
on the row.

| Situation | Says |
| --- | --- |
| still curing | `A3 is still curing — due tomorrow.` |
| owes a blast | `A3 still has 5 to go through the blaster.` |
| already marked ready | `It is already marked ready.` |
| into the blaster, but blasted | `A3 has already had its blast, so it does not belong in the blaster’s queue.` |
| keyed into MYOB | `A3 is keyed into MYOB. Correct it there, or write it off — moving it here would leave the two records disagreeing.` |
| already written off | `A3 was written off. If it turned up after all, log it as a new make — the write-off stays in the ledger either way.` |
| taken back on Daily entry | `That rack has been taken back, so there is nothing to move.` |
| into MYOB from here | `A rack goes into MYOB from the MYOB entry queue, where it joins the week’s run.` |
| write-off, no reason | `A write-off needs a reason. It is the only place the shop writes down why stock went missing.` |

A sweep refuses per rack, never for the lot: whatever was due moves, and each
refusal is reported. A sweep that finds nothing says *Nothing was due* rather
than silently doing nothing.

## Two counts that differ on purpose

The menu's **Curing** badge counts racks that are curing — `green` and `curing`.
Racks sitting in the blaster's queue are counted under **Shotblast** instead, so
one rack is never in two numbers at once. The screen's own heading counts
everything on the clock. So the badge can read 3 while the screen says 4 racks:
the fourth is waiting for its blast, and it is also on the Shotblast screen.

## Who can do it

`production.record` — owner and maker. A viewer can read the whole screen,
including the reasons, and gets no buttons; the header says so in the offer bar
rather than showing a button that would fail. Write-offs are the same permission:
this shop writes off a rack because the floor saw it crack, not because an office
decided.

## On a phone

Each rack is two lines, and the reason it is not ready is on a third line when
there is one. On one line the five facts a rack carries clip each other at 390px,
and the refusal sentence pushed the buttons off the screen. *Take it off*, *Write
off* and *Put it back* are 44px tall on a phone — the floor is gloved and
one-handed — and the compact row stays on a desktop mouse.

The bottom tab bar carries Curing with its count, because four o'clock happens
standing up.

One warning for whoever edits next: the screen reads two media queries, and both
hooks must be called on every render. `useIsCompact() || useIsCoarsePointer()`
reads better and is wrong — once the first says "compact" the second is never
called, React calls that "fewer hooks than expected", and the whole screen
disappears into a blank page. `test/ui.curing.test.tsx` crosses the breakpoint on
purpose to keep that from coming back.

## What it does not do

- No moving a rack through the blaster. That is the Shotblast screen; a rack that
  owes a blast only ever explains itself here.
- No keying into MYOB, no putting a rack on a run. That is the MYOB entry queue,
  which needs a week to put it in and has its own permission.
- No partial write-offs. A rack is a rack: it is written off whole, with a reason.
  Trays that were salvaged are a new make, logged where they were made.
- No timer, no background job. The offer is made, a person presses it.

## Where it is tested

- `test/core.curing.test.ts` — what is on the clock, when a rack is ready with
  and without a blast, the buckets and their order, the summary the header
  counts, and every refusal sentence above.
- `test/data.curing.test.ts` — the writers: one stage change and one ledger line
  per move, the ready pile read back oldest-first, a sweep that moves what is due
  and refuses the rest without half-doing it, write-off with and without a
  reason, and that nobody without `production.record` can write at all.
- `test/ui.curing.test.tsx` — the screen in the DOM: which rack sits under which
  heading, which row has a button and which has a sentence, the write-off dialog
  that will not close without a reason, the ready pile and *Put it back*, the
  viewer's screen with no buttons, and the breakpoint crossing above.
- `e2e/curing.spec.ts` — the real build on desktop, phone and Firefox: a logged
  make appears with the day it comes off and wakes the menu count; a rack that
  has come off is offered, moved by one press, lands on the ready pile, survives
  a reload, and goes back on the clock when asked; a write-off is refused without
  a reason and written down with one; a shotblast make waits for the blaster
  instead of being offered as ready; an empty shop says so plainly.
