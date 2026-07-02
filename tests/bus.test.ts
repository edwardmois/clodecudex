import { describe, expect, it, vi } from 'vitest';
import { MessageBus } from '../src/core/bus.js';

describe('MessageBus', () => {
  it('appends posted messages to the transcript in order', () => {
    const bus = new MessageBus();
    bus.post({ from: 'user', text: 'build a login flow' });
    bus.post({ from: 'claude', text: 'taking the middleware' });

    expect(bus.transcript.map((m) => m.text)).toEqual([
      'build a login flow',
      'taking the middleware',
    ]);
    expect(bus.transcript[0]?.id).not.toEqual(bus.transcript[1]?.id);
  });

  it('notifies subscribers on every post', () => {
    const bus = new MessageBus();
    const seen = vi.fn();
    bus.onPost(seen);
    bus.post({ from: 'user', text: 'hello' });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello' }));
  });

  it('unsubscribes listeners', () => {
    const bus = new MessageBus();
    const seen = vi.fn();
    const off = bus.onPost(seen);
    off();
    bus.post({ from: 'user', text: 'hello' });
    expect(seen).not.toHaveBeenCalled();
  });

  it('drainFor returns undelivered messages from others, once', () => {
    const bus = new MessageBus();
    bus.post({ from: 'user', text: 'goal' });
    bus.post({ from: 'codex', text: 'I will take tests' });

    const first = bus.drainFor('claude');
    expect(first.map((m) => m.text)).toEqual(['goal', 'I will take tests']);
    expect(bus.drainFor('claude')).toEqual([]);
  });

  it('does not deliver an agent its own messages', () => {
    const bus = new MessageBus();
    bus.post({ from: 'claude', text: 'my own note' });
    expect(bus.drainFor('claude')).toEqual([]);
    // ...but the other side sees it
    expect(bus.drainFor('codex').map((m) => m.text)).toEqual(['my own note']);
  });

  it('does not deliver directed messages to non-recipients', () => {
    const bus = new MessageBus();
    bus.post({ from: 'user', text: 'just for codex', to: 'codex' });
    expect(bus.drainFor('claude')).toEqual([]);
    expect(bus.drainFor('codex').map((m) => m.text)).toEqual(['just for codex']);
  });

  it('reports pending and direct-message state per recipient', () => {
    const bus = new MessageBus();
    expect(bus.hasPendingFor('claude')).toBe(false);

    bus.post({ from: 'codex', text: 'fyi everyone' });
    expect(bus.hasPendingFor('claude')).toBe(true);
    expect(bus.hasDirectMessageFor('claude')).toBe(false);

    bus.post({ from: 'user', text: '@claude look at this', to: 'claude' });
    expect(bus.hasDirectMessageFor('claude')).toBe(true);

    bus.drainFor('claude');
    expect(bus.hasPendingFor('claude')).toBe(false);
    expect(bus.hasDirectMessageFor('claude')).toBe(false);
  });
});
