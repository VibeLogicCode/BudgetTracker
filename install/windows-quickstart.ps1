<#
.SYNOPSIS
  Budget Tracker on a Windows PC, in one file. No repo checkout, no build.

.DESCRIPTION
  install-windows.ps1 (next to this file) installs FROM SOURCE: it needs the project folder and
  it builds the image, which takes minutes and a working toolchain. That is the right script for
  somebody who already has the repo and may be changing it.

  This one is for somebody who just wants to run the app. It needs nothing but Windows, an
  internet connection and Docker Desktop, and it pulls the same prebuilt, multi-architecture
  image the NAS install uses (install/synology-compose-pull.yml) rather than building anything.

  Run it straight from the web:

    irm https://raw.githubusercontent.com/VibeLogicCode/BudgetTracker/main/install/windows-quickstart.ps1 | iex

  Or, to pass options that way (Invoke-Expression cannot bind parameters):

    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/VibeLogicCode/BudgetTracker/main/install/windows-quickstart.ps1))) -Port 8080

  Idempotent. It never overwrites data, and it never rewrites a compose file you have edited
  unless you ask for that with -Force.

.NOTES
  The app generates its own SECRET_KEY on first boot at data\secret.key and reuses it from then
  on, so there is nothing to configure here -- the same zero-config path the NAS file takes.
  Back that folder up: losing secret.key forces every MFA user to re-enroll.
#>
[CmdletBinding()]
param(
  [int]$Port = 3000,
  # Resolved below rather than defaulted here: %LOCALAPPDATA% is undefined off Windows, and a
  # default that THROWS while binding parameters would take the syntax and dry-run guards
  # (tests/ops/install.test.ts) down with it on a Linux CI runner.
  [string]$InstallDir = '',
  [string]$Version = 'latest',
  [switch]$Update,
  [switch]$Uninstall,
  [switch]$PurgeData,
  [switch]$NoShortcut,
  [switch]$Force,
  [switch]$DryRun,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [System.IO.Path]::GetTempPath() }
  $InstallDir = Join-Path $base 'BudgetTracker'
}

$Service = 'budget-tracker'
$Registry = 'ghcr.io/vibelogiccode/budgettracker'
$ShortcutName = 'Budget Tracker.url'

function Show-Usage {
  @'
Budget Tracker quick start (Windows)

Usage: .\install\windows-quickstart.ps1 [options]

  -Port <n>          Serve on this host port instead of 3000.
  -InstallDir <path> Where to keep the compose file and the data folder.
                     Default: %LOCALAPPDATA%\BudgetTracker
  -Version <tag>     Pin a release (e.g. 1.51.0) instead of following "latest".
  -Update            Pull the newest image and restart. Data is preserved.
  -Uninstall         Stop and remove the containers. Data is kept.
  -PurgeData         With -Uninstall, also delete the data folder. IRREVERSIBLE.
  -NoShortcut        Do not create the Start Menu shortcut.
  -Force             Rewrite the compose file even if one is already there.
  -DryRun            Print every action without doing any of them.
  -Help              Show this message.
'@ | Write-Output
}

<#
  Write-Host, NOT Write-Output, and this is the whole bug of 2026-09-24.

  Write-Output writes to the SUCCESS stream, which in PowerShell is also a function's return value.
  Get-IanaTimeZone printed two lines of explanation and then returned 'UTC'; what the caller
  actually received was an ARRAY of all three, joined with spaces on its way into a [string]
  parameter. The compose file was written with

      TZ: "  Edit TZ in C:\Users\...\docker-compose.yml if you would rather set it by hand. UTC"

  and `\U` inside a double-quoted YAML scalar means an eight-hex-digit escape, so docker compose
  refused the file with "did not find expected hexadecimal number". Wait-Healthy had the same
  defect and it was worse there: it returns $true/$false, so an array of console lines made `if
  (Wait-Healthy ...)` true no matter what, and the failure banner could never appear.

  These three are console messages, not data. Write-Host puts them where they belong, and no
  value-returning function in this script can be poisoned by adding a line of output to it.
