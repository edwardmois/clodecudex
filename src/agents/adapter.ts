import type { AgentName } from '../core/types.js';

export type AgentStatus = 'starting' | 'idle' | 'working';

export type AgentEvent =
  /** Lifecycle state changes, for the TUI status bar. */
  | { type: 'status'; status: AgentStatus }
  /** The agent said something outside the hub (its narrative output). */
  | { type: 'message'; text: string }
  /** One-line activity note: a command run, a tool call, a file touched. */
  | { type: 'activity'; text: string }
  /** The agent changed a file on disk. */
  | { type: 'file-change'; path: string; kind: 'add' | 'edit' | 'delete' }
  /** The underlying session id became known (used for crash resume). */
  | { type: 'session'; id: string }
  /** Token usage for one completed turn (both CLIs report this in-stream). */
  | { type: 'usage'; input: number; cached: number; output: number }
  /** A unit of agent work finished; the adapter can accept the next delivery. */
  | { type: 'turn-complete' }
  | { type: 'error'; message: string };

export type AgentEventListener = (event: AgentEvent) => void;

/**
 * One co-founder. Implementations wrap a real coding agent (Claude Code,
 * Codex CLI) behind a uniform surface: bootstrap it, deliver batched chat
 * digests, observe what it does.
 */
export interface AgentAdapter {
  readonly name: AgentName;
  readonly busy: boolean;
  /** Spawn the agent and send its bootstrap prompt (persona + goal context). */
  start(bootstrap: string): Promise<void>;
  /**
   * Deliver a batched digest of chat/board updates. If the agent is mid-turn
   * the delivery is queued and flushed when the turn completes.
   */
  deliver(digest: string): void;
  /**
   * Abort the current turn (user pressed Esc). The agent stays alive and
   * keeps its context; queued digests are held until the next delivery
   * instead of auto-flushing, so the user's next message goes first.
   */
  interrupt(): void;
  /** Stop the agent. Safe to call twice. */
  stop(): Promise<void>;
  onEvent(listener: AgentEventListener): () => void;
}
