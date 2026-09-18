# Matrix

`src/screens/Matrix.tsx`, route `/#/` — the board the app opens on. (The router keeps
an unknown address from dead-ending on a phone by sending it back here, but `/#/` is
the address of this screen.)

The arithmetic lives in `src/core/matrix.ts`. The screen holds no sums of its own.

## What it is for

One row per product the shop currently makes, one column per day, and in each cell
the amount of that product promised on that day — read straight off the open jobs.
The rows are coloured by where the product stands against its target, so the board
answers the only two questions worth asking standing up: **what is short**, and
**what is promised next**.

It is a reading of the two MYOB exports plus this app's own production records. It
writes nothing to MYOB, and it never re-decides what is in stock.

## The two rules the whole board rests on

Both come out of the exports themselves, and both are pinned by tests in
`test/core.matrix.test.ts` because getting either one wrong is how a shop ends up
making the same pallet twice.

1. **On-hand is already net of jobs.** MYOB's *Units On Hand* has the open orders
   taken out of it already. So a day cell adds up what is promised; it does **not**
   subtract that demand from the stock figure, and the stock column does not move
   when a job is added. A test drops a 400-unit job onto a quiet board and asserts
   the on-hand and incl-curing figures come back unchanged.

2. **"Needs making" comes from the target.** A product's shortfall is
   `target − (on hand + curing + already blasted)`, which is the **To get to target**
   column. That difference is what decides red or green — not the raw on-hand, and
   not the sum of open jobs. A target of 0 means "not judged", so a code with no
   target never wears a colour.

## Columns

| Key | Header | What it says |
| --- | --- | --- |
| `code` | Code | The MYOB item number. A button: opens the product's own drawer. Pinned. |
| `description` | Product | MYOB's wording. Pinned. |
| `unit` | Unit | `m²`, `pc` or `pack`, per product. |
| `stock` | In stock | On hand from the last stock export, baseline 10000 removed where it applies. Red when the position is short. |
| `incl` | Incl. curing & blasted | On hand plus everything already made and not yet written off. Green when the gap only needs time. |
| `target` | To get to target | How far short of the target that leaves the shop. The colour driver. |
| `due` | Due in view | Total promised inside the day columns on screen. |
| `beyond` | Beyond | Promised after the last column, so a 2-week view cannot hide a big June truck. |
| `d<day>` | Fri 18 | Demand for that calendar day. |

The day columns are generated from the horizon, so they come and go as a group.
That is safe with saved views: `resolveColumns` keeps saved widths for keys that
still exist, drops the ones that vanished, and appends new keys in declaration
order. Two people can be looking at different day ranges on the same board and
neither is fighting the other's screen.

## Colour

| Sign | Meaning |
| --- | --- |
| red row, red **In stock** | **Short.** Under target and nothing on the clock closes the gap. The row itself wears a faint red wash. |
| green **Incl. curing & blasted** | **Needs curing.** Still under target, but material is on the clock. Wait. |
| `!` in a day cell | **Past start date.** The last day a make could start and still land on that date has gone. |
| `·` | Nothing promised that day. Kept faint so the figures stand out. |

The words live beside the board as three chips — Short, Needs curing, Past start
date — with the same sentences in their `title` attributes. There is no counts band
above the board: a number sits next to the thing it describes
(`docs/screens/products.md`).

Whether a shotblast product has time left takes `production.blastHandlingDays` into
account, because blast is a day of handling as well as a day of curing. A product
whose route is still **not set** never shows `!` — the app will not judge a make
time it was never told.

## Popups

* A **day cell** opens that one number: on hand, incl. curing & blasted, to get to
  target, the day's total — and beneath it every job line behind it, with customer,
  order number, quantity and promised date, biggest first.
* A **row** (the code, or anywhere on the row) opens the whole product: the same
  facts, plus every day inside the view that carries demand, and the total sitting
  beyond it.
* Both popups end with **Open in Products**, which goes to
  `/#/products?code=S3` and opens that product's drawer. The Products screen reads
  `?code=` on load, so the jump lands on the row rather than at the top of 2,365
  codes.

## The horizon

Four buttons — 1 wk, 2 wks, 4 wks, 6 wks — stored as `horizonWeeks` on the person's
own view (`db.views`), so it is a personal choice that comes back after a reload.
The shop's default is four weeks; the choice never changes anyone else's board.

Every calendar day gets a column, Saturdays and Sundays included: a promise date on
a Saturday is a fact about a truck, and dropping the column would drop the demand
with it. Weekend columns are tinted, nothing more: curing runs through a weekend
and a truck can be loaded on one, so the app does not treat Saturday and Sunday as
days nothing happens.

The board starts at today. A line promised last week is not on it, and a promise
dated 4/04/2040 goes into **Beyond** rather than into a day nobody can plan around
— both of them are still demand, and [Future jobs](future-jobs.md) is where the
late ones get read, one order at a time.

## On a phone

Forty-two columns sideways on a 390px screen is not a board. A phone shows the
product, where it stands, and the next four days — the first six facts plus four day
columns — unless the person has made their own short list in the column picker,
which always wins. `mobileColumns` is matched against the column keys key for key,
and both sides spell those keys with `matrixDayKey()` in `src/core/matrix.ts`: when
the phone's list was spelled as a date and the columns as a day stamp, the phone
board lost every single day column. That is what `on a phone the board keeps its
days` in `test/ui.matrix.test.tsx` is for.

## What it says when there is nothing to show

Three different empties, three different sentences:

* **Nothing imported yet** → the two exports have not been dropped in. Button: *Go
  to Data sources*.
* **No products are in the current range** → the stock export holds a couple of
  thousand freight and pallet codes, and none is ticked as current. Button: *Go to
  Products*.
* **Nothing is short in the current range** / **Nothing matches this filter** → the
  board has products, and the **Only short** switch or the filter text took them
  out.

## Where it is tested

| Layer | File | What it holds |
| --- | --- | --- |
| unit | `test/core.matrix.test.ts` | 15 tests: horizon widths, weekend flags, a cell's gross/credits/lines, credit days reaching back past today, the two rules above, placeholder dates (4/04/2040) kept out of cells and into **Beyond**, `excludedShipVia`, the three tones, and the past-start-date dot. |
| jsdom | `test/ui.matrix.test.tsx` | 11 tests: the three empty states, one row per current product, red and green on the right cells, a promise landing in its own day column, a tap opening the lines behind the figure, the `!`, the Only-short filter, the horizon being a saved view, the pinned columns, and the phone board keeping its days. |
| browser | `e2e/matrix.spec.ts` | 5 tests × desktop/phone/firefox over the shop's real export shapes: the board fills in, a day cell opens, a row opens and reaches Products, the horizon survives a reload, and an untouched device is pointed at Data sources. |

No test names a volume from the exports. The browser tests find the row carrying
demand by sorting the board, so the file still passes the week the numbers change.
