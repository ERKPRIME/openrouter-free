// The native Windows launcher (bin/opencode-free.ps1, installed as opencode-free-launcher.ps1 and
// reached through the opencode-free.cmd shim). It must produce the same opencode command lines as
// bin/opencode-free.
import { test } from "node:test"
import type { TestContext } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { tempWithOpencode } from "./fixtures/fake-opencode.ts"

const WINDOWS_ONLY = process.platform === "win32" ? false : "the PowerShell launcher is Windows-only"
const LAUNCHER = fileURLToPath(new URL("../bin/opencode-free.ps1", import.meta.url))
const POWERSHELL = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")

const FAKE_OPENCODE = `#!/bin/sh
exit 1
`
const FAKE_NODE_SCRIPT = `
import fs from "node:fs"
import path from "node:path"
const lines = [process.env.OPENCODE_CONFIG ?? "", process.env.FREE_ROUTER_DIR ?? "", process.env.FOO_KEY ?? "", ...process.argv.slice(2)]
fs.writeFileSync(path.join(process.env.FREE_ROUTER_DIR, "started"), lines.join("\\n") + "\\n")
`
const FAKE_OPENCODE_WIN = `@echo off
"${process.execPath}" "%~dp0opencode-fake.mjs" %*
exit /b %errorlevel%
`

function setup(t: TestContext) {
  const dir = tempWithOpencode(t, "free-router-launcher-win-", FAKE_OPENCODE, FAKE_OPENCODE_WIN)
  fs.writeFileSync(path.join(dir, "bin", "opencode-fake.mjs"), FAKE_NODE_SCRIPT)
  fs.writeFileSync(path.join(dir, "free.jsonc"), "{}\n")
  fs.writeFileSync(path.join(dir, "providers.env"), "FOO_KEY=abc\n")
  const launcher = fs.readFileSync(LAUNCHER, "utf8").replaceAll("@FREE_ROUTER_DIR@", dir.replace(/'/g, "''"))
  fs.writeFileSync(path.join(dir, "opencode-free-launcher.ps1"), launcher)
  const cmdTemplate = fs.readFileSync(new URL("../bin/opencode-free.cmd", import.meta.url), "utf8")
  fs.writeFileSync(path.join(dir, "opencode-free.cmd"), cmdTemplate, "ascii")
  return dir
}

function launch(dir: string, args: string[]) {
  const started = path.join(dir, "started")
  fs.rmSync(started, { force: true })
  const envPath = [path.join(dir, "bin"), path.dirname(process.execPath), path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"), path.dirname(POWERSHELL)].join(path.delimiter)
  const r = spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "opencode-free-launcher.ps1"), ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: envPath, FREE_ROUTER_DIR: dir },
  })
  const lines = fs.existsSync(started) ? fs.readFileSync(started, "utf8").split("\n").slice(0, -1) : undefined
  return {
    status: r.status,
    stdout: (r.stdout ?? "").replace(/\r\n/g, "\n"),
    stderr: (r.stderr ?? "").replace(/\r\n/g, "\n"),
    started: lines,
    argv: lines?.slice(3),
  }
}

// The .cmd shim is what PATH resolves; it forwards to the .ps1 next to the install.
function launchShim(dir: string, args: string[], useEnv = true, includeFake = true) {
  const command = [path.join(dir, "opencode-free.cmd"), ...args].map((word) => `"${word}"`).join(" ")
  const pathParts = [path.dirname(process.execPath), path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"), path.dirname(POWERSHELL)]
  if (includeFake) pathParts.unshift(path.join(dir, "bin"))
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: pathParts.join(path.delimiter) }
  if (useEnv) env.FREE_ROUTER_DIR = dir
  else delete env.FREE_ROUTER_DIR
  return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
    encoding: "utf8",
    windowsVerbatimArguments: true,
    env,
  })
}

const RUNS: [args: string[], argv: string[]][] = [
  [[], ["--standalone"]],
  [["."], ["--standalone", "."]],
  [["-c"], ["--standalone", "-c"]],
  [["-m", "p/m"], ["--standalone", "-m", "p/m"]],
  [["run", "x"], ["run", "--standalone", "x"]],
  [["--print-logs", "run", "x"], ["--print-logs", "run", "--standalone", "x"]],
  [["-m", "p/m", "run", "x"], ["-m", "p/m", "run", "--standalone", "x"]],
  [["run", "fix the service"], ["run", "--standalone", "fix the service"]],
  [["run", "--", "service"], ["run", "--standalone", "--", "service"]],
  [["--log-level", "debug", "models"], ["--log-level", "debug", "models", "--standalone"]],
  [["models"], ["models", "--standalone"]],
  [["api", "model.list"], ["api", "--standalone", "model.list"]],
  [["stats", "--days", "3"], ["stats", "--standalone", "--days", "3"]],
  [["session", "list"], ["session", "list", "--standalone"]],
  [["auth", "list"], ["auth", "list", "--standalone"]],
  [["session"], ["session", "--standalone"]],
  [["auth"], ["auth", "--standalone"]],
  [["acp"], ["acp"]],
  [["serve", "--port", "1"], ["serve", "--port", "1"]],
  [["-h"], ["-h"]],
  [["--version"], ["--version"]],
  [["runn", "hello"], ["--standalone", "runn", "hello"]],
]

