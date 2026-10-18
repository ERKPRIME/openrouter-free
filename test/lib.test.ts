import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { asArray, asObject, tokens, fit, bestMatch, percentiles, score, isFree, isEligible, key, looksSmall, classifyFailure, pick, orderCandidates, mergeState, mergeConfig, readJSON, writeJSONAtomic, loadConfig, loadPins, coolingUntil, split, decodeModel, decodeState, rankedIds, DEFAULT_CONFIG as cfg } from "../src/lib.mts"
import type { FailureDecision, FailureInfo, ModelInfo, Pins } from "../src/lib.mts"

test("config merge keeps nested defaults", () => {
  const c = mergeConfig({ freeTier: { groq: [] }, weights: { arena_agent: 1 }, minContext: 1000 })
  assert.deepEqual(c.freeTier.groq, [])
  assert.deepEqual(c.freeTier.cerebras, ["*"], "untouched provider keeps its default")
  assert.equal(c.weights.arena_agent, 1)
  assert.equal(c.weights.arena_webdev, 0.35)
  assert.equal(c.minContext, 1000)
  assert.equal(c.cooldownMinutes.quota, 360)
})

test("config values of the wrong type keep their defaults", () => {
  const c = mergeConfig({ minContext: "1000", autoContinue: false, excludeProviders: ["groq", 7], freeTier: { groq: "*", nvidia: ["*"] }, weights: { arena_agent: "1" }, cooldownMinutes: { quota: null, rate: 1 } })
  assert.equal(c.minContext, cfg.minContext)
  assert.equal(c.autoContinue, false)
  assert.deepEqual(c.excludeProviders, ["groq"], "non-string entries are dropped")
  assert.deepEqual(c.freeTier.groq, cfg.freeTier.groq, "a glob list must be a list")
  assert.deepEqual(c.freeTier.nvidia, ["*"])
  assert.equal(c.weights.arena_agent, cfg.weights.arena_agent)
  assert.deepEqual(c.cooldownMinutes, { ...cfg.cooldownMinutes, rate: 1 })
  assert.deepEqual(mergeConfig([1, 2]), cfg, "not an object at all")
})

// Entries of a real `opencode api model.list` (opencode 2.0.32), headers/body/settings stripped.
const LISTED = asArray(readJSON(fileURLToPath(new URL("./fixtures/model-list.json", import.meta.url))))
const listed = (key: string) => {
  const m = LISTED.find((x) => `${asObject(x).providerID}/${asObject(x).id}` === key)
  assert.ok(m, key)
  return asObject(m)
}

// The folded cost is a float sum, so compare it with a tolerance.
const near = (c: { input: number; output: number } | undefined, input: number, output: number) => !!c && Math.abs(c.input - input) < 1e-9 && c.output === output

test("decoding a model list entry", () => {
  assert.deepEqual(decodeModel(listed("opencode/nemotron-3.5-super-vl-free")), {
    id: "nemotron-3.5-super-vl-free",
    providerID: "opencode",
    name: "Nemotron 3.5 Super VL Free",
    status: "active",
    enabled: true,
    release_date: "2026-10-15T00:00:00.000Z",
    cost: { input: 0, output: 0 },
    limit: { context: 1048576 },
    capabilities: { toolcall: true },
  })
  assert.ok(near(decodeModel(listed("opencode/mistral-large-4"))?.cost, 0.68 + 0.07, 2.09), "cache prices are folded into the input price")
  // free/auto has no price at all, which is not the same as free.
  assert.equal(decodeModel(listed("free/auto"))?.cost, undefined)
})

