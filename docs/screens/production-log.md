# Production log

`src/screens/ProductionLog.tsx`, route `/#/log`. The reading rules are in
`src/core/ledger.ts`; the readers are `ledgerWindow`, `ledgerForBatch` and
`ledgerSize` in `src/data/events.ts`, `describeRack` in `src/data/batchRepo.ts`
and `deviceLabels` in `src/data/accounts.ts`.

## What it is for

Eighteen places in this app write a line to the ledger — Daily entry, Curing, the
blaster, the MYOB run, Data sources when an export is loaded, Products when a
setting changes, People when an account or a device is touched, and the sign-in
screen every time somebody sits down at a tablet. Nothing had ever read one back.

Two questions get asked of a log, and they are different shapes:

- **"What happened?"** — a diary, newest first, grouped into days, with a filter
  for the part of the shop you care about.
- **"Who moved this rack?"** — one rack's whole history, however far back it goes.

The screen has a mode for each. They do not read the same list: the diary reads a
window of the newest lines, and one rack's history reads *every* line about that
rack, because the line you want on a Friday afternoon is usually the one a busy
fortnight has pushed out of the newest four hundred.

Nothing on this screen writes anything. The ledger is append-only by design, and a
screen that reads it must not offer to edit it.

## What gets written down

Every action the ledger can hold belongs to one of five groups, and every one has
a name. That map is exhaustive on the action type, so a new action will not
compile until somebody has said which group it belongs to and what it is called —
better a build that stops than a log with blank rows in it.

| Group | What is in it | A line reads |
| --- | --- | --- |
| On the floor | making logged, racks moved, parts parted off, blasts, write-offs, take-backs, and what the shop put on the plan | `2026-09-14-01 off the racks — 8 trays ready` |
| MYOB | stock keyed in, and racks taken back out of a run | `2026-09-14-01 keyed into MYOB — run 18/09/2026 · 8 trays · 16.00 GL4 · ref INV-42` |
| Products | exports loaded, product settings changed, products reordered | `stock import from location.xlsx: 2691 rows, 2342 new codes` |
| People | accounts, passcodes, devices, sign-ins | `Test Person signed in as owner` |
| Shop setup | published views, and anything the sync loop reported | `Make side default view published by Owner` |

Where a writer left the sentence out, the row still says what happened, with
whatever numbers the line carries: `Through the blaster — 4 trays · 4 GL4`. A
blank row is the one thing a log may never be.

Product lines name the product — `GL4: set current`, not `set current`. When the
only reader was the row on Products, the code was already on screen beside it.
Read out of context in a diary it said nothing.

## Days

Lines fall into calendar days on the device that read them: **Today**,
**Yesterday**, then `Wed 16/09/2026`. A rolling 24 hours would cut a night shift in
half, and nobody reads a shop's week that way.

Each day says what it was made of before you read a single line:

> Today — 3 on the floor · 1 keyed into MYOB · 4 products or exports · 2 people or devices

On a phone the same line counts in counters — `floor 3 · MYOB 1 · products 4 ·
people 2` — because the sentence is cut off at "4 products or e…" at that width,
which tells you less than nothing. Same groups, same order as the chips, fewer
words.

## One rack's history

A line that is about a rack carries a **This rack** button. It puts the rack in the
address (`/#/log?rack=…`), which means it survives a reload and can be handed to
somebody else as a link, and the screen changes to that rack's whole story with an
**Every line** button to get back.

The heading names the rack the way the floor names it — `Every line about
2026-09-10-01 (GL4) — 6 lines` — from the rack's own row. A rack whose row is not
on this device still has ledger lines, and the heading says so plainly instead of
showing a name it does not have.

In this mode there are no group filters: you have already narrowed to one rack, and
a chip that cannot narrow anything further is noise.

## Reading, searching, and what a filter hides

- **Chips** per group, each showing how many lines of that group are loaded. More
  than one can be on at once; **Clear** appears when anything is on.
- **People** chips when the loaded lines name more than one person, most recently
  seen first. Names come off the lines themselves, not the account list: an account
  can be renamed or deleted, and the log has to go on saying who did it. Past eight
  names the row folds into a counted **+3 more** press — a shop with five accounts
  never sees it, one that has been through a dozen casuals does not get a wall of
  names where the diary should start.
- **Search** matches the words on the line, the item code and the name — a rack
  number, `INV-42`, a file name, a person. It does not match action keys, because
  nobody types `batch.enterMyob`.
