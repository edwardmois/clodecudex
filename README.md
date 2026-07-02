# ClaudeCodeX (`ccx`)

> Two AI co-founders in your terminal. Claude Code and OpenAI Codex CLI working **simultaneously** on your codebase — live 3-way chat, shared task board, parallel editing. Your existing subscriptions, **zero API keys**.

**Status: early development — not yet released.**

## What it does

`ccx` starts an interactive session where the official Claude Code CLI and OpenAI Codex CLI run as two peers:

- They discuss your goal, split it into tasks on a shared board, and work **in parallel**
- Each task grants exclusive ownership of its files — no edit conflicts
- Completed work is cross-reviewed by the *other* model before it's marked done
- You're the third founder: jump into the conversation at any moment

## Why

- **No API keys.** Claude uses your `claude login` (Pro/Max). Codex uses your ChatGPT plan. `ccx` just orchestrates.
- **Two usage pools.** Work is split across both subscriptions in parallel — roughly double throughput, half the wall-clock on divisible tasks.
- **Cross-model review.** Claude and GPT have different blind spots. Every task gets checked by the model that didn't write it.

## Requirements

- Node.js 22+
- [Claude Code](https://claude.com/claude-code) installed and logged in (`claude login`)
- [Codex CLI](https://github.com/openai/codex) installed and logged in

## License

MIT
