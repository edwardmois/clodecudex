import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeLine } from '../src/agents/claude.js';
import { parseCodexLine } from '../src/agents/codex.js';
import { MessageBus } from '../src/core/bus.js';
import { TaskBoard } from '../src/core/taskboard.js';
import {
  JournalWriter,
  loadLatestJournal,
  newJournalPath,
  type SessionJournalData,
} from '../src/core/journal.js';
import { readCodexRateLimits } from '../src/core/usage.js';
import type { ChatMessage, Task } from '../src/core/types.js';

describe('usage events from CLI streams', () => {
  it('claude result events yield usage totals', () => {
    const line = JSON.stringify({
      type: 'result',
      is_error: false,
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 4000,
        output_tokens: 250,
      },
    });
    expect(parseClaudeLine(line)).toContainEqual({
      type: 'usage',
      input: 150,
      cached: 4000,
      output: 250,
    });
  });

  it('codex turn.completed yields usage with cached split out of input', () => {
    const line = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 66177, cached_input_tokens: 48256, output_tokens: 167 },
    });
    expect(parseCodexLine(line)).toContainEqual({
      type: 'usage',
      input: 66177 - 48256,
      cached: 48256,
      output: 167,
    });
  });
});

describe('readCodexRateLimits', () => {
  it('finds the latest rate_limits snapshot in the newest rollout file', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ccx-codex-home-'));
    const day = path.join(home, 'sessions', '2026', '07', '03');
    mkdirSync(day, { recursive: true });
    const snapshot = {
      payload: {
        type: 'token_count',
        rate_limits: {
          plan_type: 'plus',
          primary: { used_percent: 13, window_minutes: 300, resets_at: 1783114265 },
          secondary: { used_percent: 37, window_minutes: 10080, resets_at: 1783541613 },
        },
      },
    };
    writeFileSync(
      path.join(day, 'rollout-x.jsonl'),
      `${JSON.stringify({ payload: { type: 'other' } })}\n${JSON.stringify(snapshot)}\n`,
    );

    const limits = readCodexRateLimits(home);
    expect(limits?.plan_type).toBe('plus');
    expect(limits?.primary?.used_percent).toBe(13);
    expect(limits?.secondary?.used_percent).toBe(37);
  });

  it('returns undefined when no sessions exist', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ccx-codex-empty-'));
    expect(readCodexRateLimits(home)).toBeUndefined();
  });
});

describe('journal roundtrip', () => {
  it('writes on flush and loads the newest journal back', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ccx-journal-'));
    const data: SessionJournalData = {
      version: 1,
      startedAt: 1,
      updatedAt: 2,
      claudeSessionId: 'cs-1',
      codexThreadId: 'th-1',
      transcript: [{ id: 'm1', from: 'user', text: 'goal', at: 1 }],
      tasks: [{ id: 'T1', title: 'auth', files: ['src/**'], status: 'claimed', owner: 'claude', createdBy: 'user' }],
    };
    const writer = new JournalWriter(newJournalPath(dir));
    writer.schedule(data);
    writer.flush();

    const loaded = loadLatestJournal(dir);
    expect(loaded?.data.claudeSessionId).toBe('cs-1');
    expect(loaded?.data.transcript[0]?.text).toBe('goal');
    expect(JSON.parse(readFileSync(loaded?.path ?? '', 'utf8')).version).toBe(1);
  });

  it('loadLatestJournal returns undefined for a missing dir', () => {
    expect(loadLatestJournal(path.join(tmpdir(), 'ccx-nope-xyz'))).toBeUndefined();
  });
});

describe('restore', () => {
  it('bus restore preloads history without redelivering to agents', () => {
    const bus = new MessageBus();
    const history: ChatMessage[] = [
      { id: 'm1', from: 'user', text: 'old goal', at: 1 },
      { id: 'm2', from: 'codex', text: 'old status', at: 2 },
    ];
    bus.restore(history, ['claude', 'codex']);
    expect(bus.transcript).toHaveLength(2);
    expect(bus.hasPendingFor('claude')).toBe(false);
    expect(bus.hasPendingFor('codex')).toBe(false);

    bus.post({ from: 'user', text: 'new message' });
    expect(bus.drainFor('claude').map((m) => m.text)).toEqual(['new message']);
  });

  it('board restore keeps ownership enforcement and id numbering', () => {
    const board = new TaskBoard('/repo');
    const tasks: Task[] = [
      { id: 'T3', title: 'auth', files: ['src/auth/**'], status: 'claimed', owner: 'codex', createdBy: 'user' },
    ];
    board.restore(tasks);
    expect(board.canEdit('claude', '/repo/src/auth/jwt.ts')).toBe(false);
    expect(board.createTask('next', [], 'user').id).toBe('T4');
  });
});
