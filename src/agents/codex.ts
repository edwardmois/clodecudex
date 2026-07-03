import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentAdapter, AgentEvent, AgentEventListener } from './adapter.js';

export interface CodexAdapterOptions {
  cwd: string;
  /** Founders Hub MCP URL for this agent (identity baked into the path). */
  hubUrl: string;
  model?: string;
  /** Codex sandbox policy; defaults to workspace-write. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Override the executable, mainly for tests. */
  executable?: string;
}

/** Shape of one line of `codex exec --json` output (experimental JSON schema). */
interface CodexStreamEvent {
  type: string;
  thread_id?: string;
  message?: string;
  item?: {
    id: string;
    type: string;
    text?: string;
    message?: string;
    command?: string;
    status?: string;
    changes?: { path: string; kind: string }[];
    server?: string;
    tool?: string;
  };
}

const FILE_KIND: Record<string, 'add' | 'edit' | 'delete'> = {
  add: 'add',
  update: 'edit',
  delete: 'delete',
};

/**
 * Translate one JSONL line from `codex exec --json` into adapter events.
 * Exported for tests; unknown event/item types are ignored by design so new
 * Codex versions degrade gracefully instead of crashing the session.
 */
export function parseCodexLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return []; // stderr noise, banners
  let event: CodexStreamEvent;
  try {
    event = JSON.parse(trimmed) as CodexStreamEvent;
  } catch {
    return [];
  }

  switch (event.type) {
    case 'thread.started':
      return event.thread_id ? [{ type: 'session', id: event.thread_id }] : [];
    case 'turn.started':
      return [{ type: 'status', status: 'working' }];
    case 'turn.completed':
      return [{ type: 'status', status: 'idle' }, { type: 'turn-complete' }];
    case 'turn.failed':
      return [
        { type: 'error', message: event.message ?? 'Codex turn failed' },
        { type: 'status', status: 'idle' },
        { type: 'turn-complete' },
      ];
    case 'error':
      return [{ type: 'error', message: event.message ?? 'Unknown Codex error' }];
    case 'item.completed': {
      const item = event.item;
      if (!item) return [];
      switch (item.type) {
        case 'agent_message':
          return item.text ? [{ type: 'message', text: item.text }] : [];
        case 'command_execution':
          return item.command ? [{ type: 'activity', text: `$ ${item.command}` }] : [];
        case 'mcp_tool_call': {
          if (!item.tool) return [];
          const ok = item.status === undefined || item.status === 'completed';
          return [
            { type: 'activity', text: ok ? `hub → ${item.tool}` : `⚠ hub → ${item.tool} ${item.status}` },
          ];
        }
        case 'file_change':
          return (item.changes ?? []).map((change) => ({
            type: 'file-change' as const,
            path: change.path,
            kind: FILE_KIND[change.kind] ?? 'edit',
          }));
        case 'error':
          return item.message ? [{ type: 'activity', text: `⚠ ${item.message}` }] : [];
        default:
          return [];
      }
    }
    default:
      return [];
  }
}

/** Quote a single argument for a Windows shell command line (spaces only —
 * our generated args never contain cmd metacharacters). */
function quoteForShell(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

/**
 * Codex CLI co-founder. Turn-based under the hood: every delivery runs
 * `codex exec --json` (resuming the same thread), so context persists across
 * turns while the process only lives — and only holds memory — while
 * actually thinking. Prompts travel via stdin to sidestep shell quoting.
 */
export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex' as const;

  private readonly options: CodexAdapterOptions;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly queue: string[] = [];
  private sessionId: string | undefined;
  private child: ChildProcess | undefined;
  private stopped = false;
  busy = false;

  constructor(options: CodexAdapterOptions) {
    this.options = options;
  }

  async start(bootstrap: string): Promise<void> {
    this.emit({ type: 'status', status: 'starting' });
    this.runTurn(bootstrap);
  }

  deliver(digest: string): void {
    if (this.stopped) return;
    if (this.busy) {
      this.queue.push(digest);
      return;
    }
    this.runTurn(digest);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    if (this.child && this.child.exitCode === null) {
      this.child.kill();
    }
    this.child = undefined;
  }

  onEvent(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Exposed for tests: the argv used to launch a turn. */
  buildArgs(): string[] {
    const args = [
      'exec',
      '--json',
      '-s',
      this.options.sandbox ?? 'workspace-write',
      '-C',
      this.options.cwd,
      '-c',
      `mcp_servers.hub.url=${JSON.stringify(this.options.hubUrl)}`,
      // exec mode is non-interactive: without this, every hub tool call is
      // auto-cancelled by the unanswerable approval prompt (openai/codex#16685)
      '-c',
      'mcp_servers.hub.default_tools_approval_mode="auto"',
    ];
    if (this.options.model) args.push('-m', this.options.model);
    if (this.sessionId) {
      args.push('resume', this.sessionId, '-');
    } else {
      args.push('-');
    }
    return args;
  }

  private runTurn(prompt: string): void {
    this.busy = true;
    this.emit({ type: 'status', status: 'working' });

    // On Windows the real `codex` is a .cmd shim, which only runs through a
    // shell. Passing an args array alongside shell:true is deprecated
    // (DEP0190), so we assemble the command line ourselves with space-safe
    // quoting. Elsewhere (and for test overrides) spawn directly, no shell.
    const args = this.buildArgs();
    const child =
      this.options.executable === undefined && process.platform === 'win32'
        ? spawn(['codex.cmd', ...args.map(quoteForShell)].join(' '), {
            cwd: this.options.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
          })
        : spawn(this.options.executable ?? 'codex', args, {
            cwd: this.options.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
    this.child = child;

    child.stdin?.end(prompt);

    let sawTurnComplete = false;
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        for (const event of parseCodexLine(line)) {
          if (event.type === 'session') this.sessionId = event.id;
          if (event.type === 'turn-complete') sawTurnComplete = true;
          // turn-complete is emitted from the exit handler once flushing is decided
          if (event.type !== 'turn-complete') this.emit(event);
        }
      }
    });

    let stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    child.on('error', (error) => {
      this.finishTurn(`Failed to launch codex: ${error.message}`);
    });
    child.on('close', (code) => {
      if (code !== 0 && !this.stopped) {
        this.finishTurn(`codex exited with code ${code}${stderrTail ? `: ${stderrTail}` : ''}`);
        return;
      }
      if (!sawTurnComplete && !this.stopped) {
        this.emit({ type: 'status', status: 'idle' });
      }
      this.finishTurn();
    });
  }

  private finishTurn(error?: string): void {
    this.busy = false;
    this.child = undefined;
    if (error) {
      this.emit({ type: 'error', message: error });
      this.emit({ type: 'status', status: 'idle' });
    }
    this.emit({ type: 'turn-complete' });
    if (this.queue.length > 0 && !this.stopped) {
      const next = this.queue.splice(0).join('\n\n');
      this.runTurn(next);
    }
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
