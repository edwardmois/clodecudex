import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentAdapter, AgentEvent, AgentEventListener } from './adapter.js';

export interface ClaudeAdapterOptions {
  cwd: string;
  /** Founders Hub MCP URL for this agent (identity baked into the path). */
  hubUrl: string;
  /** Hub ownership-check endpoint used by the PreToolUse hook. */
  ownershipUrl: string;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
  /** Resume an earlier Claude Code session (its own local history) by id. */
  resumeSessionId?: string;
  /** Override the executable, mainly for tests. */
  executable?: string;
  /** Where to write the generated settings/mcp/hook files; defaults to a temp dir. */
  stateDir?: string;
}

/**
 * PreToolUse hook: blocks Edit/Write on files the other founder owns by
 * asking the hub. Fails open — a dead hub shouldn't brick the agent; the
 * CLI's own permission sandbox still applies.
 */
export const OWNERSHIP_HOOK_SOURCE = `let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(raw);
    const p = (input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path)) || '';
    if (!p) process.exit(0);
    const res = await fetch(process.argv[2], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
    const out = await res.json();
    if (out.allowed) process.exit(0);
    console.error(out.reason || 'Blocked: this file is owned by the other founder right now.');
    process.exit(2);
  } catch {
    process.exit(0);
  }
});
`;

const FILE_TOOLS: Record<string, 'add' | 'edit'> = {
  Write: 'add',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
};

/** Shape of one line of `claude -p --output-format stream-json` output. */
interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
  };
  message?: {
    content?: {
      type: string;
      text?: string;
      name?: string;
      input?: { file_path?: string; notebook_path?: string; command?: string };
    }[];
  };
}

/**
 * Translate one JSONL line from the Claude Code CLI into adapter events.
 * Exported for tests; unknown event types are ignored so CLI updates degrade
 * gracefully.
 */
export function parseClaudeLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let event: ClaudeStreamEvent;
  try {
    event = JSON.parse(trimmed) as ClaudeStreamEvent;
  } catch {
    return [];
  }

  switch (event.type) {
    case 'system':
      return event.subtype === 'init' && event.session_id
        ? [{ type: 'session', id: event.session_id }]
        : [];
    case 'assistant': {
      const events: AgentEvent[] = [];
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text) {
          events.push({ type: 'message', text: block.text });
        } else if (block.type === 'tool_use' && block.name) {
          const filePath = block.input?.file_path ?? block.input?.notebook_path;
          const fileKind = FILE_TOOLS[block.name];
          if (fileKind && filePath) {
            events.push({ type: 'file-change', path: filePath, kind: fileKind });
          } else if (block.name === 'Bash' && block.input?.command) {
            events.push({ type: 'activity', text: `$ ${block.input.command}` });
          } else {
            events.push({ type: 'activity', text: `⚒ ${block.name}` });
          }
        }
      }
      return events;
    }
    case 'result': {
      const events: AgentEvent[] = [];
      if (event.usage) {
        events.push({
          type: 'usage',
          input: (event.usage.input_tokens ?? 0) + (event.usage.cache_creation_input_tokens ?? 0),
          cached: event.usage.cache_read_input_tokens ?? 0,
          output: event.usage.output_tokens ?? 0,
        });
      }
      if (event.is_error) {
        events.push({ type: 'error', message: event.result ?? 'Claude turn failed' });
      }
      events.push({ type: 'status', status: 'idle' }, { type: 'turn-complete' });
      return events;
    }
    default:
      return [];
  }
}

