#!/usr/bin/env node
// openrouter-free: opencode with the free-router config, on the best free model available.
//
//   openrouter-free                 TUI on free/auto
//   openrouter-free run "..."       one-shot
//   openrouter-free acp             ACP agent (Zed, JetBrains, bb, ...)
//   openrouter-free init            create or repair the data directory, then print where it is
//   openrouter-free rank [--status] run the ranker now
//   openrouter-free doctor          versions, paths and what is missing
//
// Everything that is not one of the three commands above goes to opencode unchanged.
//
// Two layouts use this file, and both keep the code it runs next to it:
//   - npm: the package holds the code; this CLI mirrors src/ into the data directory on every run,
//     because node refuses to strip types for files under node_modules and rank.mts is TypeScript.
//   - scripts/install.sh: sets OPENROUTER_FREE_SELF_HOSTED=1 and has already copied the code and the
//     templates into the install directory, which is also the data directory.
//
// opencode 2 commands connect to a shared background service that ignores OPENCODE_CONFIG, so every
// command that can run its own server gets --standalone. `acp` and `serve` start their own server and
// read OPENCODE_CONFIG already. The service itself is refused, and so are the commands that manage,
// restart or may auto-start it (`debug`, `pair`, `mcp`, `plugin`, `upgrade`, `update`, `uninstall`):
// it could come up with this config and the provider keys exported. Run those as plain `opencode`.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const SELF_HOSTED = process.env.OPENROUTER_FREE_SELF_HOSTED === "1"
const HERE = path.dirname(fileURLToPath(import.meta.url))
// <package> for npm, <install dir> for install.sh.
const PKG = SELF_HOSTED ? HERE : path.dirname(HERE)

const NODE = process.versions.node
const [nodeMajor, nodeMinor] = NODE.split(".").map(Number)
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 18)) {
  console.error(`openrouter-free: node ${NODE} is too old: 22.18 or newer runs the TypeScript sources`)
  process.exit(1)
}

// The same resolution as src/paths.mts. Duplicated because this file runs before (and, for an npm
// install, outside) the mirrored copy that the plugin and the ranker import.
function platformDataDir() {
  const home = os.homedir()
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "openrouter-free")
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "openrouter-free")
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "openrouter-free")
}

const DATA_DIR = path.resolve(process.env.FREE_ROUTER_DIR || (SELF_HOSTED ? HERE : platformDataDir()))
const CONFIG = path.join(DATA_DIR, "free.jsonc")
const TEMPLATES = path.join(PKG, "templates")

// User files: created once, never overwritten. Re-running is how you upgrade.
const USER_FILES = [
  ["free.jsonc", "free.jsonc"],
  ["config.example.json", "config.json"],
  ["pins.example.json", "pins.json"],
  ["providers.env.example", "providers.env"],
  ["ranker.env.example", "ranker.env"],
]

// Code, mirrored into the data directory so node and opencode load it from outside node_modules.
// opencode reads ./plugin, and the plugin and rank.mts find each other as siblings, exactly as in an
// install.sh install.
const CODE_FILES = [
  ["src/plugin/index.ts", "plugin/index.ts"],
  ["src/lib.mts", "lib.mts"],
  ["src/paths.mts", "paths.mts"],
  ["src/rank.mts", "rank.mts"],
]

// Left behind by installs from before opencode 2, which read a single plugin.ts.
const STALE = ["plugin.ts", "plugin.js", "lib.mjs", "rank.mjs"]

function fail(msg) {
  console.error(`openrouter-free: ${msg}`)
  process.exit(1)
}

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).version
  } catch {
    return undefined
  }
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

function copyOnce(from, to) {
  if (fs.existsSync(to)) return false
  writeAtomic(to, fs.readFileSync(from))
  return true
}

// Only when the content changed, so an upgrade lands and an identical re-run does nothing.
function sync(from, to) {
  const next = fs.readFileSync(from)
  if (fs.existsSync(to) && fs.readFileSync(to).equals(next)) return false
  writeAtomic(to, next)
  return true
}

