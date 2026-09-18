# Getting the MYOB exports into the repository

The app needs two files, both of which MYOB already produces:

| File | MYOB report | What it answers |
| --- | --- | --- |
| `location.xlsx` | Item List [Summary] | stock on hand, by location |
| `future.xlsx` | Sales [Item Detail] | what is promised and when it goes out |

They belong in `exports/` on `main`, overwriting the previous copy. The app
reads them and never writes them.

## The honest ladder

Start at the top. Move down only when the one above is costing you time.

**1. Drop them in by hand.** MYOB exports → repository → `exports/` →
**Add file** → **Upload files** → Commit. Two drags, thirty seconds. Nothing to
maintain, nothing that can silently stop.

**2. Power Automate mirrors them from SharePoint** (below), once MYOB writes the
exports into a SharePoint or OneDrive folder by itself.

**3. A GitHub Action pulls them on a schedule.** Same result, no premium
connector, but it needs an Azure app registration to read SharePoint, which is
more setup than the flow is worth unless you already have one.

> Both halves are working now: the mirror puts a current copy in `exports/`, and
> any device that is open, online and holding the token reads them and imports
> whichever changed — see `docs/exports.md`. The manual tray on **Data sources**
> is still there for a file sitting on somebody's laptop.
>
> What the mirror cannot do is make a closed laptop look. The newest numbers wait
> in the repository until an app is opened.

## Power Automate flow

One flow, running for both files. It needs the **HTTP** action, which is a
premium connector.

**Trigger** — Recurrence, every 30 minutes, Scope: Month, in Perth time. If the
numbers only change when someone posts in MYOB, hourly is plenty: every write to
GitHub is a permanent commit, and a re-published spreadsheet is a new copy of
the whole file in history forever.

Then, for each of `location.xlsx` and `future.xlsx` (an **Apply to each** over
an array of the two paths is tidier than duplicating the flow):

1. **Get file content** (SharePoint, or OneDrive — whichever holds the MYOB
   export folder). Site Address and File Path as literal strings, not dynamic
   content, so the flow cannot lose its target when a folder is renamed.

2. **HTTP — read the current copy.** Method GET,
   `https://api.github.com/repos/Freo-Stone/Production-App-Data/contents/exports/location.xlsx?ref=main`,
   headers:

   | Key | Value |
   | --- | --- |
   | `Authorization` | `token <PAT>` |
   | `User-Agent` | `freo-production-mirror` |
   | `Accept` | `application/vnd.github+json` |
   | `X-GitHub-Api-Version` | `2022-11-28` |

   Set **Retry policy: None** on this action. Without it, the first sync of a
   file that does not exist yet fails the flow instead of telling you it is new.

3. **Compose `sha`** —
   `if(equals(outputs('HTTP_-_read_the_current_copy')?['status-code'], 404), '', outputs('HTTP_-_read_the_current_copy')?['body']?['sha'])`

4. **Compose `same`** — true when the bytes have not changed, so an unchanged
   export does not create a commit:
   `replace(replace(outputs('HTTP_-_read_the_current_copy')?['body']?['content']?, '&#10;'), '')`
   compared against `base64(body('Get_file_content'))`. GitHub returns the
   stored base64 with line breaks in it; stripping them makes the comparison
   fair. First run has nothing to compare, so it writes — that is correct.

5. **Condition** — write only when the file is new or different, and inside it a
   second condition on `empty(outputs('sha'))`:

   - **Create (no sha yet)** — PUT to the same URL, body:
     ```json
     {
       "message": "exports: location.xlsx @ {utcNow()}",
       "content": "@{base64(body('Get_file_content'))}"
     }
     ```
   - **Update (with sha)** — same, plus `"sha": "@{outputs('sha')}"`.

   The `sha` is what makes this safe: if the app or another run committed in the
   meantime, GitHub answers 409 rather than silently overwriting the newer file.

**Token** — the same kind of fine-grained token as in `docs/sync.md`, for
`Freo-Stone/Production-App-Data` — the private data repository, never the public
app one — with **Contents: Read and write**. Put it in a
solution **environment variable** marked *secret* rather than typing it into the
header: anyone who can view the flow can read a header.

## How to check each part

**The flow itself.** Power Automate → the flow → **See all runs**. Open the
latest run and expand the PUT step's **Output** → **Body**. A successful write
returns the new commit under `commit.sha`, and `content` is `null` in the
response. If the run shows *Skipped* on the write, nothing had changed — that is
the desired steady state, not a failure.

**GitHub.** Repository → `exports/` → the file's commit list. The newest commit
should be minutes old with a message naming the file and a timestamp.

**That it is really the current file.** Download it from GitHub and open it. The
report's own "as at" timestamp should match the commit message within the export
cadence. If GitHub is ahead of MYOB's folder, the flow is pointing at the wrong
path — and the commit would have been skipped, so look at step 4's output.

**In the app.** Sources → import the file → the line along the top shows the row
count and says how long ago it came in,
and the counts should match the sheet. `test/fixtures/verifiedNumbers.json`
records the counts the shop's own exports produced when the parsers were written
up — a few thousand stock rows spread over the MYOB location codes, and a few
thousand job lines across about a thousand jobs — so a file that
lands far off those is the wrong file or a changed MYOB layout.

**Rate limits.** An authenticated token gets 5,000 requests an hour, so a
30-minute cadence and two files is nowhere near the limit. If a flow is ever
changed to every minute, the number of requests per run roughly quadruples and
the repository history grows ~8,000 files a year — don't.

## If MYOB's export folder moves

Update the two paths in step 1 and nothing else. The flow will write to the same
place in the repository, so the app is unaffected.
