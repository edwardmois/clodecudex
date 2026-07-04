import { randomUUID } from 'node:crypto';
import type { ChatMessage, Participant } from './types.js';

export interface PostInput {
  from: Participant;
  text: string;
  to?: Participant;
}

type PostListener = (message: ChatMessage) => void;

const MAX_TEXT_LENGTH = 8000;

// Control chars except tab (0x09) and newline (0x0A): 0x00-0x08, 0x0B-0x1F, 0x7F.
// Built via fromCharCode so the source file itself stays free of control bytes.
const c = String.fromCharCode.bind(String);
const CONTROL_CHARS = new RegExp(`[${c(0)}-${c(8)}${c(11)}-${c(31)}${c(127)}]`, 'g');

/**
 * Single sanitization choke point for everything that enters the chat.
 * Strips control characters (so message text can't forge `[user] ...` headers
 * or smuggle terminal escapes into digests/TUI) and clamps runaway lengths.
 */
function sanitizeText(raw: string): string {
  const cleaned = raw.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '');
  return cleaned.length > MAX_TEXT_LENGTH
    ? `${cleaned.slice(0, MAX_TEXT_LENGTH)} ...[truncated]`
    : cleaned;
}

/**
 * Append-only founders' chat. Every participant posts here; agents receive
 * their unread backlog as a single batch via {@link drainFor} — the digest
 * mechanism that keeps token usage sane (one delivery per work step instead
 * of one delivery per message).
 */
export class MessageBus {
  private readonly messages: ChatMessage[] = [];
  private readonly listeners = new Set<PostListener>();
  /** Index into `messages` up to which each recipient has been delivered. */
  private readonly cursors = new Map<Participant, number>();

  get transcript(): readonly ChatMessage[] {
    return this.messages;
  }

  /**
   * Preload a transcript from a resumed session. `caughtUp` participants
   * (typically both agents — their own CLIs remember the conversation) start
   * with their cursor past the restored history so nothing is redelivered.
   */
  restore(messages: ChatMessage[], caughtUp: Participant[]): void {
    if (this.messages.length > 0) throw new Error('Cannot restore into a non-empty bus');
    this.messages.push(...messages);
    for (const participant of caughtUp) this.cursors.set(participant, this.messages.length);
  }

  /** Wipe the transcript and all delivery cursors (used by /clear). */
  clear(): void {
    this.messages.length = 0;
    this.cursors.clear();
  }

  post(input: PostInput): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(),
      from: input.from,
      text: sanitizeText(input.text),
      at: Date.now(),
      ...(input.to !== undefined ? { to: input.to } : {}),
    };
    this.messages.push(message);
    for (const listener of this.listeners) listener(message);
    return message;
  }

  onPost(listener: PostListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** All undelivered messages visible to `recipient`, marking them delivered. */
  drainFor(recipient: Participant): ChatMessage[] {
    const pending = this.pendingFor(recipient);
    this.cursors.set(recipient, this.messages.length);
    return pending;
  }

  hasPendingFor(recipient: Participant): boolean {
    return this.pendingFor(recipient).length > 0;
  }

  /** True when an undelivered message is addressed specifically to `recipient`. */
  hasDirectMessageFor(recipient: Participant): boolean {
    return this.pendingFor(recipient).some((m) => m.to === recipient);
  }

  /** Undelivered messages for `recipient` WITHOUT marking them delivered. */
  peekFor(recipient: Participant): ChatMessage[] {
    return this.pendingFor(recipient);
  }

  private pendingFor(recipient: Participant): ChatMessage[] {
    const cursor = this.cursors.get(recipient) ?? 0;
    return this.messages
      .slice(cursor)
      .filter((m) => m.from !== recipient && (m.to === undefined || m.to === recipient));
  }
}
