# Running the app from a server

**Status: the app side is built and tested; the box side is not finished.** The store seam (`src/data/store.ts`), the client that talks to the server (`src/data/serverStore.ts`) and the start-up decision are in, and green. Under `server/` there is a beginning — configuration and logging — but the routes, the static file serving, the tests and the install scripts are still to come, so do not try to run this as a server yet. This page is the reasoning, so whoever finishes it knows why it is shaped like this, and `docs/running.md` still describes the GitHub deployment that is actually in use.

## Why a server at all

The app today has no server. Two things do the work instead:

- GitHub Pages serves the files.
- GitHub's repository `Production-App-Data` is the shared store, read and written
  through the Contents API with a token on each device.

That got the shop running for nothing, and it has three costs, all of which show up
as *waiting*:

| | Today, on GitHub | On a server |
| --- | --- | --- |
| Getting a change in | a device polls every 5 min, and a commit has to land first | the box answers in milliseconds, on the office network |
| Sharing what the floor typed | it does not. The sync engine is written and tested but has never been mounted, so entries made on one PC stay on that PC | that is the whole point of a shared store |
| Being at the mercy of someone else | GitHub's status page, a token that expires, a repository setting | your own machine |
| Moving it somewhere | rebuild, repoint, re-token every device | copy one folder |

The last line is the one that matters for the plan: **build it on the current server,
move it to the box onsite at work by copying files.** Nothing in the design may make
that move need more than a copy and a start.

## The decisions, and why

**1. One process, one port, one folder.** It serves the built app and the API from the
same origin. No reverse-proxy tricks, no second service, no database server, no
Redis, no Docker requirement. One folder is the whole installation, so "transfer" is
`tar` in one direction and `tar` out the other.

**2. Same front end, a different store.** The app does not know what holds its data.
`ShopStore` is the seam — read the shop document, write it if nothing changed
underneath me, put and get the two export workbooks. Today's GitHub client satisfies
it and stays, so the Pages build keeps working and nothing built so far is thrown
away. A second implementation talks to `/api` on the same origin.

Which one runs is decided when the app starts: ask `GET /api/health`. On the server it
answers and the app uses the server; served from Pages it does not exist and the app
uses GitHub. Settings shows, in words, which one this device is talking to, because a
silent choice is exactly the kind of thing that wastes an hour later.

**3. Files, not a database.** The shop document is one JSON file
(`data/state.json`); the workbooks are the workbooks; the access log is a text file.
Writes go to a temporary file and are renamed into place, so a power cut cannot leave
a half-written shop. There is no schema to migrate when the app changes, and a person
can open `data/` and see their data with Notepad. A database would be better
software for a larger shop; it is worse software for *"copy it to the machine at
work"*, which is the requirement here.

**4. The same compare-and-swap that GitHub's API gave us.** Every write carries the
number the writer last read (`If-Match`). If it does not match, the server answers
`409` with the number it holds now, and the app merges and tries again — which is
already how `src/data/syncEngine.ts` and the folder publisher behave. Two floors
typing at once is not lost, it is merged, and the app already has the merge rules.

**5. The server does not know the passcodes.** Accounts and their hashed passcodes
live inside the shop document, hashed on the device that typed them, as they do
today. The server's only authentication question is *may this device write at all*:
first run prints a one-time setup code on the console, the app exchanges it once for a
device token, and the server keeps only hashes of those tokens. The alternative — the
server knowing passwords — would mean the box at work holds something worth stealing,
for no benefit.

**6. No dependencies.** The server is Node's own `http`, `fs` and `crypto`, built into
one file (`server/freo-server.mjs`) so the target machine needs Node and nothing else.
Node 22 or newer. A `Dockerfile` is included for the current server because that is
how it will be run there, but the Docker path runs the *same* file, so there is only
one thing being tested.

**7. It must run with the network down.** The app is already an offline-first PWA:
everything the floor does lands in the device's own IndexedDB first. The server
changes nothing about that; it makes the second half — the part where the other
computers find out — quick. If the box dies, the shop keeps working on each machine
and catches up later. That property is the reason the app was built this way and is
not negotiable in any variant.

## What has to be built

| Piece | What it is |
| --- | --- |
| `ShopStore` seam | one interface, two implementations, chosen at boot. The GitHub client keeps working unchanged |
| `server/` | static files, `/api/state`, `/api/exports/:kind`, `/api/history`, device tokens, and the console setup code |
| Mount the sync engine | it exists, is tested, and has never been started. In server mode it is how entries made on one PC reach the others |
| Folder watch against the server | the publisher already speaks through an interface, so this is a new transport, not new rules |
| Pack and install | `ops/server-pack.sh` makes one tarball; `ops/server-install.sh` puts it in `/opt/freo`, installs a systemd unit, and keeps `data/` |
| Backup | `ops/server-backup.sh` is a `tar` of `data/`. It has to be a cron job on the box, and the first restore has to be practised, not assumed |

## The two honest warnings

**HTTP on a LAN is not encrypted.** If the box is only reachable from the office
network that is a defensible choice, and it is a *choice*: the device tokens would
travel in the clear to anyone plugged into the same switch. The tidy answer is a
certificate on the office box, or keeping the server on the current VPS and letting
the office machines reach it over the internet. This will be said out loud in the
install script rather than buried here.

**Moving the store is not the same as moving the shop.** The device tokens on the
phones and PCs, the paths in Settings, and the folder watches all have to be
re-pointed at the new address, and the data in GitHub does not move by itself. The
install script therefore does one extra thing: on first run with an empty `data/`, it
offers to pull the current shop document and the two workbooks out of the repository
so the new box starts with today's numbers, not an empty shop.
