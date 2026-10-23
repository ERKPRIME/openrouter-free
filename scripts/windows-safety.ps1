# Safety checks shared by install-windows.ps1 and uninstall-windows.ps1. Kept in a separate file so
# the destructive paths can be tested without touching the real profile. All path comparisons are
# case-insensitive, as Windows paths are.

$script:RouterMarkerName = ".opencode-free-router.json"
$script:RouterMarkerFormat = 1

function Get-NormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path, [string]$Label = "path")
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "$Label is empty" }
    $full = [System.IO.Path]::GetFullPath($Path)
    if ($full -match '^[A-Za-z]:[\\/]$') { return $full.Substring(0, 2) + '\' }
    return $full.TrimEnd('\', '/')
}

function Test-PathUnder {
    param([string]$Path, [string]$Root)
    if ([string]::IsNullOrWhiteSpace($Root)) { return $false }
    $p = (Get-NormalizedPath $Path).TrimEnd('\')
    $r = (Get-NormalizedPath $Root).TrimEnd('\')
    if ($p -ieq $r) { return $true }
    return $p.StartsWith($r + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

# Refuse drive roots, the user profile and its ancestors, and operating-system / all-users locations.
# A router install writes provider keys, so a shared directory is the wrong place for it. A custom
# directory elsewhere (D:\tools\free-router, for example) is allowed.
function Assert-SafeRouterPath {
    param([Parameter(Mandatory = $true)][string]$Path, [string]$Label = "path")
    $full = Get-NormalizedPath $Path $Label
    $root = [System.IO.Path]::GetPathRoot($full)
    if (-not $root -or $full -ieq $root.TrimEnd('\', '/') -or $full -ieq $root) {
        throw "$Label refuses a drive root: $full"
    }

    $profile = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($profile)) { $profile = $HOME }
    $exact = @(
        $profile,
        $HOME,
        $env:SystemRoot,
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)},
        $env:ProgramData,
        $env:LOCALAPPDATA,
        $env:APPDATA
    )
    foreach ($candidate in $exact) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $c = Get-NormalizedPath $candidate
        if ($full -ieq $c) { throw "$Label refuses a protected directory: $full" }
        if ($candidate -in @($env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData) -and (Test-PathUnder $full $c)) {
            throw "$Label refuses a shared system directory: $full"
        }
    }
    if ($profile -and (Test-PathUnder $profile $full)) {
        throw "$Label refuses a parent of the user profile: $full"
    }
    return $full
}

function Assert-NotReparsePoint {
    param([Parameter(Mandatory = $true)][string]$Path, [string]$Label = "path")
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($item -and (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "$Label refuses a symbolic link or junction: $Path"
    }
}

# ---- install marker -------------------------------------------------------------------------
# A marker identifies a directory as a router install. The uninstaller requires it before a
# recursive -Purge, so pointing -InstallDir at the wrong directory can never delete unrelated files.
function Get-RouterMarkerPath {
    param([Parameter(Mandatory = $true)][string]$InstallDir)
    return Join-Path $InstallDir $script:RouterMarkerName
}

# Returns the marker object only when it is well formed and belongs to this exact directory.
# A corrupt, foreign or moved marker returns $null; callers decide whether that is fatal.
function Read-RouterMarker {
    param([Parameter(Mandatory = $true)][string]$InstallDir)
    $path = Get-RouterMarkerPath $InstallDir
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        $marker = [System.IO.File]::ReadAllText($path) | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $null
    }
    if ($null -eq $marker) { return $null }
    if ($marker.name -ne "opencode-free-router") { return $null }
    if ($null -eq $marker.format -or [int]$marker.format -lt 1) { return $null }
    if ([string]::IsNullOrWhiteSpace([string]$marker.installDir)) { return $null }
    try {
        $marked = Get-NormalizedPath ([string]$marker.installDir) "marker installDir"
        $actual = Get-NormalizedPath $InstallDir
    } catch {
        return $null
    }
    if ($marked -ine $actual) { return $null }
    return $marker
}

function Write-RouterMarker {
    param(
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [string]$Version = "unknown",
        [bool]$Complete = $true
    )
    $marker = [ordered]@{
        name       = "opencode-free-router"
        format     = $script:RouterMarkerFormat
        version    = $Version
        installDir = (Get-NormalizedPath $InstallDir)
        updatedAt  = [DateTime]::UtcNow.ToString("o")
        complete   = $Complete
    }
    $path = Get-RouterMarkerPath $InstallDir
    $temp = "$path.tmp-$PID"
    $json = $marker | ConvertTo-Json -Depth 4
    try {
        [System.IO.File]::WriteAllText($temp, $json, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temp -Destination $path -Force
    } finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
    }
    return $path
}

# A directory is considered a router installation when it has a valid marker or the files every
# version of the installer leaves behind. Used by the normal (non-Purge) uninstaller.
function Test-RouterInstall {
    param([Parameter(Mandatory = $true)][string]$InstallDir)
    if ($null -ne (Read-RouterMarker $InstallDir)) { return $true }
    foreach ($relative in @("free.jsonc", "plugin", "lib.mts", "rank.mts", "plugin.ts", "opencode-free-launcher.ps1", "opencode-free.cmd")) {
        if (Test-Path -LiteralPath (Join-Path $InstallDir $relative)) { return $true }
    }
    return $false
}
