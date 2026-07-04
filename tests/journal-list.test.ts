import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listJournals, loadJournal, type SessionJournalData } from '../src/core/journal.js';

function journal(overrides: Partial<SessionJournalData>): SessionJournalData {
  return {
    version: 1,
    startedAt: 1,
    updatedAt: 1,
    transcript: [],
    tasks: [],
    ...overrides,
  };
}

describe('listJournals', () => {
  it('lists sessions newest first with goal/message/task summaries', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ccx-journals-'));
    writeFileSync(
      path.join(dir, 'a.json'),
      JSON.stringify(
        journal({
          updatedAt: 100,
          transcript: [{ id: 'm1', from: 'user', text: 'build the login flow', at: 1 }],
          tasks: [
            { id: 'T1', title: 'x', files: [], status: 'done', createdBy: 'user' },
            { id: 'T2', title: 'y', files: [], status: 'open', createdBy: 'user' },
          ],
        }),
      ),
    );
    writeFileSync(path.join(dir, 'b.json'), JSON.stringify(journal({ updatedAt: 200 })));
    writeFileSync(path.join(dir, 'corrupt.json'), '{nope');

    const sessions = listJournals(dir);
    expect(sessions).toHaveLength(2); // corrupt file skipped
    expect(sessions[0]?.updatedAt).toBe(200); // newest first
    expect(sessions[1]?.firstGoal).toBe('build the login flow');
    expect(sessions[1]?.messages).toBe(1);
    expect(sessions[1]?.openTasks).toBe(1);
  });

  it('returns an empty list for a missing directory', () => {
    expect(listJournals(path.join(tmpdir(), 'ccx-does-not-exist'))).toEqual([]);
  });
});

describe('loadJournal', () => {
  it('rejects corrupt and foreign-version files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ccx-journals-'));
    mkdirSync(dir, { recursive: true });
    const corrupt = path.join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{nope');
    expect(loadJournal(corrupt)).toBeUndefined();
    const foreign = path.join(dir, 'foreign.json');
    writeFileSync(foreign, JSON.stringify({ version: 99 }));
    expect(loadJournal(foreign)).toBeUndefined();
    expect(loadJournal(path.join(dir, 'missing.json'))).toBeUndefined();
  });
});
