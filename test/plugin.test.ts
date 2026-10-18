// plugin/index.ts runs inside opencode; these tests load it in-process against a fake plugin context
// (hooks captured, switches and metadata updates recorded, events pushed by hand) and an isolated
// FREE_ROUTER_DIR.
import { test, beforeEach, after, mock } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { SessionPrompt, SessionRetry } from "@opencode/plugin/promise/session"
import type { RouterContext, SessionLike } from "../src/plugin/index.ts"

const DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "free-router-plugin-")))
process.env.FREE_ROUTER_DIR = DIR
for (const k of ["FREE_ROUTER_RANKING", "BB_THREAD_ID", "BB_CLI"]) delete process.env[k]
// lib.mts reads FREE_ROUTER_DIR when it loads, so import it and the plugin only after setting it.
const { decodeState, readJSON } = await import("../src/lib.mts")
const { default: plugin } = await import("../src/plugin/index.ts")

type Ref = { providerID: string; id: string }
const ref = (id: string): Ref => ({ providerID: id.slice(0, id.indexOf("/")), id: id.slice(id.indexOf("/") + 1) })
const FREE_AUTO = "free/auto"

// A model.list entry as opencode 2 reports it.
const listed = (id: string, extra: Record<string, unknown> = {}) => ({
  ...ref(id),
  name: id,
  status: "active",
  enabled: true,
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  limit: { context: 200000, output: 4096 },
  capabilities: { tools: true },
  time: { released: 0 },
  ...extra,
})
const PAID = [{ input: 1, output: 1, cache: { read: 0, write: 0 } }]
const MODELS = [listed("opencode/a-free"), listed("opencode/b-free"), listed("opencode/c-free"), listed("openai/gpt", { cost: PAID })]

const file = (name: string) => path.join(DIR, name)
const writeJSON = (name: string, data: unknown) => fs.writeFileSync(file(name), JSON.stringify(data))
const readState = () => decodeState(readJSON(file("state.json")))
const logText = () => (fs.existsSync(file("router.log")) ? fs.readFileSync(file("router.log"), "utf8") : "")
const count = (text: string, needle: string) => text.split(needle).length - 1

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

// Real time passes for child processes, so poll on setImmediate.
async function until(cond: () => boolean, what: string) {
  const deadline = Date.now() + 10_000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setImmediate(r))
  }
}

// An event stream the test feeds by hand; end() closes it like a dropped connection.
function createFeed() {
  const queue: unknown[] = []
  let wake: (() => void) | undefined
  let ended = false
  let aborted = false
  async function* subscribe({ signal }: { signal: AbortSignal }) {
    signal.addEventListener("abort", () => {
      aborted = true
      wake?.()
    })
    for (;;) {
      if (queue.length) yield queue.shift() as { type: string; data?: unknown }
      else if (ended || aborted) return
      else await new Promise<void>((r) => (wake = r))
    }
  }
  return {
    subscribe,
    push: (ev: unknown) => {
      queue.push(ev)
      wake?.()
    },
    end: () => {
      ended = true
      wake?.()
    },
    get aborted() {
      return aborted
    },
  }
}

interface FakeOptions {
  models?: unknown[] | Error
  sessions?: Record<string, SessionLike>
  defaultModel?: Ref | null
  switchModel?: (input: { sessionID: string; model: Ref }) => Promise<void>
  update?: (input: { sessionID: string; metadata: unknown }) => Promise<void>
  // Sessions opencode no longer has: asking for one fails.
  deleted?: string[]
  subscribe?: RouterContext["event"]["subscribe"]
}

function fakeContext({ models = MODELS, sessions = {}, defaultModel = ref(FREE_AUTO), switchModel, update, deleted = [], subscribe }: FakeOptions = {}) {
  const state = new Map(Object.entries(sessions).map(([sid, s]) => [sid, structuredClone(s)]))
  const calls = { list: 0, switches: new Array<{ sessionID: string; model: Ref }>(), updates: new Array<{ sessionID: string; metadata: unknown }>() }
  const hooks: { prompt?: (e: SessionPrompt) => Promise<void> | void; retry?: (e: SessionRetry) => Promise<void> | void } = {}
  const disposed = new Array<string>()
  const feed = createFeed()
  const ctx: RouterContext = {
    model: {
      list: async () => {
        calls.list++
        if (models instanceof Error) throw models
        return { data: models }
      },
      default: async () => ({ data: defaultModel }),
    },
    session: {
      get: async ({ sessionID }) => {
        if (deleted.includes(sessionID)) throw new Error(`no session ${sessionID}`)
        return structuredClone(state.get(sessionID) ?? {})
      },
      switchModel: async (input) => {
        await switchModel?.(input)
        calls.switches.push(input)
        state.set(input.sessionID, { ...state.get(input.sessionID), model: input.model })
      },
      // Like opencode's, this replaces the whole metadata object.
      update: async ({ sessionID, metadata }) => {
        await update?.({ sessionID, metadata })
        calls.updates.push({ sessionID, metadata })
        state.set(sessionID, { ...state.get(sessionID), metadata })
      },
      hook: ((name: "prompt" | "retry", callback: never) => {
        hooks[name] = callback
        return Promise.resolve({ dispose: async () => void disposed.push(name) })
      }) as RouterContext["session"]["hook"],
    },
    event: { subscribe: subscribe ?? feed.subscribe },
  }
  return { ctx, calls, hooks, state, disposed, feed }
}