test("a model is free only when every context tier is", () => {
  const haiku = listed("opencode/claude-haiku-5-5")
  assert.equal(asArray(haiku.cost).length, 2, "the fixture is a tiered model")
  assert.ok(near(decodeModel(haiku)?.cost, 0.5 + 0.05 + 0.625, 2.5), "the highest-priced tier is reported")
  // No tiered model with a free first tier is on offer today; this is the shape a paid long-context tier would take.
  const tier = (input: number) => ({ tier: { type: "context", size: 100000 }, input, output: input, cache: { read: 0, write: 0 } })
  const free = { input: 0, output: 0, cache: { read: 0, write: 0 } }
  assert.deepEqual(decodeModel({ ...haiku, cost: [free, tier(3)] })?.cost, { input: 3, output: 3 })
  assert.deepEqual(decodeModel({ ...haiku, cost: [free, tier(0)] })?.cost, { input: 0, output: 0 })
  const cached = (read: number, write: number) => ({ input: 0, output: 0, cache: { read, write } })
  assert.deepEqual(decodeModel({ ...haiku, cost: [cached(0, 0)] })?.cost, { input: 0, output: 0 })
  for (const c of [cached(0.1, 0), cached(0, 0.1)]) assert.ok(!isFree(decodeModel({ ...haiku, providerID: "opencode", cost: [c] }) as ModelInfo, cfg), "0/0 with a priced cache is not free")
  assert.deepEqual(decodeModel({ ...haiku, cost: [{ input: 0, output: 0 }] })?.cost, { input: 0, output: 0 }, "an absent cache price is 0")
  for (const bad of [{ read: "0.1" }, { write: null }, { read: 0, write: "0" }]) {
    assert.equal(decodeModel({ ...haiku, cost: [{ input: 0, output: 0, cache: bad }] })?.cost, undefined, `${JSON.stringify(bad)}: a cache price that is not a number leaves the cost unknown`)
  }
  for (const bad of [0.1, null, "0", [0, 0]]) {
    assert.equal(decodeModel({ ...haiku, cost: [{ input: 0, output: 0, cache: bad }] })?.cost, undefined, `${JSON.stringify(bad)}: a cache that is no object leaves the cost unknown`)
  }
  assert.equal(decodeModel({ ...haiku, cost: [] })?.cost, undefined, "no tiers")
  assert.equal(decodeModel({ ...haiku, cost: [free, { input: 0 }] })?.cost, undefined, "a tier that does not decode")
  assert.equal(decodeModel({ ...haiku, cost: "0" })?.cost, undefined)
  const gone = decodeModel({ ...listed("opencode/nemotron-3.5-super-vl-free"), enabled: false })
  assert.equal(gone?.enabled, false)
  assert.ok(gone && !isEligible(gone, cfg, pins), "a disabled model is not eligible")
})

test("the router keys on a model's id, not its modelID", () => {
  // Synthetic: every real entry has the two equal today. Derived from a real free entry.
  const m = decodeModel({ ...listed("opencode/nemotron-3.5-super-vl-free"), id: "router-id-free", modelID: "upstream-name" })
  assert.equal(m?.id, "router-id-free")
  assert.ok(m)
  assert.equal(key(m), "opencode/router-id-free")
  assert.deepEqual(orderCandidates(["opencode/router-id-free", "opencode/upstream-name"], [m], cfg, pins), ["opencode/router-id-free"])
})

test("decoding models and state keeps the well-formed parts", () => {
  const bare = decodeModel({ id: "x", providerID: "p", cost: [{ input: 0 }], limit: {}, capabilities: {}, time: { released: "soon" } })
  assert.deepEqual([bare?.cost, bare?.limit, bare?.capabilities, bare?.release_date], [undefined, undefined, undefined, undefined], "partial nested fields are left out")
  assert.equal(decodeModel({ id: "x", providerID: "p", time: { released: 0 } })?.release_date, undefined, "0 is unreleased")
  assert.equal(decodeModel({ id: "x", providerID: "p", time: { released: 1e300 } })?.release_date, undefined, "out of range")
  assert.equal(decodeModel({ id: "x" }), undefined, "no provider")
  assert.equal(decodeModel("x"), undefined)

  const state = decodeState({ cooldowns: { a: { until: 5, klass: "quota", reason: 7 }, b: { klass: "rate" }, c: 1 }, sessions: { s: { model: "m" }, t: { at: 1 } } })
  assert.deepEqual(state, { cooldowns: { a: { until: 5, klass: "quota", reason: undefined } }, sessions: { s: { model: "m", at: 0 } } })
  assert.deepEqual(decodeState(undefined), { cooldowns: {}, sessions: {} })
})

const pins: Pins = { pin: [], ban: [], alias: {} }
// The class and the failover of a decision.
const klass = (d: FailureDecision) => (d.action === "failover" ? d.klass : undefined)
const failover = (d: FailureDecision) => (d.action === "failover" ? d : undefined)
const model = (providerID: string, id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  providerID,
  id,
  name: id,
  status: "active",
  cost: { input: 0, output: 0 },
  limit: { context: 200000 },
  capabilities: { toolcall: true },
  ...extra,
})