// Create what is missing and bring the mirrored code up to date. Returns what it touched.
function ensure() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const created = []
  const updated = []
  if (!SELF_HOSTED) {
    if (!fs.existsSync(TEMPLATES)) fail(`${TEMPLATES} is missing; reinstall the package`)
    fs.mkdirSync(path.join(DATA_DIR, "plugin"), { recursive: true })
    for (const [from, to] of CODE_FILES) {
      if (sync(path.join(PKG, from), path.join(DATA_DIR, to))) updated.push(to)
    }
    for (const name of STALE) fs.rmSync(path.join(DATA_DIR, name), { force: true })
    for (const [from, to] of USER_FILES) {
      if (copyOnce(path.join(TEMPLATES, from), path.join(DATA_DIR, to))) created.push(to)
    }
    // Keys, so only the owner can read them. Windows ignores the group/other bits.
    for (const name of ["providers.env", "ranker.env"]) {
      try {
        fs.chmodSync(path.join(DATA_DIR, name), 0o600)
      } catch {
        // not there, or not ours to change
      }
    }
  }
  return { created, updated }
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || !m[1]) continue
    let value = m[2] ?? ""
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/, "")
    }
    // Same as sourcing the file in sh: the file wins over what the shell had.
    process.env[m[1]] = value
  }
}

function findOnPath(names) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const p = path.join(dir, name)
      try {
        if (fs.statSync(p).isFile()) return p
      } catch {
        // not this directory
      }
    }
  }
  return undefined
}

// Where opencode really is. npm's .cmd shim on Windows only names a wrapped binary, and cmd.exe
// expands %VAR% and splits unquoted spaces in the arguments, so follow the shim to the executable
// instead of running a message through a shell.
//   { kind: "direct", cmd, prefix }  spawn cmd with prefix + argv
//   { kind: "shim", cmd }            has to go through cmd.exe
function targetOf(file) {
  if (!/\.(cmd|bat)$/i.test(file)) return { kind: "direct", cmd: file, prefix: [] }
  let text = ""
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return { kind: "shim", cmd: file }
  }
  const dir = path.dirname(file)
  const exe = /"?%[~]?dp0%[\\/]([^"%]+?\.exe)"/i.exec(text)
  if (exe && exe[1]) return { kind: "direct", cmd: path.join(dir, exe[1]), prefix: [] }
  const js = /"?%[~]?dp0%[\\/]([^"%]+?\.(?:js|mjs|cjs))"/i.exec(text)
  if (js && js[1]) return { kind: "direct", cmd: process.execPath, prefix: [path.join(dir, js[1])] }
  return { kind: "shim", cmd: file }
}

function opencodeTarget() {
  const override = process.env.OPENCODE_FREE_OPENCODE
  if (override) return targetOf(override)
  if (process.platform !== "win32") return { kind: "direct", cmd: "opencode", prefix: [] }
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").toUpperCase().split(";")
  const names = []
  if (exts.includes(".EXE")) names.push("opencode.exe")
  if (exts.includes(".CMD")) names.push("opencode.cmd")
  if (exts.includes(".BAT")) names.push("opencode.bat")
  const found = findOnPath(names.length > 0 ? names : ["opencode.exe", "opencode.cmd", "opencode.bat"])
  return found ? targetOf(found) : { kind: "direct", cmd: "opencode", prefix: [] }
}

