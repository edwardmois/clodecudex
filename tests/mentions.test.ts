import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { expandFileMentions } from '../src/tui/mentions.js';

describe('expandFileMentions', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'ccx-mentions-'));
    mkdirSync(path.join(cwd, 'src'), { recursive: true });
    writeFileSync(path.join(cwd, 'src', 'slugify.js'), 'export {}');
    writeFileSync(path.join(cwd, 'README.md'), '# hi');
  });

  it('validates and normalizes an existing file mention, appending a footer', () => {
    const r = expandFileMentions('fix the bug in @src/slugify.js please', cwd);
    expect(r.missing).toEqual([]);
    expect(r.files).toEqual(['src/slugify.js']);
    expect(r.text).toContain('fix the bug in src/slugify.js please');
    expect(r.text).toContain('── Files referenced');
    expect(r.text).toContain('- src/slugify.js');
  });

  it('handles trailing punctuation and windows separators', () => {
    const r = expandFileMentions('look at @src\\slugify.js, ok?', cwd);
    expect(r.files).toEqual(['src/slugify.js']);
    expect(r.text).toContain('look at src/slugify.js, ok?');
  });

  it('reports path-like mentions that do not exist and flags them as missing', () => {
    const r = expandFileMentions('check @src/nope.ts', cwd);
    expect(r.missing).toEqual(['src/nope.ts']);
    expect(r.files).toEqual([]);
    expect(r.text).not.toContain('── Files referenced');
  });

  it('rejects mentions escaping the project root', () => {
    const r = expandFileMentions('read @../../etc/passwd now', cwd);
    expect(r.missing).toEqual(['../../etc/passwd']);
  });

  it('leaves founder mentions and non-path @words untouched', () => {
    const r = expandFileMentions('@claude ping @codex and thank @everyone', cwd);
    expect(r.files).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.text).toBe('@claude ping @codex and thank @everyone');
  });

  it('dedupes repeated mentions of the same file', () => {
    const r = expandFileMentions('@README.md and again @README.md', cwd);
    expect(r.files).toEqual(['README.md']);
  });
});
