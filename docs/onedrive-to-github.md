# OneDrive or SharePoint → the repository, with nothing switched on

**If a person is at the machine that exports MYOB anyway, `docs/folder-watch.md` is
the better arrangement**: the app on that machine notices the workbook and commits it
itself, with no app registration and no secret. This page is for when nobody is, or
when the files already live in Microsoft storage and you would rather not depend on a
PC being awake.

The other mirror. Nothing runs on a PC: GitHub itself comes and fetches the two
MYOB workbooks from your Microsoft storage four mornings an hour, using a
read-only permission you grant once. No Power Automate licence, no always-on
machine, and every run says in plain words what it decided.

| | This | The PC script | Power Automate |
| --- | --- | --- | --- |
| Costs | nothing extra | nothing extra | the HTTP action is a premium connector |
| Runs when | always | that PC is on and signed in | always |
| Needs from you | one app registration, one secret, six values | a git clone and a scheduled task | a flow with seven steps |
| Reads | OneDrive for Business, or a SharePoint library | a folder on that PC | SharePoint or OneDrive |

The job it does and the job it cannot do are the same as everywhere else in
`docs/power-automate.md`: **it copies a workbook that MYOB has already put in that
folder.** MYOB will not export a report on a schedule by itself, so until it does,
somebody still presses Export — this only removes the browser, the login and the
two drags that follow.

## Install it

The workflow lives in this repository at **`ops/github-pull-exports.yml`**. It has
to be copied into the *data* repository, because that is where the files belong:

1. `Production-App-Data` → **Add file** → **Upload files** → drag
   `github-pull-exports.yml` in, then before committing set the path to
   `.github/workflows/pull-myob-exports.yml` (use *Commit directly to `main`*).
   The name it is saved under does not matter; the folder does.
2. That repository's `README.md` says *"No workflows"* — it earned that rule, after
   a copy of the app and its deploy workflow once got committed there and every
   mirror commit started a build that could only fail. This one is the agreed
   exception: it is not the app, it cannot fail a build, and it writes only
   `exports/`. Add one line to that README so the next person is not surprised:

   > The one workflow here is `.github/workflows/pull-myob-exports.yml`: it copies
   > the two MYOB exports out of OneDrive. It writes nothing else. `ops/` in the app
   > repository holds its source, so edit it there and paste it back.

## The secret, once

Everything below is a copy and paste. It is done on any computer with a terminal —
it is *not* the office PC, and nothing is left installed.

**1. Make an app registration** at <https://portal.azure.com>:

- **App registrations → New registration**
- Name: `production-app-exports` (anything)
- Supported account types: **Accounts in this organizational directory only**
- **Register**, then on the overview page copy the **Application (client) ID** —
  that is the value called `ONEDRIVE_CLIENT_ID` later.
- **Authentication → Add a platform → Mobile and desktop**, redirect URI
  `http://localhost`, Save.
- **API permissions → Add a permission → Microsoft Graph → Delegated →
  Files.Read**. Nothing else. It can read files the signed-in account can already
  see, and it cannot write anything.

**2. Sign in once, so Microsoft issues a refresh token.** In a terminal, with the
client ID from above pasted in:

```bash
curl -s -X POST https://login.microsoftonline.com/common/oauth2/v2.0/devicecode \
     -d 'client_id=PASTE_THE_CLIENT_ID' -d 'scope=Files.Read offline_access'
```

The answer carries a `user_code` and a `verification_url`. Open that URL in a
browser, type the code, and sign in as the work account that can see the folder
with the exports in it. Then, still in the terminal:

```bash
curl -s -X POST https://login.microsoftonline.com/common/oauth2/v2.0/token \
     -d 'client_id=PASTE_THE_CLIENT_ID' -d 'grant_type=device_code' \
     -d 'code=THE_device_code_FROM_THE_FIRST_ANSWER'
```

That answer holds a long `"refresh_token"`. Copy just that string.

If the second call says `authorization_declined` or the tenant blocks device-code
sign-in, say so and it can be done another way — the secret you end up with is the
same shape.

**3. Put it in GitHub.** `Production-App-Data` → **Settings → Secrets and
variables → Actions → New repository secret**:

| Name | `ONEDRIVE_REFRESH_TOKEN` |
| --- | --- |
| Secret | the `refresh_token` string |

It never leaves GitHub. The workflow masks the session token it trades for, so a
run log cannot leak it either.

## The six values

Same settings page, **Variables** tab, **New repository variable**:

| Name | OneDrive for Business | SharePoint |
| --- | --- | --- |
| `ONEDRIVE_CLIENT_ID` | the Application (client) ID | same |
| `ONEDRIVE_SOURCE` | `onedrive` | `sharepoint` |
| `ONEDRIVE_PATH` | `/Documents/MYOB exports` | `/Shared Documents/MYOB exports` |
| `ONEDRIVE_SITE` | *(leave out)* | `freostone.sharepoint.com`, or the whole site URL |
| `LOCATION_FILE` | `Item List.xlsx` | same, whatever the file is really called |
| `FUTURE_FILE` | `Sales.xlsx` | same |

Two things to get exactly right, because they are the two that fail:

- **The path starts with a slash and is spelled like the folder.** For OneDrive for
  Business, files you see under *Documents* are under `/Documents/...` — the
  personal drive root is not `/Documents` in OneDrive for Business, and if you are
  not sure, run the workflow and read the **"The folder holds"** step: it lists what
  Microsoft says is in the path you gave.
- **The two file names are what MYOB actually saved.** Not what the app calls them.
  The app reads `exports/location.xlsx`; the export on your OneDrive may be called
  `Item List [Summary] 18-09-2026.xlsx`, and then that is the value, spelled the
  same.

## Test it

`Production-App-Data` → **Actions** → **Pull MYOB exports** → **Run workflow**.
The log tells you where it stopped, in words:

| The log says | What it means |
| --- | --- |
| `Microsoft would not swap that refresh token` | The secret is wrong, revoked, or from a different app registration. |
| `Could not read that site` / `Could not read that OneDrive` | The account the token was signed in as cannot see that site, or `ONEDRIVE_SITE` is wrong. |
| `The folder holds …` | What Microsoft found at your `ONEDRIVE_PATH`. If your file is not in that list, the path or the spelling is wrong — this step exists for that moment. |
| `not found` | That file name is not in the folder. |
| `unchanged` | Microsoft's own sha1 equals the copy already committed. **The steady state, not a failure.** |
| `copied to exports/…` | It landed, and the commit is this run's. |
| `refused - no row with the headings …` | The workbook is not the report its name says. **This is the identical test the app runs**, so the mirror can never publish a file the app would go on to reject. |
| `unreadable` | Not an Excel file at all. |

Once a file lands, any device that is open, online and holding a token pulls it
within its own interval; **Data sources → Check now** does it immediately.

## How often, and what it costs

The schedule in the file is `0 20,22,0,2 * * *` — 04:00, 06:00, 08:00 and 10:00
Perth time, since GitHub's clocks are UTC. A run where nothing changed writes no
commit. Do not set it to every minute: every real change is a permanent commit
carrying a whole copy of the workbook, and the history is forever.

Private repositories get 2,000 minutes a month of Linux runners; four short runs a
day is a rounding error on that.

## Taking it away

Delete the workflow file to stop the schedule; delete the secret to take the
permission away; delete the app registration in Azure to revoke the refresh token
for good. Nothing on a device needs changing — the app keeps working from whatever
is in `exports/`, and the manual tray on **Data sources** always works.