#>
function Write-Step { param([string]$Message) Write-Host "`n==> $Message" }
function Write-Info { param([string]$Message) Write-Host $Message }
function Write-Warn { param([string]$Message) Write-Warning $Message }

function Invoke-Step {
  param([string]$Command, [string[]]$Arguments)
  if ($DryRun) {
    Write-Info "[dry-run] would run: $Command $($Arguments -join ' ')"
    return
  }
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command exited with $LASTEXITCODE" }
}

<#
  Every compose command runs FROM the install folder, because that is what makes `./data` in the
  compose file mean the data folder beside it. Routed through one helper so a dry run never has to
  enter a directory it has just declined to create -- which is exactly what the first dry run of
  this script did.
#>
function Invoke-Compose {
  param([string[]]$Arguments)
  if ($DryRun) {
    Write-Info "[dry-run] would run (in $InstallDir): docker compose $($Arguments -join ' ')"
    return
  }
  Push-Location $InstallDir
  try { Invoke-Step 'docker' (@('compose') + $Arguments) }
  finally { Pop-Location }
}

<#
  VIRTUALIZATION, CHECKED FIRST AND BY ITSELF.

  Docker Desktop on Windows runs the app inside a WSL2 virtual machine, so a machine with VT-x /
  AMD-V turned off in its firmware cannot run it at all -- and it fails LATE and unhelpfully:
  winget installs two gigabytes happily, Docker Desktop starts, and then the engine simply never
  answers. Without this check the script would sit through its three-minute wait and then tell
  somebody to start Docker Desktop, which is the one thing that cannot help them.

  Two properties, because either one alone lies. VirtualizationFirmwareEnabled reports False on a
  machine where a hypervisor is ALREADY running (Windows has claimed the extensions), so a bare
  reading of it condemns a working PC. HypervisorPresent answers that case directly: if something
  is already virtualizing, the firmware setting is on whatever WMI says about it.
#>
function Test-Virtualization {
  $system = $null
  $processor = $null
  try {
    $system = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
    $processor = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1
  }
  catch {
    # Not Windows, or WMI is unavailable. Nothing can be concluded, so conclude nothing: the
    # engine check below is the real gate either way.
    return
  }
  if ($system.HypervisorPresent) { return }
  if ($processor.VirtualizationFirmwareEnabled) { return }

  Write-Warn 'Hardware virtualization is turned off on this machine.'
  Write-Info ''
  Write-Info '  Docker Desktop runs the app in a lightweight virtual machine, so it cannot start'
  Write-Info '  without it. Nothing is wrong with Windows or with this app -- it is a firmware'
  Write-Info '  setting, and turning it on takes about two minutes:'
  Write-Info ''
  Write-Info '    1. Restart and open the BIOS/UEFI setup (usually Del, F2, F10 or F12 at boot).'
  Write-Info '    2. Turn on the CPU virtualization setting. Intel calls it "Intel VT-x" or'
  Write-Info '       "Intel Virtualization Technology"; AMD calls it "SVM Mode" or "AMD-V".'
  Write-Info '       It often lives under Advanced, CPU Configuration or Security.'
  Write-Info '    3. Save, let Windows boot, and run this script again.'
  Write-Info ''
  Write-Info '  On a work laptop the setting may be locked by IT -- ask them, or run Budget Tracker'
  Write-Info '  on a NAS or another machine instead (see INSTALL.md).'
  throw 'Hardware virtualization must be enabled before Docker Desktop can run.'
}

<#
  Docker Desktop is the one prerequisite, and "not installed" and "installed but not started" are
  different problems with different fixes. A script that reports them as one thing ("docker: command
  failed") sends somebody to reinstall software they already have.
#>
function Install-DockerDesktop {
  Write-Warn 'Docker Desktop is not installed.'
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Info 'Install it from https://www.docker.com/products/docker-desktop/ and run this again.'
    throw 'Docker Desktop is required.'
  }
  Write-Info 'Installing it with winget. Accept the prompts; this takes a few minutes.'
  Invoke-Step 'winget' @('install', '-e', '--id', 'Docker.DockerDesktop', '--accept-package-agreements', '--accept-source-agreements')
  Write-Info ''
  Write-Info 'Docker Desktop is installed. It needs one reboot and one manual start before it works:'
  Write-Info '  1. Reboot if Windows asks (it enables WSL2 and virtualization).'
  Write-Info '  2. Start Docker Desktop from the Start Menu and wait for the whale to stop animating.'
  Write-Info '  3. Run this script again.'
  throw 'Docker Desktop needs to be started once before the app can be installed.'
}

