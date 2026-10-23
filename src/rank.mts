#!/usr/bin/env node
// Ranks the free models opencode can reach right now and writes ranking.json for plugin/index.ts.
//   node rank.mts            refresh ranking.json
//   node rank.mts --status   print ranking, cooldowns and per-session picks (no refresh)
//   node rank.mts --quiet    refresh, printing only warnings (scheduled / plugin-triggered runs)
//   --config <free.jsonc>    opencode config to list models with (default: free.jsonc next to this file)
//   --lock <file>            remove this lock file when done (set by the plugin's self-refresh)
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import {
  DIR,
  readJSON,
  writeJSONAtomic,
  loadConfig,
  loadPins,
  isEligible,
  percentiles,
  score,
  coolingUntil,
  decodeModel,
  decodeState,
  asObject,
  isArray,
  isObject,
  list,
  entries,
  optString,
  optNumber,
  stringList,
  errorText,
  redactSecrets,
  findExecutable,
  windowsCommandLine,
  needsCommandShell,
} from "./lib.mts"
import type { JsonObject, ModelInfo, RankedRow, Row, Scored, SourceHit } from "./lib.mts"

const HELP = `Usage: rank.mts [options]

  (no options)             refresh ranking.json and print a one-line summary
  --status                 print ranking.json, cooldowns and recent session picks
  --quiet                  refresh, printing only warnings
  --config <free.jsonc>    opencode config to list models with (default: free.jsonc here)
  --lock <file>            remove this lock file when done (set by the plugin)
  -h, --help               show this help

Ranking needs network access, opencode 2 on PATH and at least one configured provider.
Exit codes: 0 success, 1 refresh failed, 2 invalid command line.`

const argv = process.argv.slice(2)
if (argv.includes("-h") || argv.includes("--help")) {
  console.log(HELP)
  process.exit(0)
}
const valueFlags = new Set(["--config", "--lock"])
const knownFlags = new Set(["--status", "--quiet", "-h", "--help", "--config", "--lock"])
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] as string
  if (!a.startsWith("-")) {
    console.error(`rank: unexpected argument '${a}' (see --help)`)
    process.exit(2)
  }
  if (!knownFlags.has(a)) {
    console.error(`rank: unknown option '${a}' (see --help)`)
    process.exit(2)
  }
  if (valueFlags.has(a)) {
    if (argv[i + 1] === undefined) {
      console.error(`rank: ${a} needs a value`)
      process.exit(2)
    }
    i++
  }
}

const arg = (name: string) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const CONFIG_FILE = path.resolve(arg("--config") ?? path.join(DIR, "free.jsonc"))
const CACHE = path.join(DIR, "cache")
const HF = "https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&split=latest"
const ARENA: Record<string, [config: string, field: string]> = { arena_agent: ["agent", "score"], arena_webdev: ["webdev", "rating"], arena_text: ["text", "rating"] }
const AA_URL = "https://artificialanalysis.ai/api/v2/language/models/free"

// An Artificial Analysis model: its slug (or name) and its index scores.
interface AAModel {
  name: string
  evaluations: Record<string, number>
}

interface Ranking {
  generatedAt: string
  attribution: string
  candidatesSeen: number
  warnings: string[]
  models: Scored[]
}