test("the PowerShell launcher gets --standalone where opencode takes it", { skip: WINDOWS_ONLY }, (t) => {
  const dir = setup(t)
  for (const [args, argv] of RUNS) {
    const r = launch(dir, args)
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`)
    assert.deepEqual(r.argv, argv, args.join(" "))
  }
})

test("the PowerShell launcher starts opencode with the router config and provider keys", { skip: WINDOWS_ONLY }, (t) => {
  const dir = setup(t)
  const r = launch(dir, ["run", "x"])
  assert.deepEqual(r.started?.slice(0, 3), [path.join(dir, "free.jsonc"), dir, "abc"])
})

test("the PowerShell launcher refuses commands that manage the shared service", { skip: WINDOWS_ONLY }, (t) => {
  const dir = setup(t)
  for (const cmd of ["debug", "pair", "mcp", "plugin", "upgrade", "update", "uninstall"]) {
    for (const args of [[cmd], [cmd, "list"], ["--log-level", "debug", cmd]]) {
      const r = launch(dir, args)
      assert.equal(r.status, 2, args.join(" "))
      assert.equal(r.stderr, `opencode-free: run \`opencode ${cmd} ...\` directly; it manages the shared background service\n`)
      assert.equal(r.started, undefined, "opencode is never started")
    }
  }
  assert.deepEqual(launch(dir, ["run", "--", "mcp"]).argv, ["run", "--standalone", "--", "mcp"])
  assert.deepEqual(launch(dir, ["run", "debug it"]).argv, ["run", "--standalone", "debug it"])
})

test("the PowerShell launcher refuses the shared service and hints at quoting a message", { skip: WINDOWS_ONLY }, (t) => {
  const dir = setup(t)
  const refused = /^opencode-free: can't run the shared background service, and refuses --service anywhere in the arguments \(quote it inside a message\); use opencode-free for the TUI or opencode-free acp for editors and bb\n$/
  for (const args of [["service"], ["service", "restart"], ["serve", "--service"], ["serve", "--service=true"], ["--service=1"], ["--agent", "--service"], ["--log-level", "--service"], ["--agent", "run", "service"], ["--log-level", "debug", "service", "stop"]]) {
    const r = launch(dir, args)
    assert.equal(r.status, 2, args.join(" "))
    assert.match(r.stderr, refused, args.join(" "))
    assert.equal(r.started, undefined)
  }
  for (const args of [["run", "fix", "the", "service"], ["run", "service"], ["session", "list", "service"]]) {
    const r = launch(dir, args)
    assert.equal(r.status, 2, args.join(" "))
    assert.equal(r.stderr, `opencode-free: quote the message: opencode-free ${args[0]} "..."\n`)
    assert.equal(r.started, undefined)
  }
})

test("the PowerShell launcher answers --list-models and reports a missing config", { skip: WINDOWS_ONLY }, (t) => {
  const dir = setup(t)
  const r = launch(dir, ["--list-models"])
  assert.equal(r.stdout, "free/auto\n")
  assert.equal(r.started, undefined)

  fs.rmSync(path.join(dir, "free.jsonc"))
  const missing = launch(dir, ["run", "x"])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /free\.jsonc not found/)
  assert.equal(missing.started, undefined)
})

test("the .cmd shim forwards arguments to the PowerShell launcher", { skip: WINDOWS_ONLY }, (t) => {
  const dir = setup(t)
  const listing = launchShim(dir, ["--list-models"])
  assert.equal(listing.status, 0, listing.stderr)
  assert.equal((listing.stdout ?? "").replace(/\r\n/g, "\n"), "free/auto\n")

  fs.rmSync(path.join(dir, "started"), { force: true })
  const run = launchShim(dir, ["run", "hello world"])
  assert.equal(run.status, 0, run.stderr)
  const lines = fs.readFileSync(path.join(dir, "started"), "utf8").split("\n").slice(0, -1)
  assert.deepEqual(lines.slice(3), ["run", "--standalone", "hello world"])
})

