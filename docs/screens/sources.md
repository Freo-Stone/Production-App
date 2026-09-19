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
| The import line, at the top right | the automatic-import switch, the interval, what each of the two files last did, and **Details** for the paths in the repository. `docs/exports.md` |
| The folder line, under it | whether *this* computer is watching a MYOB folder, what the last look decided about each file, and **Details** for the two names, the age limit and the folder itself. `docs/folder-watch.md` |
| Import by hand | one line, closed. Open it and the tray is there: drop the workbooks, see which report each one is, load them |
| Locations counted as stock | one line, closed, saying how many of the groups are counted. Open it for the chips |
| The mirrors | one card, two tabs — the stock rows and the job lines exactly as exported — with everything above it that is not the table |

Two of those are `Disclosure`s (`src/ui/primitives.tsx`): a line, a caret, and
content that is not in the screen at all until asked for. They were full-height
cards, and the table anyone came for started below the fold.

**There are no counts above the table.** There were four tiles — rows in the stock
mirror, lines in the job mirror, the location groups, how many lines carry a
placeholder date — they became one line of facts, and the answer was still *"remove
this from all pages, i do not need to see this."* Fair enough, because every one of
those numbers is already where it is looked at: the tab labels say `Stock (n)`, the
chip in the header says how old the data is, and the count of groups on the line
that holds them says `n of m counted`. Nothing is lost that anyone was reading, so
the band is gone and the table has the room.

The rule for the whole screen follows from it: a number appears where it is used,
not in a summary above the thing it describes.

## Room

Measured in the browser with both mirrors loaded and the panels closed: the grid
runs **342→704** of a 1280×720 window and **408→747** of a 390×839 phone, the page
behind it has 1px and 0px left to scroll respectively, and the card that holds it
starts a quarter of the way down either screen. `e2e/layout.spec.ts` holds that
quarter.

The table's box is inherited, not measured and not guessed. The shell is
`h-dvh`, `main` is the scroll region (`min-h-0 overflow-y-auto`), and a
`flex-1 min-h-0` chain through the card hands the grid whatever height the window
has left. `useFillBelow` used to measure `innerHeight - top - gap` in JavaScript and
write an inline pixel height, with a hand-typed gap per screen; that number was
wrong on one side or the other for any window it was not drawn for, which is how a
54px dead strip and unreachable rows were the *same* bug.

The invariant to keep: **a grid stays a scroll box only while every height above it
is definite.** Give the chain an auto height and the grid takes the height of the
virtualised spacer — the 91,673px bug again from the opposite direction. That is
also why a phone held sideways is handled in `src/styles/theme.css`: under
`@media (max-height: 560px)` the page takes over and the wrapper takes a *definite*
240px, so the shortfall becomes page scroll instead of rows hidden by the card.

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

One line, on the right: the switch, the interval, and per file whether it is up to
date, how long ago it came in, or what went wrong. *Check now* re-reads both files
without waiting for the interval.

**Details** opens the rest: the two paths in the repository — so the mirror can be
pointed at wherever Power Automate actually writes — each file's fuller line with
its size and arrival time, and the sentence about why a laptop that stayed shut
over the weekend imports on Monday morning.

A viewer sees the same statuses with nothing to change, because the answer is
useful and the controls are not theirs. They are not offered the interval either:
their own write would be refused anyway.

## The folder line

The other end of the same pipe. Everything above this screen is about files coming
*in* from the repository; this line is about a file leaving *from the folder on this
machine's own disk*, which is the only way today's numbers get there without somebody
dragging them.

It is a line for the same reason the import line is: the screen is opened to read the
table. On the line, the state — **No folder yet**, **Waiting for one click**,
**Cannot watch folders**, **Folder refused**, or **Watching** with the folder's own
name and the interval — plus when the last file went out. **Look now** does not wait
for the next minute; **Pause** stops it here and remembers the folder; **Details**
holds the two file names, the age limit, one line per file saying what the last look
made of it, and **Forget this folder**.

Three of those states exist because only a hand on this keyboard can fix them:
pointing the browser at the folder, clicking once after a browser restart (Windows
makes every web page ask again; the app cannot do it for you), and telling MYOB to
save into that folder. **Cannot watch folders** is not an error: Firefox and Safari
will not let a web page see a disk at all, so on those browsers the line says so and
the rest of the app is untouched.

When a folder holds a file that *looks* like the export but is not named what
Settings says, the line says **Named differently** and offers the file as a button.
It is never used on its own: guessing wrong here overwrites the wrong mirror on every
computer at once, and the shop finds out when the numbers look odd. A viewer sees all
of this and nothing to press.

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

The shop-facing view of the same lines is [Future jobs](future-jobs.md): the order
book in promise order, with what the shop can already point at against each line.
This screen stays the import-facing one — every column exactly as it arrived, and
the rows the parser refused.
