import { MessageBus } from './bus.js';
import { TaskBoard } from './taskboard.js';
import { FoundersHub } from '../hub/server.js';
import { emptyTotals, type TokenTotals } from './usage.js';
import type { JournalWriter, SessionJournalData } from './journal.js';
import { buildBootstrap, buildResumeBrief } from '../config/personas.js';
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
  | { type: 'agent-error'; agent: AgentName; message: string }
  /** A founder ran out of subscription quota and was auto-paused. */
  | { type: 'agent-limit'; agent: AgentName; message: string };

export interface SessionOptions {
  cwd: string;
  config: CcxConfig;
  /** Injectable for tests; defaults to real Claude/Codex adapters. */
  createAdapters?: (hub: FoundersHub) => Record<AgentName, AgentAdapter>;
  /** How long peer chatter may wait before being flushed to an idle agent. */
  idleFlushMs?: number;
  /** How often to check for deadlock (both idle + open tasks). */
  nudgeIntervalMs?: number;
  /** Persist chat/board/session-ids here as the session runs. */
  journal?: JournalWriter;
  /** Restore state from a previous session's journal. */
  resume?: SessionJournalData;
}

const DEFAULT_IDLE_FLUSH_MS = 45_000;
const DEFAULT_NUDGE_INTERVAL_MS = 90_000;

/**
 * Recognize "you're out of quota" errors from either CLI, e.g.
 * "You've hit your session limit · resets 10:10pm" (claude) or
 * rate/usage-limit errors from codex.
 */
export function isUsageLimitError(message: string): boolean {
  return /(hit your .{0,20}limit|(usage|session|rate|weekly).{0,10}limit (reached|exceeded)|rate.?limited|too many requests|\b429\b)/i.test(
    message,
  );
}

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
  private readonly limitPaused = new Set<AgentName>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly usage: Record<AgentName, TokenTotals> = {
    claude: emptyTotals(),
    codex: emptyTotals(),
  };
  private readonly sessionIds: Partial<Record<AgentName, string>> = {};
  private readonly startedAt = Date.now();
  private flushTimer: NodeJS.Timeout | undefined;
  private nudgeTimer: NodeJS.Timeout | undefined;
  private lastNudgeAt = 0;
  private started = false;

  constructor(options: SessionOptions) {
    this.options = options;
    this.board = new TaskBoard(options.cwd);
    this.hub = new FoundersHub({ bus: this.bus, board: this.board });

    if (options.resume) {
      // agents catch up through their own CLI histories, not redelivery
      this.bus.restore(options.resume.transcript, [...AGENT_NAMES]);
      this.board.restore(options.resume.tasks);
      if (options.resume.claudeSessionId) this.sessionIds.claude = options.resume.claudeSessionId;
      if (options.resume.codexThreadId) this.sessionIds.codex = options.resume.codexThreadId;
    }

    this.bus.onPost((message) => {
      this.emit({ type: 'chat', message });
      this.saveJournal();
      // user posts and direct mentions wake idle recipients immediately
      for (const agent of AGENT_NAMES) {
        if (message.from === 'user' || message.to === agent) this.tryDeliver(agent, false);
      }
    });
    this.board.onChange((task) => {
      this.emit({ type: 'task-update', task });
      this.saveJournal();
    });
  }

  get resumed(): boolean {
    return this.options.resume !== undefined;
  }

  usageOf(agent: AgentName): TokenTotals {
    return this.usage[agent];
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
    const firstPrompt = (agent: AgentName, persona: string): string => {
      if (!this.options.resume) return buildBootstrap(agent, persona);
      const open = this.board
        .listTasks()
        .filter((t) => t.status !== 'done')
        .map((t) => `${t.id} [${t.status}]${t.owner ? ` @${t.owner}` : ''} ${t.title}`);
      return buildResumeBrief(agent, open);
    };
    await Promise.all([
      this.agents.claude.start(firstPrompt('claude', config.claude.persona)),
      this.agents.codex.start(firstPrompt('codex', config.codex.persona)),
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

  /**
   * Interrupt in-flight work (Esc / /stop). Returns the founders that were
   * actually mid-turn; they stay alive and their context survives — held
   * chat waits so the user's next message is heard first.
   */
  interruptBusy(only?: AgentName): AgentName[] {
    const targets = only ? [only] : [...AGENT_NAMES];
    const interrupted: AgentName[] = [];
    for (const agent of targets) {
      const adapter = this.agents?.[agent];
      if (adapter?.busy) {
        adapter.interrupt();
        interrupted.push(agent);
      }
    }
    return interrupted;
  }

  resume(agent: AgentName): void {
    this.paused.delete(agent);
    this.limitPaused.delete(agent);
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
    this.saveJournal();
    this.options.journal?.flush();
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
        ...(this.options.resume?.claudeSessionId
          ? { resumeSessionId: this.options.resume.claudeSessionId }
          : {}),
      }),
      codex: new CodexAdapter({
        cwd,
        hubUrl: this.hub.urlFor('codex'),
        sandbox: config.codex.sandbox,
        reasoningEffort: config.codex.reasoningEffort,
        ...(config.codex.model ? { model: config.codex.model } : {}),
        ...(this.options.resume?.codexThreadId
          ? { resumeThreadId: this.options.resume.codexThreadId }
          : {}),
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
        if (isUsageLimitError(event.message)) {
          // one announcement, then silence — every delivery would re-fail
          if (!this.limitPaused.has(agent)) {
            this.limitPaused.add(agent);
            this.paused.add(agent);
            this.emit({ type: 'agent-limit', agent, message: event.message });
            this.bus.post({
              from: 'system',
              text: `${agent} hit its subscription usage limit and is paused (${event.message}). The team continues without ${agent}; the user can /resume ${agent} once the limit resets.`,
            });
          }
          break;
        }
        this.emit({ type: 'agent-error', agent, message: event.message });
        break;
      case 'turn-complete':
        this.status[agent] = 'idle';
        this.tryDeliver(agent, true);
        break;
      case 'usage': {
        const totals = this.usage[agent];
        totals.input += event.input;
        totals.cached += event.cached;
        totals.output += event.output;
        totals.turns += 1;
        break;
      }
      case 'session':
        this.sessionIds[agent] = event.id;
        this.saveJournal();
        break;
    }
  }

  private saveJournal(): void {
    this.options.journal?.schedule({
      version: 1,
      startedAt: this.options.resume?.startedAt ?? this.startedAt,
      updatedAt: Date.now(),
      ...(this.sessionIds.claude ? { claudeSessionId: this.sessionIds.claude } : {}),
      ...(this.sessionIds.codex ? { codexThreadId: this.sessionIds.codex } : {}),
      transcript: [...this.bus.transcript],
      tasks: this.board.listTasks(),
    });
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
