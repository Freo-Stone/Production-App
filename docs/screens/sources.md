# Data sources

`src/screens/Sources.tsx`, route `/#/sources`. Makers and the owner; a viewer
does not get offered it.

## What it is for

The bridge between MYOB and the shop's own numbers. Everything the board says
about stock on hand and promised jobs comes from the two exports, and this is
where they come in, where you can see how current they are, and where you can
read what was actually imported.

## Layout, top to bottom

| Block | What it is |
| --- | --- |
| The line along the top | rows in the stock mirror, lines in the job mirror, and how many lines carry a placeholder date — and on the right, the automatic-import line: the switch, the interval, and what each of the two files last did. `docs/exports.md` |
| Import by hand | one line, closed. Open it and the tray is there: drop the workbooks, see which report each one is, load them |
| Locations counted as stock | one line, closed, saying how many of the groups are counted. Open it for the chips |
| The mirrors | one card, two tabs — the stock rows and the job lines exactly as exported — with everything the blocks above did not use |

Two of those are `Disclosure`s (`src/ui/primitives.tsx`): a line, a caret, and
content that is not in the screen at all until asked for. They were full-height
cards, and the table anyone came for started below the fold.

## Room

The table's box is measured, not guessed. `useFillBelow` takes the distance from
where the box starts to the bottom of the window, less the phone's bottom bar and
any line of guidance underneath it, and re-measures when the window resizes, when
a phone's URL bar appears, and when anything above it wraps onto another line.

Both halves of that mattered. The height used to be a guess — `min(62vh, 620px)` —
and the grid inside it grew to the height of every row it held: 91,673px for 1,102
job lines. `DataTable` with no `height` was being sized by its content instead of
filling its parent, the card around it clipped, and the rows past about the twelfth
belonged to no scroll at all — the wheel moved the page and the table stayed where
it was. So the fix is in the grid as much as in this screen: a `DataTable` that is
not given a height fills the parent it is put in, and `e2e/layout.spec.ts` holds
both the fill and the scroll, on a mouse and on a phone.

One consequence of the table reaching the bottom: toasts arrive over it. They used
to hang in space nobody needed. A toast that takes the pointer there sits on a
column's resize handle, and a handle that will not drag reads as a broken table, so
the toast card is click-through and only its own two buttons answer the pointer.

## Automatic import

The shop's decisions and the facts on one line: the switch, the interval, and per
file whether it is up to date, how long ago it came in, or what went wrong. *Check
now* re-reads both files without waiting for the interval.

**Details** opens the rest: the two paths in the repository — so the mirror can be
pointed at wherever Power Automate actually writes — each file's fuller line with
its size and arrival time, and the sentence about why a laptop that stayed shut
over the weekend imports on Monday morning.

A viewer sees the same statuses with nothing to change, because the answer is
useful and the controls are not theirs. They are not offered the interval either:
their own write would be refused anyway.

## Import by hand

Still there, still the way in when a file is on somebody's laptop. Files are read
in the browser; nothing is uploaded, and the tray says which report it found
inside each workbook rather than trusting its name.

Choosing files opens the line by itself, so *Load* is never behind a caret nobody
thought to click. Dropping the same export twice replaces the tray's entry
instead of stacking a second copy of it: a second `location.xlsx` means "use this
one".

## What an import does, and what it refuses to do

- The stock mirror and the job mirror are **replaced** by the file, not added to.
  Two exports of the same report mean the later one is the truth.
- Product **identity** follows the exports: a code that appears in either becomes
  known, and its description follows MYOB's copy, because that field belongs to
  MYOB.
- Nothing else about a product is touched. An import never enables a code, never
  changes a unit, a tray yield, a target or a cure time. Those are the shop's
  decisions, made in Products, and an import that flipped them would wreck the
  matrix every time the exports were refreshed.
- A workbook that is neither report is refused with a sentence naming what was
  expected.

## Reading the mirrors

Both tabs are the grid engine, so filter, column widths, sorting and the shared
or personal view behave as they do everywhere else. The stock tab shows
`Units On Hand` exactly as exported — baseline items still carry the phantom
10,000 there, which is the point of showing it raw; the derived figures live on
the board.

Placeholder promise dates (a year like 4/04/2040 means "no date yet") are held
out of the near-term job list, and the switch above the table puts them back when
you need to see them.
