# Sign in

`src/screens/SignIn.tsx`, shown instead of the whole app while no account is
signed in on this device.

## What it is for

The gate at the door. It answers one question — who is using this device — and
nothing else runs until it is answered, because everything else in the app asks
what the signed-in person is allowed to do.

It is a screen, not a dialog. The first-run name prompt was a dialog, and a
person arriving at a brand-new device has to be able to read what the app is
about to do and back out of it without closing the tab.

## What it can be

| State | Screen |
| --- | --- |
| This device has never met the shop | **Set up the shop** — name, passcode twice, and the first owner is created |
| There are accounts here | **Who is on this device?** — the list, each with their role in plain words |
| A person is picked | their name, one passcode field, Enter submits |
| This device cannot reach its own data | an explanation and a Try again button, not a spinner forever |

Nothing is asked for that the app cannot verify: the passcode is checked against
a digest stored with the account, on this device.

## Rules a person can see from here

- Wrong passcode and unknown name say the same thing, so the list cannot be
  probed for who exists.
- Five wrong attempts on a device and the button counts a thirty-second wait
  out loud. Reloading does not clear it — that would be the way round it.
- An account that has been switched off says so and stays out.
- A device the owner has taken off the list is refused before the passcode is
  even looked at.
- Once in, the device stays in. There is no expiry: the claim sits in this
  browser's own storage and is re-checked against the account list every time the
  app opens, so a person who has been switched off, renamed or fired from the
  shop loses the session at the next opening rather than keeping a name they no
  longer hold.

## What is on the frame

The shop's own logo, at 64px, so a person arriving at a device can tell they are in
the shop's app rather than a lookalike — it is the one screen where the lettering has
room to be read, and everywhere else the block device from the same artwork carries
it (`docs/brand.md`). On the first-run screen there is also the passcode advice —
what a short code costs, since the digests live inside the shop's own shared file.
`docs/accounts.md` explains why the advice is advice and not a rule.
