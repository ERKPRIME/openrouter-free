# Changelog

Add entries under `## Unreleased`. The upstream project cuts a release on every push to its `master`
that changes shipped code: the release workflow moves entries under the new version, tags it and
publishes the GitHub release. A `[minor]` or `[major]` marker in a commit subject picks the bump;
otherwise it is a patch. This fork uses `master`, so its release workflow only runs when started
manually from the Actions tab.

## Unreleased

- The retry hook now logs the model, the attempt and opencode's own decision before it acts, and
  says when it ignores a retry because the session's model is not the router's pick (a manual
  `/model`, a lost pick). A provider failure that never reaches the router - a stream that fails
  already past its first token, or a hook opencode never calls - now leaves a trace in `router.log`
  instead of returning silently, so a missing failover can be told apart from a failover that was
  never asked for.

- Native Windows support: `install-windows.ps1` and `uninstall-windows.ps1`, their `.cmd`
  Command Prompt/Explorer wrappers, plus a PowerShell launcher (`bin/opencode-free.ps1`, installed as
  `opencode-free-launcher.ps1`) and a `.cmd` shim. They mirror the POSIX install/upgrade/uninstall
  behavior, keep user config and keys untouched, and make the `opencode-free` shim work from any
  directory. The shim is relative (`%~dp0`), and the rendered PowerShell launcher is UTF-8 with BOM,
  so install paths with accents or other non-ASCII characters work. The launcher does not use the
  `opencode-free` name, so PowerShell runs the `.cmd` as a child process instead of dot-sourcing the
  `.ps1` and leaking `OPENCODE_CONFIG`/`FREE_ROUTER_DIR` into the session. The tests run the
  PowerShell scripts against a temporary install directory and exercise both `.cmd` entry points.
- The Windows installer moves the shim directory to the front of the user PATH with
  `scripts/windows-path.ps1`. The helper keeps the semicolons between entries (a string-plus-array
  bug had joined the first two paths), and a test covers spaces, duplicates and an empty PATH.
- `rank.mts` finds npm's `opencode.cmd` on Windows and runs `.cmd`/`.bat` shims through `cmd.exe`
  with quoted argv, instead of `spawnSync(..., { shell: true })` (which triggers Node's DEP0190 and
  does not escape arguments). The plugin's runtime lookup likewise finds `node.exe`/`bun.exe` by
  `PATHEXT` on Windows.
- Windows has no permission bits for privacy: the mode tests now check the inherited user-profile
  ACL on Windows and keep the `0600` assertions on POSIX.
- Hardened the router and installers after an independent review:
  - `rank.mts` no longer leaks `ranker.env` into opencode's environment and removes the Artificial
    Analysis key from the child process that lists models. Plugin log lines are timestamped; errors,
    warnings and cooldown reasons are redacted; logs rotate and are mode `0600` on POSIX. Cache
    parsing is BOM-tolerant, drops malformed entries and treats future timestamps as stale.
  - Leaderboard pagination is capped, ranked IDs are deduplicated, and atomic writes clean up their
    temporary file on failure.
  - The plugin detects cyclic parent/fork graphs, limits retry waits, and handles background-refresh
    spawn/lock errors without breaking a session.
  - Windows installs write a `.opencode-free-router.json` marker (`complete: false` while copying),
    refuse protected paths, the repository, junctions/symlinks and unrelated non-empty directories,
    and restrict user files to the current user, `SYSTEM` and `Administrators` where ACLs are
    available. Re-applying an already-correct ACL no longer warns.
  - `uninstall-windows.ps1 -Purge` requires a valid marker; `-Force` is the explicit legacy escape
    hatch. A normal uninstall removes only known code, an empty plugin directory and a shim owned by
    this install.
  - The PowerShell launcher passes `.cmd`/`.bat` targets through `cmd.exe` with explicit quoting,
    preserves `&|<>^!`, embedded quotes, empty arguments, trailing backslashes and Unicode, reports a
    missing `opencode` with exit 127, and does not leak the router environment into the caller's
    shell. `%NAME%` expansion and newlines remain documented `cmd.exe` limitations.
  - `install.sh` escapes shell and sed metacharacters in `--dir`; coverage runs on Node 22/24 as well
    as Node 26 (using `--test-coverage-include-all` only where supported).

## 0.1.3 — 2026-10-19

- **Breaking: opencode 2 only.** The plugin is ported to opencode 2's plugin API; opencode 1.x is no
  longer supported and `install.sh` refuses it. After upgrading opencode, **re-run `install.sh`**: it
  installs the plugin as `plugin/index.ts`, removes the old `plugin.ts`, and rewrites the one-line
  `"plugin": ["./plugin.ts"]` of an existing `free.jsonc` to `"plugins": ["./plugin"]`. A multi-line
  entry is left alone and the install stops with the edit to make. The template now uses opencode 2's
  config keys (`providers`, `package`, `settings`, `capabilities`); an existing `free.jsonc` with the
  old provider block keeps working.
- Failover is now done inside opencode's own retry: the plugin switches the session's model and
  opencode retries the request on it at once, in the same turn. The abort / wait-for-idle / "continue"
  prompt, the status polling and the bb queued message are gone, and so is the `[free-router]` message
  in the conversation. `autoContinue: false` now means the turn fails and the next message uses the
  new model. When the switch budget (`maxSwitchesPerTurn`) is spent or no model is left, the provider's
  error is shown at once instead of waiting out a long retry.
