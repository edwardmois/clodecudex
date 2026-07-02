import { spawn, type ChildProcess } from 'node:child_process';
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
  private stopped = false;
  busy = false;

  constructor(options: ClaudeAdapterOptions) {
    this.options = options;
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
    return args;
  }

  async start(bootstrap: string): Promise<void> {
    this.emit({ type: 'status', status: 'starting' });
    const stateDir = this.options.stateDir ?? mkdtempSync(path.join(tmpdir(), 'ccx-claude-'));
    this.stateDir = stateDir;
    this.writeStateFiles(stateDir);

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
      this.emit({ type: 'error', message: `Failed to launch claude: ${error.message}` });
      this.emit({ type: 'status', status: 'idle' });
    });
    child.on('close', (code) => {
      if (!this.stopped) {
        if (code !== 0) {
          this.emit({
            type: 'error',
            message: `claude exited with code ${code}${stderrTail ? `: ${stderrTail}` : ''}`,
          });
        }
        this.busy = false;
        this.emit({ type: 'status', status: 'idle' });
        this.emit({ type: 'turn-complete' });
      }
    });

    this.send(bootstrap);
  }

  deliver(digest: string): void {
    if (this.stopped) return;
    if (this.busy || !this.child) {
      this.queue.push(digest);
      return;
    }
    this.send(digest);
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
      if (event.type === 'turn-complete') {
        this.busy = false;
        this.emit(event);
        if (this.queue.length > 0 && !this.stopped) {
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
