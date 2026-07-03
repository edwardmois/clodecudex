# ccx — ClaudeCodeX

> Two AI co-founders in one terminal. **Claude Code** and **OpenAI Codex CLI** working together on your codebase — live 3-way chat, a shared task board, cross-review by the model that didn't write the code. Runs on the subscriptions you already have. **Zero API keys.**

**Status: v0.1 — early development.**

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
npm install -g claudecodex

cd your-project
ccx doctor        # verify both CLIs are installed and logged in
ccx               # start a session
```

Then just type a goal. Slash commands: `/pause claude|codex`, `/resume`, `/tasks`, `/diff`, `/help`, `/quit`. Use `@claude …` / `@codex …` to address one founder.

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

Everything is optional — defaults are sensible and safe. `--yolo` disables both agents' permission prompts (use in disposable environments only).

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
