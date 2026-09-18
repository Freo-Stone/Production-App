# Mirroring the exports from a PC, without Power Automate

The same job as `docs/power-automate.md` — get the two MYOB workbooks into
`exports/` in the data repository — with nothing to buy and nothing to log in to
except Windows. Two scripts in `ops/`, run by Windows Task Scheduler on a PC that
is already on in the shop.

| | This | Power Automate |
| --- | --- | --- |
| Costs | nothing | the HTTP action is a premium connector |
| Set up on | the office PC | make.powerautomate.com |
| Needs | the folder MYOB exports into, a git clone, one push to remember the token | SharePoint or OneDrive holding the files |
| Runs when | that PC is switched on and signed in | always, including at 3am |
| Who can fix it later | anyone who can open a folder | whoever built the flow |

Do the hand-drop in GitHub (`docs/power-automate.md`, top of the ladder) until this
feels worth it. It is thirty seconds, and it cannot silently stop.

## Once, on the PC

**1. Get the two scripts onto it.** `ops/mirror-exports.ps1` and
`ops/register-mirror-task.ps1`, in one folder, say `C:\freo`.

**2. Clone the data repository.** In PowerShell:

```powershell
git clone https://github.com/Freo-Stone/Production-App-Data.git C:\freo\data
```

**3. Let Windows remember a token,** so the script never has one written in it.

```powershell
cd C:\freo\data
echo "" >> README.md
git commit -am "token stored"
git push
```

When the sign-in window appears, choose **Authentication: Token** (or "Paste
clipboard" after copying the key) and use the same fine-grained token described in
`docs/sync.md` — scoped to `Production-App-Data`, **Contents: Read and write**.
Better: issue a separate one for this PC, so taking a laptop away does not stop the
mirror. Every later push goes through silently from then on. Delete that README
commit when you like; it exists to have something to push.

**4. Point the script at real folders.** Open `mirror-exports.ps1` and edit the
block at the top — it is the only part meant to be changed:

```powershell
$SourceFolder = 'C:\Users\yourname\Documents\MYOB Exports'   # where MYOB saves reports
$RepoFolder   = 'C:\freo\data'
$Files = @(
  @{ Source = 'Item List.xlsx'; Destination = 'exports/location.xlsx'; ReportTitle = 'Item List [Summary]' },
  @{ Source = 'Sales.xlsx';     Destination = 'exports/future.xlsx';   ReportTitle = 'Sales [Item Detail]' }
)
```

The left-hand names are whatever MYOB actually wrote to that folder. The right-hand
names are what every device reads, so leave those alone.

## Run it

```powershell
cd C:\freo
powershell -ExecutionPolicy Bypass -File .\mirror-exports.ps1
```

Every line it prints also goes into `mirror-exports.log` beside it, so a night that
went wrong leaves a sentence behind instead of a shrug.

## Put it on a schedule

```powershell
powershell -ExecutionPolicy Bypass -File .\register-mirror-task.ps1
```

One hour from 07:00 by default. `-EveryHours 4 -At 06:30` for four times a day.
Check it in Task Scheduler, run it immediately with
`schtasks /run /tn "Freo MYOB exports"`, and take it off with
`schtasks /delete /tn "Freo MYOB exports" /f`.

It is registered as your user, only while you are logged on — no administrator
password needed, which is why the office PC should stay signed in. If it gets
restarted and sits at the lock screen, open Task Scheduler, right-click the task
and set **Run whether user is logged on or not**; it asks for that account's
Windows password once.

## What it will not publish, and why

| The log says | Because |
| --- | --- |
| `REFUSED … last written 41 hours ago` | A stale workbook published as current is worse than none: the shop would plan against last week's stock. Export again from MYOB. The limit is `$MaxAgeHours`. |
| `REFUSED … it contains Sales [Item Detail], not Item List [Summary]` | The wrong report under the right name, which does happen. The app refuses these too; it is better to hear it here. |
| `REFUSED … only 512 bytes` | That is not a report. |
| `could not find '…' inside … Publishing it anyway` | The title could not be located in the file — a MYOB layout change. It publishes, and says so, because a mirror that refuses everything it cannot identify is useless. |
| `nothing new to publish` | The copies in the repository are byte for byte the same. This is the steady state, not a failure. |
| `git push failed: rejected … non-fast-forward` | Something else committed first. Run it again; it pulls first, so it clears on the second run. |
| `git push failed: Authentication failed` | Windows has forgotten the token: do step 3 again. |

## What this still does not do

It cannot make MYOB produce a report. **The export step stays manual**: someone
presses Export in MYOB and the file lands in `$SourceFolder`. What is automated is
everything after that, which is the part that used to be a browser, a login and two
drags.

If MYOB ever writes those two reports into a folder by itself — an AccountRight
feature, or a macro on the office PC — this script needs no change at all, and
neither does the flow.
