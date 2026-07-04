# Changelog

## 0.7.0 — 2026-07-04

- **One team voice** — the founders now answer you as one team: they agree in chat who speaks (whoever owns the work; Claude by default), the speaker replies for both ("we split it, we're done"), and duplicate parallel reports are protocol violations. Their internal coordination is still visible but rendered dim — answers to you stand out.
- **Input history** — ↑/↓ recall previous inputs (shell-style, with your in-progress draft preserved). Persisted per project in `.ccx/history.json` across sessions.
- **`/clear`** — wipe the founders' chat, the task board, and both agents' contexts; fresh founders are re-bootstrapped without restarting ccx.
- **`/model claude|codex <model>`** — switch a founder's model mid-session. Claude restarts its process resuming the same conversation (context survives); Codex applies it from the next turn (same thread).
- **`ccx sessions`** — list past sessions in the project (date, message count, open tasks, first goal), and resume any of them with `ccx --resume <n>`; bare `--resume` still takes the latest.
- **Safer Ctrl+C** — first press warns, second press quits cleanly (journal flushed, agents shut down). No more instant kills.

## 0.6.1 — 2026-07-04

- **Enter accepts the highlighted completion** while the `@` menu is open (it used to submit the raw text, producing `unknown founder "@"`). Tab still works; a second Enter sends the message.
- **Autocomplete now works in gitignored folders** — a cwd that is entirely ignored by the parent repo (like a scratch/smoke folder) made `git ls-files` return nothing; the file index now falls back to the directory walk in that case.

## 0.6.0 — 2026-07-04

- **`@` autocomplete** — typing `@` opens a live suggestion menu of project files *and* folders under the input (plus `claude`/`codex` at the start of a line). `Tab` completes, `↑`/`↓` move, `Esc` dismisses (interrupting founders stays on `Esc` when no menu is open). Directory completions stay open so you can keep drilling in; paths with spaces are quoted automatically. The list comes from `git ls-files` (tracked + untracked, `.gitignore` respected) with a bounded directory walk as fallback outside git repos, cached so typing never touches the disk.

## 0.5.0 — 2026-07-04

- **Esc to interrupt** — press Esc to stop whatever the founders are doing mid-turn, like in Claude Code. Claude gets the stream-json interrupt control request (its session process stays alive); Codex's turn process is stopped (its thread survives and resumes on the next message). Context is kept on both sides, and chat that queued up while they worked is held back so your next message is heard first.
- **`/stop [claude|codex]`** — the same interrupt as an explicit command, optionally targeting one founder.

## 0.4.0 — 2026-07-03

- **`@file` mentions** — reference files in messages like in Claude Code: `fix the bug in @src/auth.ts`. Paths are validated before sending (typos error immediately), normalized, and both founders are told to read them. Contents aren't inlined — the agents read the files themselves, so nothing is paid for twice. `@claude` / `@codex` still address founders.

## 0.3.1 — 2026-07-03

- **Consistent replies** — agents are now instructed that turn narration is invisible to their co-founder: anything meant for the user or the team goes through founders' chat (`[claude → user]`-style lines, journaled and resumable). Narration remains for private work-progress notes only.

## 0.3.0 — 2026-07-03

- **Faster Codex turns** — Codex now runs at `medium` reasoning effort by default (its own default is `high`, which made even trivial replies slow). Configurable per project via `codex.reasoningEffort` (`minimal|low|medium|high|xhigh`).
- **Codex startup slimmed** — ccx sessions no longer scan, inject, or write your personal Codex memories; the co-founder bootstrap already carries the needed context. (Global Codex plugins still load — disable unused ones in `~/.codex` if startup matters to you.)

## 0.2.0 — 2026-07-03

- **`/usage`** — per-founder token totals for the session, plus real Codex subscription windows (5-hour and weekly used %, read from Codex's local session records; no network calls). Claude Code doesn't expose subscription limits yet ([anthropics/claude-code#44328](https://github.com/anthropics/claude-code/issues/44328)).
- **`ccx --resume`** — continue the previous session in a project. Both agents reattach to their own CLI conversation histories; ccx restores the founders' chat, the task board (ownership intact), and replays recent messages. State lives in `.ccx/sessions/` — no database.
- **Graceful usage-limit handling** — a founder that runs out of quota is auto-paused with one clear `⛔` message; the other founder continues solo. `/resume` it after the reset.
- **Quiet TUI by default** — internal tool calls and hub plumbing are hidden, commands are cleaned and clamped, board changes render as inline `✦` lines, duplicated agent output is suppressed. `--verbose` restores the raw stream.
- **`--claude-model` / `--codex-model`** — per-run model overrides (config file still supported).

## 0.1.0 — 2026-07-03

- First working release: Claude Code + Codex CLI as two co-founders in one terminal — live 3-way chat, shared MCP task board ("Founders Hub"), non-overlapping file ownership (hard-enforced for Claude via PreToolUse hook, monitored for Codex), cross-model review before tasks close, `ccx doctor` preflight, Ink TUI. Runs entirely on your existing subscriptions — no API keys.
