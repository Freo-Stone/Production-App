# Future jobs

`src/screens/FutureJobs.tsx`, route `/#/jobs`. The rules — what counts as late, what
counts as covered, and who the stock belongs to — are in `src/core/jobsBoard.ts`. The
one read is `jobBoardSource` in `src/data/jobRepo.ts`.

## What it is for

MYOB hands over a list of open sales-order lines. On its own that list is no use to a
shop floor: it says a customer is owed 8 m² and says nothing about the 10 m² standing
in the yard, so the owner does the arithmetic in his head while somebody waits on the
phone.

This screen does the arithmetic. Every open line, and against it what this device can
already point at, and therefore what is *still* genuinely owed.

Four other screens touch the same rows, from other directions:

- **Data sources** shows the export exactly as it arrived — every column, the
  diagnostics, the rows the parser skipped. That is the import-facing view, and it is
  where you go when a file looks wrong.
- **The Matrix** spreads demand across days so you can see the making load. Its board
  starts at today, so an order promised last week is not on it.
- **Products** answers the same cover question per *code*, against a target level.
- **[The making plan](schedule.md)** takes what is still owed and turns it into work:
  one row per code per promised day, and the last day each make could have started and
  still landed. This screen stops at *can we ship it*; that one goes on to *so what has
  to be made, and when*.

This one is order-facing: customer, order number, promised date, and whether we can
ship it.

## What "covered" is made of

The pool a line is measured against is built by the same `productPosition` the rest of
the app uses, so the two screens cannot disagree:

- **stock on hand** — the last stock export, summed over the locations ticked on Data
  sources, with the phantom 10000 taken off once for a baseline item;
- **on the racks** — curing, waiting for the blaster, and on the blaster;
- **ready** — counted as available unless *Count ready as available* is switched off on
  Settings, because a finished rack that nobody has moved is a judgement the shop
  makes, not a fact;
- **keyed into MYOB, not exported** — racks marked entered after the stock snapshot was
  taken. MYOB has them; the export on this device does not yet, so they are still the
  shop's to point at.

That total is what the **Whole shop** column shows. It belongs to the *code*, not to a
line — which is why it reads the same figure on every line for that code.

## The one rule that is a decision

> Where a code is promised to more than one customer, the **earliest promise is covered
> first**, and a later promise cannot take the same pallet twice.

MYOB does not say which order line a pallet answers. Somebody has to decide, and a
screen that leaves it out leaves the owner deciding it differently on paper each time.
Promise date decides first, then the order number so that two lines promised the same
day come out the same way twice. Lines with a promise date the shop does not believe
sort after every dated promise: **an order that has never been dated must not eat the
stock a customer is actually waiting for.**

This is the app's rule, not a fact from the export, and the footnote under the table
says so on screen.

So: **Covered** is a claim about this line, **Whole shop** is a fact about the code, and
adding the Covered column up will equal the Whole shop figure only when the book is
short enough to cover.

## What counts as late, and what does not

- Promised **today** is `0` days to go. Not late — it is the day the truck comes.
- Promised before today and still open is late, in days, and coloured as short.
- **4/04/2040** — a placeholder the export uses for a large share of its open lines —
  and anything more than the planning horizon away is **no promise date**. It is not
  late, it is not due, and it is left out of the near-term views. The count of them
  sits on a chip so nobody wonders where the rest of the book went, and pressing the
  chip brings them back with a line explaining what you are now looking at.

The late lines matter more than they look: the production board starts at today, so an
order that slipped a fortnight ago is invisible there while still being real demand.
This is the screen where they surface.

## Reading it

Four windows across the top — **Past due**, **This week**, **Next fortnight**,
**Everything** — each carrying the number of lines it will show. Then two filters that
take lines out:

- **Still needed** — only the lines the shop cannot cover from what it has and is
  making.
- **No promise date** — the undated lines, off by default.
- **Left-out ship-via** — appears only if the shop has configured ship-vias to exclude,
  so this screen agrees with the Matrix and Products about what counts as demand.

A search runs over customer, order number, item code, description, salesperson and
ship-via. While anything is filtered the screen prints how many lines it is showing out
of how many it holds, and the Clear button appears. A filter that quietly shrinks a
table is indistinguishable from a shop that has quietly stopped owing things.

Pressing a row opens the line underneath the table: the promised date in words, the
pool broken into the things a person can go and look at (on the shelf, on the racks,
ready, keyed into MYOB), what this line takes out of it, and what it still needs.
Pressing it again, or Close, puts it away.

## Codes that are not ours

A code in the export that is not a product on this device has nothing to compare
against. Those rows say **not ours** rather than showing a zero, and pressing one says
plainly that all of it stands as owed — a bought-in item, or a code this device has
never seen. They are counted separately in the header, and they are never treated as a
failure to cover.

## Credits, and units

Negative lines are credits and returns. They are kept, exactly as exported, and they are
never "covered" — a credit is not something you put a pallet against.

Both sides are in the item's own unit: the export sells in the unit the stock is
counted in (m², lm, each), so Sold and Covered are directly comparable. If an item's
unit on Products is wrong, every figure on this screen is wrong in the same way — the
comparison is only as good as that setting.

## What this screen does not do

- **It writes nothing.** There is no button on it that changes an order, a rack or a
  stock figure. The export is the record; the shop's own numbers come from the other
  screens.
- It does not **reserve** stock. MYOB allocates nothing here, and two people reading
  this screen do not lock a pallet to each other.
- It does not know about stock in a location that is not ticked on Data sources, or
  work being made on a device that has not synced.
- It cannot tell you what a promise date *should* be. Undated lines stay undated.
- No export, no print view, and no saved filters — apart from a column layout and
  column widths, which are remembered like every other table in the app.

## Where it is tested

- `test/core.jobsBoard.test.ts` — fourteen cases on the reading rules: what is late, the
  window edges, the placeholder year, allocation in promise order (including an export
  that offers the later promise first), the stock rules being reused rather than
  re-invented, credits, codes that are not ours, and the chip counts never promising
  more than the filter will show.
- `test/data.jobs.test.ts` — seven cases on the read: newest export wins, a
  discontinued product is no longer one of ours, a written-off rack is not work in
  progress, and a device with jobs but no stock export still gets a usable answer.
- `test/ui.jobs.test.tsx` — eleven cases on the screen: the header sentence, the
  empty-state for a device that has never had the export, the pallet going to the
  earliest promise on screen, filters reporting what they hid, the detail panel, the
  not-ours wording, and the phone width.
- `e2e/jobs.spec.ts` — the real fixture exports loaded the way the shop loads them, on
  desktop, phone and Firefox: the stub is gone, the counts on the chips are the counts
  in the rows, the undated lines add exactly the number they claim, pressing a line
  explains it, and nothing on a phone runs off the side of the screen.
