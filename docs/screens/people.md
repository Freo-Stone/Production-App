# People and devices

`src/screens/People.tsx`, route `/#/people`. Owner only.

## What it is for

Two questions, answered on one screen: **who can sign in**, and **which machines
hold the shop's data**. Both are the owner's to decide, and both need to be
visible together — a name that is signed in on four devices is a different
problem from a name signed in on one.

## Layout

Two tables, deliberately ordinary ones. The app's `DataTable` engine carries
column sizing, sorting, view persistence and drag-reordering for the boards that
need them; this screen is eight rows that change when the owner changes them, and
giving it an engine it does not use would cost more than it returns.

**People** — Name, Role, Status, Devices, Changed, Actions. Sorted owner first,
then makers, then viewers, alphabetically inside each, so the list reads the same
on every device.

**Devices** — label and device id, who signed in there last, when it was last
seen, and whether it is still allowed.

## Actions

| On a person | What happens |
| --- | --- |
| Rename | keeps their id, so the work they logged stays theirs |
| Role | owner's decision only; the owner role itself is not assignable |
| Switch off / back on | stops the sign-in, keeps the history. This is the one for somebody who has gone |
| Passcode | sets a new one without knowing the old one |
| Delete | leaves a tombstone, so other devices do not bring them back. The last owner cannot be deleted |

| On a device | What happens |
| --- | --- |
| Label | renames it — "Shop phone", "Office PC" — because a hex id is not a thing to show a person |
| Take off the list | that device cannot sign in again. Taking off **this** device signs you out on the spot |
| Allow again | only possible from another device, which is what makes the button mean something |

## What is on the header

The account menu, on every screen: the person signed in, their role, a field to
change their **own** passcode, this screen when the role allows it, and Sign out.
Changing your own passcode needs it typed twice and is refused with the same
advice the first-run screen gives — the digests travel inside the shop's shared
file, so a weak one is a real cost, not a style failure.

## What it says about sync

The screen states plainly that this list lives on this device until the shop's
sync loop is running, and that a person added here is not yet on another machine.
The collections and the merge are finished; the loop that carries the shared file
between devices is the next piece of work in `TASKS.md`. Saying it on the screen
is better than having it discovered on a phone in the yard.