// The shim itself is ASCII and uses %~dp0, so a non-ASCII install path only ever appears in the
// UTF-8-with-BOM .ps1. This is what makes accented Windows usernames work.
test("the .cmd shim works from a path with non-ASCII characters", { skip: WINDOWS_ONLY }, (t) => {
  const base = setup(t)
  const dir = path.join(base, "carpeta ñandú")
  fs.mkdirSync(dir)
  fs.copyFileSync(path.join(base, "free.jsonc"), path.join(dir, "free.jsonc"))
  fs.copyFileSync(path.join(base, "providers.env"), path.join(dir, "providers.env"))
  const rendered = fs.readFileSync(path.join(base, "opencode-free-launcher.ps1"), "utf8").replaceAll(base.replace(/'/g, "''"), dir.replace(/'/g, "''"))
  fs.writeFileSync(path.join(dir, "opencode-free-launcher.ps1"), "\uFEFF" + rendered, "utf8")
  fs.copyFileSync(path.join(base, "opencode-free.cmd"), path.join(dir, "opencode-free.cmd"))

  const r = launchShim(dir, ["--list-models"], false)
  assert.equal(r.status, 0, r.stderr)
  assert.equal((r.stdout ?? "").replace(/\r\n/g, "\n"), "free/auto\n")
})

// cmd.exe expands %NAME% in an argument before PowerShell sees it, and the outer .cmd shim cannot
// carry an embedded double quote or newline (documented in README). Everything else must survive
// literally, and nothing may be executed by cmd itself.
test("the .cmd shim forwards shell metacharacters and Unicode without interpreting them", { skip: WINDOWS_ONLY }, (t) => {
  const dir = setup(t)
  const started = path.join(dir, "started")
  const sentinel = path.join(dir, "redirected.txt")
  const cases: Array<[argument: string, argv: string[]]> = [
    ["", ["run", "--standalone", ""]],
    ["dos palabras", ["run", "--standalone", "dos palabras"]],
    ["a&b|c<d>e^f", ["run", "--standalone", "a&b|c<d>e^f"]],
    ["semi;colon", ["run", "--standalone", "semi;colon"]],
    ["par(en)s", ["run", "--standalone", "par(en)s"]],
    ["50%", ["run", "--standalone", "50%"]],
    ["ñandú 日本語", ["run", "--standalone", "ñandú 日本語"]],
    ["& echo HACKED", ["run", "--standalone", "& echo HACKED"]],
    ["| echo HACKED", ["run", "--standalone", "| echo HACKED"]],
    ["> redirected.txt", ["run", "--standalone", "> redirected.txt"]],
  ]
  for (const [argument, argv] of cases) {
    fs.rmSync(started, { force: true })
    fs.rmSync(sentinel, { force: true })
    const r = launchShim(dir, ["run", argument])
    assert.equal(r.status, 0, `${argument}: ${r.stderr}`)
    const lines = fs.readFileSync(started, "utf8").split("\n").slice(0, -1)
    assert.deepEqual(lines.slice(3), argv, argument)
    assert.doesNotMatch(r.stdout ?? "", /HACKED/, argument)
    assert.equal(fs.existsSync(sentinel), false, `${argument}: cmd did not redirect`)
  }
})

test("the PowerShell launcher passes an embedded quote to a .cmd opencode", { skip: WINDOWS_ONLY }, (t) => {
  const dir = setup(t)
  const r = launch(dir, ["run", 'say "hi"'])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.argv, ["run", "--standalone", 'say "hi"'])

  const trailing = launch(dir, ["run", "C:\\trailing\\"])
  assert.equal(trailing.status, 0, trailing.stderr)
  assert.deepEqual(trailing.argv, ["run", "--standalone", "C:\\trailing\\"])
})

test("the shim explains a missing opencode but still answers --list-models", { skip: WINDOWS_ONLY }, (t) => {
  const dir = setup(t)
  const missing = launchShim(dir, ["--version"], true, false)
  assert.equal(missing.status, 127, missing.stderr)
  assert.match((missing.stderr ?? "").replace(/\r\n/g, "\n"), /^opencode-free: opencode is not on PATH; install opencode 2 or add it to PATH$/m)

  const models = launchShim(dir, ["--list-models"], true, false)
  assert.equal(models.status, 0, models.stderr)
  assert.equal((models.stdout ?? "").replace(/\r\n/g, "\n"), "free/auto\n")
  assert.equal(fs.existsSync(path.join(dir, "started")), false)
})
