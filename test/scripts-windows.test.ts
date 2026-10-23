// The native Windows install/update/uninstall scripts, run for real against temporary directories and
// a fake opencode on PATH. Every test isolates install, shim and user paths, and none of them writes
// the machine's user PATH: they use -NoPath, or -NoPathUpdate with -ShimDir.
import { test } from "node:test"
import type { TestContext } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { tempWithOpencode } from "./fixtures/fake-opencode.ts"

const WINDOWS_ONLY = process.platform === "win32" ? false : "the PowerShell scripts are Windows-only"
const SCRIPTS = fileURLToPath(new URL("../scripts/", import.meta.url))
const TEMPLATE = fs.readFileSync(new URL("../templates/free.jsonc", import.meta.url), "utf8")
const SYSTEM32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")
const POWERSHELL = path.join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe")
const NODE_DIR = path.dirname(process.execPath)
const COMSPEC = process.env.ComSpec ?? "cmd.exe"

interface EnvOptions {
  node?: boolean
  pathPrefix?: string[]
  extra?: NodeJS.ProcessEnv
}

function envFor(root: string, options: EnvOptions = {}) {
  const parts = [...(options.pathPrefix ?? []), path.join(root, "bin")]
  if (options.node !== false) parts.push(NODE_DIR)
  parts.push(SYSTEM32, path.dirname(POWERSHELL))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.extra,
    PATH: parts.join(path.delimiter),
    USERPROFILE: path.join(root, "home"),
    HOME: path.join(root, "home"),
  }
  // The developer shell has FREE_ROUTER_DIR/OPENCODE_CONFIG pointing at a real install. Never let a
  // test inherit them: the launcher would read the real configuration instead of the temp one.
  if (!options.extra?.FREE_ROUTER_DIR) delete env.FREE_ROUTER_DIR
  if (!options.extra?.OPENCODE_CONFIG) delete env.OPENCODE_CONFIG
  return env
}

function setup(t: TestContext, version = "2.0.32") {
  const root = tempWithOpencode(t, "free-router-scripts-win-", "#!/bin/sh\nexit 1\n", `@echo off\r\necho opencode v${version}\r\nexit /b 0\r\n`)
  fs.mkdirSync(path.join(root, "home"))
  return { root, dir: path.join(root, "install"), shim: path.join(root, "shim") }
}

// A fake opencode that also records the argv the launcher passes for `run`.
function recordingSetup(t: TestContext) {
  const root = tempWithOpencode(
    t,
    "free-router-record-win-",
    "#!/bin/sh\nexit 1\n",
    `@echo off\r
if "%~1"=="--version" (\r
  echo opencode v2.0.32\r
  exit /b 0\r
)\r
if "%~1"=="acp" (\r
  echo boom 1>&2\r
  exit /b 7\r
)\r
"${process.execPath}" "%~dp0record.mjs" %*\r
exit /b %errorlevel%\r
`,
  )
  fs.writeFileSync(
    path.join(root, "bin", "record.mjs"),
    `import fs from "node:fs"\nimport path from "node:path"\nconst dir = process.env.FREE_ROUTER_DIR\nif (!dir) { process.stderr.write("FREE_ROUTER_DIR missing\\n"); process.exit(9) }\nfs.writeFileSync(path.join(dir, "opencode-args.json"), JSON.stringify(process.argv.slice(2)))\n`,
  )
  fs.mkdirSync(path.join(root, "home"))
  return { root, dir: path.join(root, "install"), shim: path.join(root, "shim") }
}

function script(name: string, root: string, args: string[], options: EnvOptions = {}) {
  return spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(SCRIPTS, name), ...args], {
    encoding: "utf8",
    cwd: root,
    env: envFor(root, options),
  })
}

function quoteWord(word: string) {
  return `"${word}"`
}

function cmdScript(name: string, root: string, args: string[], options: EnvOptions = {}) {
  const command = [path.join(SCRIPTS, name), ...args].map(quoteWord).join(" ")
  return spawnSync(COMSPEC, ["/d", "/v:off", "/s", "/c", `"${command}"`], {
    encoding: "utf8",
    cwd: root,
    windowsVerbatimArguments: true,
    env: envFor(root, options),
  })
}

function runShim(shim: string, args: string[], root: string, options: EnvOptions = {}) {
  const command = [path.join(shim, "opencode-free.cmd"), ...args].map(quoteWord).join(" ")
  return spawnSync(COMSPEC, ["/d", "/v:off", "/s", "/c", `"${command}"`], {
    encoding: "utf8",
    cwd: root,
    windowsVerbatimArguments: true,
    env: envFor(root, options),
  })
}

