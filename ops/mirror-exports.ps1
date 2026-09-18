<#
  Mirror the MYOB exports into the shop's data repository.

  Run it by hand any time:  powershell -ExecutionPolicy Bypass -File .\mirror-exports.ps1
  Run it on a schedule:     powershell -ExecutionPolicy Bypass -File .\register-mirror-task.ps1

  It does four things, in this order, and writes a line about all of them to
  mirror-exports.log next to itself:

    1. pulls the repository so it is not pushing against a stale copy;
    2. checks each workbook MYOB exported is the report its name says it is, and
       is recent enough to be worth publishing;
    3. copies them into exports/ and commits, if the bytes actually changed;
    4. pushes.

  A night where nothing is exported is not an error: the script says "nothing new
  to publish" and leaves the repository alone. A workbook that is the wrong report
  is refused, because the app refuses it too, and it is kinder to hear it here.

  Setup, once, before the first run - see docs/mirror-on-a-pc.md:
    git clone https://github.com/Freo-Stone/Production-App-Data.git C:\freo\data
    cd C:\freo\data
    git push                (once, so Windows remembers the token)

  Keep this file ASCII: Windows PowerShell reads a script as ANSI unless the file
  carries a byte-order mark, and a plain-text UTF-8 save turns every em dash into
  garbage in the log.
#>

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# The only part of this file you should have to change.
# ---------------------------------------------------------------------------
$SourceFolder = 'C:\Users\yourname\Documents\MYOB Exports'   # where MYOB saves the reports
$RepoFolder   = 'C:\freo\data'                               # the clone you made, above
$LogPath      = Join-Path $PSScriptRoot 'mirror-exports.log'

# The two reports, as MYOB saves them, and the path they get published to.
# Change the left-hand names to whatever MYOB actually wrote; keep the right-hand
# ones, they are what every device reads.
$Files = @(
  @{ Source = 'Item List.xlsx'; Destination = 'exports/location.xlsx'; ReportTitle = 'Item List [Summary]' },
  @{ Source = 'Sales.xlsx';     Destination = 'exports/future.xlsx';   ReportTitle = 'Sales [Item Detail]' }
)

# Refuse a workbook older than this. A stale file published as current is worse
# than no file at all: the shop would be planning against last week's stock.
$MaxAgeHours = 30

# ---------------------------------------------------------------------------
function Write-Log([string]$Message) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Output $line
  Add-Content -Path $LogPath -Value $line -Encoding UTF8
}

function Invoke-Git([string[]]$GitArgs) {
  # safe.directory stops an ownership complaint when a repo sits on a path Windows
  # and Git disagree about, which is normal on a shared office machine.
  $output = & git -c safe.directory=* -C $RepoFolder @GitArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($GitArgs -join ' ') failed: $($output -join ' ')"
  }
  return ($output | Out-String).Trim()
}

# The report's own title, read out of the workbook. MYOB prints it inside the
# sheet, which is the only reliable way to tell the two reports apart - a file
# named "Sales.xlsx" that contains the item list is a real thing that happens.
function Get-WorkbookText([string]$Path) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
  $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $text = ''
    foreach ($entry in $zip.Entries) {
      if ($entry.FullName -ne 'xl/sharedStrings.xml') { continue }
      $stream = $entry.Open()
      $reader = New-Object System.IO.StreamReader($stream)
      $text = $reader.ReadToEnd()
      $reader.Close()
      $stream.Close()
    }
    return $text
  } finally {
    $zip.Dispose()
  }
}

Write-Log '--- export mirror ---'

if (-not (Test-Path (Join-Path $RepoFolder '.git'))) {
  throw "no git repository at $RepoFolder - clone it first, see docs/mirror-on-a-pc.md"
}
if (-not (Test-Path $SourceFolder)) {
  throw "nothing to read at $SourceFolder - set the `$SourceFolder line to the folder MYOB exports into"
}

Invoke-Git @('pull', '--rebase', '--autostash') | Out-Null

$ExportsDir = Join-Path $RepoFolder 'exports'
if (-not (Test-Path $ExportsDir)) { New-Item -ItemType Directory -Path $ExportsDir | Out-Null }

$published = @()
$refused = @()

foreach ($file in $Files) {
  $sourcePath = Join-Path $SourceFolder $file.Source
  if (-not (Test-Path $sourcePath)) {
    Write-Log ("not exported: {0} is not in {1}" -f $file.Source, $SourceFolder)
    continue
  }

  $item = Get-Item $sourcePath
  $ageHours = ((Get-Date) - $item.LastWriteTime).TotalHours
  if ($ageHours -gt $MaxAgeHours) {
    Write-Log ("REFUSED {0}: last written {1:N0} hours ago, more than {2:N0}. Export it from MYOB again." `
        -f $file.Source, $ageHours, $MaxAgeHours)
    $refused += $file.Source
    continue
  }
  if ($item.Length -lt 2048) {
    Write-Log ("REFUSED {0}: only {1} bytes, that is not a report." -f $file.Source, $item.Length)
    $refused += $file.Source
    continue
  }

  # Wrong report under a right name: refuse. Neither title found (a layout change,
  # or strings stored somewhere other than sharedStrings): say so and go ahead,
  # because a mirror that will not publish what it cannot identify is useless.
  $body = Get-WorkbookText -Path $sourcePath
  if ($body -notlike ('*' + $file.ReportTitle + '*')) {
    $other = $Files | Where-Object { $_.ReportTitle -ne $file.ReportTitle } | Select-Object -First 1
    if ($other -and ($body -like ('*' + $other.ReportTitle + '*'))) {
      Write-Log ("REFUSED {0}: it contains {1}, not {2}. Put the right report in the folder." `
          -f $file.Source, $other.ReportTitle, $file.ReportTitle)
      $refused += $file.Source
      continue
    }
    Write-Log ("warning: could not find '{0}' inside {1}. Publishing it anyway - open it and check." `
        -f $file.ReportTitle, $file.Source)
  }

  $target = Join-Path $RepoFolder $file.Destination
  Copy-Item -Path $sourcePath -Destination $target -Force
  Write-Log ("staged {0} from {1} ({2:N0} bytes, {3:N1} hours old)" `
      -f $file.Destination, $file.Source, $item.Length, $ageHours)
  $published += $file.Destination
}

if ($published.Count -eq 0) {
  Write-Log 'nothing new to publish.'
  if ($refused.Count -gt 0) { Write-Log ("refused: {0}" -f ($refused -join ', ')) }
  return
}

$status = Invoke-Git @('status', '--porcelain')
if ($status -eq '') {
  Write-Log 'nothing new to publish: the copies in the repository are byte for byte the same.'
  return
}

Invoke-Git @('add', '--', 'exports') | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
Invoke-Git @('commit', '-m', "exports: $($published -join ', ') @ $stamp") | Out-Null
Invoke-Git @('push') | Out-Null
Write-Log ("pushed {0}. Every device reads it within its own check interval." -f ($published -join ', '))

if ($refused.Count -gt 0) {
  Write-Log ("refused, so not published: {0}" -f ($refused -join ', '))
}