function Test-IsElevated {
  try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object System.Security.Principal.WindowsPrincipal($identity)).IsInRole(
      [System.Security.Principal.WindowsBuiltInRole]::Administrator)
  }
  catch { return $false }
}

<#
  WSL2, CHECKED BEFORE THE ENGINE IS EVEN ASKED.

  Reported from a real install: Docker Desktop was installed and `docker --version` answered, and
  the engine then refused every command with "failed to connect to the docker API at
  npipe:////./pipe/dockerDesktopLinuxEngine". Docker Desktop's own window said why -- WSL is not
  installed -- but this script never looked, so it sat through its wait and blamed the engine.

  `wsl.exe` EXISTS on every modern Windows even when the feature is not installed; it is a stub
  that prints "wsl is not installed" and exits non-zero. So the test is the exit code and the text,
  never the presence of the command.

  wsl.exe writes UTF-16, which arrives here with NUL bytes between the characters and makes a
  plain -match fail on a string that visibly contains the words. They are stripped before matching.
#>
function Test-WslReady {
  if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) { return $false }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $raw = (& wsl --status 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { return $false }
    $text = $raw -replace "`0", ''
    return ($text -notmatch 'not installed')
  }
  catch { return $false }
  finally { $ErrorActionPreference = $previous }
}

function Install-Wsl {
  Write-Warn 'Windows Subsystem for Linux (WSL2) is not installed.'
  Write-Info ''
  Write-Info '  Docker Desktop runs the app inside WSL2, so the engine cannot start without it.'
  Write-Info ''
  if (-not (Test-IsElevated)) {
    Write-Info '  Open PowerShell as Administrator (right-click -> Run as administrator) and run:'
    Write-Info ''
    Write-Info '      wsl --install --no-distribution'
    Write-Info ''
    Write-Info '  Then restart the computer, start Docker Desktop once, and run this script again.'
    throw 'WSL2 must be installed before Docker Desktop can run.'
  }
  Write-Info '  This window is elevated, so it can be installed now.'
  # --no-distribution on purpose: Docker Desktop creates its own docker-desktop distro, and
  # installing Ubuntu alongside it drops the person into an unrelated first-run account setup.
  Invoke-Step 'wsl' @('--install', '--no-distribution')
  Write-Info ''
  Write-Info '  WSL2 is installed. Now:'
  Write-Info '    1. Restart the computer.'
  Write-Info '    2. Start Docker Desktop once and wait for "Engine running".'
  Write-Info '    3. Run this script again.'
  throw 'Restart the computer to finish installing WSL2.'
}

<#
  A QUIET probe. The earlier version was `& docker info 2>&1 | Out-Null`, and that merge is the
  reason the real install above printed a wall of red PowerShell error text instead of this
  script's own message: with $ErrorActionPreference = 'Stop', 2>&1 turns a native command's
  stderr into error records, so a failed probe THREW and took the friendly path with it.

  2>$null discards stderr instead of promoting it, and the preference is relaxed for the length
  of the call because a probe that fails is the normal case here, not an error.
#>
function Test-DockerEngine {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & docker info 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  }
  catch { return $false }
  finally { $ErrorActionPreference = $previous }
}

