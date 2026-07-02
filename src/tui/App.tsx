import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Static, Text, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { execFile } from 'node:child_process';
import type { Session, SessionEvent } from '../core/session.js';
import type { AgentStatus } from '../agents/adapter.js';
import { AGENT_NAMES, type AgentName, type Task } from '../core/types.js';
import { HELP_TEXT, parseInput } from './commands.js';

const AGENT_COLORS: Record<string, string> = {
  user: 'white',
  claude: 'magenta',
  codex: 'cyan',
  system: 'yellow',
};

interface DisplayItem {
  id: number;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  text: string;
}

let nextItemId = 0;
function item(text: string, opts: Partial<DisplayItem> = {}): DisplayItem {
  return { id: nextItemId++, text, ...opts };
}

function statusGlyph(status: AgentStatus, paused: boolean): string {
  if (paused) return '⏸ paused';
  switch (status) {
    case 'working':
      return '● working';
    case 'starting':
      return '◌ starting';
    default:
      return '○ idle';
  }
}

function taskGlyph(task: Task): string {
  const owner = task.owner ? ` @${task.owner}` : '';
  return `${task.id} [${task.status}]${owner} ${task.title}`;
}

export function App({ session }: { session: Session }): React.JSX.Element {
  const { exit } = useApp();
  const [items, setItems] = useState<DisplayItem[]>(() => [
    item('ccx — two co-founders, one terminal. Type a goal, or /help.', {
      color: 'green',
      bold: true,
    }),
  ]);
  const [input, setInput] = useState('');
  const [statuses, setStatuses] = useState<Record<AgentName, AgentStatus>>({
    claude: 'starting',
    codex: 'starting',
  });
  const [pausedAgents, setPausedAgents] = useState<Set<AgentName>>(new Set());
  const [tasks, setTasks] = useState<Task[]>([]);

  const append = useCallback((entry: DisplayItem) => {
    setItems((prev) => [...prev, entry]);
  }, []);

  useEffect(() => {
    return session.onEvent((event: SessionEvent) => {
      switch (event.type) {
        case 'chat': {
          const { from, to, text } = event.message;
          append(
            item(`[${from}${to ? ` → ${to}` : ''}] ${text}`, {
              color: AGENT_COLORS[from] ?? 'white',
              bold: from === 'user',
            }),
          );
          break;
        }
        case 'agent-message':
          append(item(`(${event.agent}) ${event.text}`, { color: AGENT_COLORS[event.agent], dim: true }));
          break;
        case 'agent-activity':
          append(item(`  ${event.agent}: ${event.text}`, { dim: true }));
          break;
        case 'file-change':
          append(item(`  ${event.agent} ${event.kind} ${event.path}`, { dim: true }));
          break;
        case 'violation':
          append(item(`⚠ OWNERSHIP: ${event.agent} touched ${event.path}`, { color: 'red', bold: true }));
          break;
        case 'agent-error':
          append(item(`✗ ${event.agent}: ${event.message}`, { color: 'red' }));
          break;
        case 'agent-status':
          setStatuses((prev) => ({ ...prev, [event.agent]: event.status }));
          break;
        case 'task-update':
          setTasks(session.board.listTasks());
          break;
      }
    });
  }, [session, append]);

  const showDiff = useCallback(() => {
    execFile(
      'git',
      ['diff', '--stat'],
      { cwd: process.cwd(), timeout: 10_000 },
      (error, stdout) => {
        if (error) append(item(`✗ git diff failed: ${error.message}`, { color: 'red' }));
        else append(item(stdout.trim() || '(no uncommitted changes)', { dim: true }));
      },
    );
  }, [append]);

  const submit = useCallback(
    (raw: string) => {
      setInput('');
      const command = parseInput(raw);
      switch (command.type) {
        case 'message':
          session.postUserMessage(command.text, command.to);
          break;
        case 'pause':
          session.pause(command.agent);
          setPausedAgents((prev) => new Set(prev).add(command.agent));
          append(item(`⏸ ${command.agent} paused`, { color: 'yellow' }));
          break;
        case 'resume':
          session.resume(command.agent);
          setPausedAgents((prev) => {
            const next = new Set(prev);
            next.delete(command.agent);
            return next;
          });
          append(item(`▶ ${command.agent} resumed`, { color: 'yellow' }));
          break;
        case 'tasks': {
          const list = session.board.listTasks();
          append(item(list.length ? list.map(taskGlyph).join('\n') : 'Board is empty.', { dim: true }));
          break;
        }
        case 'diff':
          showDiff();
          break;
        case 'help':
          append(item(HELP_TEXT, { dim: true }));
          break;
        case 'quit':
          void session.stop().finally(() => exit());
          break;
        case 'error':
          append(item(`✗ ${command.message}`, { color: 'red' }));
          break;
      }
    },
    [session, append, exit, showDiff],
  );

  const openTasks = useMemo(() => tasks.filter((t) => t.status !== 'done'), [tasks]);

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(entry) => (
          <Text key={entry.id} color={entry.color} bold={entry.bold} dimColor={entry.dim}>
            {entry.text}
          </Text>
        )}
      </Static>

      <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1}>
        <Box gap={3}>
          {AGENT_NAMES.map((agent) => (
            <Text key={agent} color={AGENT_COLORS[agent]}>
              {agent} {statusGlyph(statuses[agent], pausedAgents.has(agent))}
            </Text>
          ))}
          <Text dimColor>
            board: {openTasks.length ? openTasks.map((t) => `${t.id}${t.owner ? `@${t.owner}` : ''}`).join(' ') : 'empty'}
          </Text>
        </Box>
        <Box>
          <Text color="green">{'> '}</Text>
          <TextInput value={input} onChange={setInput} onSubmit={submit} />
        </Box>
      </Box>
    </Box>
  );
}
