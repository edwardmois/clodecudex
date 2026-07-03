import { MessageBus } from './bus.js';
import { TaskBoard } from './taskboard.js';
import { FoundersHub } from '../hub/server.js';
import { buildBootstrap } from '../config/personas.js';
import { ClaudeAdapter } from '../agents/claude.js';
import { CodexAdapter } from '../agents/codex.js';
import type { AgentAdapter, AgentEvent, AgentStatus } from '../agents/adapter.js';
import type { CcxConfig } from '../config/config.js';
import {
  AGENT_NAMES,
  type AgentName,
  type ChatMessage,
  type Participant,
  type Task,
} from './types.js';

export type SessionEvent =
  | { type: 'chat'; message: ChatMessage }
  | { type: 'agent-status'; agent: AgentName; status: AgentStatus }
  | { type: 'agent-message'; agent: AgentName; text: string }
  | { type: 'agent-activity'; agent: AgentName; text: string }
  | { type: 'file-change'; agent: AgentName; path: string; kind: 'add' | 'edit' | 'delete' }
  | { type: 'task-update'; task: Task }
  | { type: 'violation'; agent: AgentName; path: string }
  | { type: 'agent-error'; agent: AgentName; message: string };

export interface SessionOptions {
  cwd: string;
  config: CcxConfig;
  /** Injectable for tests; defaults to real Claude/Codex adapters. */
  createAdapters?: (hub: FoundersHub) => Record<AgentName, AgentAdapter>;
  /** How long peer chatter may wait before being flushed to an idle agent. */
  idleFlushMs?: number;
  /** How often to check for deadlock (both idle + open tasks). */
  nudgeIntervalMs?: number;
}

const DEFAULT_IDLE_FLUSH_MS = 45_000;
const DEFAULT_NUDGE_INTERVAL_MS = 90_000;

function formatDigest(messages: ChatMessage[]): string {
  // Continuation lines are indented so multi-line text can never forge a
  // `[sender]` header at column 0 (bus sanitization strips the rest).
  const lines = messages.map(
    (m) => `[${m.from}${m.to ? ` → ${m.to}` : ''}] ${m.text.replace(/\n/g, '\n    ')}`,
  );
  return `── New chat messages ──\n${lines.join('\n')}`;
}

/**
 * The orchestrator: owns the bus, board, and hub; runs both agents; and
 * decides when chat is worth waking an agent for.
 *
 * Delivery policy (the token-budget core):
 * - Messages from the user, or addressed directly to an agent, are delivered
 *   as soon as that agent is idle.
 * - Peer chatter is lazy: it rides along on the agent's next hub tool call
 *   (the hub piggybacks unread chat on every response) or is flushed after
 *   `idleFlushMs` if the agent stays idle — never one delivery per message.
 */
export class Session {
  readonly bus = new MessageBus();
  readonly board: TaskBoard;
  readonly hub: FoundersHub;

  private readonly options: SessionOptions;
  private agents: Record<AgentName, AgentAdapter> | undefined;
  private readonly status: Record<AgentName, AgentStatus> = {
    claude: 'starting',
    codex: 'starting',
  };
  private readonly paused = new Set<AgentName>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private flushTimer: NodeJS.Timeout | undefined;
  private nudgeTimer: NodeJS.Timeout | undefined;
  private lastNudgeAt = 0;
  private started = false;

  constructor(options: SessionOptions) {
    this.options = options;
    this.board = new TaskBoard(options.cwd);
    this.hub = new FoundersHub({ bus: this.bus, board: this.board });

    this.bus.onPost((message) => {
      this.emit({ type: 'chat', message });
      // user posts and direct mentions wake idle recipients immediately
      for (const agent of AGENT_NAMES) {
        if (message.from === 'user' || message.to === agent) this.tryDeliver(agent, false);
      }
    });
    this.board.onChange((task) => this.emit({ type: 'task-update', task }));
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('Session already started');
    this.started = true;
    await this.hub.start();

    this.agents = this.options.createAdapters
      ? this.options.createAdapters(this.hub)
      : this.createRealAdapters();

    for (const agent of AGENT_NAMES) {
      const adapter = this.agents[agent];
      adapter.onEvent((event) => this.handleAgentEvent(agent, event));
    }
    const { config } = this.options;
    await Promise.all([
      this.agents.claude.start(buildBootstrap('claude', config.claude.persona)),
      this.agents.codex.start(buildBootstrap('codex', config.codex.persona)),
    ]);

    const flushMs = this.options.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS;
    this.flushTimer = setInterval(() => {
      for (const agent of AGENT_NAMES) this.tryDeliver(agent, true);
    }, flushMs);
    const nudgeMs = this.options.nudgeIntervalMs ?? DEFAULT_NUDGE_INTERVAL_MS;
    this.nudgeTimer = setInterval(() => this.checkDeadlock(nudgeMs), nudgeMs);
  }

