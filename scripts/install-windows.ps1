[CmdletBinding()]
param(
    [switch]$NoRank,
    # Skip the user-profile shim and the PATH update. The tests use this so they never touch the
    # machine's real PATH; a normal install keeps the default.
    [switch]$NoPath,
    # Install the shim but do not change the user PATH. Tests use this with -ShimDir to exercise the
    # shim without writing the registry.
    [switch]$NoPathUpdate,
    [string]$ShimDir = (Join-Path $HOME ".local\bin"),
    [string]$InstallDir = (Join-Path $HOME ".config\opencode\free-router")
)

trap {
    [Console]::Error.WriteLine("install-windows: $($_.Exception.Message)")
    exit 1
}

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

$requiredFiles = @(
    "src\plugin\index.ts",
    "src\lib.mts",
    "src\rank.mts",
    "bin\opencode-free.ps1",
    "bin\opencode-free.cmd",
    "scripts\windows-path.ps1",
    "scripts\windows-safety.ps1",
    "scripts\windows-acl.ps1",
    "templates\free.jsonc",
    "templates\config.example.json",
    "templates\pins.example.json",
    "templates\providers.env.example",
    "templates\ranker.env.example",
    "package.json"
)
foreach ($relative in $requiredFiles) {
    if (-not (Test-Path (Join-Path $repo $relative) -PathType Leaf)) {
        throw "missing '$relative'. Keep this script inside the repository's scripts directory."
    }
}

. (Join-Path $PSScriptRoot "windows-path.ps1")
. (Join-Path $PSScriptRoot "windows-safety.ps1")
. (Join-Path $PSScriptRoot "windows-acl.ps1")

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$openCodeCommand = Get-Command opencode -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw "Node.js is not on PATH." }
if (-not $openCodeCommand) { throw "OpenCode is not on PATH. Install it first: npm install -g opencode-ai" }

$nodeVersionText = (& node -p "process.versions.node").Trim()
if ($LASTEXITCODE -ne 0) { throw "could not run 'node -p process.versions.node'." }
$nodeVersion = [version]$nodeVersionText
if ($nodeVersion -lt [version]"22.18.0") {
    throw "The router requires Node.js 22.18 or newer. Detected: $nodeVersionText"
}

$ocVersionOutput = (& opencode --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "could not run 'opencode --version': $ocVersionOutput" }

# OpenCode reports versions such as "opencode v2.1.2"; allow the optional "v".
$ocMatch = [regex]::Match($ocVersionOutput, '(?i)(?:^|[^0-9])v?(\d+)\.(\d+)\.(\d+)\b')
if (-not $ocMatch.Success -or [int]$ocMatch.Groups[1].Value -lt 2) {
    $detected = if ($ocMatch.Success) { "$($ocMatch.Groups[1].Value).$($ocMatch.Groups[2].Value).$($ocMatch.Groups[3].Value)" } else { "of unknown version" }
    [Console]::Error.WriteLine("$($openCodeCommand.Source) is opencode $detected`: opencode 2 or newer is required (put it first on PATH)")
    exit 1
}

$InstallDir = Assert-SafeRouterPath -Path $InstallDir -Label "-InstallDir"
if (Test-PathUnder $InstallDir $repo) {
    throw "-InstallDir refuses the repository itself: $InstallDir"
}
if (Test-Path -LiteralPath $InstallDir -PathType Leaf) {
    throw "-InstallDir is a file, not a directory: $InstallDir"
}
Assert-NotReparsePoint $InstallDir "-InstallDir"

# The install directory may be new, an existing router install, or a pre-marker install from an
# older version (free.jsonc/plugin/…). Never take over an unrelated non-empty directory: a purge
# could later delete its files.
if (Test-Path -LiteralPath $InstallDir -PathType Container) {
    $existing = @(Get-ChildItem -LiteralPath $InstallDir -Force)
    if ($existing.Count -gt 0 -and -not (Test-RouterInstall -InstallDir $InstallDir)) {
        throw "-InstallDir refuses a non-empty directory that is not an opencode-free-router install: $InstallDir"
    }
}

# The marker is written with complete=false before anything is copied and rewritten with
# complete=true at the end. A failed install is still recognisable, and the uninstaller only allows
# a recursive -Purge of a directory that carries a valid marker.
$routerVersion = "unknown"
try {
    $package = [System.IO.File]::ReadAllText((Join-Path $repo "package.json")) | ConvertFrom-Json
    if ($package.version) { $routerVersion = [string]$package.version }
} catch {
    Write-Warning "could not read the package version: $($_.Exception.Message)"
}