function freshPowerShell(root: string, pathPrefix: string[], command: string, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    encoding: "utf8",
    cwd: root,
    env: envFor(root, { pathPrefix, extra }),
  })
}

const install = (root: string, dir: string, ...extra: string[]) =>
  script("install-windows.ps1", root, ["-InstallDir", dir, "-NoRank", "-NoPath", ...extra])
const installShim = (root: string, dir: string, shim: string, ...extra: string[]) =>
  script("install-windows.ps1", root, ["-InstallDir", dir, "-ShimDir", shim, "-NoRank", "-NoPathUpdate", ...extra])
const uninstall = (root: string, dir: string, ...extra: string[]) =>
  script("uninstall-windows.ps1", root, ["-InstallDir", dir, "-NoPath", ...extra])
const uninstallShim = (root: string, dir: string, shim: string, ...extra: string[]) =>
  script("uninstall-windows.ps1", root, ["-InstallDir", dir, "-ShimDir", shim, ...extra])
const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), "utf8")
const normal = (s: string | null) => (s ?? "").replace(/\r\n/g, "\n")

const USER_FILES = ["free.jsonc", "config.json", "pins.json", "providers.env", "ranker.env", "ranking.json", "state.json", "notes.txt"]

function snapshot(dir: string) {
  const out: Record<string, string> = {}
  for (const name of USER_FILES) {
    const file = path.join(dir, name)
    if (fs.existsSync(file)) out[name] = fs.readFileSync(file, "utf8")
  }
  return out
}

function assertSnapshot(dir: string, before: Record<string, string>, label: string) {
  for (const [name, content] of Object.entries(before)) {
    assert.equal(read(dir, name), content, `${label}: ${name} is unchanged`)
  }
}

