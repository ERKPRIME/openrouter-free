// install.sh and uninstall.sh run for real against a temporary --dir and HOME, with an `opencode` on
// PATH that only reports a version.
import { test } from "node:test"
import type { TestContext } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { tempWithOpencode } from "./fixtures/fake-opencode.ts"

const SCRIPTS = fileURLToPath(new URL("../scripts/", import.meta.url))
const TEMPLATE = fs.readFileSync(new URL("../templates/free.jsonc", import.meta.url), "utf8")

function setup(t: TestContext, version = "opencode v2.0.32") {
  const root = tempWithOpencode(t, "free-router-scripts-", `#!/bin/sh\necho "${version}"\n`)
  fs.mkdirSync(path.join(root, "home"))
  return { root, dir: path.join(root, "install") }
}

// node is found next to this process's binary; opencode is the fake.
function script(name: string, root: string, args: string[]) {
  const path_ = [path.join(root, "bin"), path.dirname(process.execPath), "/usr/bin", "/bin"].join(":")
  return spawnSync("sh", [path.join(SCRIPTS, name), ...args], { encoding: "utf8", env: { PATH: path_, HOME: path.join(root, "home") } })
}
const install = (root: string, dir: string, ...extra: string[]) => script("install.sh", root, ["--dir", dir, "--no-rank", ...extra])
const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), "utf8")

test("install refuses opencode 1.x and a version it cannot read", (t) => {
  for (const version of ["1.19.3", "not a version"]) {
    const { root, dir } = setup(t, version)
    const r = install(root, dir)
    assert.equal(r.status, 1, version)
    assert.match(r.stderr, new RegExp(`${path.join(root, "bin", "opencode")} is opencode (${version}|of unknown version): opencode 2 or newer is required`))
    assert.equal(fs.existsSync(dir), false, "nothing is installed")
  }
})

test("a fresh install copies the plugin as a directory and writes the v2 config", (t) => {
  const { root, dir } = setup(t)
  const r = install(root, dir)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(dir, "plugin/index.ts"), fs.readFileSync(new URL("../src/plugin/index.ts", import.meta.url), "utf8"))
  for (const f of ["lib.mts", "rank.mts", "opencode-free", "free.jsonc", "config.json", "pins.json"]) assert.ok(fs.existsSync(path.join(dir, f)), f)
  assert.equal(read(dir, "free.jsonc"), TEMPLATE)
  assert.match(read(dir, "free.jsonc"), /^ {2}"plugins": \["\.\/plugin"\],$/m)
  assert.match(read(dir, "opencode-free"), /dir="\$\{FREE_ROUTER_DIR:-[^@]*\}"/, "install directory filled in")
})

test("an upgrade moves the old plugin entry, leaves comments and the rest alone, and removes the old code", (t) => {
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
  const r = install(root, dir)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /updated {2}.*free\.jsonc \(plugin -> plugins\)/)
  assert.equal(
    read(dir, "free.jsonc"),
    old.replace('  "plugin": ["./plugin.js"],', '  "plugins": ["./plugin"],'),
    "only the active entry changed",
  )
  for (const f of ["plugin.ts", "plugin.js", "lib.mjs", "rank.mjs"]) assert.equal(fs.existsSync(path.join(dir, f)), false, f)

  // Run again: nothing left to change.
  const again = install(root, dir)
  assert.equal(again.status, 0, again.stderr)
  assert.doesNotMatch(again.stdout, /updated {2}.*free\.jsonc/)
})

test("a free.jsonc that does not load the plugin directory fails the install with the edit to make", (t) => {
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
    if (ok) assert.equal(r.status, 0, `${what}: ${r.stderr}`)
    else {
      assert.equal(r.status, 1, what)
      assert.match(r.stderr, /does not load it: replace its "plugin" entry with "plugins": \["\.\/plugin"\] \(on one line, and move any other entries of the old array into it\), then run install\.sh again/, what)
    }
    assert.equal(read(dir, "free.jsonc"), config, `${what}: left as it was`)
  }
})

test("uninstall removes the plugin file and only an empty plugin directory", (t) => {
  const { root, dir } = setup(t)
  assert.equal(install(root, dir).status, 0)
  const r = script("uninstall.sh", root, ["--dir", dir])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fs.existsSync(path.join(dir, "plugin")), false)
  for (const f of ["lib.mts", "rank.mts", "opencode-free"]) assert.equal(fs.existsSync(path.join(dir, f)), false, f)
  for (const f of ["free.jsonc", "config.json", "pins.json"]) assert.ok(fs.existsSync(path.join(dir, f)), `${f} is kept`)

  // A plugin directory the user put files in stays, and so do the files.
  assert.equal(install(root, dir).status, 0)
  fs.writeFileSync(path.join(dir, "plugin", "mine.ts"), "mine")
  const keep = script("uninstall.sh", root, ["--dir", dir])
  assert.equal(keep.status, 0, keep.stderr)
  assert.equal(fs.existsSync(path.join(dir, "plugin", "index.ts")), false)
  assert.equal(read(dir, "plugin/mine.ts"), "mine")

  // And with no plugin directory at all.
  fs.rmSync(path.join(dir, "plugin"), { recursive: true })
  assert.equal(script("uninstall.sh", root, ["--dir", dir]).status, 0)
})