$pluginDir = Join-Path $InstallDir "plugin"
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
Assert-NotReparsePoint $pluginDir "-InstallDir\plugin"
Protect-RouterPath -Path $InstallDir
Write-RouterMarker -InstallDir $InstallDir -Version $routerVersion -Complete $false | Out-Null

# Code: always replaced. Old installs kept plugin.ts/plugin.js and .mjs copies next to the files.
foreach ($destination in @(
    (Join-Path $pluginDir "index.ts"),
    (Join-Path $InstallDir "lib.mts"),
    (Join-Path $InstallDir "rank.mts"),
    (Join-Path $InstallDir "opencode-free-launcher.ps1"),
    (Join-Path $InstallDir "opencode-free.cmd")
)) {
    Assert-NotReparsePoint $destination "install destination"
}
Copy-Item (Join-Path $repo "src\plugin\index.ts") (Join-Path $pluginDir "index.ts") -Force
Copy-Item (Join-Path $repo "src\lib.mts") (Join-Path $InstallDir "lib.mts") -Force
Copy-Item (Join-Path $repo "src\rank.mts") (Join-Path $InstallDir "rank.mts") -Force
foreach ($old in @("plugin.ts", "plugin.js", "lib.mjs", "rank.mjs", "opencode-free.ps1")) {
    Remove-Item (Join-Path $InstallDir $old) -Force -ErrorAction SilentlyContinue
}

$psLauncherPath = Join-Path $InstallDir "opencode-free-launcher.ps1"
$psLauncher = [System.IO.File]::ReadAllText((Join-Path $repo "bin\opencode-free.ps1"))
$psDirectory = $InstallDir.Replace("'", "''")
$psLauncher = $psLauncher.Replace("@FREE_ROUTER_DIR@", $psDirectory)
[System.IO.File]::WriteAllText($psLauncherPath, $psLauncher, (New-Object System.Text.UTF8Encoding($true)))

# Installed as opencode-free-launcher.ps1, not opencode-free.ps1: PowerShell resolves a .ps1 by bare
# name and would run it in the caller's session, leaking OPENCODE_CONFIG/FREE_ROUTER_DIR into the
# shell. The .cmd shim is the only opencode-free command, so it always runs in a child process.
$cmdLauncherPath = Join-Path $InstallDir "opencode-free.cmd"
Copy-Item (Join-Path $repo "bin\opencode-free.cmd") $cmdLauncherPath -Force

# User files: created once, never overwritten.
$copyOnce = @(
    @{ Source = "templates\free.jsonc"; Destination = "free.jsonc" },
    @{ Source = "templates\config.example.json"; Destination = "config.json" },
    @{ Source = "templates\pins.example.json"; Destination = "pins.json" },
    @{ Source = "templates\providers.env.example"; Destination = "providers.env" },
    @{ Source = "templates\ranker.env.example"; Destination = "ranker.env" }
)
foreach ($item in $copyOnce) {
    $destination = Join-Path $InstallDir $item.Destination
    if (-not (Test-Path -LiteralPath $destination)) {
        Copy-Item (Join-Path $repo $item.Source) $destination
        Write-Host "created: $destination"
    } else {
        Write-Host "kept (never overwritten): $destination"
    }
}

# The one edit ever made to an existing free.jsonc: its plugin entry follows the move to opencode 2's
# "plugins" directory entry. Comment lines are neither rewritten nor counted.
$configPath = Join-Path $InstallDir "free.jsonc"
$raw = [System.IO.File]::ReadAllText($configPath)
$newline = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
$lines = $raw -split "`r?`n"
$oldEntry = '"plugin"\s*:\s*\[\s*"\./plugin\.[tj]s"\s*\]'
$changed = $false
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -notmatch '^\s*//' -and $lines[$i] -match $oldEntry) {
        $lines[$i] = [regex]::Replace($lines[$i], $oldEntry, '"plugins": ["./plugin"]')
        $changed = $true
    }
}
if ($changed) {
    [System.IO.File]::WriteAllText($configPath, ($lines -join $newline))
    Write-Host "updated  $configPath (plugin -> plugins)"
}