test("Add-FrontOfPath moves the shim to the front without corrupting separators", { skip: WINDOWS_ONLY }, () => {
  const helper = path.join(SCRIPTS, "windows-path.ps1").replace(/'/g, "''")
  const cases: Array<[pathValue: string, directory: string, expected: string]> = [
    ["C:\\A;C:\\B;C:\\C", "C:\\B", "C:\\B;C:\\A;C:\\C"],
    ["C:\\A;C:\\B", "C:\\B", "C:\\B;C:\\A"],
    ["C:\\Program Files\\A;C:\\Users\\Me", "C:\\Users\\Me", "C:\\Users\\Me;C:\\Program Files\\A"],
    ["C:\\Users\\Me;C:\\A", "C:\\Users\\Me", "C:\\Users\\Me;C:\\A"],
    ["", "C:\\Users\\Me", "C:\\Users\\Me"],
    ["C:\\A;C:\\A;C:\\B", "C:\\A", "C:\\A;C:\\B"],
  ]
  for (const [pathValue, directory, expected] of cases) {
    const command = `. '${helper}'; Add-FrontOfPath -PathValue '${pathValue}' -Directory '${directory}'`
    const r = spawnSync(POWERSHELL, ["-NoLogo", "-NoProfile", "-Command", command], { encoding: "utf8" })
    assert.equal(r.status, 0, normal(r.stderr))
    assert.equal(normal(r.stdout).trim(), expected)
  }
})

test("install-windows refuses OpenCode 1.x and a version it cannot read", { skip: WINDOWS_ONLY }, (t) => {
  for (const version of ["1.19.3", "not a version"]) {
    const { root, dir } = setup(t, version)
    const r = install(root, dir)
    assert.equal(r.status, 1, version)
    assert.match(normal(r.stderr), new RegExp(`opencode\\.cmd is opencode (${version}|of unknown version): opencode 2 or newer is required`))
    assert.equal(fs.existsSync(dir), false, "nothing is installed")
  }
})

test("install-windows refuses a missing OpenCode and a PATH without Node", { skip: WINDOWS_ONLY }, (t) => {
  const missingOpenCode = setup(t)
  fs.rmSync(path.join(missingOpenCode.root, "bin"), { recursive: true, force: true })
  const noOpenCode = install(missingOpenCode.root, missingOpenCode.dir)
  assert.equal(noOpenCode.status, 1)
  assert.match(normal(noOpenCode.stderr), /install-windows: OpenCode is not on PATH/)
  assert.equal(fs.existsSync(missingOpenCode.dir), false)

  const missingNode = setup(t)
  const noNode = script("install-windows.ps1", missingNode.root, ["-InstallDir", missingNode.dir, "-NoRank", "-NoPath"], { node: false })
  assert.equal(noNode.status, 1)
  assert.match(normal(noNode.stderr), /install-windows: Node\.js is not on PATH/)
  assert.equal(fs.existsSync(missingNode.dir), false)
})

test("install-windows copies the plugin and launchers and writes the v2 config", { skip: WINDOWS_ONLY }, (t) => {
  const { root, dir } = setup(t)
  const r = install(root, dir)
  assert.equal(r.status, 0, normal(r.stderr))
  assert.equal(read(dir, "plugin/index.ts"), fs.readFileSync(new URL("../src/plugin/index.ts", import.meta.url), "utf8"))
  for (const f of ["lib.mts", "rank.mts", "opencode-free-launcher.ps1", "opencode-free.cmd", "free.jsonc", "config.json", "pins.json", "providers.env", "ranker.env"]) {
    assert.ok(fs.existsSync(path.join(dir, f)), f)
  }
  assert.equal(read(dir, "free.jsonc"), TEMPLATE)
  assert.match(read(dir, "free.jsonc"), /^ {2}"plugins": \["\.\/plugin"\],$/m)
  assert.match(read(dir, "opencode-free-launcher.ps1"), /@FREE_ROUTER_DIR@|free-router-scripts-win-/, "install directory filled in")
  assert.equal(read(dir, "opencode-free-launcher.ps1").charCodeAt(0), 0xfeff, "the rendered PowerShell launcher is UTF-8 with BOM")
  assert.equal(read(dir, "opencode-free.cmd"), fs.readFileSync(new URL("../bin/opencode-free.cmd", import.meta.url), "utf8"), "the shim is the versioned relative shim")
  assert.match(read(dir, "opencode-free.cmd"), /%~dp0opencode-free-launcher\.ps1/)
})

test("install-windows works in paths with spaces and non-ASCII characters", { skip: WINDOWS_ONLY }, (t) => {
  for (const [label, dirName, shimName] of [
    ["spaces", "install dir with spaces", "shim dir with spaces"],
    ["non-ASCII", "instalación ñandú con espacios", "shim ñandú con espacios"],
  ] as const) {
    const { root } = setup(t)
    const dir = path.join(root, dirName)
    const shim = path.join(root, shimName, "bin")
    const r = installShim(root, dir, shim)
    assert.equal(r.status, 0, `${label}: ${normal(r.stderr)}`)
    assert.ok(fs.existsSync(path.join(shim, "opencode-free.cmd")), `${label}: shim was installed`)
    assert.ok(fs.existsSync(path.join(shim, "opencode-free-launcher.ps1")), `${label}: launcher companion was installed`)

    const version = runShim(shim, ["--version"], root)
    assert.equal(version.status, 0, `${label}: ${normal(version.stderr)}`)
    assert.match(normal(version.stdout), /^opencode v2\.0\.32$/m, label)
    const models = runShim(shim, ["--list-models"], root)
    assert.equal(models.status, 0, `${label}: ${normal(models.stderr)}`)
    assert.equal(normal(models.stdout), "free/auto\n", label)
  }
})

test("install-windows is idempotent and never overwrites user files", { skip: WINDOWS_ONLY }, (t) => {
  const { root, dir } = setup(t)
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "free.jsonc"), TEMPLATE)
  fs.writeFileSync(path.join(dir, "config.json"), '{"minContext":12345}\n')
  fs.writeFileSync(path.join(dir, "pins.json"), '{"pin":["a/b"]}\n')
  fs.writeFileSync(path.join(dir, "providers.env"), "GROQ_API_KEY=user-value\n")
  fs.writeFileSync(path.join(dir, "ranker.env"), "ARTIFICIAL_ANALYSIS_API_KEY=user-value\n")
  fs.writeFileSync(path.join(dir, "ranking.json"), '{"models":[]}\n')
  fs.writeFileSync(path.join(dir, "state.json"), '{"cooldowns":{}}\n')
  fs.writeFileSync(path.join(dir, "notes.txt"), "keep me\n")
  const before = snapshot(dir)

  const first = install(root, dir)
  assert.equal(first.status, 0, normal(first.stderr))
  assertSnapshot(dir, before, "first install")
  const installed = {
    plugin: read(dir, "plugin/index.ts"),
    lib: read(dir, "lib.mts"),
    rank: read(dir, "rank.mts"),
    ps1: read(dir, "opencode-free-launcher.ps1"),
    cmd: read(dir, "opencode-free.cmd"),
  }

  const second = install(root, dir)
  assert.equal(second.status, 0, normal(second.stderr))
  assertSnapshot(dir, before, "second install")
  assert.equal(read(dir, "plugin/index.ts"), installed.plugin)
  assert.equal(read(dir, "lib.mts"), installed.lib)
  assert.equal(read(dir, "rank.mts"), installed.rank)
  assert.equal(read(dir, "opencode-free-launcher.ps1"), installed.ps1)
  assert.equal(read(dir, "opencode-free.cmd"), installed.cmd)
  assert.doesNotMatch(normal(second.stdout), /updated {2}.*free\.jsonc/)
})

