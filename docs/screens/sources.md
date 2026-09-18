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
| Freshness | four tiles: rows in the stock mirror, lines in the job mirror, the location groups found, and how many lines carry a placeholder date |
| Automatic import | the card that pulls the two files out of the repository on its own — `docs/exports.md` |
| Import by hand | the tray: drop the workbooks, see which report each one is, load them |
| The mirrors | one card, two tabs — the stock rows and the job lines exactly as exported |

## Automatic import

The shop's decisions and the facts are on the card together: the switch, the
interval, the two paths in the repository, and — per file — whether it is up to
date, when it came in, how many rows it carried, or what went wrong. *Check now*
re-reads both files without waiting for the interval.

A viewer sees the same statuses with nothing to change, because the answer is
useful and the controls are not theirs.

## Import by hand

Still there, still the way in when a file is on somebody's laptop. Files are read
in the browser; nothing is uploaded, and the tray says which report it found
inside each workbook rather than trusting its name.

Dropping the same export twice replaces the tray's entry instead of stacking a
second copy of it: a second `location.xlsx` means "use this one".

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
