# Changelog

## 0.2.0 — 2026-07-03

- **`/usage`** — per-founder token totals for the session, plus real Codex subscription windows (5-hour and weekly used %, read from Codex's local session records; no network calls). Claude Code doesn't expose subscription limits yet ([anthropics/claude-code#44328](https://github.com/anthropics/claude-code/issues/44328)).
- **`ccx --resume`** — continue the previous session in a project. Both agents reattach to their own CLI conversation histories; ccx restores the founders' chat, the task board (ownership intact), and replays recent messages. State lives in `.ccx/sessions/` — no database.
- **Graceful usage-limit handling** — a founder that runs out of quota is auto-paused with one clear `⛔` message; the other founder continues solo. `/resume` it after the reset.
- **Quiet TUI by default** — internal tool calls and hub plumbing are hidden, commands are cleaned and clamped, board changes render as inline `✦` lines, duplicated agent output is suppressed. `--verbose` restores the raw stream.
- **`--claude-model` / `--codex-model`** — per-run model overrides (config file still supported).

## 0.1.0 — 2026-07-03

- First working release: Claude Code + Codex CLI as two co-founders in one terminal — live 3-way chat, shared MCP task board ("Founders Hub"), non-overlapping file ownership (hard-enforced for Claude via PreToolUse hook, monitored for Codex), cross-model review before tasks close, `ccx doctor` preflight, Ink TUI. Runs entirely on your existing subscriptions — no API keys.