test("install-windows upgrades a POSIX-oriented layout and preserves user files", { skip: WINDOWS_ONLY }, (t) => {
  const { root, dir } = setup(t)
  fs.mkdirSync(dir)
  for (const f of ["plugin.ts", "plugin.js", "lib.mjs", "rank.mjs"]) fs.writeFileSync(path.join(dir, f), "old")
  const old = `{
  // "plugin": ["./plugin.ts"] was the entry before opencode 2
    // "plugin": ["./plugin.js"],
  "plugin": ["./plugin.js"],
  "model": "free/auto",
  "provider": { "free": {} }
}
`
  fs.writeFileSync(path.join(dir, "free.jsonc"), old)
  fs.writeFileSync(path.join(dir, "config.json"), '{"minContext":777}\n')
  fs.writeFileSync(path.join(dir, "pins.json"), '{"ban":["x/y"]}\n')
  fs.writeFileSync(path.join(dir, "providers.env"), "OPENROUTER_API_KEY=user-value\n")
  fs.writeFileSync(path.join(dir, "ranker.env"), "CUSTOM=user-value\n")
  fs.writeFileSync(path.join(dir, "ranking.json"), '{"models":[{"id":"a/b"}]}\n')
  fs.writeFileSync(path.join(dir, "state.json"), '{"sessions":{}}\n')
  const before = snapshot(dir)

  const r = install(root, dir)
  assert.equal(r.status, 0, normal(r.stderr))
  assert.match(normal(r.stdout), /updated {2}.*free\.jsonc \(plugin -> plugins\)/)
  assert.equal(read(dir, "free.jsonc"), old.replace('  "plugin": ["./plugin.js"],', '  "plugins": ["./plugin"],'), "only the active entry changed")
  assertSnapshot(dir, Object.fromEntries(Object.entries(before).filter(([name]) => name !== "free.jsonc")), "upgrade")
  for (const f of ["plugin.ts", "plugin.js", "lib.mjs", "rank.mjs"]) assert.equal(fs.existsSync(path.join(dir, f)), false, f)
  assert.ok(fs.existsSync(path.join(dir, "plugin", "index.ts")))

  const again = install(root, dir)
  assert.equal(again.status, 0, normal(again.stderr))
  assert.doesNotMatch(normal(again.stdout), /updated {2}.*free\.jsonc/)
})

test("install-windows rejects a free.jsonc that does not load the plugin directory", { skip: WINDOWS_ONLY }, (t) => {
  const cases: Record<string, [config: string, ok: boolean]> = {
    "an active plugins entry beside an indented commented old line": ['{\n    // "plugin": ["./plugin.ts"],\n  "plugins": ["./plugin"]\n}\n', true],
    "other plugins next to it": ['{ "plugins": ["other", "./plugin"] }\n', true],
    "only an indented commented old line": ['{\n    // "plugin": ["./plugin.ts"],\n  "model": "free/auto"\n}\n', false],
    "a multi-line plugin array": ['{\n  "plugin": [\n    "./plugin.ts"\n  ]\n}\n', false],
    "an old entry next to the new one": ['{ "plugin": ["./other"], "plugins": ["./plugin"] }\n', false],
  }
  for (const [what, [config, ok]] of Object.entries(cases)) {
    const { root, dir } = setup(t)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, "free.jsonc"), config)
    const r = install(root, dir)
    if (ok) assert.equal(r.status, 0, `${what}: ${normal(r.stderr)}`)
    else {
      assert.equal(r.status, 1, what)
      assert.match(normal(r.stderr), /does not load it: replace its "plugin" entry with "plugins": \["\.\/plugin"\] \(on one line, and move any other entries of the old array into it\), then run install-windows\.ps1 again/, what)
      assert.doesNotMatch(normal(r.stdout), /Installed to:/, `${what}: no misleading success`)
    }
    assert.equal(read(dir, "free.jsonc"), config, `${what}: left as it was`)
  }
})

test("install-windows reports a filesystem failure without a success message", { skip: WINDOWS_ONLY }, (t) => {
  const { root, dir } = setup(t)
  fs.writeFileSync(dir, "not a directory")
  const r = install(root, dir)
  assert.equal(r.status, 1)
  assert.match(normal(r.stderr), /install-windows:/)
  assert.doesNotMatch(normal(r.stdout), /Installed to:/)
  assert.equal(fs.readFileSync(dir, "utf8"), "not a directory")
})

