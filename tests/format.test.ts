import { describe, expect, it } from 'vitest';
import { formatActivity, isNearDuplicate } from '../src/tui/format.js';
import { isUsageLimitError } from '../src/core/session.js';

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

describe('isNearDuplicate', () => {
  it('detects narration repeating a chat post (containment after normalization)', () => {
    expect(
      isNearDuplicate(
        'Idle and ready. No task claimed yet.',
        'Idle and ready.  No task claimed yet.',
      ),
    ).toBe(true);
    expect(
      isNearDuplicate(
        'Understood. Idle and ready. No task claimed yet.',
        'Idle and ready. No task claimed yet.',
      ),
    ).toBe(true);
  });

  it('does not flag genuinely different messages', () => {
    expect(isNearDuplicate('T1 approved, closing.', 'Starting on the tests now.')).toBe(false);
    expect(isNearDuplicate('ok', 'ok then, moving on to T2')).toBe(false);
    expect(isNearDuplicate(undefined, 'anything')).toBe(false);
  });
});

describe('isUsageLimitError', () => {
  it('matches real limit messages from both CLIs', () => {
    expect(isUsageLimitError("You've hit your session limit · resets 10:10pm")).toBe(true);
    expect(isUsageLimitError('usage limit reached')).toBe(true);
    expect(isUsageLimitError('Rate limit exceeded, retry later')).toBe(true);
    expect(isUsageLimitError('HTTP 429 Too Many Requests')).toBe(true);
  });

  it('does not match ordinary errors', () => {
    expect(isUsageLimitError('spawn failed unexpectedly')).toBe(false);
    expect(isUsageLimitError('file size limit is 10MB')).toBe(false);
  });
});