test("name matching", () => {
  const rows = [
    { name: "nvidia-nemotron-3-ultra-550b-a55b-nvfp4", value: 1400 },
    { name: "mimo-v2.6-pro", value: 1500 },
    { name: "muse-spark-1.3-max", value: 1600 },
    { name: "Kimi K3 (Max)", value: 1 },
    { name: "qwen3.8-27b", value: 1300 },
  ]
  assert.equal(bestMatch(["nemotron-3-ultra-free"], rows)?.name, "nvidia-nemotron-3-ultra-550b-a55b-nvfp4")
  assert.equal(bestMatch(["nvidia/nemotron-3-ultra-550b-a55b:free"], rows)?.name, "nvidia-nemotron-3-ultra-550b-a55b-nvfp4")
  assert.equal(bestMatch(["mimo-v2.6-flash-free"], rows), undefined, "flash must not match pro")
  assert.equal(bestMatch(["muse-spark-1.3-contributor-free"], rows), undefined, "unknown variant qualifier")
  assert.equal(bestMatch(["qwen/qwen3.8-27b:free"], rows)?.name, "qwen3.8-27b")
  assert.equal(bestMatch(["Qwen 3.8 27B"], rows)?.name, "qwen3.8-27b")
  assert.ok(fit(tokens("space-bunny-free"), tokens("Space Bunny Alpha")) >= 0)
  assert.deepEqual(tokens("ling-3.0-flash-fin-free"), ["ling", "3", "flash", "fin"])
  assert.deepEqual(tokens("ling-3-0-flash-fin"), ["ling", "3", "flash", "fin"], "AA dash versions")
  assert.deepEqual(tokens("muse-spark-1-3-xhigh"), ["muse", "spark", "1.3"])
  assert.deepEqual(tokens("gemma-4-26b-a4b-it"), ["gemma", "4", "26b", "a4b"])
})

test("percentiles", () => {
  const p = percentiles([{ value: 10 }, { value: 30 }, { value: 20 }])
  assert.deepEqual(p.map((r) => r.pct), [0, 1, 0.5])
})

test("small-model detection", () => {
  assert.ok(looksSmall("liquid/lfm-2.5-2.6b:free"))
  assert.ok(looksSmall("nemotron-3.5-lightning-free"))
  assert.ok(!looksSmall("nvidia/nemotron-3-ultra-550b-a55b:free"))
  assert.ok(!looksSmall("space-bunny-free"))
})

test("scoring: stealth near top, tiny unscored below scored, pins win", () => {
  const boards = { arena_webdev: percentiles([{ name: "nvidia-nemotron-3-ultra-550b", value: 1500 }, { name: "big-model", value: 1700 }, { name: "weak", value: 1000 }]) }
  const cands = [model("opencode", "nemotron-3-ultra-free"), model("opencode", "space-bunny-free", { name: "Space Bunny Free" }), model("openrouter", "liquid/lfm-2.5-2.6b:free", { release_date: new Date().toISOString().slice(0, 10) })]
  const r = score(cands, boards, ["Space Bunny Alpha"], cfg, pins)
  assert.equal(r[0]?.id, "opencode/space-bunny-free")
  assert.equal(r[1]?.id, "opencode/nemotron-3-ultra-free")
  assert.equal(r.at(-1)?.id, "openrouter/liquid/lfm-2.5-2.6b:free")
  const pinned = score(cands, boards, ["Space Bunny Alpha"], cfg, { ...pins, pin: ["opencode/nemotron-3-ultra-free"] })
  assert.equal(pinned[0]?.id, "opencode/nemotron-3-ultra-free")
})

