import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InputHistory, historyPath, loadHistory, saveHistory } from '../src/tui/history.js';

describe('InputHistory', () => {
  it('recalls entries backwards and forwards, preserving the draft', () => {
    const history = new InputHistory(['first', 'second']);
    expect(history.up('typing this')).toBe('second');
    expect(history.up('')).toBe('first');
    expect(history.up('')).toBeUndefined(); // oldest — stay put
    expect(history.down()).toBe('second');
    expect(history.down()).toBe('typing this'); // the stashed draft comes back
    expect(history.down()).toBeUndefined();
  });

  it('collapses consecutive duplicates and ignores blank submissions', () => {
    const history = new InputHistory();
    history.push('build it');
    history.push('build it');
    history.push('   ');
    history.push('test it');
    expect(history.all()).toEqual(['build it', 'test it']);
  });

  it('resets navigation after a push', () => {
    const history = new InputHistory(['a']);
    history.up('');
    history.push('b');
    expect(history.up('')).toBe('b');
  });
});

describe('history persistence', () => {
  it('round-trips entries through .ccx/history.json', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'ccx-history-'));
    saveHistory(cwd, ['one', 'two']);
    expect(loadHistory(cwd)).toEqual(['one', 'two']);
  });

  it('returns empty history for missing or corrupt files', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'ccx-history-'));
    expect(loadHistory(cwd)).toEqual([]);
    mkdirSync(path.dirname(historyPath(cwd)), { recursive: true });
    writeFileSync(historyPath(cwd), '{not json');
    expect(loadHistory(cwd)).toEqual([]);
    writeFileSync(historyPath(cwd), JSON.stringify({ nope: true }));
    expect(loadHistory(cwd)).toEqual([]);
  });
});
