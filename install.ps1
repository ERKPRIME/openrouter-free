<#
.SYNOPSIS
  Install or upgrade opencode-free-router from PowerShell.

.DESCRIPTION
  Finds a POSIX shell and runs scripts/install.sh. Git for Windows ships one. Your free.jsonc,
  config.json, pins.json, provider keys and state are never overwritten.

.PARAMETER Bb
  Also register a "Free (auto)" ACP agent in bb (provider acp-free). Same as --bb.

.PARAMETER Dir
  Install directory. Defaults to $env:XDG_CONFIG_HOME/opencode/free-router or ~/.config/opencode/free-router.

.PARAMETER NoRank
  Skip the first ranking run. Same as --no-rank.

.EXAMPLE
  .\install.ps1
.EXAMPLE
  .\install.ps1 -Bb
#>
[CmdletBinding()]
param(
  [switch]$Bb,
  [string]$Dir,
  [switch]$NoRank
)

$ErrorActionPreference = 'Stop'

$repo = $PSScriptRoot
$script = Join-Path $repo 'scripts/install.sh'
if (-not (Test-Path $script)) {
  Write-Error "install.ps1: $script not found; run this from the repository root"
  exit 1
}

$candidates = @(
  (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe'),
  (Join-Path $env:LocalAppData 'Programs\Git\bin\bash.exe')
)
$bash = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $bash) {
  $cmd = Get-Command bash -ErrorAction SilentlyContinue
  if ($cmd) { $bash = $cmd.Source }
}
if (-not $bash) {
  Write-Error 'install.ps1: Git Bash not found. Install Git for Windows from https://git-scm.com/download/win, or run scripts/install.sh yourself with any POSIX shell.'
  exit 1
}

$argv = @()
if ($Bb) { $argv += '--bb' }
if ($Dir) { $argv += '--dir', $Dir }
if ($NoRank) { $argv += '--no-rank' }

& $bash $script @argv
exit $LASTEXITCODE