test("free filter", () => {
  assert.ok(isFree(model("opencode", "x-free"), cfg))
  assert.ok(!isFree(model("openai", "gpt-x", { cost: { input: 1, output: 2 } }), cfg))
  assert.ok(isFree(model("groq", "llama-x", { cost: { input: 0.5, output: 1 } }), cfg), "freeTier provider")
  assert.ok(!isFree(model("google", "gemini-3.1-pro", { cost: { input: 1, output: 2 } }), cfg), "google pro not free tier")
  assert.ok(isFree(model("google", "gemini-3.8-flash", { cost: { input: 1, output: 2 } }), cfg))
  assert.ok(!isFree(model("openrouter", "a:free"), { ...cfg, excludeProviders: ["openrouter"] }))
  assert.ok(!isFree(model("zai-coding-plan", "glm-5.2"), cfg), "subscription plans report price 0 but are not free")
  assert.ok(!isFree(model("lmstudio", "local-model"), cfg), "unlisted provider with price 0")
  assert.ok(!isFree(model("opencode", "claude-x", { cost: { input: 3, output: 15 } }), cfg), "paid Zen model")
  assert.ok(isFree(model("nvidia", "nemotron-x"), cfg))
  assert.ok(isFree(model("mistral", "labs-devstral-small-2512"), cfg), "Mistral's 0-priced model")
  assert.ok(isFree(model("mistral", "mistral-small-2603", { cost: { input: 0.15, output: 0.6 } }), cfg), "Experiment plan family")
  assert.ok(!isFree(model("mistral", "mistral-large-2512", { cost: { input: 0.5, output: 1.5 } }), cfg), "paid Mistral family")
  assert.ok(!isFree(model("mistral", "devstral-medium-latest", { cost: { input: 0.4, output: 2 } }), cfg), "paid Mistral family")
  assert.ok(isFree(model("zai", "glm-4.7-flash"), cfg), "Z.AI flash models are priced 0")
  assert.ok(!isFree(model("zai", "glm-4.7-flashx", { cost: { input: 0.07, output: 0.4 } }), cfg), "the paid FlashX twin")
  assert.ok(!isFree(model("zai", "glm-5.3", { cost: { input: 1.4, output: 4.4 } }), cfg), "paid Z.AI flagship")
  assert.ok(isFree(model("zhipuai", "glm-4.5-flash"), cfg), "same free models on the China endpoint")
  assert.ok(isFree(model("modelscope", "Qwen/Qwen3-235B-A22B-Thinking-2507"), cfg), "ModelScope serves everything free")
  assert.ok(!isFree(model("vercel", "meta/llama-3.3-70b"), cfg), "Vercel's catalog 0 is not free")
  assert.ok(!isFree(model("kilo", "z-ai/glm-5.2:free"), cfg), "gateway clone is not on the allowlist")
  assert.ok(!isEligible(model("free", "auto"), cfg, pins), "virtual model")
  assert.ok(!isEligible(model("opencode", "y-free", { capabilities: { toolcall: false } }), cfg, pins))
  assert.ok(!isEligible(model("opencode", "y-free", { limit: { context: 32000 } }), cfg, pins))
  assert.ok(!isEligible(model("openrouter", "nvidia/nemotron-3.5-content-safety:free"), cfg, pins))
  assert.ok(!isEligible(model("opencode", "y-free"), cfg, { ...pins, ban: ["opencode/y-free"] }))
  assert.ok(!isEligible(model("openrouter", "openrouter/auto"), cfg, pins), "OpenRouter routers can bill paid models")
  assert.ok(!isEligible(model("google", "gemini-3.1-flash-live-preview"), cfg, pins), "realtime audio model")
  assert.ok(isEligible(model("openrouter", "stealth/space-bunny-alpha"), cfg, pins))
  assert.ok(isEligible(model("zai", "glm-4.7-flash"), cfg, pins), "free GLM Flash model is usable")
  assert.ok(!isEligible(model("zai", "glm-4.5-flash", { limit: { context: 32000 } }), cfg, pins), "under minContext")
  assert.ok(!isEligible(model("mistral", "labs-devstral-small-2512", { status: "deprecated" }), cfg, pins), "deprecated")
})

test("example config agrees with the shipped defaults", () => {
  const example = JSON.parse(fs.readFileSync(new URL("../templates/config.example.json", import.meta.url), "utf8"))
  assert.deepEqual(example.freeTier, cfg.freeTier, "config.example.json freeTier drifted from DEFAULT_CONFIG")
  assert.equal(example.minContext, cfg.minContext)
})

