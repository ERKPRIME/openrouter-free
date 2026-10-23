# Security Policy

## Supported versions

Pre-1.0: only the latest commit on `master` receives fixes.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Report it privately through
GitHub Security Advisories:
<https://github.com/lettland/opencode-free-router/security/advisories/new>

## What to know

- **Keys.** `providers.env` is exported into opencode, so the agent's tools can read those keys, like
  any opencode provider key. `ranker.env` (Artificial Analysis) is read only by `rank.mts`; it is
  parsed into the ranker's own process environment, is not exported to opencode, and the Artificial
  Analysis key is removed from the environment of the child process that lists models. On POSIX both
  files are created with mode `0600`. On Windows the installer restricts the install directory and
  the user files to the current user, `SYSTEM` and the built-in `Administrators` group. ACL
  restriction is best effort: FAT/exFAT, some network shares and policy-locked profiles cannot store
  it, and the installer warns instead of failing.
- **Cost.** A model is used only if its provider is on the `freeTier` allowlist. A price of 0 alone
  is not trusted, since subscription plans and gateways report 0 too. Every pick is re-checked
  against live provider data, so a stale ranking cannot route to a model that has since become paid.
  Groq, Cerebras, Google and Mistral count as free because of their free tiers: a key with billing
  enabled can be charged. Mistral is allowlisted by model name, limited to the families its free
  Experiment plan covers, so a billing-enabled key is charged for those models exactly as it would
  be for Groq or Cerebras.
- **Data.** Free models are usually paid for with data. Most of OpenCode Zen's free models are
  exceptions to its zero-retention policy: they may use data to improve the model, NVIDIA's free
  endpoints log usage, and "contributor" models train on prompts. OpenRouter's free providers may
  keep prompts. Don't use `free/auto` for confidential code. Narrow the pool with `pins.json` → `ban`
  or `excludeProviders`.
- **Logs.** `router.log` is timestamped per line. Both `router.log` and `state.json` redact common
  credential shapes. They keep up to 200 characters of the error message a provider returned when a model
  failed. Some providers put a masked fragment of the API key in such a message. A failing hook also
  logs up to three stack frames: code locations with local paths, which may include your username, no
  provider data. `router.log` also names session ids and, when looking up a parent or fork source
  fails, up to 200 characters of opencode's own error text for it. The response body is only read to
  classify the failure, never kept. Keep that in mind before sharing either file.
- **Cache.** `cache/candidates.json` keeps what opencode reported for each model, without headers,
  request bodies or provider settings. Malformed entries are dropped per entry. Corrupt files and a
  cache timestamp in the future are treated as stale rather than trusted.
- **Windows installer.** The installer refuses drive roots, protected/system locations, the
  repository itself, symlinks/junctions and unrelated non-empty directories. It writes
  `.opencode-free-router.json` with `complete: false` before copying anything and sets
  `complete: true` only at the end. The uninstaller requires a valid marker before a recursive
  `-Purge`; `-Force` is an explicit escape hatch for legacy marker-less installs and should be used
  only when you are certain the directory is a router install. A normal uninstall removes only known
  code files, an empty `plugin` directory and a shim that references this install.
- **Windows launcher.** The `.cmd` shim always starts the PowerShell launcher in a child process, so
  `OPENCODE_CONFIG` and `FREE_ROUTER_DIR` do not leak into the caller's shell. Every argument is
  quoted before it reaches `opencode`, including `.cmd`/`.bat` targets invoked through `cmd.exe`.
  `&`, `|`, `<`, `>`, `^`, `!`, embedded quotes, empty arguments, trailing backslashes and Unicode are
  preserved and covered by tests. `cmd.exe` still expands `%NAME%` before the launcher runs, and
  newlines cannot be passed through a `.cmd` argument; treat those as platform limitations.
- **Remote data** (LMArena, Artificial Analysis, OpenRouter) is parsed as JSON and used only for
  scoring; it is never executed. Leaderboard pagination is capped, so a broken or endless endpoint
  cannot page forever.
- **Atomic writes.** `writeJSONAtomic` removes its temporary file when a rename fails, so a failed
  write cannot leave a stale temporary copy of state, ranking or config behind.