// `target` lets ranker.env stay out of process.env: only providers.env may reach the opencode child.
function loadEnv(file: string, target: Record<string, string | undefined> = process.env) {
  let text
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return
  }
  for (const line of text.split("\n")) {
    const [, name, value] = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/) ?? []
    if (!name || !value) continue
    target[name] = value.replace(/^(['"])(.*)\1$/, "$2")
  }
}

async function getJSON(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url.split("?")[0]}`)
  return res.json()
}

// Fetch a source, falling back to its last good copy. `ttl` skips the network while the cache is fresh.
async function cached<T>(name: string, ttl: number, load: () => Promise<T>, decode: (v: unknown) => T, warnings: string[]) {
  const file = path.join(CACHE, `${name}.json`)
  const prev = asObject(readJSON(file))
  const fetchedAt = optNumber(prev.fetchedAt)
  const now = Date.now()
  // A future timestamp is a bad clock or a hand-edited cache. Treat it as stale instead of trusting
  // it until the clock catches up.
  const fresh = fetchedAt !== undefined && fetchedAt <= now + 5 * 60e3 && now - fetchedAt < ttl
  if (fresh) return decode(prev.data)
  try {
    const data = await load()
    fs.mkdirSync(CACHE, { recursive: true })
    writeJSONAtomic(file, { fetchedAt: Date.now(), data })
    return data
  } catch (e) {
    warnings.push(`${name}: ${redactSecrets(errorText(e))}${fetchedAt !== undefined ? ` (using copy from ${new Date(fetchedAt).toISOString()})` : " (no previous copy)"}`)
    return decode(prev.data)
  }
}

const decodeRows = (v: unknown) =>
  list(v, (x): Row | undefined => {
    const r = asObject(x)
    const name = optString(r.name)
    return name === undefined ? undefined : { name, value: optNumber(r.value) }
  })

// Overall rows come first in every board; stop paging once another category starts.
async function arenaBoard(config: string, field: string) {
  const rows: Row[] = []
  // The API normally returns a few hundred overall rows; the cap only stops a broken or malicious
  // response that keeps claiming there are more pages.
  for (let offset = 0; offset <= 100_000; offset += 100) {
    const d = asObject(await getJSON(`${HF}&config=${config}&offset=${offset}&length=100`))
    for (const { row } of list(d.rows, asObject)) {
      const r = asObject(row)
      if (r.category !== "overall") return rows
      const name = optString(r.model_name)
      if (name !== undefined) rows.push({ name, value: optNumber(r[field]) })
    }
    if (offset + 100 >= (optNumber(d.num_rows_total) ?? 0)) return rows
  }
  throw new Error(`${config}: leaderboard pagination did not end`)
}

const decodeAA = (v: unknown) =>
  list(v, (x): AAModel | undefined => {
    const m = asObject(x)
    const name = optString(m.slug) ?? optString(m.name)
    return name === undefined ? undefined : { name, evaluations: entries(m.evaluations, optNumber) }
  })

// Only called when ARTIFICIAL_ANALYSIS_API_KEY is set.
async function aaModels(key: string) {
  const out: AAModel[] = []
  for (let page = 1; page < 20; page++) {
    const d = asObject(await getJSON(`${AA_URL}?page=${page}`, { "x-api-key": key }))
    out.push(...decodeAA(d.data))
    if (asObject(d.pagination).has_more !== true) break
  }
  return out
}

async function openrouterStealth() {
  const d = asObject(await getJSON("https://openrouter.ai/api/v1/models"))
  return list(d.data, (x) => {
    const m = asObject(x)
    const id = optString(m.id)
    return id?.startsWith("stealth/") ? optString(m.name) || id : undefined
  })
}

// Fields that can hold credentials. Provider settings carry the API key, and variants repeat them.
// The search is recursive because opencode may nest a provider object inside another field.
const SECRET_KEYS = new Set(["headers", "body", "settings", "apikey", "api_key", "authorization", "token", "secret", "password", "client_secret", "access_token", "refresh_token"])

function stripSecrets(value: unknown): unknown {
  if (isArray(value)) return value.map(stripSecrets)
  if (!isObject(value)) return value
  const out: JsonObject = {}
  for (const [k, v] of Object.entries(value)) if (!SECRET_KEYS.has(k.toLowerCase())) out[k] = stripSecrets(v)
  return out
}

// opencode prints the model list as one JSON object, possibly between log lines.
function parseModelList(out: string) {
  const clean = out.replace(/^\uFEFF/, "")
  for (const text of [clean, ...clean.split("\n"), clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)]) {
    try {
      const data = asObject(JSON.parse(text)).data
      if (isArray(data)) return data
    } catch {}
  }
  throw new Error("opencode model.list failed: no model list in its output")
}

// `raw`: every model entry opencode listed, credentials stripped, kept for debugging eligibility.
function candidates(): { raw: unknown[]; models: ModelInfo[] } {
  // npm installs opencode as opencode.cmd on Windows, which CreateProcess cannot run directly.
  // Resolve the real file first and use cmd.exe only for a .cmd/.bat shim; the arguments below are
  // constants, never user text, so nothing is interpolated into a shell.
  const executable = findExecutable("opencode")
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_CONFIG: CONFIG_FILE, FREE_ROUTER_DIR: DIR, FREE_ROUTER_RANKING: "1" }
  // ranker.env is for this process only. If a user also put the key in providers.env, keep it out of
  // the opencode child; that child passes its environment on to provider plugins and tools.
  delete env.ARTIFICIAL_ANALYSIS_API_KEY
  const options = {
    // FREE_ROUTER_RANKING stops the plugin (loaded by this opencode) from starting another ranking.
    env,
    encoding: "utf8" as const,
    timeout: 180_000,
    maxBuffer: 64 << 20,
  }
  const args = ["api", "--standalone", "model.list"]
  const r = needsCommandShell(executable ?? "")
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/v:off", "/s", "/c", `"${windowsCommandLine(executable as string, args)}"`], { ...options, windowsVerbatimArguments: true })
    : spawnSync(executable ?? "opencode", args, options)
  if (r.status !== 0) throw new Error(`opencode model.list failed: ${redactSecrets((r.stderr || r.error?.message || "").slice(0, 300))}`)
  const data = parseModelList(r.stdout)
  return { raw: list(data, (x) => (isObject(x) ? stripSecrets(x) : undefined)), models: list(data, decodeModel) }
}

async function refresh() {
  loadEnv(path.join(DIR, "providers.env"))
  // Never put ranker.env into process.env: candidates() spawns opencode with a copy of it.
  const rankerEnv: Record<string, string | undefined> = {}
  loadEnv(path.join(DIR, "ranker.env"), rankerEnv)
  const cfg = loadConfig()
  const pins = loadPins()
  const warnings: string[] = []

  const { raw, models: all } = candidates()
  const cands = all.filter((m) => isEligible(m, cfg, pins))
  fs.mkdirSync(CACHE, { recursive: true })
  writeJSONAtomic(path.join(CACHE, "candidates.json"), raw) // model metadata only, for debugging eligibility

  const boards: Record<string, RankedRow[]> = {}
  for (const [src, [config, field]] of Object.entries(ARENA)) {
    boards[src] = percentiles(await cached(src, 20 * 3600e3, () => arenaBoard(config, field), decodeRows, warnings))
  }
  const aaKey = rankerEnv.ARTIFICIAL_ANALYSIS_API_KEY ?? process.env.ARTIFICIAL_ANALYSIS_API_KEY
  const aa = aaKey ? await cached("aa", 20 * 3600e3, () => aaModels(aaKey), decodeAA, warnings) : []
  if (!aaKey) warnings.push("aa: ARTIFICIAL_ANALYSIS_API_KEY not set, Artificial Analysis scores skipped")
  const aaRows = (metric: string): Row[] => aa.map((m) => ({ name: m.name, value: m.evaluations[metric] }))
  boards.aa_coding = percentiles(aaRows("artificial_analysis_coding_index"))
  boards.aa_agentic = percentiles(aaRows("artificial_analysis_agentic_index"))
  boards.aa_intelligence = percentiles(aaRows("artificial_analysis_intelligence_index"))
  const stealth = await cached("openrouter_stealth", 3 * 3600e3, openrouterStealth, stringList, warnings)

  const ranking: Ranking = {
    generatedAt: new Date().toISOString(),
    attribution: "Scores use LMArena (lmarena-ai/leaderboard-dataset) and Artificial Analysis (artificialanalysis.ai).",
    candidatesSeen: raw.length,
    warnings,
    models: score(cands, boards, stealth, cfg, pins),
  }
  writeJSONAtomic(path.join(DIR, "ranking.json"), ranking)
  return ranking
}

function decodeHit(v: unknown): SourceHit | undefined {
  const h = asObject(v)
  const as = optString(h.as)
  const pct = optNumber(h.pct)
  return as === undefined || pct === undefined ? undefined : { as, value: optNumber(h.value), pct }
}

function decodeScored(v: unknown): Scored | undefined {
  const m = asObject(v)
  const id = optString(m.id)
  const s = optNumber(m.score)
  const reason = optString(m.reason)
  if (id === undefined || s === undefined || reason === undefined) return undefined
  return { id, score: s, reason, sources: entries(m.sources, decodeHit), release_date: optString(m.release_date) ?? null }
}

function status() {
  const ranking = asObject(readJSON(path.join(DIR, "ranking.json")))
  const models = list(ranking.models, decodeScored)
  const state = decodeState(readJSON(path.join(DIR, "state.json")))
  const now = Date.now()
  console.log(`ranking.json: ${optString(ranking.generatedAt) ?? "missing"}  (${models.length} eligible of ${optNumber(ranking.candidatesSeen) ?? "?"} models)`)
  for (const w of stringList(ranking.warnings)) console.log(`  warning: ${w}`)
  console.log("")
  models.forEach((m, i) => {
    const until = coolingUntil(state, m.id, now)
    const cool = until ? `  [cooling until ${new Date(until).toLocaleTimeString()}: ${state.cooldowns[m.id]?.klass ?? "provider"}]` : ""
    const src = Object.entries(m.sources).map(([k, v]) => `${k}=${v.pct}(${v.as})`).join(" ")
    console.log(`${String(i + 1).padStart(2)}. ${m.score.toFixed(3)}  ${m.id}  — ${m.reason}${cool}${src ? `\n      ${src}` : ""}`)
  })
  const sessions = Object.entries(state.sessions).sort((a, b) => b[1].at - a[1].at).slice(0, 10)
  if (sessions.length) {
    console.log("\nrecent sessions:")
    for (const [id, s] of sessions) console.log(`  ${id}  ${s.model}  (${new Date(s.at).toLocaleString()})`)
  }
}

if (process.argv.includes("--status")) status()
else {
  const lock = arg("--lock")
  try {
    // --quiet: print only warnings, so a clean refresh is silent.
    const r = await refresh()
    if (!process.argv.includes("--quiet")) console.log(`ranked ${r.models.length} free models; top: ${r.models.slice(0, 3).map((m) => m.id).join(", ") || "none"}`)
    for (const w of r.warnings) console.log(`warning: ${w}`)
    if (!r.models.length) console.log("warning: no eligible free models found")
  } catch (e) {
    console.error(`rank failed: ${redactSecrets(errorText(e))}`)
    process.exitCode = 1
  } finally {
    if (lock) fs.rmSync(lock, { force: true })
  }
}
