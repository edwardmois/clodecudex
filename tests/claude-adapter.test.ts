import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeAdapter,
  OWNERSHIP_HOOK_SOURCE,
  parseClaudeLine,
} from '../src/agents/claude.js';
import type { AgentEvent } from '../src/agents/adapter.js';
import { MessageBus } from '../src/core/bus.js';
import { TaskBoard } from '../src/core/taskboard.js';
import { FoundersHub } from '../src/hub/server.js';

// tests/fixtures/claude-hello.jsonl mirrors a real recording of
// `claude -p --output-format stream-json --verbose` (Claude Code 2.1.198),
// with the init event trimmed to the fields the parser reads.
const fixture = readFileSync(new URL('./fixtures/claude-hello.jsonl', import.meta.url), 'utf8');

function parseAll(input: string): AgentEvent[] {
  return input.split('\n').flatMap(parseClaudeLine);
}

describe('parseClaudeLine', () => {
  it('parses a real recorded session end-to-end', () => {
    const events = parseAll(fixture);
    expect(events).toContainEqual({
      type: 'session',
      id: '7a3f9934-ebb2-4c32-98a7-a99e25a6491a',
    });
    expect(events).toContainEqual({ type: 'message', text: 'hello from claude' });
    expect(events.at(-1)).toEqual({ type: 'turn-complete' });
  });

  it('maps file tools to file-change and Bash to activity', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/auth/jwt.ts' } },
          { type: 'tool_use', name: 'Write', input: { file_path: 'src/new.ts' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/x.ts' } },
        ],
      },
    });
    expect(parseClaudeLine(line)).toEqual([
      { type: 'file-change', path: 'src/auth/jwt.ts', kind: 'edit' },
      { type: 'file-change', path: 'src/new.ts', kind: 'add' },
      { type: 'activity', text: '$ npm test' },
      { type: 'activity', text: '⚒ Read' },
    ]);
  });

  it('surfaces error results (real not-logged-in recording)', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Not logged in · Please run /login',
      session_id: '5111f9ae',
    });
    const events = parseClaudeLine(line);
    expect(events[0]).toEqual({
      type: 'error',
      message: 'Not logged in · Please run /login',
    });
    expect(events.at(-1)).toEqual({ type: 'turn-complete' });
  });

  it('ignores noise and unknown event types', () => {
    expect(parseClaudeLine('Shell cwd was reset')).toEqual([]);
    expect(parseClaudeLine('{"type":"user","message":{}}')).toEqual([]);
    expect(parseClaudeLine('{"type":"stream_event"}')).toEqual([]);
    expect(parseClaudeLine('')).toEqual([]);
  });
});

describe('ClaudeAdapter.buildArgs', () => {
  it('builds a persistent stream-json session with lean settings and hub config', () => {
    const adapter = new ClaudeAdapter({
      cwd: 'D:/proj',
      hubUrl: 'http://127.0.0.1:5000/hub/abc/claude',
      ownershipUrl: 'http://127.0.0.1:5000/hub/abc/claude/ownership',
      model: 'sonnet',
    });
    const args = adapter.buildArgs('/state');
    expect(args).toContain('-p');
    expect(args).toContain('stream-json');
    expect(args).toContain('--setting-sources');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe(path.join('/state', 'mcp.json'));
    expect(args[args.indexOf('--settings') + 1]).toBe(path.join('/state', 'settings.json'));
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
  });
});