/**
 * Claude Code co-founder: one persistent `claude -p` process speaking
 * bidirectional stream-json over stdio. Uses the user's existing CLI login
 * (subscription OAuth) — no SDK, no API key. `--setting-sources ""` keeps
 * the session lean (no user plugins/hooks); the hub MCP server and the
 * ownership hook are injected via generated `--mcp-config`/`--settings`.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude' as const;

  private readonly options: ClaudeAdapterOptions;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly queue: string[] = [];
  private child: ChildProcess | undefined;
  private stateDir: string | undefined;
  private sessionId: string | undefined;
  private stopped = false;
  private interrupted = false;
  busy = false;

  constructor(options: ClaudeAdapterOptions) {
    this.options = options;
    this.sessionId = options.resumeSessionId;
  }

  /** Exposed for tests: the argv used to launch the session. */
  buildArgs(stateDir: string): string[] {
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      '',
      '--permission-mode',
      this.options.permissionMode ?? 'acceptEdits',
      '--mcp-config',
      path.join(stateDir, 'mcp.json'),
      '--settings',
      path.join(stateDir, 'settings.json'),
    ];
    if (this.options.model) args.push('--model', this.options.model);
    if (this.options.resumeSessionId) args.push('--resume', this.options.resumeSessionId);
    return args;
  }

  async start(bootstrap: string): Promise<void> {
    this.emit({ type: 'status', status: 'starting' });
    const stateDir = this.options.stateDir ?? mkdtempSync(path.join(tmpdir(), 'ccx-claude-'));
    this.stateDir = stateDir;
    this.writeStateFiles(stateDir);
    this.spawnChild(stateDir);
    this.send(bootstrap);
  }

  private spawnChild(stateDir: string): void {
    const executable = this.options.executable ?? 'claude';
    const child = spawn(executable, this.buildArgs(stateDir), {
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) this.handleLine(line);
    });

    let stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    child.on('error', (error) => {
      if (this.child !== child) return;
      this.emit({ type: 'error', message: `Failed to launch claude: ${error.message}` });
      this.emit({ type: 'status', status: 'idle' });
    });
    child.on('close', (code) => {
      // a replaced (setModel restart) or stopped child may exit late — ignore it
      if (this.child !== child || this.stopped) return;
      if (code !== 0) {
        this.emit({
          type: 'error',
          message: `claude exited with code ${code}${stderrTail ? `: ${stderrTail}` : ''}`,
        });
      }
      this.busy = false;
      this.emit({ type: 'status', status: 'idle' });
      this.emit({ type: 'turn-complete' });
    });
  }

  /**
   * Restart the persistent process with the new model, resuming its own
   * conversation history — context survives the switch. An in-flight turn
   * is cut short (like an interrupt); held chat waits for the next delivery.
   */
  setModel(model: string): void {
    this.options.model = model;
    if (!this.child || this.stopped || !this.stateDir) return; // applies at start()
    const old = this.child;
    this.child = undefined; // silences old close/error handlers
    old.stdin?.end();
    const timer = setTimeout(() => old.kill(), 3000);
    old.once('close', () => clearTimeout(timer));

    if (this.sessionId) this.options.resumeSessionId = this.sessionId;
    const wasBusy = this.busy;
    this.busy = false;
    this.interrupted = false;
    this.spawnChild(this.stateDir);
    if (wasBusy) {
      this.emit({ type: 'status', status: 'idle' });
      this.emit({ type: 'turn-complete' });
    }
  }

  deliver(digest: string): void {
    if (this.stopped) return;
    if (this.busy || !this.child) {
      this.queue.push(digest);
      return;
    }
    // include anything held back by an interrupt
    const held = this.queue.splice(0);
    this.send([...held, digest].join('\n\n'));
  }

  /**
   * Abort the in-flight turn via the stream-json control protocol; the
   * session process stays alive with its context intact.
   */
  interrupt(): void {
    if (!this.busy || !this.child) return;
    this.interrupted = true;
    const line = JSON.stringify({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' },
    });
    this.child.stdin?.write(`${line}\n`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 5000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  onEvent(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private send(text: string): void {
    this.busy = true;
    this.emit({ type: 'status', status: 'working' });
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    this.child?.stdin?.write(`${line}\n`);
  }

  private handleLine(line: string): void {
    for (const event of parseClaudeLine(line)) {
      if (event.type === 'session') this.sessionId = event.id;
      // an aborted turn reports itself as an error result; the user asked
      // for the stop, so don't surface it as a failure
      if (this.interrupted && event.type === 'error') continue;
      if (event.type === 'turn-complete') {
        this.busy = false;
        const wasInterrupted = this.interrupted;
        this.interrupted = false;
        this.emit(event);
        // after an interrupt, held digests wait for the next delivery so the
        // user's follow-up message goes first
        if (!wasInterrupted && this.queue.length > 0 && !this.stopped) {
          this.send(this.queue.splice(0).join('\n\n'));
        }
        continue;
      }
      this.emit(event);
    }
  }

  private writeStateFiles(stateDir: string): void {
    const hookScript = path.join(stateDir, 'ownership-hook.cjs');
    writeFileSync(hookScript, OWNERSHIP_HOOK_SOURCE);
    writeFileSync(
      path.join(stateDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { hub: { type: 'http', url: this.options.hubUrl } } }, null, 2),
    );
    writeFileSync(
      path.join(stateDir, 'settings.json'),
      JSON.stringify(
        {
          // Headless mode cannot answer permission prompts: pre-allow every
          // hub coordination tool ("mcp__hub" = all tools on that server).
          permissions: { allow: ['mcp__hub'] },
          hooks: {
            PreToolUse: [
              {
                matcher: 'Edit|Write|MultiEdit|NotebookEdit',
                hooks: [
                  {
                    type: 'command',
                    command: `node "${hookScript}" "${this.options.ownershipUrl}"`,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
