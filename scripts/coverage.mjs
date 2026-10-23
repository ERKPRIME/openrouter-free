// Cross-platform coverage entry point. Node 22/24 have --test-coverage-include but not
// --test-coverage-include-all (Node 26+); use it when available so files no test imports still count,
// and keep the same command working on the older versions used by CI and contributors.
import { mkdirSync } from "node:fs"
import { spawnSync } from "node:child_process"
import process from "node:process"

mkdirSync("coverage", { recursive: true })

const help = spawnSync(process.execPath, ["--help"], { encoding: "utf8" })
const supportsIncludeAll = `${help.stdout}${help.stderr}`.includes("--test-coverage-include-all")

const args = [
  "--test",
  "--experimental-test-coverage",
  "--test-coverage-include=src/**",
  ...(supportsIncludeAll ? ["--test-coverage-include-all"] : []),
  "--test-reporter=spec",
  "--test-reporter-destination=stdout",
  "--test-reporter=lcov",
  "--test-reporter-destination=coverage/lcov.info",
  "test/*.test.ts",
]

const run = spawnSync(process.execPath, args, { stdio: "inherit" })
process.exit(run.status ?? 1)