function Start-DockerEngine {
  # `docker info` is the only honest test of "is the engine actually accepting commands" -- the
  # docker.exe binary is on PATH long before the VM behind it is up.
  if (Test-DockerEngine) { return }

  $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $desktop) {
    Write-Step 'Starting Docker Desktop'
    Start-Process -FilePath $desktop | Out-Null
    Write-Info 'Waiting for the Docker engine (up to 3 minutes on a cold start).'
    for ($waited = 0; $waited -lt 180; $waited += 5) {
      Start-Sleep -Seconds 5
      if (Test-DockerEngine) {
        Write-Info "The engine answered after ${waited}s."
        return
      }
    }
  }

  Write-Warn 'The Docker engine did not answer.'
  Write-Info '  Start Docker Desktop and wait for it to say "Engine running", then run this again.'
  Write-Info '  If it never gets there, check its own window: it names the missing piece, and the'
  Write-Info '  usual answers are WSL2 (wsl --install --no-distribution, elevated, then reboot) or'
  Write-Info '  hardware virtualization in the BIOS/UEFI.'
  throw 'The Docker engine is not responding.'
}

function Test-Prerequisites {
  Write-Step 'Checking Docker'
  if ($DryRun) {
    Write-Info '[dry-run] skipping the Docker checks.'
    return
  }
  # Before the install, not after it: there is no point downloading two gigabytes onto a machine
  # that cannot run the result.
  Test-Virtualization
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Install-DockerDesktop }
  Write-Info "docker: $(docker --version)"
  # WSL before the engine, always. Docker Desktop can be installed, on PATH and answering
  # --version while the engine behind it has no machine to run on -- which is exactly what a real
  # install hit, and asking the engine first turns a one-line fix into a three-minute timeout
  # pointing at the wrong thing.
  if (-not (Test-WslReady)) { Install-Wsl }
  Start-DockerEngine
  Invoke-Step 'docker' @('compose', 'version')
}

<#
  The container reads an IANA zone ("America/Toronto"); Windows keeps its own names ("Eastern
  Standard Time"). .NET 6+ can convert between them and Windows PowerShell 5.1 cannot, so this
  tries and falls back to UTC rather than guessing a zone on somebody's behalf -- a wrong guess
  silently moves what the app calls "today".
#>
function Get-IanaTimeZone {
  $windowsId = (Get-TimeZone).Id
  $iana = $null
  try {
    $converted = $null
    if ([System.TimeZoneInfo]::TryConvertWindowsIdToIanaId($windowsId, [ref]$converted)) { $iana = $converted }
  }
  catch {
    # PowerShell 5.1: the method does not exist. Nothing to report -- the fallback is the answer.
  }
  if ([string]::IsNullOrWhiteSpace($iana)) {
    Write-Warn "Could not map the Windows time zone '$windowsId' to an IANA name; using UTC."
    Write-Warn "Edit TZ in the compose file if you would rather set it by hand."
    return 'UTC'
  }
  return $iana
}

<#
  THE COMPOSE FILE. Deliberately the same shape as install/synology-compose-pull.yml: the same
  published image, the same container hardening, and the same Watchtower wiring so that in-app
  updates (Settings -> About) work here exactly as they do on a NAS. tests/ops/install.test.ts
  pins that agreement, because two install paths that quietly diverge on hardening is how a
  Windows install ends up the weak one.
#>
function Write-ComposeFile {
  param([string]$Path, [string]$Tag, [string]$TimeZone)
  <#
    A second fence behind the streams fix above. An IANA zone is letters, digits, underscore,
    plus, minus and slash -- nothing else. Anything carrying a space or a backslash is not a time
    zone, whatever produced it, and writing it into a double-quoted YAML scalar is how this file
    became unparseable once already. Refuse it here rather than emit a file docker cannot read.
  #>
  if ($TimeZone -notmatch '^[A-Za-z0-9_+/-]+$') {
    Write-Warn "Ignoring a malformed time zone value; using UTC."
    $TimeZone = 'UTC'
  }
  $yaml = @"
# Budget Tracker. Written by install/windows-quickstart.ps1 -- safe to edit and keep.
#
# This pulls a prebuilt image; nothing is built on this machine. To pin a version, change the
# tag below to a release number (e.g. :1.51.0) and run the script again with -Update.
#
# UPDATES ARE OFF UNTIL YOU TURN THEM ON. Watchtower sits and waits; it only ever acts when the
# app asks it to, and the app only asks after an admin presses "Enable update checks" in
# Settings -> About. Watchtower needs Docker's control socket to replace a container, which is
# host-level access -- WATCHTOWER_LABEL_ENABLE scopes it to containers carrying the label below,
# and only this app carries it. Delete the watchtower service if that is more trust than you
# want to extend; you would then update by running this script with -Update.
services:
  budget-tracker:
    image: ${Registry}:${Tag}
    container_name: budget-tracker
    restart: unless-stopped
    ports:
      - "${Port}:3000"
    environment:
      TRUST_PROXY: "0"
      TZ: "${TimeZone}"
      PORT: "3000"
      DATA_DIR: /data
      WATCHTOWER_URL: "http://watchtower:8080/v1/update"
      WATCHTOWER_TOKEN: "budget-tracker-local-update"
    volumes:
      - ./data:/data
    labels:
      com.centurylinklabs.watchtower.enable: "true"
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=64m
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

  watchtower:
    image: containrrr/watchtower:latest
    container_name: budget-tracker-watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      WATCHTOWER_LABEL_ENABLE: "true"
      WATCHTOWER_CLEANUP: "true"
      WATCHTOWER_HTTP_API_UPDATE: "true"
      WATCHTOWER_HTTP_API_TOKEN: "budget-tracker-local-update"
      TZ: "${TimeZone}"
"@
  if ($DryRun) {
    Write-Info "[dry-run] would write: $Path"
    return
  }
  # UTF8 without a BOM: docker compose reads the file as YAML and a BOM is a parse error on it.
  [System.IO.File]::WriteAllText($Path, $yaml, (New-Object System.Text.UTF8Encoding($false)))
  Write-Info "wrote $Path"
}

# Quiet, like the engine probe: an unreadable file is an answer, not an error to throw on.
function Test-ComposeFileValid {
  param([string]$Path)
  if ($DryRun) { return $true }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & docker compose -f $Path config -q 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  }
  catch { return $false }
  finally { $ErrorActionPreference = $previous }
}