async function start(opts: FakeOptions = {}) {
  const fake = fakeContext(opts)
  const cleanup = await plugin.setup(fake.ctx)
  const { hooks } = fake
  assert.ok(hooks.prompt && hooks.retry && typeof cleanup === "function")
  const prompt = (sid: string) => hooks.prompt?.({ sessionID: sid, messageID: "msg", prompt: { text: "hi" }, delivery: "steer" } as unknown as SessionPrompt)
  // The hook sees opencode's own decision (a 429 waits 15 minutes) and may replace it.
  const retry = async (sid: string, f: { model?: string; type?: string; message?: string; status?: number; body?: string; attempt?: number; delay?: number | undefined; retry?: boolean } = {}) => {
    const e = {
      sessionID: sid,
      agent: "build",
      model: ref(f.model ?? "opencode/a-free"),
      error: { type: f.type ?? "provider.rate-limit", message: f.message ?? "Rate limit exceeded", status: f.status ?? 429, ...(f.body ? { response: { body: f.body } } : {}) },
      attempt: f.attempt ?? 2,
      decision: f.retry === false ? { retry: false } : { retry: true, delay: f.delay ?? 900_000 },
    }
    await hooks.retry?.(e as unknown as SessionRetry)
    return e.decision
  }
  const emit = async (type: string, sid: string) => {
    fake.feed.push({ type, data: { sessionID: sid } })
    await settle()
  }
  return { ...fake, cleanup, prompt, retry, emit }
}

const pickOf = (p: Awaited<ReturnType<typeof start>>, sid: string) => p.state.get(sid)?.model
const IMMEDIATELY = { retry: true, delay: 0 }
const quota = { type: "provider.quota", message: "Free usage exceeded, subscribe to Go", status: 429 }

beforeEach(() => {
  for (const f of fs.readdirSync(DIR)) fs.rmSync(file(f), { recursive: true, force: true })
  writeJSON("ranking.json", { models: [{ id: "opencode/a-free" }, { id: "opencode/b-free" }, { id: "opencode/c-free" }] })
})

after(() => fs.rmSync(DIR, { recursive: true, force: true }))

test("free/auto gets the best free model, which then sticks to the session and is kept in its metadata", async () => {
  const p = await start({ sessions: { s1: {}, s2: {}, s4: { model: ref("openai/gpt") } } })
  await p.prompt("s1")
  assert.deepEqual(p.calls.switches, [{ sessionID: "s1", model: ref("opencode/a-free") }], "no variant: the placeholder's means nothing to a real model")
  assert.equal(readState().sessions.s1?.model, "opencode/a-free")
  assert.deepEqual(p.state.get("s1")?.metadata, { freeRouter: { pick: "opencode/a-free" } })
  assert.match(logText(), /pick s1 -> opencode\/a-free\n/)

  // A newer ranking does not move a session that already has a healthy model, and does not touch it again.
  writeJSON("ranking.json", { models: [{ id: "opencode/b-free" }, { id: "opencode/a-free" }] })
  fs.utimesSync(file("ranking.json"), new Date(), new Date(Date.now() + 5000))
  await p.prompt("s1")
  assert.equal(p.calls.switches.length, 1)
  assert.equal(p.calls.updates.length, 1)
  assert.equal(count(logText(), "pick "), 1)
  await p.prompt("s2")
  assert.equal(pickOf(p, "s2")?.id, "b-free", "new sessions follow the new ranking")
  assert.equal(p.calls.list, 1, "the model list is cached")

  // Anything else is left alone, including its errors.
  await p.prompt("s4")
  assert.equal(p.calls.switches.length, 2)
  assert.deepEqual(await p.retry("s4", { model: "openai/gpt", status: 401, type: "provider.auth", message: "Unauthorized", retry: false }), { retry: false })
  assert.equal(readState().sessions.s4, undefined)
  assert.deepEqual(readState().cooldowns, {})
})

test("existing metadata is kept when the pick is recorded", async () => {
  const p = await start({ sessions: { s1: { metadata: { mine: { n: 1 } } } } })
  await p.prompt("s1")
  assert.deepEqual(p.state.get("s1")?.metadata, { mine: { n: 1 }, freeRouter: { pick: "opencode/a-free" } })
})

test("a session is routed while on its pick, even after the sticky record expired, until the user picks another model", async () => {
  // The sticky record is gone, but the metadata remembers the pick: still ours, so it is picked again.
  const p = await start({ sessions: { s1: { model: ref("opencode/b-free"), metadata: { freeRouter: { pick: "opencode/b-free" } } } } })
  await p.prompt("s1")
  assert.equal(pickOf(p, "s1")?.id, "a-free")
  assert.equal(p.calls.switches.length, 1)

  // /model to another model: it is neither free/auto nor the pick, so routing ends there.
  const q = await start({ sessions: { s2: { model: ref("opencode/c-free"), metadata: { freeRouter: { pick: "opencode/b-free" } } } } })
  await q.prompt("s2")
  assert.equal(q.calls.switches.length, 0)
  assert.deepEqual(await q.retry("s2", { model: "opencode/c-free" }), { retry: true, delay: 900_000 }, "its failures are opencode's business")
  assert.equal(readState().sessions.s2, undefined)
  assert.deepEqual(readState().cooldowns, {})

  // /model free/auto rejoins.
  q.state.set("s2", { ...q.state.get("s2"), model: ref(FREE_AUTO) })
  await q.prompt("s2")
  assert.equal(pickOf(q, "s2")?.id, "a-free")
})

