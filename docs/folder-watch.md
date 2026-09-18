# The folder watch: the PC that exports MYOB sends the file itself

The first rung now, and the others below it are fallbacks.

Everything in `power-automate.md`, `mirror-on-a-pc.md` and `onedrive-to-github.md`
starts from the same fact: **the workbook only changes while a person is standing at
a machine pressing Export in MYOB.** Those other three arrangements work around that
by fetching a file that is already sitting in a folder, some minutes later, from
somewhere else.

The folder watch asks a simpler question. The computer that just wrote the file is
awake, has the file, and knows it changed. So let *that* computer tell the shop.

```
MYOB presses Export  ->  location.xlsx lands in a folder on that PC
                     ->  this app, open on that PC, notices within a minute
                     ->  it imports the file there, and commits it to
                         Production-App-Data/exports/
                     ->  every other computer picks it up on its own check,
                         exactly as before
```

Nothing about the other computers changes. A machine that cannot see the folder
carries on taking the exports out of the repository, which is where this one puts
them. If the watch is switched off everywhere, the app works exactly as it did.

## Three minutes, on the computer that runs MYOB

1. Open the app in **Chrome or Edge** (see "Which browsers" below), sign in as
   somebody who can import, and go to **Data sources**.
2. On the folder line at the top right, press **Choose the folder** and pick the
   folder MYOB exports into. Windows asks once whether this app may read that
   folder; allow it. Choosing the folder switches the watch on by itself.
3. Press **Look now**. If the folder holds today's `location.xlsx` and
   `future.xlsx`, the line says **Sent** and a green toast says *Sent to the shop*.

Then tell MYOB to save there. MYOB's Export box has a *Save in* folder; point it at
the same folder and every export after that arrives on its own. If you would rather
not touch MYOB's defaults, export normally and drag the file into that folder — the
watch cannot tell the difference.

To check it end to end, do a real export in the morning and look at another
computer: within its own automatic-import interval (five minutes by default) its
stock and jobs numbers move without anyone touching it.

## What it does, and what it refuses to do

Every minute while the app is open and online on that computer, it lists the folder.
An unchanged folder costs one directory listing — no file contents are read, and no
request goes to GitHub. A file is only sent when all of these hold:

| The rule | Why it is there |
| --- | --- |
| The file is called exactly what Settings says (`location.xlsx`, `future.xlsx`) | A name that only *looks* right is offered to a person on the screen and never used on its own. Guessing wrong overwrites the wrong mirror on every computer at once. |
| Its size and write time have stopped moving since the previous look | MYOB writes straight into the folder, and OneDrive downloads in pieces. This is what stops half a workbook reaching the shop. It costs about one minute. |
| It is bigger than 2 KB | A truncated or empty export is not a report. `Ctrl+S` on an empty preview does this. |
| It was written within 30 hours (the number is yours to change) | A workbook from last Thursday is not today's stock, however it came to be in that folder. |
| Its **contents** are the report that file has to be | The same test the parsers use: the stock file must have an `Item No.` and a `Units On Hand` column under an *Item List [Summary]* banner. One mis-click in MYOB's save box and the jobs report is sitting in `location.xlsx`. This is the failure the feature must never have, so it is checked before the file leaves the PC. |
| The bytes are not the ones this PC already sent | Committing identical bytes still stores another multi-megabyte copy in the history for good. |

When a file is sent, the commit message names the machine:

```
exports: exports/location.xlsx from Shop PC @ 18/09/2026 07:12 (2,691 rows)
```

That line is in the repository's history and in the app's own log, because *which
computer did this number come out of* is the first question when two screens
disagree.

Order matters too: the file is imported **on this computer first**, then published.
A shop whose internet is down still gets today's stock on the machine that exported
it, and the screen says the publish failed instead of pretending nothing happened.

## Which browsers, and the one click after a restart

Only **Chrome and Edge** can be shown a folder from a web page. Firefox and Safari
will not let any website see a disk at all, so on those the line reads **Cannot
watch folders** and the app carries on exactly as before — hand the files over on
that machine, or let another computer do the watching.

There is a catch that belongs to the browser, not to this app, and it will bite
every Monday morning: after a browser **restart**, Windows makes the app ask again
for permission to read the folder. It is one click on a button that says **Let this
app read it**, and it has to be a real click by a real person — no web page can
grant itself. Until that click happens the line reads **Waiting for one click** and
nothing is published from that machine.

So: leave the app open on the machine that exports, rather than closing the browser
at night. If you do close it, one click in the morning, and the folder is read again.

## If the folder is a OneDrive folder

A OneDrive-synced folder *is* a Windows folder, so this all works unchanged — with
two things to know:

- **Set the folder to "Always keep on this device"** (right-click the folder in File
  Explorer). Otherwise Windows keeps a *pointer* to a file it has not downloaded,
  and reading it means downloading it first. With no signal, the read fails, and
  the screen says the folder would not give up the file.
- A file still syncing is exactly the case the "has it stopped moving" rule catches,
  so a OneDrive folder is if anything *safer* than a local one.

A network share (`\\server\MYOB exports`) works the same way and has no sync delay
at all. That is the tidier arrangement if the shop has a server: every PC exports to
the share, and one PC watching the share feeds the whole shop.

## More than one computer watching

That is allowed, and it is what the shop wants: if the shop PC is shut, the laptop
does it. Two machines reading the same folder will occasionally try to commit the
same file at the same moment. The app handles it: the loser re-reads the repository
and writes again against the number the winner left, with *after another PC wrote
first* in the commit message. When both files were identical, the sha check stops
the second one before it sends anything. Last write wins, and the history says who
wrote last.

## Every state, and what to do about it

| The line says | What it means | What to do |
| --- | --- | --- |
| **No folder yet** | This computer has not been pointed at one. The watch cannot start from nowhere. | Press **Choose the folder**. |
| **Waiting for one click** | It remembers the folder; the browser wants proving again (a restart does this). | Press **Let this app read it**. |
| **Folder refused** | The person at this machine said no to the permission dialog. | Press **Choose the folder** and allow it this time. |
| **Cannot watch folders** | This browser cannot see a disk. | Nothing to fix here. Use Chrome or Edge on the machine that exports. |
| **Watching** + *Not in the folder* | Watching fine; today's file is not there. | Press Export in MYOB, into that folder. |
| **Watching** + *Named differently* | The folder holds a file that looks like the export but is not called what Settings says. | In **Details**, press **Use <that name>** — or change MYOB's file name. |
| **Watching** + *Held back* | One of the rules above stopped it. The sentence says which. | Usually: it is still being written (wait a minute), or it is old, or it is the wrong report. |
| **Watching** + *Could not send* | The file was fine and something else failed — no token on this device, or GitHub refused. | The sentence says which. Import by hand meanwhile; the other computers are still on the last good file. |
| **Watching** + *Nothing new* | Correct and normal. Nothing has changed since the last look. | Nothing. |

**Pause** stops the watch on this computer but remembers the folder. **Forget this
folder** (in Details) makes this machine forget it entirely. Both are per-computer
settings, like the device's name and its token: nothing here is stored in the
repository or sent to the other computers.

## What it still cannot do

- MYOB will not export on a schedule by itself, so this does not remove the person
  who presses Export. It removes the browser, the login and the two drags that
  follow.
- It only works while the app is open on the exporting machine. A PC that exports
  with the app closed is a PC that needs one of the fallbacks, or a habit of opening
  the app.
- The computer doing the watching is a minute ahead of the others — it has the file,
  they have the copy. Same data, one minute apart, and it is the machine you are
  most likely to be standing at when you exported.
