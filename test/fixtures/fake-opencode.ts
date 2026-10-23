// A temporary directory whose bin/ holds an `opencode` that is a canned shell script, for the tests
// that run the CLI, the launcher or the install scripts for real. Removed when the test ends.
import type { TestContext } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export function tempWithOpencode(t: TestContext, prefix: string, script: string, windowsScript?: string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  fs.mkdirSync(path.join(dir, "bin"))
  fs.writeFileSync(path.join(dir, "bin", "opencode"), script, { mode: 0o755 })
  // Windows cannot run the extensionless shell script or a .cmd file directly; PATH resolution
  // finds this one by PATHEXT, and the caller's script starts it through cmd.exe.
  if (process.platform === "win32" && windowsScript) fs.writeFileSync(path.join(dir, "bin", "opencode.cmd"), windowsScript, "ascii")
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
