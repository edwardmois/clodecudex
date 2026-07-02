import { randomUUID } from 'node:crypto';
import type { ChatMessage, Participant } from './types.js';

export interface PostInput {
  from: Participant;
  text: string;
  to?: Participant;
}

type PostListener = (message: ChatMessage) => void;

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

  post(input: PostInput): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(),
      from: input.from,
      text: input.text,
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