// Last resort: a shim that names neither a binary nor a script has to go through cmd.exe.
function cmdQuote(a) {
  return /^[^\s"&|<>^()%!]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`
}

function invoke(argv, { encoding, inherit } = {}) {
  const t = opencodeTarget()
  const stdio = inherit ? "inherit" : ["ignore", "pipe", "pipe"]
  if (t.kind === "shim") {
    const line = `"${t.cmd}" ${argv.map(cmdQuote).join(" ")}`
    const args = ["/d", "/s", "/c", line]
    return process.platform === "win32"
      ? spawnSync(process.env.ComSpec ?? "cmd.exe", args, { stdio, encoding, windowsVerbatimArguments: true })
      : spawnSync(t.cmd, argv, { stdio, encoding })
  }
  return spawnSync(t.cmd, [...t.prefix, ...argv], { stdio, encoding })
}

function run(argv) {
  const r = invoke(argv, { inherit: true })
  if (r.error) {
    const hint = r.error.code === "ENOENT" ? " (is opencode 2 installed and on PATH?)" : ""
    fail(`cannot start opencode: ${r.error.message}${hint}`)
  }
  // Ctrl+C and friends surface as a signal, not a status.
  process.exit(r.status ?? (r.signal ? 1 : 0))
}

function usage() {
  const v = version()
  console.log(`openrouter-free${v ? ` ${v}` : ""}: opencode, always on the best free model available.

  openrouter-free                 TUI on free/auto
  openrouter-free run "..."       one-shot
  openrouter-free acp             ACP agent (Zed, JetBrains, bb, ...)
  openrouter-free init            create or repair the data directory
  openrouter-free rank [--status] run the ranker now; --status prints the current ranking
  openrouter-free doctor          versions, paths and what is missing

Every other argument and command goes to opencode unchanged (see \`opencode --help\`). It runs in its
own private server (--standalone), because opencode 2's shared background service ignores
OPENCODE_CONFIG. \`service\`, \`serve --service\`, \`debug\`, \`pair\`, \`mcp\`, \`plugin\`, \`upgrade\`,
\`update\` and \`uninstall\` are refused: run those as plain \`opencode\`.

data: ${DATA_DIR}`)
}

function rank(rest) {
  ensure()
  const r = spawnSync(process.execPath, [path.join(DATA_DIR, "rank.mts"), ...rest], {
    stdio: "inherit",
    env: { ...process.env, FREE_ROUTER_DIR: DATA_DIR },
  })
  if (r.error) fail(`cannot run the ranker: ${r.error.message}`)
  process.exit(r.status ?? 1)
}

function doctor() {
  const v = version()
  console.log(`openrouter-free${v ? ` ${v}` : ""}${SELF_HOSTED ? " (scripts/install.sh install)" : ""}`)
  console.log(`  package:  ${SELF_HOSTED ? "(installed in the data directory)" : PKG}`)
  console.log(`  data:     ${DATA_DIR}`)
  console.log(`  node:     v${NODE}`)

  const t = opencodeTarget()
  const r = invoke(["--version"], { encoding: "utf8" })
  const reported = r.status === 0 && r.stdout ? String(r.stdout).trim().split(/\r?\n/)[0] : "not runnable"
  console.log(`  opencode: ${reported} (${t.cmd})`)
  if (r.error) console.log(`            ${r.error.message}`)

  const files = ["free.jsonc", "config.json", "pins.json", "providers.env", "ranker.env"]
  const missing = files.filter((f) => !fs.existsSync(path.join(DATA_DIR, f)))
  console.log(`  config:   ${missing.length === 0 ? "ok" : `missing ${missing.join(", ")} (run openrouter-free init)`}`)

  const code = ["plugin/index.ts", "lib.mts", "paths.mts", "rank.mts"].filter((f) => !fs.existsSync(path.join(DATA_DIR, f)))
  console.log(`  code:     ${code.length === 0 ? "ok" : `missing ${code.join(", ")} (run openrouter-free init)`}`)

  if (fs.existsSync(CONFIG)) {
    const active = fs
      .readFileSync(CONFIG, "utf8")
      .split(/\r?\n/)
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n")
    console.log(
      /"plugins"\s*:\s*\[[^\]]*"\.\/plugin"/.test(active)
        ? "  plugin:   ok (./plugin)"
        : `  plugin:   ${CONFIG} does not load "./plugin"; add "plugins": ["./plugin"] (opencode 2)`,
    )
  }

  const ranking = path.join(DATA_DIR, "ranking.json")
  const st = fs.statSync(ranking, { throwIfNoEntry: false })
  if (!st) {
    console.log("  ranking:  none yet; the plugin ranks on first start or run openrouter-free rank")
  } else {
    let count = "unreadable"
    try {
      const parsed = JSON.parse(fs.readFileSync(ranking, "utf8"))
      const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.ranking) ? parsed.ranking : []
      count = `${rows.length} models`
    } catch {
      // reported as unreadable
    }
    const hours = ((Date.now() - st.mtimeMs) / 3600e3).toFixed(1)
    console.log(`  ranking:  ${count}, updated ${hours} h ago`)
  }

  const envFile = path.join(DATA_DIR, "providers.env")
  const keys = fs.existsSync(envFile)
    ? fs
        .readFileSync(envFile, "utf8")
        .split(/\r?\n/)
        .filter((l) => /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S/.test(l)).length
    : 0
  console.log(
    `  keys:     ${keys > 0 ? `${keys} provider key(s) in providers.env` : "none in providers.env; opencode's own credentials are used"}`,
  )
}

// ---- main ---------------------------------------------------------------------------------------

const argv = process.argv.slice(2)
const first = argv[0]