test("children and forks follow the pick of the session they came from", async () => {
  writeJSON("state.json", { cooldowns: {}, sessions: { parent: { model: "opencode/b-free", at: Date.now() } } })
  const p = await start({
    sessions: {
      parent: { model: ref("opencode/b-free") },
      child: { parentID: "parent", model: ref("opencode/b-free") },
      other: { parentID: "parent", model: ref("opencode/c-free") },
      fork: { fork: { sessionID: "parent" }, model: ref("opencode/b-free") },
      free: { parentID: "parent", model: ref(FREE_AUTO) },
    },
  })
  await p.prompt("child")
  assert.equal(pickOf(p, "child")?.id, "a-free", "managed: it runs on its parent's pick, so it gets a pick of its own")
  await p.prompt("fork")
  assert.equal(pickOf(p, "fork")?.id, "a-free")
  await p.prompt("other")
  assert.equal(pickOf(p, "other")?.id, "c-free", "a model of its own choosing stays")
  await p.prompt("free")
  assert.equal(pickOf(p, "free")?.id, "a-free", "free/auto is always ours")

  // A child that never saw the prompt hook (its first action was a command) still fails over.
  const q = await start({ sessions: { parent: { model: ref("opencode/a-free") }, kid: { parentID: "parent", model: ref("opencode/a-free") } } })
  writeJSON("state.json", { cooldowns: {}, sessions: { parent: { model: "opencode/a-free", at: Date.now() } } })
  assert.deepEqual(await q.retry("kid"), IMMEDIATELY)
  assert.equal(pickOf(q, "kid")?.id, "b-free")
  assert.equal(readState().cooldowns["opencode/a-free"]?.klass, "rate")
})

test("a message that arrives while a turn runs changes nothing", async () => {
  const p = await start({ sessions: { s1: {} } })
  await p.emit("session.execution.started", "s1")
  await p.prompt("s1")
  assert.equal(p.calls.switches.length, 0, "a steer or queued message: the session is on its pick already")
  await p.emit("session.execution.succeeded", "s1")
  await p.prompt("s1")
  assert.equal(p.calls.switches.length, 1)

  for (const end of ["session.execution.failed", "session.execution.interrupted", "session.idle"]) {
    await p.emit("session.execution.started", "s1")
    await p.emit(end, "s1")
    p.state.set("s1", { model: ref(FREE_AUTO) })
    await p.prompt("s1")
    assert.equal(pickOf(p, "s1")?.id, "a-free", end)
  }
  await p.emit("server.connected", "s1")
  await p.emit("session.text.started", "nobody")
})

test("no free model leaves free/auto in place and fails fast", async () => {
  const none = await start({ models: [], sessions: { s1: {} } })
  await none.prompt("s1")
  await none.prompt("s1")
  assert.equal(none.calls.list, 2, "an empty model list is not cached")
  assert.equal(none.calls.switches.length, 0)
  assert.deepEqual(await none.retry("s1", { model: FREE_AUTO, type: "provider.transport", status: undefined as never }), { retry: false })
  assert.equal(fs.existsSync(file("state.json")), false)

  const broken = await start({ models: new Error("server down"), sessions: { s1: {} } })
  await broken.prompt("s1")
  const log = logText()
  assert.match(log, /prompt hook failed s1: server down\n/)
  assert.equal(count(log, "ERROR no free model available for s1; free/auto left in place"), 3)
})

test("free/auto reaching the retry hook (a command the prompt hook never routed) is picked there", async () => {
  const p = await start({ sessions: { s1: {} } })
  const decision = await p.retry("s1", { model: FREE_AUTO, type: "provider.transport", message: "ConnectionRefused", status: undefined as never })
  assert.deepEqual(decision, IMMEDIATELY)
  assert.deepEqual(p.calls.switches, [{ sessionID: "s1", model: ref("opencode/a-free") }])
  assert.equal(readState().sessions.s1?.model, "opencode/a-free")
  assert.deepEqual(readState().cooldowns, {}, "the placeholder is not a failed model")
})