- Anything a filter shuts out is counted out loud: `4 lines hidden by the filter`.
  A list that silently shrinks is how a person starts distrusting a log.
- Nothing matches, the lines are here, just not these ones. **Clear the filters**.

## How far back it goes

The diary reads the newest 400 lines through the ledger's own index, and **Show
earlier lines** takes another 400. This is a live query — it runs again on every
write in the shop — so it walks the index and stops, rather than pulling every line
this device has ever written into memory and sorting it. The header says
`1,204 lines on this device`, and `the newest 400 back to Yesterday` only when
there really are lines not on screen yet. When everything is loaded, neither the
hedge nor the button is offered.

## Names, on both sides of a line

The **who** comes from the signed-in account, stamped when the line is written. A
line written with nobody signed in says `nobody signed in` rather than borrowing the
last person's name.

The **where** is the device's id, because an id survives a rename. People is where
the shop gives its tablets names, so the log looks the name up: `Floor tablet`, and
`Floor tablet (this device)` for the one you are holding. Before it has a name the
id is the only true thing to say, so it is shown trimmed to `8f4c1a2e…` — a UUID
across every line makes the diary unreadable on a phone.

## What a line cannot tell you

A line's time is **when the press happened**, not the day the making, the blast or
the cure belongs to. Log yesterday's making this morning and the line lands today,
because that is the fact an audit log is for. The business date is in the sentence —
`2026-09-14-01 · 8 trays of GL4 on Line 1` — which is why rack numbers carry the
date they were made on.

A line is also not a receipt: it says what somebody pressed, and the numbers they
pressed it with. Costing, stock movements and anything MYOB holds are elsewhere.

## Who can see it

| Role | Reading the log |
| --- | --- |
| Owner | everything on this device |
| Maker | everything on this device |
| Viewer | everything on this device |

Reading is not gated. Lines from other devices arrive with the sync, as a union —
the ledger is one of the tables that is never overwritten by another device, so
"who moved this rack" survives however the records themselves get merged.

## On a phone

The diary is used one-handed on a tablet in a dusty bag, so:

- filters, rack buttons and **Show earlier lines** are thumb-sized, measured in the
  browser tests at 412px wide;
- day headers count instead of talking;
- the meta line under a line is one row and truncated, with the full device id in
  its title;
- nothing hangs off the side of the screen — the tests measure the right-hand edge
  of every filter button and the page's own scroll width.

## What it does not do

- **It writes nothing.** No edit, no delete, no note typed into the log. The way to
  put something right is the screen that got it wrong, which writes its own line.
- **No export.** It reads a ledger that came from presses; there is nothing to hand
  to MYOB. The MYOB run's copy-out is on `/#/myob`.
- **No undo here.** A take-back writes `batch.undo` where it happened — Daily entry,
  Curing, the MYOB run — and shows up here like anything else.
- **No saved filters.** The group chips, the person and the search are this
  afternoon's, deliberately. Only the rack stays in the address, because it is a
  question about a thing, not about how you like the list.
- **No tail that follows.** New lines arrive with the data, but the screen does not
  scroll itself. Reading a page while it moves under you is how lines get missed.
- **No per-line detail drawer.** The sentence is the whole record; where a line came
  from a screen that can show more, that screen can.

## Where it is tested

`test/core.ledger.test.ts` — the action map covers every action and uses every
group, the fallback sentence, day labels (including a clock running ahead), day
grouping and tie-breaks, the two summary styles, every filter dimension, and the
shortened device id.

`test/data.ledger.test.ts` — the window comes back newest first and clamps a
silly size, one rack's history reaches further back than the window does, the count
includes lines about racks that are gone, `describeRack` still names a written-off
rack and says nothing about a rack this device never saw, and the actor stamp comes
from the account.

`test/ui.log.test.tsx` — fourteen cases under jsdom: the empty device, day headings
and the day's own summary, `nobody signed in`, a line with no sentence, group and
person filters with the hidden count, the folded row of names, search across three
shapes of text, the nothing-matches state, paging at 400 lines, one rack's history
from a press and from a link, the singular "1 line", the rack that is not on this
device, and the media-query regression.

`e2e/log.spec.ts` — through the real build on desktop, Pixel 7 and Firefox: the
diary starts at the sign-in that set the device up; a day's making appears under
Today; a rack logged on Daily entry, taken off the cure and keyed into MYOB leaves
three lines that one press reads back; a search finds the rack by its number and
every line shown is about it; paging is only offered when there is more; and on a
phone nothing overflows and nothing is smaller than a thumb.