if (first === "init") {
  const { created, updated } = ensure()
  console.log(`data directory: ${DATA_DIR}`)
  for (const f of created) console.log(`  created  ${f}`)
  for (const f of updated) console.log(`  updated  ${f}`)
  if (created.length === 0 && updated.length === 0) console.log("  already up to date")
  if (!fs.existsSync(CONFIG)) fail(`${CONFIG} is missing and could not be created`)
  console.log(`\nNext: add provider keys to ${path.join(DATA_DIR, "providers.env")} (optional), then run\n  openrouter-free`)
  process.exit(0)
}

if (first === "doctor") {
  doctor()
  process.exit(0)
}

if (first === "rank") rank(argv.slice(1))

if (argv.length === 1 && (first === "-h" || first === "--help" || first === "help")) {
  usage()
  process.exit(0)
}

if (argv.length === 1 && (first === "-v" || first === "--version")) {
  const v = version()
  console.log(`openrouter-free${v ? ` ${v}` : ""}`)
  const r = invoke(["--version"], { encoding: "utf8" })
  if (r.status === 0 && r.stdout) console.log(String(r.stdout).trim().split(/\r?\n/)[0])
  process.exit(0)
}

const { created } = ensure()
if (!fs.existsSync(CONFIG)) fail(`${CONFIG} is missing; run openrouter-free init`)

// bb's model list (modelCli, see install.sh --bb). free/auto is the only model, so print it without
// starting opencode, which can fail with "database is locked" while other opencode processes run,
// and a failed listing makes bb replace free/auto with "Agent default".
if (argv.length === 1 && first === "--list-models") {
  console.log("free/auto")
  process.exit(0)
}

loadEnvFile(path.join(DATA_DIR, "providers.env"))
process.env.FREE_ROUTER_DIR = DATA_DIR
process.env.OPENCODE_CONFIG = CONFIG

if (created.length > 0) {
  console.error(`openrouter-free: created ${DATA_DIR}`)
  console.error(`  add provider keys to ${path.join(DATA_DIR, "providers.env")} for more free models`)
}

// Flags (from `opencode --help` and each subcommand's) whose next word is their value, not a subcommand.
const TAKES_VALUE = new Set([
  "--log-level", "--completions", "--server", "--session", "-s", "--prompt", "--model", "-m", "--agent",
  "--format", "--file", "-f", "--title", "--data", "-d", "--header", "-H", "--param", "--hostname", "--port",
  "--cors", "--days", "--year", "--project", "--limit", "--url", "--method", "--replay-limit",
])

const refuseCommand = (name) => {
  console.error(`openrouter-free: run \`opencode ${name} ...\` directly; it manages the shared background service`)
  process.exit(2)
}

const refuseService = () => {
  console.error(
    "openrouter-free: can't run the shared background service, and refuses --service anywhere in the arguments (quote it inside a message); use openrouter-free for the TUI or openrouter-free acp for editors and bb",
  )
  process.exit(2)
}

// One scan of the arguments. `sub`: the first word that is a subcommand. `at`: the argument after
// which --standalone goes: the subcommand, or for a command group its own subcommand (`session list`;
// a bare `session` takes it after itself).
let sub = ""
let at = 0
let skip = false
let group = false
let i = 0

for (const a of argv) {
  i++
  // Checked before the skip: a flag's value does not hide --service.
  if (a === "--service" || a.startsWith("--service=")) refuseService()
  if (skip) {
    skip = false
    continue
  }
  if (a === "--") break
  if (a.startsWith("--") && a.includes("=")) continue
  if (a.startsWith("-")) {
    if (TAKES_VALUE.has(a)) skip = true
    continue
  }
  if (sub) {
    if (a === "service") {
      console.error(`openrouter-free: quote the message: openrouter-free ${sub} "..."`)
      process.exit(2)
    }
    if (group) {
      at = i
      group = false
    }
    continue
  }
  switch (a) {
    case "acp":
    case "serve":
      sub = a
      break
    case "upgrade":
    case "update":
    case "uninstall":
    case "debug":
    case "pair":
    case "mcp":
    case "plugin":
      refuseCommand(a)
      break
    case "api":
    case "models":
    case "stats":
    case "mini":
    case "run":
    case "reload":
      sub = a
      at = i
      break
    case "session":
    case "auth":
      sub = a
      at = i
      group = true
      break
    case "service":
      refuseService()
      break
  }
}

if (!sub) run(["--standalone", ...argv])
if (at === 0) run(argv)

// Insert --standalone after argument `at`.
const out = []
let n = 0
for (const a of argv) {
  n++
  out.push(a)
  if (n === at) out.push("--standalone")
}
run(out)
