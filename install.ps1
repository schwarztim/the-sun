<#
.SYNOPSIS
  install.ps1 — build every thesun subsystem so `thesun` runs as one tool (Windows).

.DESCRIPTION
  PowerShell mirror of install.sh for a dev checkout on Windows. Idempotent and
  per-subsystem: builds whatever is missing and reports ✓ / – / ✗ per subsystem.
  Builds: generator (Node), fleet (Go: fleetd + thesun.exe CLI), default servers
  (atlassian + servicenow Go, vendored ms365 Node), gateway (Node), hermes (pnpm).
  Shipping releases are prebuilt binaries; this is the dev-from-source path.

.NOTES
  Not executable-tested on this platform — lint by inspection. Run from a PowerShell
  prompt with Go, Node, and pnpm on PATH:  .\install.ps1
#>

$ErrorActionPreference = 'Continue'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Ok   { param($m) Write-Host "  " -NoNewline; Write-Host "OK  " -ForegroundColor Green -NoNewline; Write-Host $m }
function Write-Skip { param($m) Write-Host "  -   $m (skipped)" -ForegroundColor DarkGray }
function Write-Fail { param($m) Write-Host "  " -NoNewline; Write-Host "X   " -ForegroundColor Red -NoNewline; Write-Host $m }

function Test-Have { param($cmd) [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# Version floors. Match what the code actually needs, so a present-but-too-old
# runtime fails HERE with a copy-pasteable fix instead of mid-build with a raw
# tsc/toolchain error:
#   node >= 18   generator/package.json engines.node ">=18.0.0" (lowest declared floor)
#   go   >= 1.26 the `go` directive in fleet\fleetd\go.mod
$NodeMinMajor = 18
$GoMinMajor = 1
$GoMinMinor = 26

# Invoke-Preflight runs AFTER Invoke-Bootstrap, so by this point every required
# runtime should be present. It guards two failure modes: present-but-too-old,
# and absent-because-bootstrap-was-declined. Both are fatal, because a skipped
# subsystem is a broken install that would otherwise report success.
# --- bootstrap: obtain missing prerequisites ---------------------------------
#
# A bare Windows machine is the normal case for someone receiving this. Without
# this step an absent runtime silently SKIPS its subsystem and the install
# reports success while leaving a stack that cannot run: no `go` means no fleetd
# and no thesun.exe at all. So install what is missing, then fail if it is still
# missing rather than skipping.
#
# winget ships with Windows 10 1809+ and Windows 11. When it is absent (older
# builds, or an org that strips the App Installer) the exact download links are
# printed instead. -NoBootstrap skips this for centrally-managed hosts.

$script:Bootstrap = $true
if ($args -contains '-NoBootstrap' -or $args -contains '--no-bootstrap') { $script:Bootstrap = $false }

# winget package IDs, verified against the public winget-pkgs manifests.
$script:WingetIds = @{ go = 'GoLang.Go'; node = 'OpenJS.NodeJS.LTS'; git = 'Git.Git' }

function Install-Prereq {
    param($tool)
    $id = $script:WingetIds[$tool]
    if (-not $id) { return $false }
    Write-Host "    installing $tool (winget: $id)..."
    # --accept-*-agreements is required or winget blocks waiting on a prompt and
    # the whole install appears to hang.
    & winget install --id $id --exact --silent `
        --accept-package-agreements --accept-source-agreements | Out-Null
    return ($LASTEXITCODE -eq 0)
}

# winget updates the machine PATH but not the PATH of THIS process, so a tool
# installed above is invisible for the rest of the script without this refresh.
function Update-PathFromMachine {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Invoke-Bootstrap {
    Write-Host "> bootstrap (prerequisites)"

    $missing = @()
    foreach ($t in @('git', 'node', 'go')) { if (-not (Test-Have $t)) { $missing += $t } }

    if ($missing.Count -eq 0) {
        Write-Ok "git, node, and go already present"
    }
    elseif (-not $script:Bootstrap) {
        Write-Skip ("bootstrap disabled (-NoBootstrap); missing: " + ($missing -join ', '))
    }
    elseif (-not (Test-Have winget)) {
        Write-Fail ("missing: " + ($missing -join ', ') + " - and winget is not available")
        Write-Host ""
        Write-Host "  winget ships with Windows 10 1809+ and Windows 11. Install 'App Installer'"
        Write-Host "  from the Microsoft Store, then re-run:  .\install.ps1"
        Write-Host ""
        Write-Host "  Or install by hand:"
        Write-Host "    Go    https://go.dev/dl/"
        Write-Host "    Node  https://nodejs.org/en/download"
        Write-Host "    Git   https://git-scm.com/download/win"
        exit 1
    }
    else {
        foreach ($t in $missing) { [void](Install-Prereq $t) }
        Update-PathFromMachine
        $still = @()
        foreach ($t in $missing) { if (-not (Test-Have $t)) { $still += $t } }
        if ($still.Count -gt 0) {
            Write-Fail ("still missing after bootstrap: " + ($still -join ', '))
            Write-Host ""
            Write-Host "  winget ran but these are not on PATH in this session."
            Write-Host "  open a new PowerShell window and re-run:  .\install.ps1"
            exit 1
        }
        Write-Ok ("installed: " + ($missing -join ', '))
    }

    # pnpm via corepack - bundled with Node, so no download and no extra trust.
    if (-not (Test-Have pnpm)) {
        if (Test-Have corepack) {
            Write-Host "    enabling pnpm via corepack..."
            & corepack enable pnpm 2>$null | Out-Null
            & corepack prepare pnpm@latest --activate 2>$null | Out-Null
        }
        if ((-not (Test-Have pnpm)) -and (Test-Have npm)) {
            Write-Host "    installing pnpm via npm..."
            & npm install -g pnpm 2>$null | Out-Null
        }
        Update-PathFromMachine
        if (Test-Have pnpm) { Write-Ok "pnpm enabled" } else { Write-Fail "pnpm unavailable (hermes will not build)" }
    }
    else { Write-Ok "pnpm present" }
}

function Invoke-Preflight {
    Write-Host "> preflight (runtime versions)"

    if (Test-Have node) {
        $nodeRaw = (& node --version 2>$null)               # e.g. v24.3.0
        if ($nodeRaw -match '^v?(\d+)\.') {
            $nodeMajor = [int]$Matches[1]
            if ($nodeMajor -lt $NodeMinMajor) {
                Write-Fail "node $nodeRaw is too old (need >= $NodeMinMajor.x for the generator/gateway/hermes TypeScript build)"
                Write-Host ""
                Write-Host "  fix: install Node >= $NodeMinMajor, then re-run: .\install.ps1"
                Write-Host "       nvm-windows: nvm install $NodeMinMajor; nvm use $NodeMinMajor"
                Write-Host "       else:        https://nodejs.org/en/download"
                exit 1
            }
            Write-Ok "node $nodeRaw (>= $NodeMinMajor.x)"
        }
    } else {
        Write-Fail "node is not on PATH"
        Write-Host ""
        Write-Host "  node >= $NodeMinMajor is required: the generator, gateway, and hermes are all TypeScript."
        Write-Host "  re-run without -NoBootstrap to install it, or:  https://nodejs.org/en/download"
        exit 1
    }

    if (Test-Have go) {
        $goRaw = (& go version 2>$null)                     # go version go1.26.0 windows/amd64
        if ($goRaw -match 'go(\d+)\.(\d+)') {
            $goMajor = [int]$Matches[1]; $goMinor = [int]$Matches[2]
            if (($goMajor -lt $GoMinMajor) -or (($goMajor -eq $GoMinMajor) -and ($goMinor -lt $GoMinMinor))) {
                Write-Fail "go $goMajor.$goMinor is too old (fleet\fleetd\go.mod requires go >= $GoMinMajor.$GoMinMinor)"
                Write-Host ""
                Write-Host "  fix: install Go >= $GoMinMajor.$GoMinMinor, then re-run: .\install.ps1"
                Write-Host "       https://go.dev/dl/"
                exit 1
            }
            Write-Ok "go $goMajor.$goMinor (>= $GoMinMajor.$GoMinMinor)"
        }
    } else {
        Write-Fail "go is not on PATH"
        Write-Host ""
        Write-Host "  go >= $GoMinMajor.$GoMinMinor is required: without it there is no fleetd and no"
        Write-Host "  thesun.exe at all, so the install would report success and leave nothing runnable."
        Write-Host "  re-run without -NoBootstrap to install it, or:  https://go.dev/dl/"
        exit 1
    }
}

Write-Host "installing thesun (one tool: generate -> run -> route -> authenticate)..."

Invoke-Bootstrap
Invoke-Preflight

# 1) generator (Node/TypeScript)
Write-Host "> generator"
$genDir = Join-Path $Root 'generator'
if ((Test-Path (Join-Path $genDir 'package.json')) -and (Test-Have npm)) {
    Push-Location $genDir
    try {
        & npm install --silent
        & npm run build --silent
        if ($LASTEXITCODE -eq 0) { Write-Ok "generator built" } else { Write-Fail "generator build failed" }
    } catch { Write-Fail "generator build failed: $_" }
    finally { Pop-Location }
} else { Write-Skip "generator (no package.json or npm)" }

# 2) fleet (Go: fleetd + thesun CLI)
Write-Host "> fleet"
$fleetDir = Join-Path $Root 'fleet\fleetd'
if ((Test-Path $fleetDir) -and (Test-Have go)) {
    Push-Location $fleetDir
    try {
        $fleetdOut = Join-Path $fleetDir 'bin\fleetd.exe'
        $thesunOut = Join-Path $Root 'bin\thesun.exe'
        & go build -o $fleetdOut .\cmd\fleetd
        $fleetdRc = $LASTEXITCODE
        & go build -o $thesunOut .\cmd\thesun
        $thesunRc = $LASTEXITCODE
        if ($fleetdRc -eq 0 -and $thesunRc -eq 0) { Write-Ok "fleetd + thesun CLI built" } else { Write-Fail "fleet build failed" }
    } catch { Write-Fail "fleet build failed: $_" }
    finally { Pop-Location }
} else { Write-Skip "fleet (no fleetd dir or go)" }

# 3) default MCP servers (Go: atlassian + servicenow; Node: vendored ms365)
# Non-fatal: a failure here leaves a default server unbuilt (doctor/status will
# flag it FAIL) but must never abort the whole install.
Write-Host "> default servers"
if (Test-Have go) {
    foreach ($name in @('atlassian', 'servicenow')) {
        $d = Join-Path $Root "fleet\servers\generated\$name"
        if (Test-Path $d) {
            Push-Location $d
            try {
                # go appends .exe on Windows automatically; leave the name extension-agnostic.
                $out = Join-Path $d "bin\$name-mcp"
                & go build -o $out .
                if ($LASTEXITCODE -eq 0) { Write-Ok "$name-mcp built" } else { Write-Fail "$name-mcp build failed (default server stays unavailable until fixed)" }
            } catch { Write-Fail "$name-mcp build failed: $_" }
            finally { Pop-Location }
        } else { Write-Skip "$name-mcp (no source at $d)" }
    }
} else { Write-Skip "default Go servers (no go)" }

# ms365 is optional: only wire it when the vendored package is present.
$ms365Dir = Join-Path $Root 'servers\vendor\ms365'
if (Test-Path (Join-Path $ms365Dir 'package.json')) {
    if (Test-Have npm) {
        Push-Location $ms365Dir
        try {
            & npm install --silent
            if ($LASTEXITCODE -eq 0) { Write-Ok "ms365 vendor deps installed (device-code login still needed before first use)" } else { Write-Fail "ms365 vendor npm install failed" }
        } catch { Write-Fail "ms365 vendor npm install failed: $_" }
        finally { Pop-Location }
    } else { Write-Skip "ms365 vendor (no npm)" }
} else { Write-Skip "ms365 default server not vendored; see servers/vendor/ms365/README.md or run 'thesun add'" }

# 4) gateway (Node/TypeScript)
Write-Host "> gateway"
$gwDir = Join-Path $Root 'gateway'
if ((Test-Path (Join-Path $gwDir 'package.json')) -and (Test-Have npm)) {
    Push-Location $gwDir
    try {
        & npm install --silent
        & npm run build --silent
        if ($LASTEXITCODE -eq 0) { Write-Ok "gateway built" } else { Write-Fail "gateway build failed" }
    } catch { Write-Fail "gateway build failed: $_" }
    finally { Pop-Location }
} else { Write-Skip "gateway (no package.json or npm)" }

# 5) hermes (pnpm monorepo)
Write-Host "> hermes"
$hermesDir = Join-Path $Root 'hermes'
if (Test-Path (Join-Path $hermesDir 'package.json')) {
    if (Test-Have pnpm) {
        Push-Location $hermesDir
        try {
            & pnpm install --silent
            & pnpm run build
            if ($LASTEXITCODE -eq 0) { Write-Ok "hermes built" } else { Write-Fail "hermes build failed" }
        } catch { Write-Fail "hermes build failed: $_" }
        finally { Pop-Location }
    } else { Write-Fail "hermes needs pnpm (npm i -g pnpm)" }
} else { Write-Skip "hermes (no package.json)" }

# 6) CLI on PATH
$thesunBin = Join-Path $Root 'bin\thesun.exe'
if (Test-Path $thesunBin) { Write-Ok "thesun CLI at $thesunBin" }

# 7) durable PATH: add bin to the USER PATH (persists across shells) idempotently.
# Non-clobbering: a different thesun already on PATH is noted, not overwritten.
function Add-BinToUserPath {
    $binDir = Join-Path $Root 'bin'
    if (-not (Test-Path $thesunBin)) { Write-Skip "PATH persist (bin\thesun.exe not built)"; return }

    # Note (do not touch) a different thesun already resolvable on PATH.
    $existing = Get-Command thesun -ErrorAction SilentlyContinue
    if ($existing -and ($existing.Source -ine $thesunBin)) {
        Write-Fail "a different 'thesun' is already on PATH at $($existing.Source) (left untouched)"
        Write-Host "     to prefer this build, ensure $binDir precedes it on PATH"
    }

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($null -eq $userPath) { $userPath = '' }
    $parts = $userPath.Split(';') | Where-Object { $_ -ne '' }
    $already = $parts | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') }
    if ($already) {
        Write-Ok "bin already on the user PATH: $binDir"
    } else {
        $newPath = if ($userPath -eq '') { $binDir } else { ($userPath.TrimEnd(';') + ';' + $binDir) }
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        $env:PATH = $env:PATH + ';' + $binDir   # reflect into the current session too
        Write-Ok "added bin to the user PATH: $binDir (open a new terminal for it to take effect everywhere)"
    }
}
Add-BinToUserPath

Write-Host ""
Write-Host "done. next:"
Write-Host "  `$env:PATH = `"$(Join-Path $Root 'bin');`" + `$env:PATH   # fallback: only if the PATH step above was skipped"
Write-Host "  thesun up        # start hermes -> fleetd -> gateway"
Write-Host "  thesun status    # whole-stack health"