test("a failure that exhausts the model switches in place and retries at once", async () => {
  const p = await start({ sessions: { s1: {} } })
  await p.prompt("s1")
  await p.emit("session.execution.started", "s1")

  // A short rate limit: opencode's own retry is left alone.
  const wait = await p.retry("s1", { delay: 3000 })
  assert.deepEqual(wait, { retry: true, delay: 3000 })
  assert.match(logText(), /retry s1 attempt 2: Rate limit exceeded \(letting opencode retry\)\n/)

  const decision = await p.retry("s1", { ...quota, body: '{"error":{"message":"secret-body"}}' })
  assert.deepEqual(decision, IMMEDIATELY)
  const state = readState()
  assert.equal(state.cooldowns["opencode/a-free"]?.klass, "quota")
  assert.equal(state.cooldowns["opencode/a-free"]?.reason, "Free usage exceeded, subscribe to Go")
  assert.equal(state.sessions.s1?.model, "opencode/b-free")
  assert.deepEqual(p.calls.switches.at(-1), { sessionID: "s1", model: ref("opencode/b-free") })
  assert.deepEqual(p.state.get("s1")?.metadata, { freeRouter: { pick: "opencode/b-free" } })
  assert.match(logText(), /failover s1: opencode\/a-free -> opencode\/b-free \(quota: Free usage exceeded, subscribe to Go\)\n/)
  assert.ok(!logText().includes("secret-body") && !fs.readFileSync(file("state.json"), "utf8").includes("secret-body"), "the response body is only read, never kept")
})

test("long messages are cut before they are kept", async () => {
  const p = await start({ sessions: { s1: {} } })
  await p.prompt("s1")
  await p.retry("s1", { ...quota, message: `Free usage exceeded ${"x".repeat(500)}` })
  assert.equal(readState().cooldowns["opencode/a-free"]?.reason?.length, 200)
  assert.ok(logText().split("\n").every((l) => l.length < 260))
})

test("auth failures cool the whole provider", async () => {
  const p = await start({ sessions: { s1: {} } })
  await p.prompt("s1")
  assert.deepEqual(await p.retry("s1", { type: "provider.auth", message: "Unauthorized", status: 401, retry: false }), IMMEDIATELY)
  const state = readState()
  assert.equal(state.cooldowns["opencode/*"]?.klass, "auth")
  assert.equal(state.cooldowns["opencode/*"]?.reason, "Unauthorized")
  assert.equal(state.sessions.s1?.model, "opencode/b-free", "every model is cooling, so the one that frees up first")
  assert.match(logText(), /WARN all free models are cooling down; using the one that frees up first: opencode\/b-free\n/)
})

test("failures are counted from the last switch", async () => {
  const p = await start({ sessions: { s1: {} } })
  await p.prompt("s1")
  await p.emit("session.execution.started", "s1")
  // opencode's first failure is attempt 2; one 429 there is a transient one.
  assert.deepEqual(await p.retry("s1", { attempt: 2, delay: 3000 }), { retry: true, delay: 3000 })
  assert.equal(p.calls.switches.length, 1)
  assert.equal((await p.retry("s1", { attempt: 3, delay: 3000 })).delay, 0, "the second one in a row is not")
  assert.equal(pickOf(p, "s1")?.id, "b-free")

  // The counter does not restart on the new model: attempt 4 is its first failure, and a transient one.
  assert.deepEqual(await p.retry("s1", { model: "opencode/b-free", attempt: 4, delay: 3000 }), { retry: true, delay: 3000 })
  assert.equal(pickOf(p, "s1")?.id, "b-free")
  // A counter behind the switch (clamped to 1) does not fail over either.
  assert.deepEqual(await p.retry("s1", { model: "opencode/b-free", attempt: 1, delay: 3000 }), { retry: true, delay: 3000 })
  assert.deepEqual(await p.retry("s1", { model: "opencode/b-free", attempt: 5, delay: 3000 }), IMMEDIATELY)
  assert.equal(pickOf(p, "s1")?.id, "c-free")
})

test("two failures of the same model switch once, the late one is retried on the new model", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const p = await start({ sessions: { s1: {} }, switchModel: async ({ model }) => (model.id === "b-free" ? gate : undefined) })
  await p.prompt("s1")
  await p.emit("session.execution.started", "s1")
  const first = p.retry("s1", quota)
  const second = p.retry("s1", { ...quota, message: "Free usage exceeded again" })
  await settle()
  release()
  assert.deepEqual(await first, IMMEDIATELY)
  assert.deepEqual(await second, IMMEDIATELY, "the first late one is retried; the session is on the new pick")
  assert.equal(count(logText(), "failover "), 1)
  assert.equal(p.calls.switches.filter((s) => s.model.id === "b-free").length, 1)
  assert.equal(readState().cooldowns["opencode/a-free"]?.reason, "Free usage exceeded, subscribe to Go", "the late one adds no cooldown")
})

test("a request left on a model the session switched away from is retried once, then let fail", async () => {
  // The primary request's failure switches first; an auxiliary request (a compaction keeps the model
  // it started with) fails on the old model afterwards.
  const p = await start({ sessions: { s1: {} } })
  await p.prompt("s1")
  await p.emit("session.execution.started", "s1")
  assert.deepEqual(await p.retry("s1", quota), IMMEDIATELY)
  assert.deepEqual(await p.retry("s1", { ...quota, attempt: 3 }), IMMEDIATELY, "the first one may be the primary request that lost the race")
  assert.deepEqual(await p.retry("s1", { ...quota, attempt: 4 }), { retry: false }, "the next ones only hit the provider that just failed")
  assert.deepEqual(await p.retry("s1", { ...quota, attempt: 5 }), { retry: false })
  assert.equal(count(logText(), "failover "), 1, "one switch, no more")
  assert.equal(p.calls.switches.filter((s) => s.model.id === "b-free").length, 1)
  assert.equal(Object.keys(readState().cooldowns).length, 1, "no cooldown for the late ones")

  // A new execution starts over.
  await p.emit("session.execution.started", "s1")
  assert.deepEqual(await p.retry("s1", { ...quota, model: "opencode/b-free" }), IMMEDIATELY)
  assert.equal(count(logText(), "failover "), 2)
})