test("failure classification", () => {
  const fail = (f: Partial<FailureInfo> & { message: string }) => classifyFailure({ type: "", attempt: 1, delay: 0, ...f }, cfg)
  const min = (m: number) => m * 60e3

  // What is not the model's fault stays with opencode, whatever the status says.
  for (const f of [{ message: "context_length_exceeded", status: 400 }, { type: "provider.content-filter", message: "blocked", status: 400 }, { message: "Output length exceeded", status: 500 }]) {
    assert.equal(fail(f).action, "ignore", f.message)
  }

  // Auth: the whole provider, and ahead of the quota and removal wordings.
  assert.deepEqual(fail({ type: "provider.auth", message: "Unauthorized", status: 401 }), { action: "failover", klass: "auth", scope: "provider", cooldownMs: min(1440) })
  assert.equal(failover(fail({ message: "insufficient permissions", status: 401 }))?.scope, "provider")
  assert.equal(klass(fail({ message: "limit reached", status: 403 })), "auth")
  assert.equal(failover(fail({ message: "no such key", type: "provider.auth" }))?.scope, "provider", "the type alone is enough")

  // Removed or refused: one model.
  assert.equal(klass(fail({ type: "provider.invalid-request", message: "Not Found", status: 404 })), "unavailable")
  assert.equal(klass(fail({ message: "Payment required", status: 402 })), "unavailable", "free plan asked for a paid model")
  assert.equal(klass(fail({ message: "Payment required to use this model" })), "unavailable", "the wording alone, as in v1")
  assert.equal(klass(fail({ message: "FreeTierError: OpenCode's free tier can only be used from within OpenCode", status: 403 })), "auth", "403 is auth first")
  assert.equal(klass(fail({ message: "FreeTierError: OpenCode's free tier can only be used from within OpenCode" })), "unavailable")
  assert.equal(klass(fail({ message: "model not found", status: 400 })), "unavailable")
  assert.equal(klass(fail({ message: "model does not exist", status: 500, attempt: 2 })), "server", "a retried 5xx is a transient fault, not a removal")
  assert.equal(fail({ message: "model does not exist", status: 500 }).action, "wait")

  // Quota wording wins over a 429: a daily limit is not a ten-minute rate limit.
  const q = failover(fail({ type: "provider.rate-limit", message: "Rate limit exceeded: free-models-per-day", status: 429, body: '{"error":{"message":"daily quota used"}}' }))
  assert.equal(q?.klass, "quota")
  assert.equal(q?.cooldownMs, min(360))
  assert.equal(klass(fail({ message: "Free usage exceeded, subscribe to Go" })), "quota")
  assert.equal(failover(fail({ message: "Free usage exceeded", delay: min(600) }))?.cooldownMs, min(600), "honours a longer wait")
  assert.equal(klass(fail({ type: "provider.quota", message: "denied" })), "quota", "unverified type, still a hint")

  // Rate limits wait for opencode's retry unless the wait is long or they repeat.
  assert.equal(fail({ message: "Too Many Requests", status: 429, delay: 5000 }).action, "wait")
  const r = failover(fail({ message: "Too Many Requests", status: 429, delay: 3 * 3600e3 }))
  assert.equal(r?.klass, "rate")
  assert.equal(r?.cooldownMs, 3 * 3600e3, "honours retry-after")
  assert.equal(failover(fail({ message: "Too Many Requests", status: 429, attempt: 2 }))?.cooldownMs, min(10))
  assert.equal(klass(fail({ message: "rate limit hit", attempt: 2 })), "rate", "no status, wording only")

  // Server faults need to repeat.
  assert.equal(fail({ message: "Provider is overloaded", status: 503 }).action, "wait")
  assert.equal(klass(fail({ message: "Provider is overloaded", status: 503, attempt: 2 })), "server")
  assert.equal(failover(fail({ message: "Provider is overloaded", attempt: 2, delay: 3600e3 }))?.cooldownMs, 3600e3)
  assert.equal(klass(fail({ type: "provider.internal", message: "internal server error", status: 500, attempt: 2 })), "server")
  assert.equal(klass(fail({ type: "provider.transport", message: "Connection lost while reading the response: ECONNRESET", status: 200, attempt: 2 })), "server", "a stream cut mid-answer carries status 200")
  assert.equal(klass(fail({ type: "provider.transport", message: "The connection was aborted", attempt: 2 })), "server", "a transport error that says aborted is a provider fault")
  assert.equal(klass(fail({ type: "provider.timeout", message: "stalled", attempt: 2 })), "server", "unverified type, still a hint")
  assert.equal(klass(fail({ type: "provider.no-route", message: "stalled", attempt: 2 })), "server", "unverified type, still a hint")

  // An error nobody recognises gives up eventually.
  assert.equal(fail({ message: "something odd", attempt: 2 }).action, "wait")
  assert.deepEqual(fail({ message: "something odd", attempt: 3 }), { action: "failover", klass: "server", cooldownMs: min(5) })
  assert.deepEqual(fail({ type: "provider.mystery", message: "", attempt: 3 }), { action: "failover", klass: "server", cooldownMs: min(5) }, "unknown type, empty message")
  assert.equal(failover(fail({ message: "Free usage exceeded", delay: Number.NaN }))?.cooldownMs, min(360), "a delay that is not a number counts as none")
})

