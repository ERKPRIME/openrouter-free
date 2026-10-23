# opencode-free-router

[![ci](https://github.com/ERKPRIME/openrouter-free/actions/workflows/ci.yml/badge.svg)](https://github.com/ERKPRIME/openrouter-free/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/openrouter-free.svg)](https://www.npmjs.com/package/openrouter-free)
[![npm downloads](https://img.shields.io/npm/dm/openrouter-free.svg)](https://www.npmjs.com/package/openrouter-free)
[![Coverage Status](https://coveralls.io/repos/github/ERKPRIME/openrouter-free/badge.svg?branch=master)](https://coveralls.io/github/ERKPRIME/openrouter-free?branch=master)

> **Recommended:** `npm install -g openrouter-free` then run `openrouter-free` from any directory. [View on npm](https://www.npmjs.com/package/openrouter-free)

An [opencode](https://opencode.ai) plugin that always runs on the **best free model available right
now**, so you never have to track which free models exist this week.

You pick one model, `free/auto`, and the plugin does the rest:

- **Ranked, not random.** Every free model opencode can reach is scored with
  [LMArena](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset) (agent, webdev and text
  boards) and [Artificial Analysis](https://artificialanalysis.ai) (coding, agentic and intelligence
  indices). New stealth models with no benchmarks yet, like the ones OpenRouter and OpenCode Zen run
  for a week, are detected and placed near the top.
- **Sticky.** A session keeps its model. It does not switch on every request. When a better model
  appears, new sessions get it.
- **Fails over.** When the model hits its quota or rate limit, is removed, or is refused, it goes on
  cooldown and the session moves to the next-ranked model. The interrupted task continues
  automatically, in the same turn.
- **Only free.** Free providers are an explicit allowlist, and each pick is re-checked against live
  provider data. Subscription plans that report a price of 0 are never used.

```text
$ npm install -g openrouter-free
$ openrouter-free run "explain this repo"
> build · space-bunny-free
```

This repository is the Windows-native adaptation of
[lettland/opencode-free-router](https://github.com/lettland/opencode-free-router). It keeps the
original Linux/macOS behavior and adds first-class native Windows support. Read the
[Spanish README](README.es.md). Published on npm as [`openrouter-free`](https://www.npmjs.com/package/openrouter-free).

**Quick start (npm):** `npm install -g openrouter-free && openrouter-free`

Requires **opencode 2** (`opencode --version` says 2.x) and Node 22.18+ (or Bun), on macOS, Linux or
Windows. The code is TypeScript and ships as source: opencode loads the plugin directly, and Node
22.18+ or Bun runs the ranker without a build step.

If you upgrade opencode from 1.x to 2, run the installer again: the 1.x plugin does not load on 2, and
it moves the `plugin` entry of your `free.jsonc` to the `plugins` entry opencode 2 reads.

### npm (recommended)

```sh
npm install -g openrouter-free
openrouter-free
```

The first run creates the data directory, ranks the free models and opens the TUI. Nothing is written
inside `node_modules`: the CLI mirrors the code it runs into your data directory, because Node refuses
to strip types under `node_modules` and `rank.mts` is TypeScript.

On Windows, `npm install -g` works from PowerShell or Command Prompt and installs an
`openrouter-free.cmd` shim next to your global `node`. If the command is not found afterwards, the npm
global bin directory is not on `PATH`; `npm config get prefix` prints it.

Data lives in:

| Platform | Directory |
|---|---|
| Windows | `%APPDATA%\openrouter-free` |
| macOS | `~/Library/Application Support/openrouter-free` |
| Linux | `$XDG_CONFIG_HOME/openrouter-free`, else `~/.config/openrouter-free` |

Set `FREE_ROUTER_DIR` to use another directory. Provider keys go in `providers.env` there (optional:
keys you already have via `opencode auth login` work without it).

### From a checkout (`scripts/install.sh`)

The shell installer keeps everything, code included, in one directory: `~/.config/opencode/free-router`
(or `$XDG_CONFIG_HOME/…`, or `--dir PATH`). It runs the first ranking and links `opencode-free` into
`~/.local/bin` if that is on your `PATH`. Re-run it to upgrade. Your config, pins, keys and state are
never overwritten. It is a separate install from the npm package; use `FREE_ROUTER_DIR` to share one
data directory between them.

#### Windows (Command Prompt or PowerShell)

```bat
git clone https://github.com/ERKPRIME/openrouter-free.git
cd openrouter-free
install.cmd          # add --bb to also register a bb agent
```

```powershell
git clone https://github.com/ERKPRIME/openrouter-free.git
cd openrouter-free
.\install.ps1        # add -Bb to also register a bb agent
```

`install.cmd` and `install.ps1` only locate Git Bash and run `scripts/install.sh`; Git for Windows
ships one. If it is not found, run `scripts/install.sh` yourself with any POSIX shell (Git Bash, WSL).
On Windows the installer also writes `opencode-free.cmd` and `opencode-free.ps1` next to the POSIX
`opencode-free`, so the launcher works from Command Prompt and PowerShell without Git Bash.

#### macOS, Linux, Git Bash, or WSL

```sh
git clone https://github.com/ERKPRIME/openrouter-free.git
cd openrouter-free
./scripts/install.sh          # add --bb to also register a bb agent
```

To pin a release instead of tracking `master`, `git checkout vX.Y.Z` (see
[releases](https://github.com/ERKPRIME/openrouter-free/releases)) before running it.

### Running it

```sh
openrouter-free                # npm: TUI on free/auto
opencode-free                  # install.sh: the same launcher
openrouter-free run "..."      # one-shot
openrouter-free acp            # ACP agent (Zed, JetBrains, bb, ...)
openrouter-free doctor         # versions, paths, what is missing
openrouter-free rank --status  # ranking, cooldowns, model per session
```

`openrouter-free` is the same as `opencode-free`, and both are plain `opencode` with the free-router
config layered on top via `OPENCODE_CONFIG`. Your normal `opencode` is unaffected. opencode 2 commands
normally talk to a shared background service that ignores that variable, so the wrapper runs each of
them with its own private server (`--standalone`). Three consequences: `openrouter-free service` (and
`serve --service`) is refused; so are the commands that manage, restart or may auto-start that service
(`debug`, `pair`, `mcp`, `plugin`, `upgrade`, `update`, `uninstall`), because it could come up with the
free-router config and your provider keys, so run those as plain `opencode`; and a `run` message has to
be quoted, because an unquoted word `service` in it is refused too:

```sh
openrouter-free run "restart the service"    # not: openrouter-free run restart the service
```

The wrapper exits with `127` and a clear message when `opencode` is not on `PATH`. `--list-models`
still works in that case.

### Windows argument handling

The `.cmd` shim always runs the PowerShell launcher in a child process, so it does not leak
`OPENCODE_CONFIG` or `FREE_ROUTER_DIR` into your PowerShell session. The launcher quotes every
argument. These forms are supported and tested:

- spaces and non-ASCII paths/arguments;
- `&`, `|`, `<`, `>`, `^`, `!` inside an argument;
- embedded double quotes and empty arguments;
- arguments with trailing backslashes.

Known `cmd.exe` limitations, not bugs in the launcher:

- `%NAME%` is expanded by `cmd.exe` before the launcher sees it. Escape or avoid literal percent
  signs in arguments.
- Newlines cannot be passed through a `.cmd` argument.

The PowerShell launcher deliberately is not named `opencode-free.ps1`; it is installed as
`opencode-free-launcher.ps1`. PowerShell resolves a bare `.ps1` name in the current session, which
would leak the router environment into your shell. The `.cmd` shim is the only `opencode-free`
command.

## bb

On POSIX, `./scripts/install.sh --bb` registers a custom ACP agent **Free (auto)** (provider
`acp-free`) that runs `opencode-free acp`. Pick `free/auto` as its model. No other bb agent is
touched. If an older install shows only "Agent default" as the model, re-run `./scripts/install.sh
--bb`.

The native Windows installer has no `-bb` switch. To use bb on Windows, point an ACP agent at
`opencode-free.cmd acp` and select `free/auto`; re-running the Windows installer does not touch bb's
configuration.

A failover happens inside the running prompt, so bb sees one prompt answered by the new model; it
does not receive a queued "continue" message.

## Which free models

Without keys you get OpenCode Zen's free models. Each key you add grows the pool:

| Provider | Key | What counts as free |
|---|---|---|
| OpenCode Zen | none | models priced 0 (`*-free`, big-pickle, …) |
| OpenRouter | `OPENROUTER_API_KEY` | `:free` models (routers such as `openrouter/auto` are excluded) |
| NVIDIA | `NVIDIA_API_KEY` | models priced 0 on build.nvidia.com |
| Z.AI | `ZHIPU_API_KEY` | models priced 0 (GLM-4.7-Flash, GLM-4.5-Flash, GLM-4.6V-Flash) |
| Zhipu AI | `ZHIPU_API_KEY` | the same free GLM Flash models, for a China (BigModel) account |
| ModelScope | `MODELSCOPE_API_KEY` | all models (priced 0; 2,000 requests a day) |
| Mistral | `MISTRAL_API_KEY` | Devstral Small, Codestral and Mistral Small via the free Experiment plan |
| Groq | `GROQ_API_KEY` | all models via the free tier |
| Cerebras | `CEREBRAS_API_KEY` | all models via the free tier |
| Google AI Studio | `GOOGLE_GENERATIVE_AI_API_KEY` | Flash and Gemma models via the free tier |

Keys you already have through `opencode auth login` or your shell work automatically. Otherwise put
them in `~/.config/opencode/free-router/providers.env` (or the Windows install directory). This also
covers launches that do not read your shell profile, such as bb or GUI applications.

**Use free-plan accounts.** Groq, Cerebras, Google and Mistral models count as free because of their
free tiers, so a key with billing enabled may be charged.

Notes on the extra providers:

- **Z.AI / Zhipu.** The free GLM Flash models are free for every account, not trial credits. The
  catch is throughput: roughly one request at a time, about one a second. They are two separate
  platforms sharing one variable, `ZHIPU_API_KEY`: a z.ai key only works on `zai`, a BigModel
  (China) key only on `zhipuai`. The wrong endpoint returns 401 and that provider goes on a
  24-hour cooldown, so exactly one of the two reaches the pool.
- **ModelScope.** Everything it serves is free, with a quota of 2,000 requests a day (500 per model)
  and no card, but signup wants a phone number and the endpoint is fastest inside Asia.
- **Mistral.** The Experiment plan (no card, 1B tokens a month, 1 request a second) covers Devstral
  Small 2, Codestral and Mistral Small, but the catalog prices them, so the router matches them by
  name. Every Devstral entry Mistral lists is currently marked deprecated, including its only
  0-priced one, so the router skips those. The Devstral glob is there for the first current Devstral
  Small that appears. Tune the families in `config.json` if Mistral changes the plan:
  `{"mistral": ["$zero", "devstral-small*", "codestral*", "mistral-small*"]}`.

Left out on purpose, because a price of 0 there does not mean free: Cloudflare Workers AI (10,000
neurons a day, and the models its free plan dropped now answer 403, which would bench the whole
provider), Vercel AI Gateway (free credits need a payment method, and the catalog marks Llama models
as 0 that Vercel actually prices), Hugging Face ($0.10 of monthly credits), and the many gateway
clones that list every model at 0.

An optional `ARTIFICIAL_ANALYSIS_API_KEY` in `ranker.env` adds Artificial Analysis scores (free key,
100 requests a day; the ranker uses a few per refresh). Without it, ranking uses LMArena only.

`ranker.env` is read only by `rank.mts`. It is parsed into the ranker's own process environment and
is not exported to opencode or the agent's tools. The Artificial Analysis key is also removed from
the environment of the child process that lists models.

## How ranking works

`rank.mts` writes `ranking.json`. The plugin re-runs it in the background whenever the file is older
than `refreshHours` (6), one refresh at a time.

1. It lists the models opencode can reach (`opencode api --standalone model.list`) and keeps the ones
   that are free, can call tools, are enabled, and have at least 64k context. A model with several
   price tiers counts as free only if every tier is.
2. It matches each model against the leaderboards by name. `mimo-v2.6-flash` never matches
   `mimo-v2.6-pro`, and AA's `ling-3-0-flash-fin` matches `ling-3.0-flash-fin-free`.
3. Each source becomes a percentile. The score is the weighted mean over the sources that matched.
4. Models with no benchmarks: stealth models (OpenRouter's `stealth/` listing) score `stealthScore`
   (0.95). Others score about 0.25–0.35, less for small models, so an unknown 2B preview never beats
   a benchmarked model.

```sh
node %APPDATA%\openrouter-free\rank.mts --status    # npm on Windows
node ~/.config/openrouter-free/rank.mts --status   # npm on Linux
node "$HOME/Library/Application Support/openrouter-free/rank.mts" --status  # npm on macOS
node ~/.config/opencode/free-router/rank.mts --status  # scripts/install.sh
```

Commands:

```text
Usage: rank.mts [options]

  (no options)             refresh ranking.json and print a one-line summary
  --status                 print ranking.json, cooldowns and recent session picks
  --quiet                  refresh, printing only warnings
  --config <free.jsonc>    opencode config to list models with (default: free.jsonc here)
  --lock <file>            remove this lock file when done (set by the plugin)
  -h, --help               show this help

Exit codes: 0 success, 1 refresh failed, 2 invalid command line.
```

### Overrides: `pins.json`

```json
{
  "pin":   ["opencode/space-bunny-free"],
  "ban":   ["openrouter/liquid/lfm-2.5-2.6b:free"],
  "alias": { "opencode/some-model-free": "name-on-the-leaderboard" }
}
```

`pin` forces models to the top in that order, `ban` never uses them, and `alias` fixes a missed
benchmark match. Duplicate IDs are removed after pinning. Run `rank.mts` after editing.

### Settings: `config.json`

Everything is optional. Nested maps merge with the defaults key by key. Values of the wrong type fall
back to the default.

| Key | Default | Meaning |
|---|---|---|
| `freeTier` | see table above | allowlist: provider → model globs; `"$zero"` = models priced 0 |
| `excludeProviders` | `[]` | never use these, e.g. `["openrouter"]` for sensitive code |
| `minContext` | `64000` | minimum context window |
| `weights` | `arena_agent 0.35, arena_webdev 0.35, arena_text 0.15, aa_coding 0.25, aa_agentic 0.25, aa_intelligence 0.15` | score weights |
| `stealthScore` | `0.95` | score for unbenchmarked stealth models |
| `unscoredBase` | `0.25` | base score for other unbenchmarked models |
| `unscoredRecencyMax` | `0.1` | maximum recency bonus for unbenchmarked models |
| `smallPenalty` | `0.15` | penalty for small models |
| `cooldownMinutes` | quota 360, rate 10, server 5, unavailable 1440 | how long a failed model sits out, unless `retry-after` says longer |
| `maxSwitchesPerTurn` | `3` | failover budget per message |
| `autoContinue` | `true` | retry the failed turn on the next model; `false` fails the turn instead and the next message uses the new model |
| `refreshHours` | `6` | re-rank when `ranking.json` is older than this |

Malformed cache or state data is ignored per entry instead of breaking the router. A cache timestamp
in the future is treated as stale, and temporary files from atomic writes are cleaned up on failure.

## Failover in detail

opencode keeps one model for a whole turn, including its own retries, which can wait up to fifteen
minutes on a rate limit. So when a request fails, the plugin looks at the error before opencode
retries:

1. If the model is to blame, it goes on cooldown, until `retry-after` if the provider sends one,
   otherwise the default above. A quota message, a removed model, or an auth/permission rejection
   (401/403) fails over at once; a rate limit or server error fails over after the second try, or at
   once when the wait would be over a minute. A context overflow, a cut-off answer or a content
   filter is not the model's fault and is left to opencode.
2. The session moves to the next-ranked model that is not cooling down. If every model is cooling
   down, it uses the one that frees up first.
3. opencode retries the same request on the new model straight away, in the same turn. The partial
   answer of a request cut off half-way stays in the conversation and the new model continues from
   it.

At most `maxSwitchesPerTurn` switches happen per turn; after that the provider's error is shown at
once instead of being waited out. With `autoContinue` off, the turn fails and the next message runs
on the new model.

**A failover sends the whole conversation to the next free provider without asking.** Everything
said in the session so far goes to the new model's provider, under that provider's data terms.

Where you can see a switch: the model shown by the TUI, the model ACP clients report, `router.log`
(`failover ...`) and `rank.mts --status`. There is no extra message in the conversation.

**Choosing a model yourself ends routing for that session.** After `/model` to anything but `free/auto`
the router leaves the session and its errors alone; `/model free/auto` hands it back.

## bb

`./scripts/install.sh --bb` registers a custom ACP agent **Free (auto)** (provider `acp-free`) that
runs `openrouter-free acp` (npm) or `opencode-free acp` (scripts install). Pick `free/auto` as its model.
No other bb agent is touched. If an older install shows only "Agent default" as the model, re-run the
installer with `--bb`. A failover happens inside the running prompt, so bb sees one prompt answered by
the new model; it no longer receives a queued "continue" message.

## Privacy and security

**Free models are usually paid for with your data.** Assume prompts and completions may be logged or
used for training:

- On OpenCode Zen, most free models are explicit exceptions to Zen's zero-retention policy. During
  the free period, data "may be used to improve the model" (Big Pickle, MiMo Flash, Ling Flash Fin).
  NVIDIA's free endpoints log usage ("do not submit personal or confidential data"). "Contributor"
  models such as Muse Spark Contributor Free train on your prompts. Some stealth models state zero
  retention. Check [Zen's privacy notes](https://opencode.ai/docs/zen/) for the current list.
- On OpenRouter, free providers may keep prompts.
- Groq, Cerebras, Google and Mistral free tiers follow each provider's own terms. So do Z.AI's free
  GLM Flash models and ModelScope's free inference.

Do not point `free/auto` at confidential or client code. Narrow the pool with `ban` in `pins.json`
or list whole providers in `excludeProviders`. See [SECURITY.md](SECURITY.md).

Security-relevant behavior of this implementation:

- `providers.env` is exported into opencode, so the agent's tools can read those keys, like any
  opencode provider key. `ranker.env` is not exported; it is read only by `rank.mts`.
- On POSIX, key files and state/log files are created with mode `0600`. On Windows, the installer
  restricts the install directory and user files to the current user, `SYSTEM` and the built-in
  `Administrators` group. ACL restriction is best effort: on FAT/exFAT, some network shares or
  policy-locked profiles it warns and leaves the install usable.
- `router.log` is timestamped per line. Both `router.log` and `state.json` redact common credential
  shapes. Error text is cut to 200 characters. Stack frames are cut to three. The response body is read only to
  classify a failure, never stored. Logs still contain session IDs, local paths and possibly a
  provider's masked key fragment; review before sharing.
- `cache/candidates.json` strips headers, request bodies and provider settings.
- The Windows installer requires a `.opencode-free-router.json` marker before `-Purge` recursively
  deletes a directory. `-Force` is the explicit escape hatch for legacy marker-less installs.
- The uninstaller removes only shims that reference this install directory, and a normal uninstall
  removes only known code files and an empty `plugin` directory.
- `writeJSONAtomic` removes its temporary file when a rename fails. The ranker caps leaderboard
  pagination so a broken or endless endpoint cannot page forever.

## Troubleshooting

- `rank.mts --status` shows the ranking, warnings, active cooldowns, and which model each session uses.
- `router.log` in the data directory records picks, failovers and background refreshes (see "Install" for
  where it lives).
- `cache/candidates.json` holds what opencode reported for each model (without headers, request
  bodies and provider settings), which explains why a model was or wasn't eligible.

## Development

```sh
npm ci --ignore-scripts       # compiler and type definitions, for npm run check only
npm run check                 # type-check (TypeScript 7, strict)
npm test                      # tests; no network and no real opencode needed
npm run test:coverage         # tests plus coverage/lcov.info (cross-platform coverage runner)
npm run lint:sh               # shellcheck (requires shellcheck)
./scripts/e2e-failover.sh     # POSIX: real opencode 2 + a fake 429 provider
```

## Update and uninstall

### npm
```sh
npm update -g openrouter-free        # update to the latest published version
npm uninstall -g openrouter-free     # remove the global command
```
Your data in `%APPDATA%\openrouter-free` (Windows), `~/Library/Application Support/openrouter-free`
(macOS) or `~/.config/openrouter-free` (Linux) is not removed by `npm uninstall`; delete it manually
if you want to purge everything. `FREE_ROUTER_DIR` can point it somewhere else.

### From a checkout
```sh
./scripts/uninstall.sh [--bb] [--purge]
```
This removes the code and the wrapper (and the bb agent with `--bb`). Your config, keys and state stay
unless you pass `--purge`.

## Publishing (manual)
```sh
npm login
npm publish
```
Publish only when authorized; this project does not publish automatically. Check `npm pack --dry-run`
and test the `.tgz` before publishing. Update the version in `package.json` and `CHANGELOG.md` first.

## Attribution


Model scores come from [LMArena](https://lmarena.ai) (`lmarena-ai/leaderboard-dataset`) and
[Artificial Analysis](https://artificialanalysis.ai). Not affiliated with either, or with opencode.

## License

[BSD-2-Clause](LICENSE)
