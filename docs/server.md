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

## The routes, as they are built

`server/src/` is the source; `pnpm run build:server` turns it into the one file
`server/freo-server.mjs` that actually runs. There are seven routes, and every one of
them is a decision above rather than a new idea.

| Route | Auth | What it does |
| --- | --- | --- |
| `OPTIONS /api/**` | none | the preflight every browser sends before it will put a workbook from `file://` |
| `GET /api/health` | none | `{ok, store:"server", version}`. Unauthenticated on purpose: this is how a device finds out whether there is a server here at all, before it has any right to ask anything else |
| `POST /api/device/token` | code or bearer | first device spends the console setup code and gets a token; after that an existing device introduces the next one. 200 for the code, 201 for an introduction |
| `GET`, `PUT /api/state` | bearer | the shop document. `ETag` is the git blob sha; `If-Match` and `If-None-Match: *` are the compare-and-set |
| `GET`, `PUT /api/exports/:kind` | bearer | the two workbooks, `location` and `future`, as bytes. Same compare-and-set, plus `Last-Modified` |
| `GET /api/history?path=&limit=` | bearer | the write log, newest first. This is the folder watch's whole existence: one small request instead of a two-megabyte download |
| anything else | none | the built app, with the SPA fallback. A path under `/assets/` that does not exist stays a 404, because HTML where JavaScript was asked for is a blank screen with no clue as to why |

Six environment variables, all with defaults that work on a box in the shop:
`FREO_PORT` (8787), `FREO_HOST` (0.0.0.0), `FREO_DATA` (`./data`), `FREO_STATIC`
(`./dist`), `FREO_OPEN` (off), `FREO_BASE` (root).

Four things the decisions above did not settle, settled here:

- **Write metadata travels in the query string**, as `?message=&device=`, and unknown
  parameters are ignored. The body is already the document, so the note about who
  saved it and why has to go somewhere else, and a header is the wrong somewhere:
  header values are bytes with no declared encoding, and a browser will not send
  `saved — bays 3–6 ready` in one at all. Percent-encoded in a query parameter it
  arrives exactly as typed, which is the difference between a write log the shop can
  read and one that says `saved â€” bays`. Accepting unknown parameters is what lets a
  newer app talk to an older box.
- **A write is refused before it is parsed.** A state document over 8 MB, or a
  workbook over 32 MB, is a mistake rather than a shop: today's largest workbook is
  under a megabyte. An unparseable document is refused with 400 and the stored file is
  left alone, because the alternative is a box that stores rubbish and then 404s on
  the next save.
- **`/api/history` answers with the current file when the log is behind it.** The
  folder watch compares the sha in the first entry against the file in its own folder;
  if the log ever lagged the file, the watch would call the two different forever and
  republish the workbook on every tick. So the log is read, and if what is on disk is
  newer than the top entry, that is reported as the first entry.
- **A request the client hangs up on is logged as 499 and nothing else.** A phone that
  gives up halfway through a save is a normal Tuesday, and a server that writes a
  half-received file for it is not a server.

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
prints the two commands that put the current shop document from the repository in
place, so the new box can start with today's numbers instead of an empty shop. It
prints them rather than running them, because that needs somebody's GitHub token and
the shop's numbers should not pass through a script that is not the app. Nothing moves
the two MYOB workbooks: they appear on the new box the first time the office PC writes
them there, and until then the new server says so instead of serving an old file.