function Get-EffectivePort {
  param([string]$Path)
  if (Test-Path $Path) {
    $match = Select-String -Path $Path -Pattern '"(\d+):3000"' | Select-Object -First 1
    if ($match -and $match.Matches[0].Groups[1].Value) {
      return [int]$match.Matches[0].Groups[1].Value
    }
  }
  return $Port
}

function Wait-Healthy {
  param([int]$EffectivePort)
  Write-Step 'Waiting for the app to report healthy on /api/health'
  $url = "http://127.0.0.1:$EffectivePort/api/health"
  if ($DryRun) {
    Write-Info "[dry-run] would poll $url"
    return $true
  }
  for ($waited = 0; $waited -lt 180; $waited += 3) {
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) {
        Write-Info "Healthy after ${waited}s."
        return $true
      }
    }
    catch { Start-Sleep -Seconds 3 }
  }
  Write-Warn 'The app did not become healthy within 180 seconds.'
  return $false
}

# Empty off Windows, and on a locked-down profile. A missing Start Menu is not a failed install.
function Get-ShortcutPath {
  $programs = [Environment]::GetFolderPath('Programs')
  if ([string]::IsNullOrWhiteSpace($programs)) { return '' }
  return Join-Path $programs $ShortcutName
}

function Add-Shortcut {
  param([int]$EffectivePort)
  if ($NoShortcut) { return }
  $path = Get-ShortcutPath
  if ($path -eq '') { return }
  Write-Step 'Adding a Start Menu shortcut'
  if ($DryRun) {
    Write-Info "[dry-run] would write: $path"
    return
  }
  # A .url file rather than a .lnk: the target is a web page, this needs no COM object, and
  # Windows gives it the browser's own icon.
  @"
[InternetShortcut]
URL=http://localhost:$EffectivePort/
"@ | Set-Content -Path $path -Encoding ASCII
  Write-Info "wrote $path"
}

function Remove-Shortcut {
  $path = Get-ShortcutPath
  if ($path -eq '' -or -not (Test-Path $path)) { return }
  if ($DryRun) { Write-Info "[dry-run] would remove: $path" }
  else { Remove-Item -Force $path }
}

