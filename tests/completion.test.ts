import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FileIndex,
  applyCompletion,
  extractMentionQuery,
  rankCompletions,
} from '../src/tui/completion.js';

describe('extractMentionQuery', () => {
  it('finds the @token being typed at the end of the input', () => {
    expect(extractMentionQuery('fix @src/au')).toEqual({ start: 4, query: 'src/au' });
    expect(extractMentionQuery('@')).toEqual({ start: 0, query: '' });
    expect(extractMentionQuery('@cl')).toEqual({ start: 0, query: 'cl' });
  });

  it('ignores finished, quoted, and mid-word @ tokens', () => {
    expect(extractMentionQuery('fix @src/auth.ts now')).toBeUndefined(); // finished (space)
    expect(extractMentionQuery('see @"my file')).toBeUndefined(); // hand-quoted
    expect(extractMentionQuery('mail edward@gmail')).toBeUndefined(); // email
    expect(extractMentionQuery('no mention here')).toBeUndefined();
  });

  it('completes only the last mention when there are several', () => {
    expect(extractMentionQuery('@claude look at @src/in')).toEqual({ start: 16, query: 'src/in' });
  });
});

describe('rankCompletions', () => {
  const candidates = [
    'src/',
    'src/auth/',
    'src/auth/jwt.ts',
    'src/index.ts',
    'tests/',
    'tests/auth.test.ts',
    'README.md',
  ];

  it('prefers full-path prefix, then basename matches', () => {
    expect(rankCompletions('src/a', candidates)[0]).toBe('src/auth/');
    expect(rankCompletions('jwt', candidates)[0]).toBe('src/auth/jwt.ts');
    // basename prefix (index.ts) beats path substring (tests/…)
    expect(rankCompletions('ind', candidates)[0]).toBe('src/index.ts');
  });

  it('matches case-insensitively and respects the limit', () => {
    expect(rankCompletions('readme', candidates)).toEqual(['README.md']);
    expect(rankCompletions('', candidates, 3)).toHaveLength(3);
    expect(rankCompletions('zzz', candidates)).toEqual([]);
  });

  it('surfaces shallow paths first on an empty query', () => {
    expect(rankCompletions('', candidates)[0]).toBe('src/');
  });
});

describe('applyCompletion', () => {
  const at = (input: string) => {
    const mention = extractMentionQuery(input);
    if (!mention) throw new Error('no mention in test input');
    return mention;
  };

  it('replaces the token and ends file mentions with a space', () => {
    const input = 'fix @src/au';
    expect(applyCompletion(input, at(input), 'src/auth/jwt.ts')).toBe('fix @src/auth/jwt.ts ');
  });

  it('keeps directory completions open for further typing', () => {
    const input = 'look in @sr';
    expect(applyCompletion(input, at(input), 'src/auth/')).toBe('look in @src/auth/');
  });

  it('quotes completions containing spaces', () => {
    const input = 'read @my';
    expect(applyCompletion(input, at(input), 'my docs/notes.md')).toBe('read @"my docs/notes.md" ');
  });

  it('completes founder names at the start of a line', () => {
    const input = '@cl';
    expect(applyCompletion(input, at(input), 'claude')).toBe('@claude ');
  });
});

describe('FileIndex', () => {
  it('indexes files and their ancestor directories outside a git repo', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ccx-completion-'));
    mkdirSync(path.join(root, 'src', 'auth'), { recursive: true });
    mkdirSync(path.join(root, 'node_modules', 'junk'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'auth', 'jwt.ts'), '');
    writeFileSync(path.join(root, 'README.md'), '');
    writeFileSync(path.join(root, 'node_modules', 'junk', 'ignored.js'), '');

    const entries = new FileIndex(root).candidates();
    expect(entries).toContain('src/');
    expect(entries).toContain('src/auth/');
    expect(entries).toContain('src/auth/jwt.ts');
    expect(entries).toContain('README.md');
    expect(entries.some((e) => e.includes('node_modules'))).toBe(false);
  });

  it('reuses the cached index within the TTL', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ccx-completion-'));
    writeFileSync(path.join(root, 'a.txt'), '');
    const index = new FileIndex(root);
    expect(index.candidates()).toContain('a.txt');
    writeFileSync(path.join(root, 'b.txt'), '');
    // still the cached snapshot — no disk hit per keystroke
    expect(index.candidates()).not.toContain('b.txt');
  });
});
