# The making plan

`src/screens/Schedule.tsx`, route `/#/schedule`. The rules — what has to be made, which
promise a make answers, and the last day it could have started — are in
`src/core/schedule.ts`. The one read is `scheduleSource` in `src/data/planRepo.ts`, and
the three writers on that file (`addPlanItem`, `startPlanItem`, `cancelPlanItem`) are the
only way anything gets onto this plan or off it.

## What it is for

The order book answers *can we ship this*. This answers the other question, the one the
owner is asked every morning: **what has to be made, and by when must it have started.**

It works that out of what is already known. The order book says which codes are still
short after stock and racks; Products says how long a code takes (cure days, whether it
goes through the blaster); Settings adds the blasting handling days and any planning
buffer. Subtracting the lead time from the promise date gives the day the make has to
have started. That day is the whole point of the screen: a make whose start day went by
last Tuesday is not "due next week", it is already behind.

Nothing here is invented. A row exists because a customer is owed something, or because
the shop put a make on the plan itself.

## What a row is

**A row is a code and a promised day** — not an order line. If eleven customers are all
promised GL4 on the 22nd, that is one make of the total, not eleven jobs on a list. The
orders behind it are named in the card under the table, each with its customer and its
quantity, so the row can be checked against the phone call.

Two kinds of row, and the **On the plan** column says which:

- **not yet** — a promise with nothing written down for it. The quantity is exactly what
  the order book says is still owed for that code on that day.
- **planned** or **being made** — something the shop put on the plan, with its own
  quantity and promise date. When it covers the promises for that day completely the gap
  row disappears; when it is short, what is left stands as its own row.

A make that produces *more* than the promises it answers keeps the extra and says so —
`Makes 118.00 m² and 12.00 m² more than the promises it answers`. Surplus is reported,
never trimmed off to make the numbers tidy. Someone may be making tomorrow's stock on
purpose.

## Where the start date comes from

```
promise date
  − cure days                    (Products)
  − blasting handling days       (Settings, only for a code made through the blaster)
  − planning buffer              (Settings)
= the latest day this could have started and still landed
```

That is `calc.latestStartDate`, the same function the Matrix tones use, so a row the plan
calls **already behind** is late on both screens and the two cannot drift apart. The
card under the table spells the arithmetic out for the row you pressed — *Lead time 3
days — 2 days of cure, 1 day off the blaster, and no buffer* — and says, in plain words,
whether that day is today, still to come, or gone.

A code with no cure time set still gets a date from whatever it does have, but the plan
will not *write* it down until Products says whether it is made or blasted: a start date
is a commitment, and the blasting day is half of it.

## The piles

Five piles across the top, each carrying the count of rows it will show:

| Pile | What is in it |
| --- | --- |
| **Already behind** | The day the make had to start has gone. |
| **Start this week** | Has to start within the next seven days, today included. |
| **Later** | On the plan, but not due to start yet. |
| **Being made** | Marked started. Its own date stops mattering — it is on the floor. |
| **No start date** | Nothing to work a lead time from: an undated promise, or a code that is not one of ours. |

Plus **Nobody has planned it**, which cuts across the piles and leaves only the promises
with nothing written down for them, and **Everything**. Search runs over item code,
description, customer names, order numbers and the sentence in the Why column. While
anything is filtered the screen prints how many rows it is showing out of how many it
holds — the count a chip shows is always the count pressing it gives.

## The one rule that is a decision

> A make answers the **earliest promise for its code first**, unless the plan line was
> written with the orders it answers named on it.

The export never says which order line a planned make is for. Somebody has to decide, so
the rule is stated: promise date first, then order number, so the same plan reads the
same way twice. A line that names its orders (`linkedJobIds`) overrides the ordering,
because that is a person saying *this make is for these jobs*.

Two things follow, and both are tested:

- **A pallet is not counted twice.** A make can only cover what is not already covered,
  so two plan lines for the same code cannot both claim the same promise.
- **Undated promises wait their turn.** A line with no promise date sorts after every
  dated one. An order nobody has dated must not eat the cover a customer is actually
  waiting for.

## Writing it down

Three writes, and each one needs a maker or owner sign-in:

- **Put N m² on the plan** — from a short row, with that row's quantity and promise date
  and the order numbers it answers already on it. The writer re-reads the product inside
  its own transaction and refuses a quantity that is not a number, a code that is not on
  this device, and a code with no route: *"GL4 has no route set. Say on Products whether
  it is made or goes through the blaster…"* A refusal is a sentence, not a silent nothing.
- **Started making it** — once. Marking it started moves the row to **Being made**, and a
  started line is never reported as behind or as over-planned.
- **Take it off the plan** — with a reason. The line stays in the database marked
  cancelled, the reason goes in the ledger, and the promise it stood for comes back as a
  short row. Taking a make off the plan does not make the order go away.

All three write a ledger line (`plan.add`, `plan.start`, `plan.cancel`) so the Production
log shows who put what on the plan and when.

## What this screen does not do

- It does not **log a rack**. A plan line is a promise to make. The order book carries on
  counting stock and racks as cover the moment they are logged on Daily entry — the plan
  never becomes cover by itself.
- It does not schedule a machine or a person, and it does not know the shop has weekends.
  A row says the latest day a make could have started, not who does it or on which bench.
- It does not add a make automatically. A code can be short for a week and the plan stays
  empty until somebody presses the button.
- It does not know about work being made on a device that has not synced, or stock in a
  location that is not ticked on Data sources.
- It cannot date an undated promise. Those rows stay in **No start date** until MYOB
  gives them a day.

## Where it is tested

- `test/core.schedule.test.ts` — twenty-one cases on the reading and the allocation: the
  start date coming off cure days (and a blasting day coming off for a blasted code),
  the order book's shortfall being what is asked for, one row per code per promised day,
  credits and placeholder-dated lines being no demand at all, allocation in promise
  order, an explicit link beating that order, a promise never being covered twice,
  surplus being reported not trimmed, the pile edges at −1/0/6/7 days, and the invariant
  that the book's shortfall equals the gaps plus what the plan covers.
- `test/data.plan.test.ts` — sixteen cases on the read and the three writers: the start
  date being computed at write time, links de-duplicated, a blank promise giving no start
  date, every refusal wording, the permission errors for a read-only sign-in, starting
  once only, and a cancelled line keeping its reason.
- `test/ui.schedule.test.tsx` — seventeen cases on the screen: the header sentence, the
  red row at the top, the empty states, the card explaining a date in words, the button
  writing through the real writer and the row changing hands, the reason required before
  a take-off, the read-only sign-in being shown a sentence instead of a button, and every
  chip giving the rows it says it will.
- `e2e/schedule.spec.ts` — the real MYOB exports loaded the way the shop loads them, on
  desktop, phone and Firefox: the stub is gone, the chips match the rows through the
  screen's own count, a row says whether anybody has planned it, a code with no route is
  refused out loud, a promise goes on the plan and comes off again, and — the invariant
  that matters most — **a plan line is not stock: the order book still says what is
  owed.**
