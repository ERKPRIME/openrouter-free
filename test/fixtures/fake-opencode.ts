// A temporary directory whose bin/ holds an `opencode` that is a canned shell script, for the tests
// that run the CLI, the launcher or the install scripts for real. Removed when the test ends.
import type { TestContext } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export function tempWithOpencode(t: TestContext, prefix: string, script: string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  fs.mkdirSync(path.join(dir, "bin"))
  fs.writeFileSync(path.join(dir, "bin", "opencode"), script, { mode: 0o755 })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