test("the .cmd installers forward arguments and exit codes", { skip: WINDOWS_ONLY }, (t) => {
  const { root, dir } = setup(t)
  const r = cmdScript("install-windows.cmd", root, ["-InstallDir", dir, "-NoRank", "-NoPath"])
  assert.equal(r.status, 0, normal(r.stderr))
  assert.ok(fs.existsSync(path.join(dir, "opencode-free.cmd")))

  const bad = setup(t, "1.19.3")
  const refused = cmdScript("install-windows.cmd", bad.root, ["-InstallDir", bad.dir, "-NoRank", "-NoPath"])
  assert.equal(refused.status, 1, normal(refused.stderr))
  assert.match(normal(refused.stderr), /opencode\.cmd is opencode 1\.19\.3: opencode 2 or newer is required/)

  const u = cmdScript("uninstall-windows.cmd", root, ["-InstallDir", dir, "-NoPath"])
  assert.equal(u.status, 0, normal(u.stderr))
  assert.equal(fs.existsSync(path.join(dir, "plugin")), false)
})

test("uninstall-windows removes code and preserves user files, state and unrelated files", { skip: WINDOWS_ONLY }, (t) => {
  const { root, dir } = setup(t)
  assert.equal(install(root, dir).status, 0)
  fs.writeFileSync(path.join(dir, "config.json"), '{"minContext":999}\n')
  fs.writeFileSync(path.join(dir, "pins.json"), '{"pin":["a/b"]}\n')
  fs.writeFileSync(path.join(dir, "providers.env"), "GROQ_API_KEY=user-value\n")
  fs.writeFileSync(path.join(dir, "ranker.env"), "CUSTOM=user-value\n")
  fs.writeFileSync(path.join(dir, "ranking.json"), '{"models":[]}\n')
  fs.writeFileSync(path.join(dir, "state.json"), '{"cooldowns":{}}\n')
  fs.writeFileSync(path.join(dir, "notes.txt"), "keep me\n")
  const before = snapshot(dir)

  const r = uninstall(root, dir)
  assert.equal(r.status, 0, normal(r.stderr))
  assert.equal(fs.existsSync(path.join(dir, "plugin")), false)
  for (const f of ["lib.mts", "rank.mts", "opencode-free-launcher.ps1", "opencode-free.cmd"]) assert.equal(fs.existsSync(path.join(dir, f)), false, f)
  for (const f of ["free.jsonc", "config.json", "pins.json", "providers.env", "ranker.env", "ranking.json", "state.json", "notes.txt"]) assert.ok(fs.existsSync(path.join(dir, f)), `${f} is kept`)
  assertSnapshot(dir, before, "normal uninstall")

  assert.equal(install(root, dir).status, 0)
  fs.writeFileSync(path.join(dir, "plugin", "mine.ts"), "mine")
  const keep = uninstall(root, dir)
  assert.equal(keep.status, 0, normal(keep.stderr))
  assert.equal(fs.existsSync(path.join(dir, "plugin", "index.ts")), false)
  assert.equal(read(dir, "plugin/mine.ts"), "mine")
})

test("uninstall-windows -Purge deletes only the selected install directory", { skip: WINDOWS_ONLY }, (t) => {
  const { root, dir } = setup(t)
  assert.equal(install(root, dir).status, 0)
  fs.writeFileSync(path.join(dir, "ranking.json"), '{"models":[]}\n')
  fs.writeFileSync(path.join(dir, "state.json"), '{"cooldowns":{}}\n')
  const keep = path.join(root, "keep")
  fs.mkdirSync(keep)
  fs.writeFileSync(path.join(keep, "unrelated.txt"), "keep\n")

  const r = uninstall(root, dir, "-Purge")
  assert.equal(r.status, 0, normal(r.stderr))
  assert.equal(fs.existsSync(dir), false)
  assert.equal(read(keep, "unrelated.txt"), "keep\n")

  const again = uninstall(root, dir, "-Purge")
  assert.equal(again.status, 0, normal(again.stderr))
  assert.match(normal(again.stdout), /was not installed/)
})