function Show-FailureBanner {
  param([int]$EffectivePort, [string]$Dir)
  @"

============================================================
 Budget Tracker did NOT report healthy within the timeout.

 The containers are left RUNNING on purpose, so you can look:
   cd "$Dir"
   docker compose logs --tail 100 $Service
   docker compose ps

 The usual cause on Windows is the data folder: Docker Desktop must be allowed to
 share this drive (Settings -> Resources -> File sharing).
============================================================
"@ | Write-Output
}

# ------------------------------------------------------------------ run

if ($Help) { Show-Usage; exit 0 }
if ($DryRun) { Write-Output '*** DRY RUN - nothing will be changed. ***' }

$ComposeFile = Join-Path $InstallDir 'docker-compose.yml'
$DataDir = Join-Path $InstallDir 'data'

if ($Uninstall) {
  if (-not (Test-Path $ComposeFile)) {
    Write-Warn "No install found at $InstallDir - nothing to remove."
    exit 0
  }
  Write-Step 'Stopping and removing the containers'
  Invoke-Compose @('down')
  Remove-Shortcut
  if ($PurgeData) {
    Write-Step "Deleting $DataDir as requested by -PurgeData"
    if ($DryRun) {
      Write-Info "[dry-run] would delete $DataDir"
    }
    elseif (-not (Test-Path $DataDir)) {
      Write-Info 'There was no data directory to delete.'
    }
    else {
      Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue
      if (Test-Path $DataDir) { Write-Warn "Could not fully delete $DataDir. Remove it by hand." }
      else { Write-Info 'Data deleted.' }
    }
  }
  else {
    Write-Info "Your data was kept in $DataDir - rerun with -PurgeData to delete it."
  }
  exit 0
}

Test-Prerequisites

Write-Step "Preparing $InstallDir"
if ($DryRun) {
  Write-Info "[dry-run] would create $InstallDir and $DataDir"
}
else {
  New-Item -ItemType Directory -Force $InstallDir | Out-Null
  New-Item -ItemType Directory -Force $DataDir | Out-Null
}

<#
  An existing compose file is left alone, because somebody may have pinned a version or deleted
  the watchtower service in it and a re-run must not undo that.

  Unless docker cannot read it. A broken file survived every re-run until now -- the run that
  wrote it was long over, and the only way out was a -Force nobody knew to pass. `docker compose
  config -q` is the same parser that is about to refuse it anyway, so asking first costs nothing.
#>
$rewrite = $Force
if ((Test-Path $ComposeFile) -and -not $Force) {
  if (Test-ComposeFileValid -Path $ComposeFile) {
    Write-Info "$ComposeFile already exists - leaving it untouched (use -Force to rewrite it)."
  }
  else {
    Write-Warn "$ComposeFile is not valid YAML; replacing it."
    $rewrite = $true
  }
}
if ($rewrite -or -not (Test-Path $ComposeFile)) {
  Write-ComposeFile -Path $ComposeFile -Tag $Version -TimeZone (Get-IanaTimeZone)
}

$effectivePort = Get-EffectivePort -Path $ComposeFile

Write-Step 'Pulling the image'
Invoke-Compose @('pull')
Write-Step 'Starting'
Invoke-Compose @('up', '-d')

if (Wait-Healthy -EffectivePort $effectivePort) {
  Add-Shortcut -EffectivePort $effectivePort
  if (-not $DryRun -and -not $Update) { Start-Process "http://localhost:$effectivePort/" | Out-Null }
  @"

============================================================
 Budget Tracker is running.

   http://localhost:$effectivePort

 First run:
   1. Open the URL above. You will land on the setup wizard.
   2. Create the first account - it becomes the administrator.
   3. Add the rest of the household under Settings -> Users.

 It starts with Windows, because Docker Desktop starts with Windows and the
 container is marked restart: unless-stopped. Nothing else to set up.

 Your data lives in:
   $DataDir
 Back that folder up. It holds the database AND secret.key; without the key,
 every person using two-factor sign-in has to enroll again.

 Later:
   .\windows-quickstart.ps1 -Update
   .\windows-quickstart.ps1 -Uninstall
============================================================
"@ | Write-Output
}
else {
  Show-FailureBanner -EffectivePort $effectivePort -Dir $InstallDir
  exit 1
}
