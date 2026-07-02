import { describe, expect, it } from 'vitest';
import { parseInput } from '../src/tui/commands.js';

describe('parseInput', () => {
  it('treats plain text as a broadcast message', () => {
    expect(parseInput('build a login flow')).toEqual({
      type: 'message',
      text: 'build a login flow',
    });
  });

  it('routes @mentions as directed messages', () => {
    expect(parseInput('@claude check the schema')).toEqual({
      type: 'message',
      text: 'check the schema',
      to: 'claude',
    });
    expect(parseInput('@CODEX review T1')).toEqual({
      type: 'message',
      text: 'review T1',
      to: 'codex',
    });
    expect(parseInput('@gemini hello').type).toBe('error');
    expect(parseInput('@claude').type).toBe('error');
  });

  it('parses pause/resume with agent validation', () => {
    expect(parseInput('/pause codex')).toEqual({ type: 'pause', agent: 'codex' });
    expect(parseInput('/resume claude')).toEqual({ type: 'resume', agent: 'claude' });
    expect(parseInput('/pause').type).toBe('error');
    expect(parseInput('/pause bob').type).toBe('error');
  });

  it('parses simple commands and aliases', () => {
    expect(parseInput('/tasks')).toEqual({ type: 'tasks' });
    expect(parseInput('/diff')).toEqual({ type: 'diff' });
    expect(parseInput('/help')).toEqual({ type: 'help' });
    expect(parseInput('/quit')).toEqual({ type: 'quit' });
    expect(parseInput('/exit')).toEqual({ type: 'quit' });
  });

  it('rejects unknown commands and empty input', () => {
    expect(parseInput('/frobnicate').type).toBe('error');
    expect(parseInput('   ').type).toBe('error');
  });
});
