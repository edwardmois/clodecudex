/** Everyone who can speak in a session. */
export type Participant = 'user' | 'claude' | 'codex' | 'system';

/** The two agent founders (excludes the human and system notices). */
export type AgentName = 'claude' | 'codex';

export const AGENT_NAMES: readonly AgentName[] = ['claude', 'codex'];

export function otherAgent(agent: AgentName): AgentName {
  return agent === 'claude' ? 'codex' : 'claude';
}

export interface ChatMessage {
  id: string;
  from: Participant;
  /** Undefined means addressed to everyone. */
  to?: Participant;
  text: string;
  at: number;
}

export type TaskStatus = 'open' | 'claimed' | 'review' | 'done';

export interface Task {
  id: string;
  title: string;
  /** File globs (posix-style) this task owns while claimed or in review. */
  files: string[];
  status: TaskStatus;
  owner?: AgentName;
  createdBy: Participant;
  /** Present once the owner has requested cross-review. */
  reviewSummary?: string;
}