test("a session that comes back to a model it left fails over from it again", async () => {
  writeJSON("config.json", { maxSwitchesPerTurn: 3 })
  const p = await start({ models: [listed("opencode/a-free"), listed("opencode/b-free")], sessions: { s1: {} } })
  await p.prompt("s1")
  await p.emit("session.execution.started", "s1")
  assert.deepEqual(await p.retry("s1", quota), IMMEDIATELY)
  assert.equal(pickOf(p, "s1")?.id, "b-free")
  // Only A is left to go to; it is cooling, but it is all there is.
  assert.deepEqual(await p.retry("s1", { ...quota, model: "opencode/b-free", attempt: 3 }), IMMEDIATELY)
  assert.equal(pickOf(p, "s1")?.id, "a-free", "back on A")
  assert.deepEqual(await p.retry("s1", { ...quota, attempt: 4 }), IMMEDIATELY)
  assert.equal(pickOf(p, "s1")?.id, "b-free", "A is a pick again, not a model the session left: it fails over")
  assert.equal(count(logText(), "failover "), 3)
})

test("an auxiliary failure that switches first leaves the primary's failure on the old model one retry", async () => {
  const p = await start({ sessions: { s1: {} } })
  await p.prompt("s1")
  await p.emit("session.execution.started", "s1")
  assert.deepEqual(await p.retry("s1", quota), IMMEDIATELY, "the auxiliary request: switches")
  assert.equal(pickOf(p, "s1")?.id, "b-free")
  assert.deepEqual(await p.retry("s1", { ...quota, attempt: 2 }), IMMEDIATELY, "the primary request: retried, and runs on the new pick")
  assert.deepEqual(await p.retry("s1", { ...quota, attempt: 3 }), { retry: false }, "a third failure on the old model")
  assert.equal(count(logText(), "failover "), 1)
  assert.equal(p.calls.switches.filter((s) => s.model.id === "b-free").length, 1)
})

test("free/auto reaching the retry hook twice in one execution is retried once", async () => {
  const p = await start({ sessions: { s1: {} } })
  await p.emit("session.execution.started", "s1")
  const dead = { model: FREE_AUTO, type: "provider.transport", message: "ConnectionRefused", status: undefined as never }
  assert.deepEqual(await p.retry("s1", dead), IMMEDIATELY)
  assert.deepEqual(await p.retry("s1", { ...dead, attempt: 3 }), { retry: false }, "still on free/auto: the pick did not take")
  assert.equal(p.calls.switches.length, 1)
  await p.emit("session.execution.started", "s1")
  assert.deepEqual(await p.retry("s1", { ...dead, attempt: 2 }), IMMEDIATELY, "a new execution may pick again")
})

test("a failover that stops half-way leaves the error to surface, not opencode's wait, and still spends the budget", async () => {
  writeJSON("config.json", { maxSwitchesPerTurn: 1 })
  const p = await start({
    sessions: { s1: {} },
    update: async () => {
      if (p.calls.switches.length > 1) throw new Error("metadata down")
    },
  })
  await p.prompt("s1")
  const decision = await p.retry("s1", quota)
  assert.deepEqual(decision, { retry: false }, "not the 15 minutes opencode would wait on a 429")
  assert.equal(readState().cooldowns["opencode/a-free"]?.klass, "quota", "the model stays cooled")
  assert.equal(pickOf(p, "s1")?.id, "b-free", "the switch itself went through")
  assert.match(logText(), /retry hook failed s1: metadata down\n/)
  assert.doesNotMatch(logText(), /failover s1/)

  // The switch counted: the model it left is marked left, and the budget is spent.
  assert.deepEqual(await p.retry("s1", { ...quota, attempt: 3 }), IMMEDIATELY, "a late request on the old model is retried once")
  assert.deepEqual(await p.retry("s1", { ...quota, model: "opencode/b-free" }), { retry: false })
  assert.match(logText(), /give up s1: already switched 1 times this turn; leaving opencode\/b-free/)
})

test("a half-done switch back to a model the session left does not leave that model marked left", async () => {
  writeJSON("config.json", { maxSwitchesPerTurn: 3 })
  let fail = false
  const p = await start({
    models: [listed("opencode/a-free"), listed("opencode/b-free")],
    sessions: { s1: {} },
    switchModel: async () => {
      if (fail) throw new Error("switch down")
    },
    update: async () => {
      if (fail) throw new Error("metadata down")
    },
  })
  await p.prompt("s1")
  await p.emit("session.execution.started", "s1")
  assert.deepEqual(await p.retry("s1", quota), IMMEDIATELY)
  fail = true
  // Back to A, and the metadata write stops it half-way (the switch itself went through only if it ran).
  assert.deepEqual(await p.retry("s1", { ...quota, model: "opencode/b-free", attempt: 3 }), { retry: false })
  fail = false
  p.state.set("s1", { ...p.state.get("s1"), model: ref("opencode/a-free") })
  writeJSON("state.json", { cooldowns: {}, sessions: { s1: { model: "opencode/a-free", at: Date.now() } } })
  assert.deepEqual(await p.retry("s1", { ...quota, attempt: 4 }), IMMEDIATELY)
  assert.equal(pickOf(p, "s1")?.id, "b-free", "A is a pick, not a model the session left: it fails over")
})

