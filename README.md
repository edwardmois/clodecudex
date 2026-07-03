# clodecudex (`ccx`)

> Two AI co-founders in one terminal. **Claude Code** and **OpenAI Codex CLI** working together on your codebase — live 3-way chat, a shared task board, cross-review by the model that didn't write the code. Runs on the subscriptions you already have. **Zero API keys.**

**Status: v0.2.0 — early development.** See [CHANGELOG.md](CHANGELOG.md) for what's new.

```
[user]  add rate limiting to the API + tests
[claude] Taking the middleware. T1 claimed (src/middleware/**).
[codex]  Then tests + docs are mine. T2 claimed (tests/**).
  claude edit src/middleware/rateLimit.ts
  codex add tests/rateLimit.test.ts
[claude → codex] T1 ready for review: sliding window, per-key buckets.
[codex]  Reviewed the diff. Off-by-one in window rollover — see line 41.
[claude] Fixed. Re-check?
[codex]  ✓ T1 approved.
```

## What it actually is

`ccx` is an **unofficial orchestrator** that runs the two official CLIs as peers:

- Both agents connect to a local **MCP "Founders Hub"** — a shared chat and task board
- They split your goal into tasks with **non-overlapping file ownership**, then work **in parallel**
- Finished work is **cross-reviewed by the other model** before a task closes
- You're the third founder: watch, interrupt, redirect, veto — any time

Two live coding agents **coordinating through a shared task board** — not magic simultaneous editing. File ownership is hard-enforced for Claude (PreToolUse hook), monitored for Codex, and everything happens on your git repo where `git diff` is always the source of truth.

## Why

- **No API keys.** Claude Code uses your `claude` login (Pro/Max). Codex uses your ChatGPT plan. `ccx` never sees a key or a token of your bill.
- **Two usage pools, one team.** Work splits across both subscriptions in parallel — roughly the sum of both plans' throughput, and about half the wall-clock on divisible tasks.
- **Cross-model review is the real moat.** GPT and Claude have *different* blind spots. Every task gets checked by the model that didn't write it — something no amount of tokens from a single vendor buys.

### How it compares

Multi-agent coding tools come in two shapes today:

- **Relay pipelines** (e.g. [Clodex](https://github.com/9thLevelSoftware/Clodex)) — fixed roles, taken in turns: one model plans, the other implements, both audit, a patch lands at the end. Rigorous, but sequential — you wait through every leg of the relay, and the agents never negotiate.
- **Isolation managers** (e.g. Crystal/[Nimbalyst](https://nimbalyst.com/), [Composio AO](https://github.com/ComposioHQ/agent-orchestrator)) — many sessions, each walled into its own git worktree or PR. Parallel, but the agents work *apart*: no shared context, no cross-talk, and you merge the results yourself.

`ccx` is the third shape: **both agents in the same working tree at the same time, negotiating the split themselves.** They divide your goal in chat ("I'll take the middleware, you take tests"), enforce the boundary with file ownership instead of worktree walls, and review each other before anything closes — while you sit in the room as the third founder. No patch to apply, no worktrees to merge: the repo you're looking at is the repo they're building.

### Honest token math

Running two coordinated agents costs more total tokens than one agent doing everything (~1.3–1.6× in our design). `ccx` keeps the overhead down by design:

- **Digest delivery** — agents receive chat in batches at natural boundaries, never message-by-message
- **Hub piggyback** — unread chat rides along on every task-board call for free
- **Terse-chat protocol** — status lines, not essays; silence is a valid reply
- **Diff-first reviews** — reviewers read diffs, not whole files
- **Shared `FOUNDERS_NOTES.md`** — explore the codebase once, not twice

## Requirements

- Node.js 22+
- [Claude Code](https://claude.com/claude-code) — installed and logged in (`claude` → `/login`)
- [Codex CLI](https://developers.openai.com/codex/cli) — installed and logged in (`codex login`)
- A git repository (strongly recommended — agents edit real files)

## Quick start

```bash
npm install -g clodecudex

cd your-project
ccx doctor        # verify both CLIs are installed and logged in
ccx               # start a session
```

Then just type a goal. Slash commands: `/pause claude|codex`, `/resume claude|codex`, `/tasks`, `/usage`, `/diff`, `/help`, `/quit`. Use `@claude …` / `@codex …` to address one founder.

### Usage tracking

`/usage` shows each founder's token consumption this session, plus your Codex subscription windows (5-hour and weekly, read from Codex's own local session records — no network calls). Claude Code doesn't expose subscription limits programmatically yet ([anthropics/claude-code#44328](https://github.com/anthropics/claude-code/issues/44328)); its session tokens are still counted.

### Resuming a session

```bash
ccx --resume   # continue the most recent session in this project
```

No database involved: both CLIs already persist their own conversation histories locally, so ccx only journals the shared state — the founders' chat, the task board, and the two session ids — to `.ccx/sessions/` in your project (add `.ccx/` to your `.gitignore`). On resume, both agents reattach to their existing conversations with full context, the board comes back with ownership intact, and the recent chat is replayed in the TUI.

## Configuration

`ccx.config.json` in your project (or `~/.ccx/config.json` globally):

```json
{
  "claude": {
    "model": "sonnet",
    "permissionMode": "acceptEdits",
    "persona": "You lean architecture and implementation."
  },
  "codex": {
    "model": "gpt-5.2-codex",
    "sandbox": "workspace-write",
    "persona": "You lean testing, security, and code review."
  }
}
```

Everything is optional — defaults are sensible and safe. `--claude-model` / `--codex-model` override the models for one run. `--yolo` disables both agents' permission prompts (use in disposable environments only).

When a founder runs out of subscription quota mid-session, ccx pauses it automatically (one clear message, no error spam) and the other founder keeps working — `/resume` it once the limit resets.

## Safety model

- Claude runs with `--permission-mode acceptEdits`; Codex runs sandboxed with `workspace-write` — both scoped to your project directory
- File ownership: claiming a task grants exclusive rights to its file globs; Claude is blocked by a PreToolUse hook, Codex violations are detected and flagged loudly in chat
- Work on a branch. Always. The agents edit real files.

## Roadmap

- `--strict` mode: a git worktree per agent with merge-on-review — hard isolation
- `codex app-server` transport for richer Codex integration (interrupts, approvals)
- Third founder support (Gemini CLI, …) via the `AgentAdapter` interface

## Disclaimer

`ccx` is an independent open-source project. **Not affiliated with, endorsed by, or supported by Anthropic or OpenAI.** It orchestrates the official CLIs you installed, under your own logins, subject to each provider's terms of service.

## License

MIT
