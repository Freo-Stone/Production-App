# Shotblast

`src/screens/Shotblast.tsx`, route `/#/shotblast`. Rules in `src/core/shotblast.ts`,
writers (`startBlast`, `finishBlast`, `racksAwaitingBlast`) in
`src/data/batchRepo.ts`. Read together with [the curing screen](curing.md), which
owns the same racks on the other side of the machine.

## What it is for

The blaster's own screen. It answers one question: **which racks still owe time in
the machine, and what do we do about them?**

It does not decide whether a rack can be sold. That is `readyAt`'s answer, and the
Curing screen is where it is read out. This screen records what went through the
blaster, because that is a physical event nobody else can testify to.

Blasting runs **beside** the cure, not after it — the shop's own description of
their process, and the reason a shotblast rack can be blasted while it is still
hardening. With `blastingCompletesCure` on (the default, and how they run it),
coming out of the blaster stands in for the rest of the cure, so a blasted rack can
go straight off the racks. With it off, the rack still waits for its cure date. The
screen says which of the two it is doing, in plain words at the top, because it
changes what a blast is worth.

## What is in the queue

A rack is in the queue when it is still on the floor (stages `green`, `curing`,
`awaiting_shotblast`, `blasting`), was logged as a shotblast make
(`routeSnapshot`), and has something outstanding — its quantity is more than the
amount already blasted.

That is deliberately not the same as "in the `awaiting_shotblast` stage". A shotblast
rack that somebody moved to `curing` still owes its blast, and it still appears
here. The stage says where a rack is standing; the queue says what is owed.

## The order, and why it is that way

Three lists, in this order:

| On screen | Means |
| --- | --- |
| **On the blaster** | It is in the machine now. Whichever went in first is at the top. |
| **Waiting for the blaster → Cure is done — only the blast is left** | Hardening is finished; nothing but the blast stands between this rack and a sale. |
| **Waiting for the blaster → Still curing** | It can be blasted beside the cure, and nobody's order is waiting on it. |

The middle list is the top of the queue in every sense. A rack whose cure has
finished and whose blast has not happened is the one holding up an invoice, so it
is above racks that are still hardening, and within each list the rack whose cure
ended longest ago comes first.

The header says `1 on the machine · 2 waiting · 11 trays`, with two chips when they
apply: how many waiting racks only need the blast to finish, and how many days the
most overdue has been waiting — counted between midnights, so the number does not
change as the afternoon goes on.

## Putting a rack on, and taking it off

Two buttons, and they are the physical ones: **On the blaster** and **It's done**.

Marking it going in is optional. A shop that only writes down what came out can
press *It's done* straight from the waiting list — but then the machine is a black
box while it runs, which is the one thing whoever is standing next to it wants to
know. The waiting rows therefore offer all three: **On the blaster** (the next
step), **It's done** (skip ahead), **Part of it** (the dialog). In the machine list
there are two: **It's done**, and **Part of it**.

Recording a whole rack writes three things on the batch: `blastedQty` up to its
full quantity, `blastedAt` now, and the stage back to `curing` — back on the racks.
It does **not** set the stage to `ready`. Whether the rack can be sold is
`readyAt`'s answer, and on this shop's settings that answer is "now", so the Curing
screen will be offering it as *Off the racks now* the moment the toast clears.

The ledger takes one line per event:

```
2026-09-15-01 on the blaster — 8 trays in
2026-09-15-01 through the blaster — all 8 trays out
```

## Part of it: when only some of the rack went through

The floor counts trays, so the blast is counted in trays. The dialog asks one
question — *how much of it came out?* — and says what that means before it does it:

> 3 trays come out blasted and keep 2026-09-13-01. The other 5 become their own
> rack, still to be blasted.

The trays that came out of the machine **keep the number on the label**: that is
the rack that went in, and its history, its making date and its cure clock all
belong to it. The rest of the rack becomes a new batch — a new number from the
making day, `parentBatchId` pointing back at the rack it came from, `blastedQty`
zero, and back at the top of the queue under *Needs blast*. A half-blasted pallet
that kept the old number is a pallet that gets read as blasted next time somebody
walks past it.