test("a switch that is refused leaves the session where it was, spends the budget and marks the model left", async () => {
  writeJSON("config.json", { maxSwitchesPerTurn: 1 })
  let fail = false
  const p = await start({
    sessions: { s1: {} },
    switchModel: async () => {
      if (fail) throw new Error("switch down")
    },
  })
  await p.prompt("s1")
  fail = true
  assert.deepEqual(await p.retry("s1", quota), { retry: false })
  assert.equal(pickOf(p, "s1")?.id, "a-free", "still on the model it was on")
  assert.match(logText(), /retry hook failed s1: switch down\n/)
  assert.doesNotMatch(logText(), /failover s1/)

  // Marked left: its next failure is retried once, then let fail.
  assert.deepEqual(await p.retry("s1", { ...quota, attempt: 3 }), IMMEDIATELY)
  assert.deepEqual(await p.retry("s1", { ...quota, attempt: 4 }), { retry: false })

  // Spent: a failure on another pick of the session gives up without trying to switch.
  writeJSON("state.json", { cooldowns: {}, sessions: { s1: { model: "opencode/c-free", at: Date.now() } } })
  fail = false
  assert.deepEqual(await p.retry("s1", { ...quota, model: "opencode/c-free", attempt: 5 }), { retry: false })
  assert.match(logText(), /give up s1: already switched 1 times this turn; leaving opencode\/c-free/)
})

test("a deleted parent or fork source is nobody's pick", async () => {
  const p = await start({
    deleted: ["gone"],
    sessions: { child: { parentID: "gone", model: ref("opencode/b-free") }, fork: { fork: { sessionID: "gone" }, model: ref("opencode/b-free") }, free: { parentID: "gone", model: ref(FREE_AUTO) } },
  })
  await p.prompt("child")
  await p.prompt("fork")
  assert.equal(p.calls.switches.length, 0, "not ours: it runs on a model nobody picked")
  assert.deepEqual(await p.retry("child", { model: "opencode/b-free" }), { retry: true, delay: 900_000 })
  await p.prompt("free")
  assert.equal(pickOf(p, "free")?.id, "a-free", "free/auto is ours whatever its parent")
  assert.doesNotMatch(logText(), /hook failed/)
  assert.match(logText(), /session gone lookup failed: no session gone\n/, "the lookup that failed is logged")
})

test("a retry waits for the one before it on the session, but not for longer than 30 seconds", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] })
  t.after(() => mock.timers.reset())
  let first = true
  const p = await start({
    sessions: { s1: {} },
    // The first switch never comes back.
    switchModel: async ({ model }) => {
      if (model.id === "b-free" && first) {
        first = false
        await new Promise(() => {})
      }
    },
  })
  await p.prompt("s1")
  void p.retry("s1", quota)
  await settle()
  let second: unknown
  void p.retry("s1", { ...quota, message: "Free usage exceeded again" }).then((d) => (second = d))
  await settle()
  assert.equal(second, undefined, "queued behind the hung one")
  mock.timers.tick(29_000)
  await settle()
  assert.equal(second, undefined)
  mock.timers.tick(1_000)
  await settle()
  assert.deepEqual(second, IMMEDIATELY, "ran anyway")
})

test("a deleted session is forgotten", async () => {
  const p = await start({ sessions: { s1: {} } })
  await p.emit("session.execution.started", "s1")
  await p.prompt("s1")
  assert.equal(p.calls.switches.length, 0, "busy")
  await p.emit("session.deleted", "s1")
  await p.prompt("s1")
  assert.equal(p.calls.switches.length, 1, "its turn record is gone, so it is not busy")
})

test("hook failures are logged cut to 200 characters with a few stack frames", async () => {
  const p = await start({
    sessions: { s1: {} },
    switchModel: async () => {
      throw new Error(`server said ${"x".repeat(500)}`)
    },
  })
  await p.prompt("s1")
  const lines = logText().split("\n").filter(Boolean)
  assert.ok(lines.every((l) => l.length < 400))
  assert.match(lines[0] ?? "", /prompt hook failed s1: server said x{188}$/)
  assert.ok(lines.length >= 2 && lines.length <= 4, "the failure and at least one, at most three, frames")
  assert.ok(lines.slice(1).every((l) => /^ {4}at /.test(l)))
})

