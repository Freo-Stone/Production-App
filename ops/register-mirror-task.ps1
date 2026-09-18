<#
  Put mirror-exports.ps1 on a schedule in Windows Task Scheduler.

  Run this once, in an ordinary PowerShell window:

      powershell -ExecutionPolicy Bypass -File .\register-mirror-task.ps1

  defaults to every hour from 07:00. Other shapes you may prefer:

      .\register-mirror-task.ps1 -EveryHours 4              four times a day
      .\register-mirror-task.ps1 -At 06:30 -EveryHours 1    starting half six

  It uses schtasks.exe rather than the Register-ScheduledTask cmdlets because the
  same one line works on every Windows version this shop runs, and the result is
  visible in Task Scheduler straight afterwards.

  Runs as you, only while you are logged on - which needs no administrator
  password. If the office PC is left switched on and signed in, that is the whole
  story. If it gets restarted and sits at the lock screen, open Task Scheduler,
  right-click the task, and choose "Run whether user is logged on or not" (it will
  ask for that user's Windows password once).

  Keep this file ASCII: Windows PowerShell reads a script as ANSI unless the file
  carries a byte-order mark.
#>

param(
  [string]$At = '07:00',
  [int]$EveryHours = 1,
  [string]$ScriptPath = '',
  [string]$TaskName = 'Freo MYOB exports'
)

$ErrorActionPreference = 'Stop'

if ($ScriptPath -eq '') { $ScriptPath = Join-Path $PSScriptRoot 'mirror-exports.ps1' }
if (-not (Test-Path $ScriptPath)) {
  throw "cannot find $ScriptPath - put this script next to mirror-exports.ps1, or pass -ScriptPath."
}
$ScriptPath = (Resolve-Path $ScriptPath).Path

if ($At -notmatch '^\d{2}:\d{2}$') { throw "-At wants a 24-hour time like '07:00', not '$At'." }
if ($EveryHours -lt 1 -or $EveryHours -gt 24) { throw '-EveryHours wants 1 to 24.' }

# -WindowStyle Hidden so no black window pops over whatever the PC is doing. The
# path is quoted because a folder called "My Documents" is common enough, and if
# the line below lands in the task badly, Task Scheduler shows it: check the
# "Task To Run" line printed at the end and fix that one box in the GUI.
$command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $ScriptPath

Write-Output "task:    $TaskName"
Write-Output "script:  $ScriptPath"
Write-Output "runs:    every $EveryHours hour(s) from $At"
Write-Output ''

& schtasks.exe /create /tn $TaskName /tr $command /sc HOURLY /mo $EveryHours /st $At /f
if ($LASTEXITCODE -ne 0) {
  throw ("schtasks could not create the task (exit $LASTEXITCODE). If it says Access is denied, " +
    'right-click this script and choose Run with PowerShell, or ask for an account allowed to add tasks.')
}

Write-Output ''
Write-Output 'Created. What Windows now has:'
& schtasks.exe /query /tn $TaskName /fo LIST /v | Select-String -Pattern 'Next Run|Status|Last Run|Last Result|Task To Run'

Write-Output ''
Write-Output "Run it now without waiting:  schtasks /run /tn `"$TaskName`""
Write-Output ("Look at what it did:         type `"{0}`"" -f (Join-Path $PSScriptRoot 'mirror-exports.log'))
Write-Output "Take it off again:           schtasks /delete /tn `"$TaskName`" /f"