$active = ($lines | Where-Object { $_ -notmatch '^\s*//' }) -join "`n"
if ($active -match '"plugin"\s*:' -or $active -notmatch '"plugins"\s*:\s*\[[^\]]*"\./plugin"') {
    [Console]::Error.WriteLine("installed the code, but $configPath does not load it: replace its `"plugin`" entry with `"plugins`": [`"./plugin`"] (on one line, and move any other entries of the old array into it), then run install-windows.ps1 again")
    exit 1
}

# A command shim under the user's profile. Both the .cmd and the rendered launcher .ps1 are copied
# together so the shim can use %~dp0; adding the directory to the user PATH affects new terminals only.
if (-not $NoPath) {
    $userBin = Assert-SafeRouterPath -Path $ShimDir -Label "-ShimDir"
    Assert-NotReparsePoint $userBin "-ShimDir"
    New-Item -ItemType Directory -Force -Path $userBin | Out-Null
    # The .cmd calls opencode-free-launcher.ps1 by a relative path. The launcher already contains the
    # absolute install directory, and no .ps1 is named opencode-free, so PowerShell always runs the
    # .cmd as a child process.
    if ($userBin -ine $InstallDir) {
        Copy-Item $psLauncherPath (Join-Path $userBin "opencode-free-launcher.ps1") -Force
        Copy-Item $cmdLauncherPath (Join-Path $userBin "opencode-free.cmd") -Force
    } else {
        Write-Host "-ShimDir is the install directory; its launcher files are used directly."
    }

    # Upgrading from the first Windows version leaves opencode-free.ps1 here. PowerShell prefers a
    # .ps1 over our .cmd, so remove it when it belongs to this install (never a foreign shim).
    $legacyShim = Join-Path $userBin "opencode-free.ps1"
    if (Test-Path -LiteralPath $legacyShim -PathType Leaf) {
        $legacyText = [System.IO.File]::ReadAllText($legacyShim)
        if ($legacyText.IndexOf($InstallDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Remove-Item -LiteralPath $legacyShim -Force
        }
    }

    if (-not $NoPathUpdate) {
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        # Put the shim first: another opencode-free earlier on PATH must not shadow the router.
        $newUserPath = Add-FrontOfPath -PathValue $userPath -Directory $userBin
        if ($newUserPath -ne $userPath) {
            [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
            Write-Host "Added $userBin to the front of the user PATH. New terminals will pick it up."
        } else {
            Write-Host "$userBin is already first on the user PATH."
        }
        if (($env:Path -split ';' | Where-Object { $_.TrimEnd('\') -ieq $userBin.TrimEnd('\') }).Count -eq 0) {
            $env:Path = "$userBin;$env:Path"
        }
    }
}

# Provider keys and other user data are readable only by the current user (plus SYSTEM and
# Administrators). The directory was protected above, so newly created files inherit these rules.
Protect-RouterPath -Path @(
    (Join-Path $InstallDir "free.jsonc"),
    (Join-Path $InstallDir "config.json"),
    (Join-Path $InstallDir "pins.json"),
    (Join-Path $InstallDir "providers.env"),
    (Join-Path $InstallDir "ranker.env"),
    (Join-Path $InstallDir "ranking.json"),
    (Join-Path $InstallDir "state.json")
)
Write-RouterMarker -InstallDir $InstallDir -Version $routerVersion -Complete $true | Out-Null

Write-Host ""
Write-Host "Installed to: $InstallDir"
if ($NoPath -or $NoPathUpdate) {
    Write-Host "Launcher:     $cmdLauncherPath"
} else {
    Write-Host "Launcher:     $(Join-Path $userBin 'opencode-free.cmd')"
    Write-Host "Open a new terminal (or refresh PATH) before running opencode-free."
}
Write-Host "Model:        free/auto"
Write-Host "Your normal OpenCode was not modified."
Write-Host "Try: opencode-free --version"
Write-Host "Status: node `"$InstallDir\rank.mts`" --status"

if (-not $NoRank) {
    Write-Host ""
    Write-Host "Creating the first ranking (needs network and configured OpenCode providers)..."
    $oldConfig = $env:OPENCODE_CONFIG
    $oldDir = $env:FREE_ROUTER_DIR
    try {
        $env:OPENCODE_CONFIG = Join-Path $InstallDir "free.jsonc"
        $env:FREE_ROUTER_DIR = $InstallDir
        & node (Join-Path $InstallDir "rank.mts")
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "The first ranking failed. The install is complete; retry with: node `"$InstallDir\rank.mts`""
        }
    } finally {
        if ($null -eq $oldConfig) { Remove-Item Env:OPENCODE_CONFIG -ErrorAction SilentlyContinue } else { $env:OPENCODE_CONFIG = $oldConfig }
        if ($null -eq $oldDir) { Remove-Item Env:FREE_ROUTER_DIR -ErrorAction SilentlyContinue } else { $env:FREE_ROUTER_DIR = $oldDir }
    }
}
exit 0