test("failovers stop at maxSwitchesPerTurn and when nothing else is left; a new execution gets a new budget", async () => {
  writeJSON("config.json", { maxSwitchesPerTurn: 1 })
  const gone = { type: "provider.invalid-request", message: "model not found", status: 404, retry: false }
  const p = await start({ sessions: { s1: {} } })
  await p.prompt("s1")
  await p.emit("session.execution.started", "s1")
  assert.deepEqual(await p.retry("s1", gone), IMMEDIATELY)
  assert.equal(readState().cooldowns["opencode/a-free"]?.reason, "model not found")

  // Spent: the error surfaces now instead of sleeping, and the model is still cooled.
  assert.deepEqual(await p.retry("s1", { ...gone, model: "opencode/b-free", attempt: 3 }), { retry: false })
  assert.match(logText(), /give up s1: already switched 1 times this turn; leaving opencode\/b-free \(unavailable\)\n/)
  assert.ok(readState().cooldowns["opencode/b-free"])
  assert.equal(readState().sessions.s1?.model, "opencode/b-free")

  // A queued message starts a new execution, and with it a new budget.
  await p.emit("session.execution.succeeded", "s1")
  await p.emit("session.execution.started", "s1")
  assert.deepEqual(await p.retry("s1", { ...gone, model: "opencode/b-free", attempt: 2 }), IMMEDIATELY)
  assert.equal(readState().sessions.s1?.model, "opencode/c-free")

  const lone = await start({ models: [listed("opencode/a-free")], sessions: { s2: {} } })
  await lone.prompt("s2")
  assert.deepEqual(await lone.retry("s2", gone), { retry: false })
  assert.match(logText(), /no alternative for s2; staying on opencode\/a-free \(unavailable\)\n/)
})

test("when the event stream ends the next prompt starts a fresh turn", async () => {
  writeJSON("config.json", { maxSwitchesPerTurn: 1 })
  const p = await start({ sessions: { s1: {} } })
  await p.prompt("s1")
  await p.emit("session.execution.started", "s1")
  assert.deepEqual(await p.retry("s1", quota), IMMEDIATELY)
  assert.deepEqual(await p.retry("s1", { ...quota, model: "opencode/b-free", attempt: 3 }), { retry: false }, "budget spent")

  // The stream dies while the session looks busy; its next message must still be routed and failed over.
  p.feed.end()
  await settle()
  await p.prompt("s1")
  assert.equal(pickOf(p, "s1")?.id, "c-free", "b-free is cooling, so the new turn starts on the next one")
  assert.deepEqual(await p.retry("s1", { ...quota, model: "opencode/c-free", attempt: 2 }), IMMEDIATELY)
  assert.equal(count(logText(), "failover "), 2, "the earlier switch did not use up the new turn's budget")
})

test("a command-first session (no prompt hook) with only its metadata pick still fails over", async () => {
  const p = await start({ sessions: { s1: { model: ref("opencode/a-free"), metadata: { freeRouter: { pick: "opencode/a-free" } } } } })
  assert.equal(readState().sessions.s1, undefined, "the sticky record is gone")
  assert.deepEqual(await p.retry("s1"), IMMEDIATELY)
  assert.equal(pickOf(p, "s1")?.id, "b-free")
})

test("autoContinue off switches the model but leaves the next message to the user", async () => {
  writeJSON("config.json", { autoContinue: false })
  const p = await start({ sessions: { s1: {} } })
  await p.prompt("s1")
  await p.emit("session.execution.started", "s1")
  assert.deepEqual(await p.retry("s1"), { retry: false })
  assert.match(logText(), /switched s1 to opencode\/b-free; autoContinue off, next message will use it\n/)
  assert.deepEqual(await p.retry("s1", { attempt: 3 }), { retry: false }, "nothing retries on the old model mid-turn either")
  assert.equal(readState().sessions.s1?.model, "opencode/b-free")
})

test("what is not the model's fault is left to opencode", async () => {
  const p = await start({ sessions: { s1: {} } })
  await p.prompt("s1")
  const overflow = { type: "provider.invalid-request", message: "context_length_exceeded", status: 400 }
  assert.deepEqual(await p.retry("s1", overflow), { retry: true, delay: 900_000 })
  assert.deepEqual(await p.retry("s1", { ...overflow, retry: false }), { retry: false })
  assert.deepEqual(readState().cooldowns, {})
  assert.equal(p.calls.switches.length, 1)
})

test("model list, switch and metadata failures are logged, never thrown", async () => {
  const p = await start({
    sessions: { s1: {}, s2: {} },
    switchModel: async ({ sessionID }) => {
      if (sessionID === "s2") throw new Error("switch down")
    },
  })
  await p.prompt("s2")
  assert.match(logText(), /prompt hook failed s2: switch down\n {4}at /)
  await p.prompt("s1")
  assert.equal(await p.retry("s2", { model: FREE_AUTO }).then(() => "returned"), "returned")
  assert.match(logText(), /retry hook failed s2: switch down\n/)

  const q = await start({ models: new Error("list down"), sessions: { s3: { model: ref("opencode/a-free"), metadata: { freeRouter: { pick: "opencode/a-free" } } } } })
  assert.equal(await q.retry("s3").then(() => "returned"), "returned")
  assert.match(logText(), /retry hook failed s3: list down\n/)
})