  /** The human founder speaks. `to` targets one agent (from "@claude ..."). */
  postUserMessage(text: string, to?: AgentName): void {
    this.bus.post(to ? { from: 'user', text, to } : { from: 'user', text });
  }

  pause(agent: AgentName): void {
    this.paused.add(agent);
  }

  resume(agent: AgentName): void {
    this.paused.delete(agent);
    this.tryDeliver(agent, true);
  }

  isPaused(agent: AgentName): boolean {
    return this.paused.has(agent);
  }

  statusOf(agent: AgentName): AgentStatus {
    return this.status[agent];
  }

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.nudgeTimer) clearInterval(this.nudgeTimer);
    if (this.agents) {
      await Promise.all(AGENT_NAMES.map((a) => this.agents?.[a].stop()));
    }
    await this.hub.stop();
  }

  private createRealAdapters(): Record<AgentName, AgentAdapter> {
    const { cwd, config } = this.options;
    return {
      claude: new ClaudeAdapter({
        cwd,
        hubUrl: this.hub.urlFor('claude'),
        ownershipUrl: this.hub.ownershipUrlFor('claude'),
        permissionMode: config.claude.permissionMode,
        ...(config.claude.model ? { model: config.claude.model } : {}),
      }),
      codex: new CodexAdapter({
        cwd,
        hubUrl: this.hub.urlFor('codex'),
        sandbox: config.codex.sandbox,
        ...(config.codex.model ? { model: config.codex.model } : {}),
      }),
    };
  }

  private handleAgentEvent(agent: AgentName, event: AgentEvent): void {
    switch (event.type) {
      case 'status':
        this.status[agent] = event.status;
        this.emit({ type: 'agent-status', agent, status: event.status });
        break;
      case 'message':
        this.emit({ type: 'agent-message', agent, text: event.text });
        break;
      case 'activity':
        this.emit({ type: 'agent-activity', agent, text: event.text });
        break;
      case 'file-change':
        this.emit({ type: 'file-change', agent, path: event.path, kind: event.kind });
        // Codex-side ownership is monitored, not enforced (Claude has the hook):
        // violations are surfaced to everyone, loudly.
        if (!this.board.canEdit(agent, event.path)) {
          this.emit({ type: 'violation', agent, path: event.path });
          this.bus.post({
            from: 'system',
            text: `⚠ ${agent} touched "${event.path}" which is owned by the other founder's active task. ${agent}: stop, coordinate on the board first, and revert if needed.`,
          });
        }
        break;
      case 'error':
        this.emit({ type: 'agent-error', agent, message: event.message });
        break;
      case 'turn-complete':
        this.status[agent] = 'idle';
        this.tryDeliver(agent, true);
        break;
      case 'session':
        break;
    }
  }

  /**
   * Deliver pending chat to an idle agent. Immediate deliveries require a
   * user post or direct mention; `includeLazy` flushes everything (used by
   * the timer, turn boundaries, and resume).
   */
  private tryDeliver(agent: AgentName, includeLazy: boolean): void {
    const adapter = this.agents?.[agent];
    if (!adapter || this.paused.has(agent) || adapter.busy) return;
    if (!this.bus.hasPendingFor(agent)) return;
    if (!includeLazy && !this.bus.hasDirectMessageFor(agent) && !this.hasUserPendingFor(agent)) {
      return;
    }
    const messages = this.bus.drainFor(agent);
    if (messages.length === 0) return;
    this.status[agent] = 'working';
    adapter.deliver(formatDigest(messages));
  }

  private hasUserPendingFor(agent: AgentName): boolean {
    // peek without draining: any undelivered user-authored message?
    return this.bus
      .peekFor(agent)
      .some((m) => m.from === 'user');
  }

  private checkDeadlock(nudgeMs: number): void {
    if (!this.agents) return;
    const bothIdle = AGENT_NAMES.every(
      (a) => this.status[a] === 'idle' && !this.agents?.[a].busy && !this.paused.has(a),
    );
    const openTasks = this.board.listTasks().filter((t) => t.status !== 'done');
    const nothingPending = AGENT_NAMES.every((a) => !this.bus.hasPendingFor(a));
    if (bothIdle && openTasks.length > 0 && nothingPending) {
      const now = Date.now();
      if (now - this.lastNudgeAt < nudgeMs) return;
      this.lastNudgeAt = now;
      this.bus.post({
        from: 'system',
        text: `Nudge: ${openTasks.length} task(s) still open (${openTasks
          .map((t) => t.id)
          .join(', ')}) and both founders are idle. Claim, discuss, or ask the user.`,
      });
    }
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export type { Participant };
