// bin/opencode-free decides which opencode command line to run, so these tests run it for real
// against an `opencode` on PATH that only records what it was started with.
import { test } from "node:test"
import type { TestContext } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { tempWithOpencode } from "./fixtures/fake-opencode.ts"

const LAUNCHER = fileURLToPath(new URL("../bin/opencode-free", import.meta.url))

const FAKE_OPENCODE = `#!/bin/sh
{
  printf '%s\\n' "$OPENCODE_CONFIG" "$FREE_ROUTER_DIR" "\${FOO_KEY:-}"
  for a; do printf '%s\\n' "$a"; done
} > "$FREE_ROUTER_DIR/started"
`

function setup(t: TestContext) {
  const dir = tempWithOpencode(t, "free-router-launcher-", FAKE_OPENCODE)
  fs.writeFileSync(path.join(dir, "free.jsonc"), "{}\n")
  fs.writeFileSync(path.join(dir, "providers.env"), "FOO_KEY=abc\n")
  return dir
}

function launch(dir: string, args: string[]) {
  const started = path.join(dir, "started")
  fs.rmSync(started, { force: true })
  const r = spawnSync("sh", [LAUNCHER, ...args], { encoding: "utf8", env: { PATH: `${path.join(dir, "bin")}:/usr/bin:/bin`, FREE_ROUTER_DIR: dir } })
  const lines = fs.existsSync(started) ? fs.readFileSync(started, "utf8").split("\n").slice(0, -1) : undefined
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, started: lines, argv: lines?.slice(3) }
}

// Every opencode command line the launcher is meant to produce. --standalone is what makes opencode
// run the router's own config; it goes after a command that has one and before everything else.
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
  // A group without its command still runs standalone, and the command takes the flag when it follows.
  [["session"], ["session", "--standalone"]],
  [["auth"], ["auth", "--standalone"]],
  // These start their own server, which reads OPENCODE_CONFIG itself.
  [["acp"], ["acp"]],
  [["serve", "--port", "1"], ["serve", "--port", "1"]],
  [["-h"], ["-h"]],
  [["--version"], ["--version"]],
  // opencode itself rejects a word that is no command and no directory (it exits 1).
  [["runn", "hello"], ["--standalone", "runn", "hello"]],
]

test("each command line gets --standalone where opencode takes it", (t) => {
  const dir = setup(t)
  for (const [args, argv] of RUNS) {
    const r = launch(dir, args)
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`)
    assert.deepEqual(r.argv, argv, args.join(" "))
  }
})

test("opencode starts with the router's config and the provider keys", (t) => {
  const dir = setup(t)
  const r = launch(dir, ["run", "x"])
  assert.deepEqual(r.started?.slice(0, 3), [path.join(dir, "free.jsonc"), dir, "abc"])
})

test("commands that manage the shared background service are refused, with the plain command to run", (t) => {
  const dir = setup(t)
  for (const cmd of ["debug", "pair", "mcp", "plugin", "upgrade", "update", "uninstall"]) {
    for (const args of [[cmd], [cmd, "list"], ["--log-level", "debug", cmd]]) {
      const r = launch(dir, args)
      assert.equal(r.status, 2, args.join(" "))
      assert.equal(r.stderr, `opencode-free: run \`opencode ${cmd} ...\` directly; it manages the shared background service\n`)
      assert.equal(r.started, undefined, "opencode is never started, so nothing is exported to it")
    }
  }
  // The word is only a command in command position.
  assert.deepEqual(launch(dir, ["run", "--", "mcp"]).argv, ["run", "--standalone", "--", "mcp"])
  assert.deepEqual(launch(dir, ["run", "debug it"]).argv, ["run", "--standalone", "debug it"])
})

test("the shared background service is refused, with a hint when the word is part of a message", (t) => {
  const dir = setup(t)
  const refused = /^opencode-free: can't run the shared background service, and refuses --service anywhere in the arguments \(quote it inside a message\); use opencode-free for the TUI or opencode-free acp for editors and bb\n$/
  for (const args of [["service"], ["service", "restart"], ["serve", "--service"], ["serve", "--service=true"], ["--service=1"], ["--agent", "--service"], ["--log-level", "--service"], ["--agent", "run", "service"], ["--log-level", "debug", "service", "stop"]]) {
    const r = launch(dir, args)
    assert.equal(r.status, 2, args.join(" "))
    assert.match(r.stderr, refused, args.join(" "))
    assert.equal(r.started, undefined, "opencode is never started")
  }
  for (const args of [["run", "fix", "the", "service"], ["run", "service"], ["session", "list", "service"]]) {
    const r = launch(dir, args)
    assert.equal(r.status, 2, args.join(" "))
    assert.equal(r.stderr, `opencode-free: quote the message: opencode-free ${args[0]} "..."\n`)
    assert.equal(r.started, undefined)
  }
})

test("--list-models answers without starting opencode, and a missing config is an error", (t) => {
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