test("install-windows writes an install marker and refuses unrelated non-empty directories", { skip: WINDOWS_ONLY }, (t) => {
  const { root, dir } = setup(t)
  const r = install(root, dir)
  assert.equal(r.status, 0, normal(r.stderr))
  const marker = JSON.parse(read(dir, ".opencode-free-router.json"))
  assert.equal(marker.name, "opencode-free-router")
  assert.equal(marker.format, 1)
  assert.equal(marker.complete, true)
  assert.equal(marker.version, JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version)
  assert.equal(marker.installDir.toLowerCase(), dir.toLowerCase())

  const foreign = path.join(root, "foreign")
  fs.mkdirSync(foreign)
  fs.writeFileSync(path.join(foreign, "unrelated.txt"), "keep\n")
  const refused = install(root, foreign)
  assert.equal(refused.status, 1)
  assert.match(normal(refused.stderr), /refuses a non-empty directory that is not an opencode-free-router install/)
  assert.equal(read(foreign, "unrelated.txt"), "keep\n")
  assert.equal(fs.existsSync(path.join(foreign, ".opencode-free-router.json")), false)

  // The default guard also refuses operating-system locations outright.
  const system = install(root, process.env.SystemRoot ?? "C:\\Windows")
  assert.equal(system.status, 1)
  assert.match(normal(system.stderr), /refuses a protected directory|refuses a shared system directory/)
})

test("install-windows refuses a junction for -InstallDir without writing through it", { skip: WINDOWS_ONLY }, (t) => {
  const { root } = setup(t)
  const target = path.join(root, "target")
  const link = path.join(root, "junction")
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, "sentinel.txt"), "untouched\n")
  const made = spawnSync(COMSPEC, ["/d", "/c", "mklink", "/J", link, target], { encoding: "utf8", windowsVerbatimArguments: true })
  if (made.status !== 0) {
    t.skip("this filesystem cannot create junctions")
    return
  }
  const r = install(root, link)
  assert.equal(r.status, 1)
  assert.match(normal(r.stderr), /refuses a symbolic link or junction/)
  assert.equal(read(target, "sentinel.txt"), "untouched\n")
  assert.equal(fs.existsSync(path.join(target, ".opencode-free-router.json")), false)
  fs.rmdirSync(link)
})

test("uninstall-windows -Purge requires a valid marker and -Force for legacy installs", { skip: WINDOWS_ONLY }, (t) => {
  const { root, dir } = setup(t)
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "free.jsonc"), TEMPLATE)
  fs.writeFileSync(path.join(dir, "unrelated.txt"), "keep\n")
  const sibling = path.join(root, "sibling")
  fs.mkdirSync(sibling)
  fs.writeFileSync(path.join(sibling, "sentinel.txt"), "keep\n")

  const refused = uninstall(root, dir, "-Purge")
  assert.equal(refused.status, 1)
  assert.match(normal(refused.stderr), /refuses to purge a directory without a valid opencode-free-router marker/)
  assert.equal(read(dir, "unrelated.txt"), "keep\n")

  // A marker moved from another install must not authorise a purge here.
  const markerPath = path.join(dir, ".opencode-free-router.json")
  fs.writeFileSync(markerPath, JSON.stringify({ name: "opencode-free-router", format: 1, version: "0.0.0", installDir: sibling, complete: true }))
  const foreignMarker = uninstall(root, dir, "-Purge")
  assert.equal(foreignMarker.status, 1)
  assert.equal(read(dir, "unrelated.txt"), "keep\n")

  // A corrupt marker is ignored too.
  fs.writeFileSync(markerPath, "{not json")
  const corrupt = uninstall(root, dir, "-Purge")
  assert.equal(corrupt.status, 1)
  assert.equal(read(dir, "unrelated.txt"), "keep\n")

  // -Force is the explicit escape hatch for marker-less legacy installs.
  fs.rmSync(markerPath)
  const forced = uninstall(root, dir, "-Purge", "-Force")
  assert.equal(forced.status, 0, normal(forced.stderr))
  assert.match(normal(forced.stdout) + normal(forced.stderr), /purging without an install marker because -Force was given/)
  assert.equal(fs.existsSync(dir), false)
  assert.equal(read(sibling, "sentinel.txt"), "keep\n")
})

test("uninstall-windows -Purge removes an interrupted install and leaves no marker behind", { skip: WINDOWS_ONLY }, (t) => {
  const { root, dir } = setup(t)
  assert.equal(install(root, dir).status, 0)
  const markerPath = path.join(dir, ".opencode-free-router.json")
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"))
  marker.complete = false
  fs.writeFileSync(markerPath, JSON.stringify(marker))
  const r = uninstall(root, dir, "-Purge")
  assert.equal(r.status, 0, normal(r.stderr))
  assert.match(normal(r.stdout) + normal(r.stderr), /did not complete/)
  assert.equal(fs.existsSync(dir), false)
})

test("uninstall-windows does not remove files from a directory that is not a router install", { skip: WINDOWS_ONLY }, (t) => {
  const { root } = setup(t)
  const dir = path.join(root, "not-router")
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "notes.txt"), "keep\n")
  const r = uninstall(root, dir)
  assert.equal(r.status, 0, normal(r.stderr))
  assert.match(normal(r.stdout), /does not look like an opencode-free-router install; nothing removed/)
  assert.equal(read(dir, "notes.txt"), "keep\n")
})