test("pick and order", () => {
  const now = 5_000
  const state = { cooldowns: { "a/1": { until: now + 100 }, "b/*": { until: now + 50 } } }
  assert.deepEqual(pick(["a/1", "b/2", "c/3"], state, [], now), { id: "c/3", allCooling: false })
  assert.deepEqual(pick(["a/1", "b/2"], state, [], now), { id: "b/2", allCooling: true }, "soonest cooldown")
  assert.deepEqual(pick(["a/1", "c/3"], state, ["c/3"], now), { id: "a/1", allCooling: true })
  const live = [model("opencode", "undated-free"), model("opencode", "new-free", { release_date: "2026-09-24" }), model("opencode", "old-free", { release_date: "2026-01-01" }), model("openai", "paid", { cost: { input: 1, output: 1 } })]
  const ranking = { models: [{ id: "opencode/old-free" }, { id: "openai/paid" }, { id: "opencode/gone-free" }, { score: 1 }] }
  assert.deepEqual(orderCandidates(rankedIds(ranking), live, cfg, pins), ["opencode/old-free", "opencode/new-free", "opencode/undated-free"], "stale ranking cannot route to paid or vanished models; unranked ones follow, newest first")
})

test("state merge keeps later cooldowns and prunes", () => {
  const now = Date.now()
  const merged = mergeState(
    { cooldowns: { x: { until: now + 10 }, old: { until: now - 1 } }, sessions: { s: { model: "a", at: now - 40 * 864e5 } } },
    { cooldowns: { x: { until: now + 20 } }, sessions: { t: { model: "b", at: now } } },
  )
  assert.equal(merged.cooldowns.x?.until, now + 20)
  assert.ok(!merged.cooldowns.old)
  assert.ok(!merged.sessions.s)
  assert.equal(merged.sessions.t?.model, "b")
})

test("cooldowns and ids", () => {
  const state = { cooldowns: { "a/1": { until: 200 }, "b/*": { until: 300 } } }
  assert.equal(coolingUntil(state, "a/1", 100), 200)
  assert.equal(coolingUntil(state, "b/2", 100), 300, "provider-wide cooldown")
  assert.equal(coolingUntil(state, "a/1", 250), 0)
  assert.equal(coolingUntil({ cooldowns: {} }, "c/3", 0), 0)
  assert.deepEqual(split("openrouter/qwen/qwen3:free"), { providerID: "openrouter", modelID: "qwen/qwen3:free" })
})

test("config and pins files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "free-router-lib-"))
  try {
    assert.deepEqual(loadConfig(dir), cfg, "no config.json means defaults")
    assert.deepEqual(loadPins(dir), { pin: [], ban: [], alias: {} })
    assert.equal(readJSON(path.join(dir, "missing.json")), undefined)
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json")
    assert.equal(loadConfig(dir).minContext, cfg.minContext, "broken config.json means defaults")
    writeJSONAtomic(path.join(dir, "config.json"), { minContext: 1, cooldownMinutes: { rate: 2 } })
    assert.equal(loadConfig(dir).minContext, 1)
    assert.equal(loadConfig(dir).cooldownMinutes.quota, 360)
    writeJSONAtomic(path.join(dir, "pins.json"), { ban: ["x/y", 1], alias: { "a/b": "b", "c/d": 2 } })
    assert.deepEqual(loadPins(dir), { pin: [], ban: ["x/y"], alias: { "a/b": "b" } }, "malformed entries are dropped")
    assert.equal(fs.statSync(path.join(dir, "pins.json")).mode & 0o777, 0o600, "state files are private")
    assert.deepEqual(fs.readdirSync(dir).sort(), ["config.json", "pins.json"], "no temp files left behind")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
