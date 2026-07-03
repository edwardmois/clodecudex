import { describe, expect, it } from 'vitest';
import { formatActivity } from '../src/tui/format.js';

describe('formatActivity (quiet mode)', () => {
  it('drops internal tool glyphs', () => {
    expect(formatActivity('⚒ ToolSearch', false)).toBeUndefined();
    expect(formatActivity('⚒ mcp__hub__list_tasks', false)).toBeUndefined();
  });

  it('drops successful hub tool calls', () => {
    expect(formatActivity('hub → post_message', false)).toBeUndefined();
  });

  it('keeps failed hub calls and other warnings', () => {
    expect(formatActivity('⚠ hub → post_message failed', false)).toBe(
      '⚠ hub → post_message failed',
    );
  });

  it('strips the Windows powershell.exe -Command prefix from codex commands', () => {
    const raw =
      '$ "C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command \'Get-ChildItem -Force\'';
    expect(formatActivity(raw, false)).toBe('$ Get-ChildItem -Force');
  });

  it('collapses multi-line commands and clamps long ones', () => {
    const raw = `$ node -e "${'x'.repeat(200)}\nsecond line"`;
    const out = formatActivity(raw, false);
    expect(out).toBeDefined();
    expect(out).not.toContain('\n');
    expect((out ?? '').length).toBeLessThanOrEqual(100);
    expect(out?.endsWith('…')).toBe(true);
  });

  it('passes everything through untouched in verbose mode', () => {
    expect(formatActivity('⚒ ToolSearch', true)).toBe('⚒ ToolSearch');
    expect(formatActivity('hub → post_message', true)).toBe('hub → post_message');
  });
});