test("install-windows restricts key files to the current user, SYSTEM and Administrators", { skip: WINDOWS_ONLY }, (t) => {
  const { root, dir } = setup(t)
  const r = install(root, dir)
  assert.equal(r.status, 0, normal(r.stderr))
  if (/could not restrict permissions/.test(normal(r.stderr))) {
    t.skip("this filesystem does not support ACLs")
    return
  }
  const quote = (value: string) => value.replace(/'/g, "''")
  const command = [
    `$paths = @('${quote(dir)}', '${quote(path.join(dir, "providers.env"))}', '${quote(path.join(dir, "ranker.env"))}')`,
    '"SELF=" + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    'foreach ($p in $paths) {',
    '  $acl = Get-Acl -LiteralPath $p',
    '  "PATH=" + $p',
    '  "PROTECTED=" + $acl.AreAccessRulesProtected',
    '  foreach ($rule in $acl.Access) { "RULE=" + $rule.AccessControlType + ":" + $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }',
    '}',
  ].join("\n")
  const acl = freshPowerShell(root, [], command)
  assert.equal(acl.status, 0, normal(acl.stderr))
  const text = normal(acl.stdout)
  const self = /^SELF=(S-1-[\d-]+)$/m.exec(text)?.[1]
  assert.ok(self, text)
  const allowed = new Set([self, "S-1-5-18", "S-1-5-32-544"])
  assert.equal((text.match(/^PROTECTED=True$/gm) ?? []).length, 3, text)
  const rules = [...text.matchAll(/^RULE=(\w+):(S-1-[\d-]+)$/gm)]
  assert.equal(rules.length, 9, text)
  for (const [, kind, sid] of rules) {
    assert.ok(kind && sid, text)
    assert.equal(kind, "Allow", text)
    assert.ok(allowed.has(sid), `unexpected identity ${sid} in ${text}`)
  }
})

test("install-windows leaves an already-correct protected ACL alone instead of warning", { skip: WINDOWS_ONLY }, (t) => {
  const { root, dir } = setup(t)
  const first = install(root, dir)
  assert.equal(first.status, 0, normal(first.stderr))
  if (/could not restrict permissions/.test(normal(first.stderr))) {
    t.skip("this filesystem does not support ACLs")
    return
  }
  const second = install(root, dir)
  assert.equal(second.status, 0, normal(second.stderr))
  assert.doesNotMatch(normal(second.stderr), /could not restrict permissions/)
})

test("uninstall-windows only removes a shim that belongs to this install", { skip: WINDOWS_ONLY }, (t) => {
  const { root, dir, shim } = setup(t)
  assert.equal(installShim(root, dir, shim).status, 0)
  assert.ok(fs.existsSync(path.join(shim, "opencode-free-launcher.ps1")))
  assert.ok(fs.existsSync(path.join(shim, "opencode-free.cmd")))

  // A foreign shim, or one left by a different install, must survive.
  fs.writeFileSync(path.join(shim, "opencode-free-launcher.ps1"), "another install\n")
  const foreign = uninstallShim(root, dir, shim)
  assert.equal(foreign.status, 0, normal(foreign.stderr))
  assert.equal(read(shim, "opencode-free-launcher.ps1"), "another install\n")
  assert.ok(fs.existsSync(path.join(shim, "opencode-free.cmd")))

  // A real install owns and removes both files.
  assert.equal(installShim(root, dir, shim).status, 0)
  const owned = uninstallShim(root, dir, shim)
  assert.equal(owned.status, 0, normal(owned.stderr))
  assert.equal(fs.existsSync(path.join(shim, "opencode-free-launcher.ps1")), false)
  assert.equal(fs.existsSync(path.join(shim, "opencode-free.cmd")), false)

  // Older shims embedded the install directory in the .cmd and had no companion .ps1.
  assert.equal(installShim(root, dir, shim).status, 0)
  fs.rmSync(path.join(shim, "opencode-free-launcher.ps1"))
  fs.writeFileSync(path.join(shim, "opencode-free.cmd"), `@echo off\r\npowershell.exe -File "${path.join(dir, "opencode-free.ps1")}" %*\r\n`)
  const legacy = uninstallShim(root, dir, shim)
  assert.equal(legacy.status, 0, normal(legacy.stderr))
  assert.equal(fs.existsSync(path.join(shim, "opencode-free.cmd")), false)
})

test("install-windows migrates the first Windows shim layout", { skip: WINDOWS_ONLY }, (t) => {
  const { root, dir, shim } = setup(t)
  fs.mkdirSync(shim)
  const legacy = fs.readFileSync(new URL("../bin/opencode-free.ps1", import.meta.url), "utf8").replaceAll("@FREE_ROUTER_DIR@", dir)
  fs.writeFileSync(path.join(shim, "opencode-free.ps1"), legacy)
  const r = installShim(root, dir, shim)
  assert.equal(r.status, 0, normal(r.stderr))
  assert.equal(fs.existsSync(path.join(shim, "opencode-free.ps1")), false, "legacy .ps1 is gone")
  assert.ok(fs.existsSync(path.join(shim, "opencode-free-launcher.ps1")))
  assert.ok(fs.existsSync(path.join(shim, "opencode-free.cmd")))
})

test("uninstall-windows reports a failure instead of a successful uninstall", { skip: WINDOWS_ONLY }, (t) => {
  const { root } = setup(t)
  const r = script("uninstall-windows.ps1", root, ["-InstallDir", "", "-NoPath"])
  assert.equal(r.status, 1)
  assert.match(normal(r.stderr), /uninstall-windows:/)
  assert.doesNotMatch(normal(r.stdout), /removed code|removed /)
})

test("fresh PowerShell resolves opencode-free to the router shim and keeps opencode usable", { skip: WINDOWS_ONLY }, (t) => {
  const { root, dir, shim } = recordingSetup(t)
  assert.equal(installShim(root, dir, shim).status, 0)
  const other = path.join(root, "other")
  fs.mkdirSync(other)
  fs.writeFileSync(path.join(other, "opencode-free.cmd"), "@echo off\r\necho other\r\n")

  const command = [
    '$before = $env:FREE_ROUTER_DIR',
    '$sentinel = $env:OPENCODE_CONFIG',
    '$free = @(Get-Command opencode-free -All | ForEach-Object { $_.Source })',
    '$open = @(Get-Command opencode -All | ForEach-Object { $_.Source })',
    '& opencode --version',
    '& opencode-free --version',
    '& opencode-free --list-models',
    '& opencode-free run "hello world" -- message',
    '$runCode = $LASTEXITCODE',
    '& opencode-free acp',
    '$failCode = $LASTEXITCODE',
    '& opencode --version',
    '"FREE=" + ($free -join ";")',
    '"OPEN=" + ($open -join ";")',
    '"RUN=$runCode"',
    '"FAIL=$failCode"',
    '"CONFIG_UNCHANGED=" + ($env:OPENCODE_CONFIG -eq $sentinel)',
    '"DIR_UNCHANGED=" + ($env:FREE_ROUTER_DIR -eq $before)',
  ].join("\n")

  const r = freshPowerShell(root, [shim, other], command, { OPENCODE_CONFIG: "C:\\sentinel\\config.json" })
  assert.equal(r.status, 0, normal(r.stderr))
  assert.match(normal(r.stdout), /^opencode v2\.0\.32$/m)
  assert.match(normal(r.stdout), /^free\/auto$/m)
  assert.match(normal(r.stdout), new RegExp(`^FREE=${shim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"), "shim comes first on PATH")
  assert.match(normal(r.stdout), /^OPEN=.*opencode\.cmd/m)
  assert.match(normal(r.stdout), /^RUN=0$/m)
  assert.match(normal(r.stdout), /^FAIL=7$/m, "exit code is forwarded")
  assert.match(normal(r.stdout), /^CONFIG_UNCHANGED=True$/m)
  assert.match(normal(r.stdout), /^DIR_UNCHANGED=True$/m)
  assert.match(normal(r.stderr), /boom/, "stderr is forwarded")

  assert.deepEqual(JSON.parse(read(dir, "opencode-args.json")), ["run", "--standalone", "hello world", "--", "message"])
})

test("the installed shim fails clearly when its .ps1 is missing or the install moved", { skip: WINDOWS_ONLY }, (t) => {
  const { root, dir, shim } = setup(t)
  assert.equal(installShim(root, dir, shim).status, 0)
  fs.rmSync(path.join(shim, "opencode-free-launcher.ps1"))
  const missing = runShim(shim, ["--version"], root)
  assert.notEqual(missing.status, 0)
  assert.doesNotMatch(normal(missing.stdout), /opencode v2/)

  assert.equal(installShim(root, dir, shim).status, 0)
  const moved = path.join(root, "moved")
  fs.renameSync(dir, moved)
  const stale = runShim(shim, ["--version"], root)
  assert.notEqual(stale.status, 0)
  assert.match(normal(stale.stderr), /opencode-free: .*free\.jsonc not found/)
})
