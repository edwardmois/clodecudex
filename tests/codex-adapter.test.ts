import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CodexAdapter, parseCodexLine } from '../src/agents/codex.js';
import type { AgentEvent } from '../src/agents/adapter.js';

// tests/fixtures/codex-hello.jsonl is a real recording of
// `codex exec --json "Reply with exactly: hello from codex"` (codex-cli 0.142.5).
const fixture = readFileSync(new URL('./fixtures/codex-hello.jsonl', import.meta.url), 'utf8');

function parseAll(input: string): AgentEvent[] {
  return input.split('\n').flatMap(parseCodexLine);
}

describe('parseCodexLine', () => {
  it('parses a real recorded session end-to-end', () => {
    const events = parseAll(fixture);
    expect(events).toContainEqual({
      type: 'session',
      id: '019f23e5-1421-7922-8e45-6f53d6eec0ac',
    });
    expect(events).toContainEqual({ type: 'message', text: 'hello from codex' });
    expect(events.at(-1)).toEqual({ type: 'turn-complete' });
  });

  it('maps file_change items to file-change events', () => {
    // Shape per Codex experimental JSON schema (item type FileChangeItem).
    const line = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_2',
        type: 'file_change',
        status: 'completed',
        changes: [
          { path: 'src/auth/jwt.ts', kind: 'add' },
          { path: 'src/index.ts', kind: 'update' },
        ],
      },
    });
    expect(parseCodexLine(line)).toEqual([
      { type: 'file-change', path: 'src/auth/jwt.ts', kind: 'add' },
      { type: 'file-change', path: 'src/index.ts', kind: 'edit' },
    ]);
  });

  it('maps command executions and mcp tool calls to activity lines', () => {
    expect(
      parseCodexLine(
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'i', type: 'command_execution', command: 'npm test', status: 'completed' },
        }),
      ),
    ).toEqual([{ type: 'activity', text: '$ npm test' }]);

    expect(
      parseCodexLine(
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'i', type: 'mcp_tool_call', server: 'hub', tool: 'claim_task' },
        }),
      ),
    ).toEqual([{ type: 'activity', text: 'hub → claim_task' }]);
  });

  it('ignores noise lines and unknown event types without throwing', () => {
    expect(parseCodexLine('Reading additional input from stdin...')).toEqual([]);
    expect(parseCodexLine('Shell cwd was reset to D:\\ClaudeCodeX')).toEqual([]);
    expect(parseCodexLine('{"type":"future.event","payload":{}}')).toEqual([]);
    expect(parseCodexLine('{not json')).toEqual([]);
    expect(parseCodexLine('')).toEqual([]);
  });

  it('surfaces turn failures as an error plus turn completion', () => {
    const events = parseCodexLine(
      JSON.stringify({ type: 'turn.failed', message: 'usage limit reached' }),
    );
    expect(events[0]).toEqual({ type: 'error', message: 'usage limit reached' });
    expect(events.at(-1)).toEqual({ type: 'turn-complete' });
  });
});

describe('CodexAdapter.buildArgs', () => {
  const base = {
    cwd: 'D:/proj',
    hubUrl: 'http://127.0.0.1:5000/hub/abc/codex',
  };

  it('builds a first-turn command with sandbox, cwd, hub MCP config and stdin prompt', () => {
    const adapter = new CodexAdapter(base);
    expect(adapter.buildArgs()).toEqual([
      'exec',
      '--json',
      '-s',
      'workspace-write',
      '-C',
      'D:/proj',
      '-c',
      'mcp_servers.hub.url="http://127.0.0.1:5000/hub/abc/codex"',
      '-c',
      'mcp_servers.hub.default_tools_approval_mode="approve"',
      '-',
    ]);
  });

  it('resumes the recorded session on subsequent turns', () => {
    const adapter = new CodexAdapter(base);
    // simulate the session event captured from a first turn
    (adapter as unknown as { sessionId: string }).sessionId = 'thread-123';
    const args = adapter.buildArgs();
    expect(args).toContain('resume');
    expect(args[args.indexOf('resume') + 1]).toBe('thread-123');
    expect(args.at(-1)).toBe('-');
  });

  it('passes the model override through', () => {
    const adapter = new CodexAdapter({ ...base, model: 'gpt-5.2-codex' });
    expect(adapter.buildArgs()).toContain('gpt-5.2-codex');
  });
});