test("a throwing event handler is logged by type and message only", async () => {
  const p = await start({ sessions: {} })
  const secret = "PROMPT-TEXT-THE-USER-TYPED"
  p.feed.push({
    type: "session.execution.started",
    get data(): never {
      throw new Error(`boom ${"x".repeat(400)}`)
    },
    payload: secret,
  })
  await settle()
  const log = logText()
  assert.match(log, /event session\.execution\.started failed: boom x+\n/)
  assert.ok(!log.includes(secret))
  assert.ok(log.split("\n").every((l) => l.length < 300))
  // The loop survives it.
  await p.emit("session.execution.started", "s1")
  await p.prompt("s1")
  assert.equal(p.calls.switches.length, 0)
})

test("a failing event stream is logged and leaves every session not busy", async () => {
  const p = await start({
    sessions: { s1: {} },
    subscribe: async function* () {
      yield { type: "session.execution.started", data: { sessionID: "s1" } }
      throw new Error(`stream down ${"x".repeat(400)}`)
    },
  })
  await settle()
  assert.match(logText(), /event stream failed: stream down x+\n/)
  assert.ok(logText().split("\n").every((l) => l.length < 300))
  await p.prompt("s1")
  assert.equal(p.calls.switches.length, 1, "routed although the stream said the turn was running")
})

test("cleanup stops the event stream and disposes both hooks", async () => {
  const p = await start()
  await p.cleanup?.()
  assert.deepEqual(p.disposed.sort(), ["prompt", "retry"])
  assert.equal(p.feed.aborted, true)
})

test("a stale ranking is refreshed in the background, one run at a time", async (t) => {
  const bin = file("bin")
  fs.mkdirSync(bin)
  const runtime = (name: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" > "$FREE_ROUTER_DIR/spawned"\n`, { mode: 0o755 })
  const savedPath = process.env.PATH
  process.env.PATH = `${path.join(DIR, "nowhere")}${path.delimiter}${bin}`
  t.after(() => {
    process.env.PATH = savedPath
    delete process.env.FREE_ROUTER_RANKING
  })
  const lock = file("rank.lock")
  const refreshes = () => count(logText(), "refreshing ranking in the background")
  // The shell creates the file before it writes the line, so wait for the whole line.
  const spawned = () => (fs.existsSync(file("spawned")) ? fs.readFileSync(file("spawned"), "utf8") : "")

  // Fresh ranking: nothing to do.
  runtime("node")
  await start()
  assert.equal(fs.existsSync(lock), false)

  // rank.mts's own opencode must not start another ranking.
  fs.utimesSync(file("ranking.json"), new Date(0), new Date(0))
  process.env.FREE_ROUTER_RANKING = "1"
  await start()
  assert.equal(fs.existsSync(lock), false)
  delete process.env.FREE_ROUTER_RANKING

  await start()
  assert.equal(refreshes(), 1)
  assert.equal(fs.statSync(file("router.log")).mode & 0o777, 0o600, "a log the refresh created is private")
  assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid))
  await until(() => spawned().endsWith("\n"), "rank.mts spawn")
  assert.equal(spawned(), `node ${file("rank.mts")} --quiet --lock ${lock}\n`)

  await start()
  assert.equal(refreshes(), 1, "a live lock blocks a second run")

  fs.rmSync(file("spawned"))
  fs.rmSync(path.join(bin, "node"))
  runtime("bun")
  const old = new Date(Date.now() - 11 * 60e3)
  fs.utimesSync(lock, old, old)
  fs.rmSync(file("ranking.json"))
  await start()
  assert.equal(refreshes(), 2, "an abandoned lock is taken over")
  await until(() => spawned().endsWith("\n"), "bun spawn")
  assert.match(spawned(), /^bun /)

  fs.rmSync(path.join(bin, "bun"))
  fs.rmSync(lock)
  await start()
  assert.equal(fs.existsSync(lock), false, "lock released when there is nothing to run rank.mts with")
  assert.match(logText(), /WARN ranking is stale but neither node nor bun is on PATH; run rank\.mts manually\n/)

  fs.mkdirSync(lock)
  fs.utimesSync(lock, old, old)
  await start()
  assert.match(logText(), /refresh check failed: EISDIR/)
})

test("a log from an older install is made private, at startup and when it rotates", async () => {
  fs.writeFileSync(file("router.log"), "old\n")
  fs.chmodSync(file("router.log"), 0o644)
  await start()
  assert.equal(fs.statSync(file("router.log")).mode & 0o777, 0o600)

  fs.writeFileSync(file("router.log"), "x".repeat((1 << 20) + 1))
  fs.chmodSync(file("router.log"), 0o644)
  const p = await start({ models: [], sessions: { s1: {} } })
  fs.chmodSync(file("router.log"), 0o644)
  await p.prompt("s1")
  assert.equal(fs.statSync(file("router.log.1")).mode & 0o777, 0o600, "the rotated copy")
  assert.equal(fs.statSync(file("router.log")).mode & 0o777, 0o600)
})

test("the log rotates past 1 MiB and a broken log never breaks the plugin", async () => {
  fs.writeFileSync(file("router.log"), "x".repeat((1 << 20) + 1))
  const p = await start({ models: [], sessions: { s1: {} } })
  await p.prompt("s1")
  assert.equal(fs.statSync(file("router.log.1")).size, (1 << 20) + 1)
  assert.match(logText(), /^\S+ ERROR no free model available for s1/)

  fs.rmSync(file("router.log"))
  fs.mkdirSync(file("router.log"))
  await p.prompt("s1")
})