- A session is routed while it is on `free/auto` or on the model the router picked for it (kept in the
  session's metadata as well as in `state.json`); choosing another model with `/model` ends routing
  for that session, `/model free/auto` brings it back. Child sessions and forks follow the pick of
  the session they came from.
- `opencode-free` runs every command that can with its own server (`--standalone`), since opencode 2's
  shared background service ignores `OPENCODE_CONFIG`. It refuses the `service` command, `serve
  --service`, an unquoted `service` word in a message, and the commands that manage or may
  auto-start the service (`debug`, `pair`, `mcp`, `plugin`, `upgrade`, `update`, `uninstall`): run
  those as plain `opencode`, so the service never comes up with the router's config and keys.
- The ranker lists models with `opencode api --standalone model.list`. A model counts as free only if
  every one of its price tiers is zero, and disabled models are skipped. `cache/candidates.json` no
  longer keeps headers, request bodies or provider settings.
- `router.log` and `state.json` keep up to 200 characters of a provider's error message, never its
  response body (SECURITY.md).
- To go back to opencode 1.x, first look at `free.jsonc` in the install directory. With a `"provider"`
  block (the old format) whose plugin line this version's `install.sh` rewrote, replace
  `"plugins": ["./plugin"]` with `"plugin": ["./plugin.ts"]`. With a `"providers"` block it was made
  from this version's template with opencode 2 keys: move it aside (`mv "$dir/free.jsonc"
  "$dir/free.jsonc.v2"`); v0.1.2's `install.sh` then creates a v1 one, and you carry any provider or
  model settings of your own over by hand. Either way, run the `install.sh` of v0.1.2 (this version
  deleted `plugin.ts`), then `rm -f "$dir/plugin/index.ts"; rmdir "$dir/plugin"` in the install
  directory.

## 0.1.2 — 2026-09-30

- Split the plugin's server closure into named factories

## 0.1.1 — 2026-09-28

- The code is now TypeScript, type-checked by TypeScript 7 in strict mode, and still ships as source
  with no build step: opencode loads `plugin.ts`, and Node or Bun runs `rank.mts`. **Node 22.18 or
  newer is now required** (Bun works as before); `install.sh` refuses an older `node` on `PATH`,
  since the plugin starts the ranker with it.
- Upgrading with `install.sh` replaces `plugin.js`, `lib.mjs` and `rank.mjs` with the new files and
  points the `plugin` entry of an existing `free.jsonc` at `./plugin.ts`. Nothing else in your files
  changes.
- `config.json`, `pins.json`, `state.json`, the ranking and every API response are now checked field
  by field when read. A value of the wrong type in `config.json` keeps its default, and malformed
  entries in `pins.json` are skipped, where before they could break a ranking run.

- Four more free providers on the `freeTier` allowlist, each checked against the provider's own terms
  rather than a price of 0: Z.AI and Zhipu AI (the free GLM Flash models, same key for both
  endpoints), ModelScope (all of its inference is free, with a 2,000 requests a day quota) and
  Mistral (Devstral Small, Codestral and Mistral Small on the free Experiment plan, matched by name
  since the catalog prices them). `providers.env.example` and the README list their keys and caveats.
  Cloudflare Workers AI, Vercel AI Gateway, Hugging Face and the OpenRouter clone gateways were left
  out on purpose, and the README says why.
- A new test keeps `templates/config.example.json` in step with the shipped defaults.
- A `402 Payment Required` now fails over like a removed model (24-hour cooldown) instead of being
  ignored, so a free-plan account that asks for a model it cannot pay for moves on instead of
  retrying a request that can never succeed.
- Tests now run `rank.mjs` as a CLI (stubbed network, fake `opencode`) and `plugin.js` against a
  fake opencode client, bringing line coverage of `src/` to 100%. No behavior change; an
  unreachable API-key check in `rank.mjs` was removed.
- The bb agent registered by `install.sh --bb` now lists its model with `opencode-free
  --list-models`, which prints `free/auto` without starting opencode. Listing it through opencode
  (an ACP probe, or `opencode models free`) sometimes failed, for example with "database is locked"
  while other opencode processes were running, and bb then showed only "Agent default" until a
  later refresh happened to succeed. Re-registering keeps fields you set on the entry by hand, such
  as `icon`, and a failed registration no longer prints the other agents' env values.

## 0.1.0 — 2026-09-25

First public release.

- `free/auto` model for opencode: the plugin swaps it for the best-ranked free model and keeps it
  for the whole session.
- Ranking from LMArena (agent, webdev, text) and Artificial Analysis (coding, agentic,
  intelligence), with stealth-model detection via OpenRouter and `pins.json` overrides.
- Failover on quota, rate limit, removal or refusal: cooldown, next-ranked model, automatic
  continue (a visible thread message under bb).
- Free providers are an explicit allowlist (Zen, OpenRouter and NVIDIA 0-priced models; Groq,
  Cerebras and Google free tiers). Subscription plans that report price 0 are never used.
- The plugin refreshes the ranking itself when it is older than 6 hours.
- `install.sh` / `uninstall.sh`, the `opencode-free` wrapper, and optional bb agent
  registration (`--bb`).