describe('ClaudeAdapter.interrupt', () => {
  const options = {
    cwd: 'D:/proj',
    hubUrl: 'http://127.0.0.1:5000/hub/abc/claude',
    ownershipUrl: 'http://127.0.0.1:5000/hub/abc/claude/ownership',
  };
  interface Internals {
    busy: boolean;
    interrupted: boolean;
    child: unknown;
    queue: string[];
    handleLine(line: string): void;
  }

  it('sends the stream-json interrupt control request to the live process', () => {
    const adapter = new ClaudeAdapter(options);
    const written: string[] = [];
    const internals = adapter as unknown as Internals;
    internals.busy = true;
    internals.child = { stdin: { write: (line: string) => written.push(line) } };

    adapter.interrupt();

    expect(written).toHaveLength(1);
    const request = JSON.parse(written[0] ?? '') as {
      type: string;
      request_id: string;
      request: { subtype: string };
    };
    expect(request.type).toBe('control_request');
    expect(request.request.subtype).toBe('interrupt');
    expect(request.request_id).toBeTruthy();
  });

  it('is a no-op when idle', () => {
    const adapter = new ClaudeAdapter(options);
    expect(() => adapter.interrupt()).not.toThrow();
    expect((adapter as unknown as Internals).interrupted).toBe(false);
  });

  it('swallows the aborted-turn error and holds queued digests', () => {
    const adapter = new ClaudeAdapter(options);
    const events: AgentEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    const internals = adapter as unknown as Internals;
    internals.busy = true;
    internals.interrupted = true;
    internals.queue.push('peer chatter while working');

    // what the CLI streams back after an interrupt: an error result
    internals.handleLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Request interrupted by user',
      }),
    );

    expect(adapter.busy).toBe(false);
    expect(internals.interrupted).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    // held for the next delivery instead of auto-flushed
    expect(internals.queue).toEqual(['peer chatter while working']);
  });
});

describe('ClaudeAdapter state files', () => {
  it('pre-allows all hub tools — headless mode cannot answer permission prompts', () => {
    const adapter = new ClaudeAdapter({
      cwd: 'D:/proj',
      hubUrl: 'http://127.0.0.1:5000/hub/abc/claude',
      ownershipUrl: 'http://127.0.0.1:5000/hub/abc/claude/ownership',
    });
    const stateDir = mkdtempSync(path.join(tmpdir(), 'ccx-state-'));
    (adapter as unknown as { writeStateFiles(dir: string): void }).writeStateFiles(stateDir);
    const settings = JSON.parse(readFileSync(path.join(stateDir, 'settings.json'), 'utf8')) as {
      permissions?: { allow?: string[] };
    };
    expect(settings.permissions?.allow).toContain('mcp__hub');
  });
});

describe('ownership hook end-to-end', () => {
  let bus: MessageBus;
  let board: TaskBoard;
  let hub: FoundersHub;
  let hookPath: string;

  beforeEach(async () => {
    bus = new MessageBus();
    board = new TaskBoard('/repo');
    hub = new FoundersHub({ bus, board });
    await hub.start();
    hookPath = path.join(mkdtempSync(path.join(tmpdir(), 'ccx-hook-')), 'hook.cjs');
    writeFileSync(hookPath, OWNERSHIP_HOOK_SOURCE);
  });

  afterEach(async () => {
    await hub.stop();
  });

  function runHook(url: string, toolInput: Record<string, unknown>): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [hookPath, url], { stdio: ['pipe', 'ignore', 'pipe'] });
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? -1));
      child.stdin.end(JSON.stringify({ tool_name: 'Edit', tool_input: toolInput }));
    });
  }

  it('blocks claude editing a file codex owns (exit 2), allows unowned files (exit 0)', async () => {
    board.claimTask(board.createTask('tests', ['tests/**'], 'user').id, 'codex');
    const url = hub.ownershipUrlFor('claude');

    expect(await runHook(url, { file_path: 'tests/auth.test.ts' })).toBe(2);
    expect(await runHook(url, { file_path: 'src/index.ts' })).toBe(0);
  });

  it('fails open when the hub is unreachable', async () => {
    const url = hub.ownershipUrlFor('claude');
    await hub.stop();
    expect(await runHook(url, { file_path: 'tests/auth.test.ts' })).toBe(0);
    // restart so afterEach stop() has something to close
    hub = new FoundersHub({ bus, board });
    await hub.start();
  });

  it('ignores tool calls without a file path (exit 0)', async () => {
    expect(await runHook(hub.ownershipUrlFor('claude'), { command: 'npm test' })).toBe(0);
  });
});
