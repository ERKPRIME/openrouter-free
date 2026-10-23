// Where the user's files live: free.jsonc, config.json, pins.json, the key files, ranking.json and
// state.json. Kept apart from the code so an npm install can be updated or removed without touching
// either.
//
// Resolution order:
//   1. FREE_ROUTER_DIR (set by the CLI and the wrapper, and by install.sh installs through the wrapper)
//   2. the directory next to this file, when it holds a free.jsonc: that is the scripts/install.sh
//      layout, where code and data share one directory, and it must keep working unchanged
//   3. the platform's user config directory
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// <install dir> for an install.sh install, <package>/src for an npm install.
const HERE = path.dirname(fileURLToPath(import.meta.url))

const hasConfig = (dir: string) => fs.existsSync(path.join(dir, "free.jsonc"))

// Per-user, not per-machine: providers.env holds API keys and state.json records sessions.
function platformDefault() {
  const home = os.homedir()
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "openrouter-free")
  }
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "openrouter-free")
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "openrouter-free")
}

export const DATA_DIR = path.resolve(process.env.FREE_ROUTER_DIR || (hasConfig(HERE) ? HERE : platformDefault()))