Quantities are split from the rack's own numbers (its quantity divided by its
trays), never from whatever the product's tray yield says today, and the remainder
is taken as the difference rather than a second multiplication, so the two halves
add back to the rack that was made exactly. The making date, the cure clock, the
line and the product are copied: only the blast differs between the two.

The ledger gets two lines, which name each other:

```
2026-09-13-01 through the blaster — 3 of 8 trays out
2026-09-13-02 — the other 5 trays off 2026-09-13-01, still to be blasted
```

## What it refuses

The screen asks the same question the writer asks, so a button that appeared can
only be refused for something that happened after it was drawn. Either way the
answer is a sentence, never a shrug:

| What was tried | What comes back |
| --- | --- |
| Blast a rack that has been taken back | *That rack has been taken back, so there is nothing to blast.* |
| Blast a rack that was written off | *X was written off. If it turned up after all, log it as a new make — the write-off stays in the ledger either way.* |
| Blast a rack that is keyed into MYOB | *X is keyed into MYOB. Correct it there, or write it off — moving it here would leave the two records disagreeing.* |
| Put a rack on the blaster that does not need it | *It is already marked on the blaster.* · *X has already had its blast, so it does not belong in the blaster's queue.* |
| Record a rack that does not need it | *X has already had its blast.* · *X is not a shotblast make, so it does not go through the blaster.* |
| Press on with nothing typed | *How many trays went through the blaster?* |
| Type a fraction of a tray | *Trays are whole ones.* |
| Type more trays than the rack holds | *Only 8 trays are on that rack.* |

A refusal writes nothing: not the batch, not a ledger line. The confirm button stays
disabled until the number in the box is a count of trays that fits the rack.

## Two counts that differ on purpose

The menu badge on **Shotblast** counts racks in the stages `awaiting_shotblast` and
`blasting`. The screen's queue counts racks that **owe a blast**, whatever stage
they are standing in. A shotblast rack that has been moved back to `curing` is in
the queue and not on the badge. They are both right, and they answer different
questions — "what is where" and "what is owed" — so neither is adjusted to match
the other.

## Who can press what

Reading is open to everyone signed in. Putting a rack on the blaster, and recording
what came out of it, take `production.record` — a maker or an owner. A viewer sees
the same queue, without a single button, and the card says so.

## On a phone

The rows are two lines: the number, the product and the chip; then the line, the
trays and quantity, what the cure has done, and the buttons. *On the blaster* and
*Part of it* are 44px targets — the suite measures them on a Pixel 7 — and the queue
never scrolls sideways.

The dialog is a bottom sheet. Its footer carries the safe-area inset, so *Out of the
blaster* sits above the home strip rather than under it, and the title is allowed to
wrap: "How much of 2026-09-13-01 came out?" is the question, and it stops being one
when it is cut off.

## What it does not do

- **It does not decide readiness.** `readyAt` does, and the Curing screen reads it
  out. A blast puts a rack back on the racks; whether it can come off them is asked
  there.
- **It does not write racks off.** A rack cracked in the sling is written off on
  [Curing](curing.md), which every rack on the floor is listed on. Two screens
  offering the same irreversible action is two places to look for it later.
- **It does not undo a blast.** A recorded blast is evidence about a physical
  event. If it was a mistake, write the correct amount off with a reason, or log
  the rack again — the ledger will show what happened either way.
- **It does not run on a timer.** Nobody and nothing moves a rack by itself.
- It does not track the machine's hours, service, or media. It tracks racks.

## Where it is tested

Rules and lists: `test/core.shotblast.test.ts` (order, the split's arithmetic
including quantities that do not divide evenly, and every refusal sentence).
Writers: `test/data.shotblast.test.ts` (one transaction, the numbers the ledger
lines carry, the new batch's number continuing the making day's sequence, and that
a viewer is refused). The screen: `test/ui.shotblast.test.tsx` (jsdom, including
that a rack survives the desktop-to-phone breakpoint — a short-circuited
`useIsCompact() || useIsCoarsePointer()` unmounts the whole screen, and this file
catches it). The build end to end: `e2e/shotblast.spec.ts` on desktop, Pixel 7 and
Firefox — a make logged on Daily entry arriving in the queue, a rack going onto the
machine and coming off it, the split producing a second number and the blasted half
appearing on the cure screen, and the dialog refusing a number that is not a count
of trays.
