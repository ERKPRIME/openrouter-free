[CmdletBinding()]
param(
    # Also delete the install directory: keys, config, pins, ranking and state.
    [switch]$Purge,
    # Required to -Purge a directory that has no valid install marker (installs from older
    # versions). Never recursive-delete an unrelated directory by accident.
    [switch]$Force,
    # Skip removing the user-profile shim; the tests use this so they never touch the real profile.
    [switch]$NoPath,
    [string]$ShimDir = (Join-Path $HOME ".local\bin"),
    [string]$InstallDir = (Join-Path $HOME ".config\opencode\free-router")
)

trap {
    [Console]::Error.WriteLine("uninstall-windows: $($_.Exception.Message)")
    exit 1
}

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "windows-safety.ps1")
$InstallDir = Assert-SafeRouterPath -Path $InstallDir -Label "-InstallDir"

if (-not $NoPath) {
    $shimDir = Get-NormalizedPath $ShimDir "-ShimDir"
    $shimCmd = Join-Path $shimDir "opencode-free.cmd"
    $shimPs1 = Join-Path $shimDir "opencode-free-launcher.ps1"
    $legacyPs1 = Join-Path $shimDir "opencode-free.ps1"
    # Only remove shims that belong to this install, like uninstall.sh only removes its own link.
    # Older installs embedded the install directory in the .cmd; newer ones put it in the .ps1.
    $owned = $false
    foreach ($launcher in @($shimPs1, $legacyPs1)) {
        if (Test-Path -LiteralPath $launcher -PathType Leaf) {
            $text = [System.IO.File]::ReadAllText($launcher)
            $owned = $text.IndexOf($InstallDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
            if ($owned) { break }
        }
    }
    if (-not $owned -and (Test-Path -LiteralPath $shimCmd -PathType Leaf)) {
        $text = [System.IO.File]::ReadAllText($shimCmd)
        $owned = $text.IndexOf($InstallDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    }
    if ($owned) {
        Remove-Item -LiteralPath $shimCmd -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $shimPs1 -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $legacyPs1 -Force -ErrorAction SilentlyContinue
    }
}

if ($Purge) {
    if (Test-Path -LiteralPath $InstallDir) {
        Assert-NotReparsePoint $InstallDir "-InstallDir"
        $marker = Read-RouterMarker $InstallDir
        if (-not $marker -and -not $Force) {
            throw "-InstallDir refuses to purge a directory without a valid opencode-free-router marker: $InstallDir. Use -Force only if you are certain this is a router install."
        }
        if (-not $marker) {
            Write-Warning "purging without an install marker because -Force was given: $InstallDir"
        } elseif (-not $marker.complete) {
            Write-Warning "the install marker says the last install did not complete; purging anyway: $InstallDir"
        }
        Remove-Item -LiteralPath $InstallDir -Recurse -Force
        Write-Host "removed $InstallDir"
    } else {
        Write-Host "$InstallDir was not installed"
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $InstallDir -PathType Container)) {
    Write-Host "$InstallDir was not installed"
    exit 0
}
if (-not (Test-RouterInstall -InstallDir $InstallDir)) {
    Write-Host "$InstallDir does not look like an opencode-free-router install; nothing removed"
    exit 0
}

# plugin.ts and the .js/.mjs names are what installs from before opencode 2 and the TypeScript port have.
foreach ($relative in @(
    "plugin\index.ts",
    "lib.mts",
    "rank.mts",
    "plugin.ts",
    "plugin.js",
    "lib.mjs",
    "rank.mjs",
    "opencode-free-launcher.ps1",
    "opencode-free.ps1",
    "opencode-free.cmd",
    "rank.lock"
)) {
    Remove-Item -LiteralPath (Join-Path $InstallDir $relative) -Force -ErrorAction SilentlyContinue
}

# No recursive remove: a plugin directory the user added files to stays.
$pluginDir = Join-Path $InstallDir "plugin"
if (Test-Path -LiteralPath $pluginDir -PathType Container) {
    if (-not (Get-ChildItem -LiteralPath $pluginDir -Force | Select-Object -First 1)) {
        Remove-Item -LiteralPath $pluginDir -Force
    }
}

# The marker stays so a later -Purge still recognises the directory, but it no longer claims a
# complete install.
$marker = Read-RouterMarker $InstallDir
if ($marker) {
    Write-RouterMarker -InstallDir $InstallDir -Version ([string]$marker.version) -Complete $false | Out-Null
}

Write-Host "removed code from $InstallDir; kept free.jsonc, config.json, pins.json, *.env, ranking and state (use -Purge to delete them)"
exit 0
