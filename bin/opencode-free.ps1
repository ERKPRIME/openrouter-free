# opencode with the free-router config: `opencode-free`, `opencode-free run ...`, `opencode-free acp`.
# install-windows.ps1 replaces @FREE_ROUTER_DIR@ with the install directory.
#
# opencode 2 commands connect to a shared background service that ignores OPENCODE_CONFIG, so
# every command that can run its own server gets --standalone. `acp` and `serve` start their own
# server and read OPENCODE_CONFIG already. The service itself is refused, and so are the commands
# that manage, restart or may auto-start it (`debug`, `pair`, `mcp`, `plugin`, `upgrade`, `update`,
# `uninstall`): it could come up with this config and the provider keys exported. Run those as plain
# `opencode`.
#
# The arguments come from PowerShell's automatic $args rather than a param block: -File's parameter
# binder treats a `--` separator specially and rejects `opencode-free run -- message`.
$ErrorActionPreference = "Stop"
$OpenCodeArgs = @($args)
$dir = if ($env:FREE_ROUTER_DIR) { $env:FREE_ROUTER_DIR } else { '@FREE_ROUTER_DIR@' }
$config = Join-Path $dir "free.jsonc"
if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
    [Console]::Error.WriteLine("opencode-free: $config not found; run install-windows.ps1 or set FREE_ROUTER_DIR")
    exit 1
}

if (-not $OpenCodeArgs) { $OpenCodeArgs = @() }

# bb's model list (modelCli, see install-windows.ps1). free/auto is the only model, so print it
# without starting opencode, which can fail while other opencode processes run, and a failed
# listing makes bb replace free/auto with "Agent default".
if ($OpenCodeArgs.Count -eq 1 -and $OpenCodeArgs[0] -eq "--list-models") {
    Write-Output "free/auto"
    exit 0
}

# Fail with one clear message instead of PowerShell's CommandNotFoundException, which can leave a
# stale $LASTEXITCODE behind. --list-models is answered above and keeps working without opencode.
$openCodeCommand = Get-Command opencode -ErrorAction SilentlyContinue
if (-not $openCodeCommand) {
    [Console]::Error.WriteLine("opencode-free: opencode is not on PATH; install opencode 2 or add it to PATH")
    exit 127
}
$comspec = if ($env:ComSpec) { $env:ComSpec } else { "cmd.exe" }

# Load optional provider keys from KEY=value lines; comments and blank lines are ignored.
$envFile = Join-Path $dir "providers.env"
if (Test-Path -LiteralPath $envFile -PathType Leaf) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
            $name = $Matches[1]
            $value = $Matches[2]
            if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            [Environment]::SetEnvironmentVariable($name, $value, "Process")
        }
    }
}
$env:FREE_ROUTER_DIR = $dir
$env:OPENCODE_CONFIG = $config

function Refuse-Service {
    [Console]::Error.WriteLine("opencode-free: can't run the shared background service, and refuses --service anywhere in the arguments (quote it inside a message); use opencode-free for the TUI or opencode-free acp for editors and bb")
    exit 2
}

function Refuse-Command([string]$command) {
    [Console]::Error.WriteLine("opencode-free: run ``opencode $command ...`` directly; it manages the shared background service")
    exit 2
}

# Flags (from `opencode --help` and each subcommand's) whose next word is their value, not a subcommand.
$takesValue = @(
    "--log-level", "--completions", "--server", "--session", "-s", "--prompt", "--model", "-m",
    "--agent", "--format", "--file", "-f", "--title", "--data", "-d", "--header", "-H", "--param",
    "--hostname", "--port", "--cors", "--days", "--year", "--project", "--limit", "--url", "--method",
    "--replay-limit"
)
$managed = @("upgrade", "update", "uninstall", "debug", "pair", "mcp", "plugin")

# One scan of the arguments. `sub`: the first word that is a subcommand. `at`: the argument after
# which --standalone goes: the subcommand, or for a command group its own subcommand (`session list`;
# a bare `session` takes it after itself).
$values = [System.Collections.Generic.List[string]]::new()
foreach ($argument in $OpenCodeArgs) { [void]$values.Add($argument) }
$sub = ""
$at = 0
$skip = $false
$group = $false
for ($i = 0; $i -lt $values.Count; $i++) {
    $a = $values[$i]
    # Checked before the skip: a flag's value does not hide --service.
    if ($a -eq "--service" -or $a.StartsWith("--service=")) { Refuse-Service }
    if ($skip) { $skip = $false; continue }
    if ($a -eq "--") { break }
    if ($a -match '^--[^=]+=') { continue }
    if ($a.StartsWith("-")) {
        if ($takesValue -contains $a) { $skip = $true }
        continue
    }
    if ($sub) {
        if ($a -eq "service") {
            [Console]::Error.WriteLine("opencode-free: quote the message: opencode-free $sub `"...`"")
            exit 2
        }
        if ($group) { $at = $i + 1; $group = $false }
        continue
    }
    switch ($a) {
        { $_ -in @("acp", "serve") } { $sub = $a; break }
        { $managed -contains $_ } { Refuse-Command $a }
        { $_ -in @("api", "models", "stats", "mini", "run", "reload") } { $sub = $a; $at = $i + 1; break }
        { $_ -in @("session", "auth") } { $sub = $a; $at = $i + 1; $group = $true; break }
        "service" { Refuse-Service }
    }
}

function ConvertTo-CmdArgument([string]$value) {
    # cmd.exe: quoting every argument protects &, |, <, >, ^, ! and spaces. A literal quote is
    # passed as "" inside the quoted argument, and a trailing backslash is doubled so the C runtime
    # at the end of the batch's %* chain does not turn it into a quote. Newlines and %NAME% expansion
    # are cmd limitations.
    $escaped = $value.Replace('"', '""')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Invoke-OpenCode([string[]]$CommandArgs) {
    # Reset first: a .ps1 opencode that does not run a native command would otherwise forward the
    # exit code of whatever the launcher did before it.
    $global:LASTEXITCODE = 0
    # Windows PowerShell 5.1 builds native command lines that do not quote arguments without
    # whitespace, so `opencode.cmd run a&b` would be split by cmd.exe. Invoke .cmd/.bat targets
    # through cmd.exe ourselves with every argument quoted.
    $source = if ($openCodeCommand.Path) { $openCodeCommand.Path } else { $openCodeCommand.Source }
    if ($openCodeCommand.CommandType -eq "Application" -and $source -match '\.(cmd|bat)$') {
        $line = (@($source) + $CommandArgs | ForEach-Object { ConvertTo-CmdArgument ([string]$_) }) -join ' '
        & $comspec /d /v:off /s /c $line
        exit $LASTEXITCODE
    }
    & opencode @CommandArgs
    exit $LASTEXITCODE
}

# A bare --help or --version, and the commands that start their own server or take no --standalone.
if ($values.Count -eq 1 -and $values[0] -in @("-h", "--help", "-v", "--version")) {
    Invoke-OpenCode $values.ToArray()
}
if (-not $sub) {
    Invoke-OpenCode (@("--standalone") + $values.ToArray())
}
if ($at -eq 0) {
    Invoke-OpenCode $values.ToArray()
}

$values.Insert($at, "--standalone")
Invoke-OpenCode $values.ToArray()
