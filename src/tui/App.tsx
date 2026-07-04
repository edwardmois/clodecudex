import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { execFile } from 'node:child_process';
import type { Session, SessionEvent } from '../core/session.js';
import type { AgentStatus } from '../agents/adapter.js';
import { AGENT_NAMES, type AgentName, type Task } from '../core/types.js';
import { HELP_TEXT, parseInput } from './commands.js';
import { formatActivity, isNearDuplicate } from './format.js';
import { expandFileMentions } from './mentions.js';
import { FileIndex, applyCompletion, extractMentionQuery, rankCompletions } from './completion.js';
import { formatTokens, formatWindow, readCodexRateLimits } from '../core/usage.js';

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

function statusGlyph(status: AgentStatus, paused: boolean, limited: boolean): string {
  if (limited) return '⛔ limit';
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

export function App({
  session,
  verbose = false,
}: {
  session: Session;
  verbose?: boolean;
}): React.JSX.Element {
  const { exit } = useApp();
  const [items, setItems] = useState<DisplayItem[]>(() => {
    const initial = [
      item('ccx — two co-founders, one terminal. Type a goal, or /help.', {
        color: 'green',
        bold: true,
      }),
    ];
    if (session.resumed) {
      const transcript = session.bus.transcript;
      const openTasks = session.board.listTasks().filter((t) => t.status !== 'done');
      initial.push(
        item(
          `↻ resumed previous session — ${transcript.length} messages, ${openTasks.length} open task(s)`,
          { color: 'yellow' },
        ),
      );
      for (const m of transcript.slice(-8)) {
        initial.push(item(`[${m.from}${m.to ? ` → ${m.to}` : ''}] ${m.text}`, { dim: true }));
      }
    }
    return initial;
  });
  const [input, setInput] = useState('');
  const [statuses, setStatuses] = useState<Record<AgentName, AgentStatus>>({
    claude: 'starting',
    codex: 'starting',
  });
  const [pausedAgents, setPausedAgents] = useState<Set<AgentName>>(new Set());
  const [limitedAgents, setLimitedAgents] = useState<Set<AgentName>>(new Set());
  const [tasks, setTasks] = useState<Task[]>([]);
  // last thing each agent said (chat or narration), for duplicate suppression
  const lastSaid = React.useRef<Partial<Record<AgentName, string>>>({});
  // @-mention autocomplete: menu entries, highlighted row, Esc-dismissal marker
  const fileIndex = useMemo(() => new FileIndex(process.cwd()), []);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const dismissedFor = React.useRef<string | undefined>(undefined);
  const mention = useMemo(() => extractMentionQuery(input), [input]);

  useEffect(() => {
    if (dismissedFor.current !== input) dismissedFor.current = undefined;
    if (!mention || dismissedFor.current === input) {
      setSuggestions([]);
      setSelected(0);
      return;
    }
    // at the start of a line, @ can also address a founder
    const agents =
      mention.start === 0
        ? AGENT_NAMES.filter((a) => a.startsWith(mention.query.toLowerCase()))
        : [];
    const files = rankCompletions(mention.query, fileIndex.candidates(), 8 - agents.length);
    setSuggestions([...agents, ...files]);
    setSelected(0);
  }, [input, mention, fileIndex]);

  const append = useCallback((entry: DisplayItem) => {
    setItems((prev) => [...prev, entry]);
  }, []);

  useEffect(() => {
    return session.onEvent((event: SessionEvent) => {
      switch (event.type) {
        case 'chat': {
          const { from, to, text } = event.message;
          if (from === 'claude' || from === 'codex') lastSaid.current[from] = text;
          append(
            item(`[${from}${to ? ` → ${to}` : ''}] ${text}`, {
              color: AGENT_COLORS[from] ?? 'white',
              bold: from === 'user',
            }),
          );
          break;
        }
        case 'agent-message': {
          if (isNearDuplicate(event.text, lastSaid.current[event.agent])) break;
          lastSaid.current[event.agent] = event.text;
          append(item(`(${event.agent}) ${event.text}`, { color: AGENT_COLORS[event.agent], dim: true }));
          break;
        }
        case 'agent-activity': {
          const line = formatActivity(event.text, verbose);
          if (line !== undefined) append(item(`  ${event.agent}: ${line}`, { dim: true }));
          break;
        }
        case 'file-change':
          append(item(`  ${event.agent} ${event.kind} ${event.path}`, { dim: true }));
          break;
        case 'violation':
          append(item(`⚠ OWNERSHIP: ${event.agent} touched ${event.path}`, { color: 'red', bold: true }));
          break;
        case 'agent-error':
          if (isNearDuplicate(event.message, lastSaid.current[event.agent])) break;
          append(item(`✗ ${event.agent}: ${event.message}`, { color: 'red' }));
          break;
        case 'agent-limit':
          setLimitedAgents((prev) => new Set(prev).add(event.agent));
          setPausedAgents((prev) => new Set(prev).add(event.agent));
          append(
            item(
              `⛔ ${event.agent} is out of usage (${event.message}) — paused. /resume ${event.agent} once it resets; the other founder keeps working.`,
              { color: 'yellow', bold: true },
            ),
          );
          break;
        case 'agent-status':
          setStatuses((prev) => ({ ...prev, [event.agent]: event.status }));
          break;
        case 'task-update':
          setTasks(session.board.listTasks());
          // board changes are the plot: surface them inline, one line each
          append(item(`  ✦ ${taskGlyph(event.task)}`, { color: 'yellow' }));
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

  const stopAgents = useCallback(
    (only: AgentName | undefined, quiet: boolean) => {
      const hit = session.interruptBusy(only);
      if (hit.length > 0) {
        append(
          item(`⏹ interrupted ${hit.join(' and ')} — context kept, type to redirect`, {
            color: 'yellow',
            bold: true,
          }),
        );
      } else if (!quiet) {
        append(
          item(
            only
              ? `${only} is not working right now — nothing to stop`
              : 'nobody is working right now — nothing to stop',
            { dim: true },
          ),
        );
      }
    },
    [session, append],
  );

  // Tab/↑/↓/Esc drive the @-completion menu (ink-text-input ignores these
  // keys, so they fall through to us); Esc with no menu open interrupts
  // whoever is mid-turn, like in Claude Code.
  useInput((_input, key) => {
    if (suggestions.length > 0 && mention) {
      if (key.tab) {
        const pick = suggestions[selected];
        if (pick !== undefined) setInput(applyCompletion(input, mention, pick));
        return;
      }
      if (key.downArrow) {
        setSelected((s) => (s + 1) % suggestions.length);
        return;
      }
      if (key.upArrow) {
        setSelected((s) => (s - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (key.escape) {
        dismissedFor.current = input;
        setSuggestions([]);
        return;
      }
    }
    if (key.escape) stopAgents(undefined, true);
  });

  const submit = useCallback(
    (raw: string) => {
      // Enter with the completion menu open accepts the highlighted entry
      if (suggestions.length > 0 && mention) {
        const pick = suggestions[selected];
        if (pick !== undefined) {
          setInput(applyCompletion(raw, mention, pick));
          return;
        }
      }
      setInput('');
      const command = parseInput(raw);
      switch (command.type) {
        case 'message': {
          const expanded = expandFileMentions(command.text, process.cwd());
          if (expanded.missing.length > 0) {
            append(
              item(`✗ file not found: ${expanded.missing.join(', ')} — message not sent`, {
                color: 'red',
              }),
            );
            break;
          }
          session.postUserMessage(expanded.text, command.to);
          break;
        }
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
          setLimitedAgents((prev) => {
            const next = new Set(prev);
            next.delete(command.agent);
            return next;
          });
          append(item(`▶ ${command.agent} resumed`, { color: 'yellow' }));
          break;
        case 'stop':
          stopAgents(command.agent, false);
          break;
        case 'tasks': {
          const list = session.board.listTasks();
          append(item(list.length ? list.map(taskGlyph).join('\n') : 'Board is empty.', { dim: true }));
          break;
        }
        case 'usage': {
          const lines: string[] = ['token usage this session:'];
          for (const agent of AGENT_NAMES) {
            const u = session.usageOf(agent);
            lines.push(
              `  ${agent.padEnd(6)} in ${formatTokens(u.input)} · cached ${formatTokens(u.cached)} · out ${formatTokens(u.output)} · ${u.turns} turn(s)`,
            );
          }
          const limits = readCodexRateLimits();
          if (limits) {
            const windows = [
              formatWindow('5h', limits.primary),
              formatWindow('weekly', limits.secondary),
            ].filter((w): w is string => w !== undefined);
            const plan = limits.plan_type ? ` (${limits.plan_type})` : '';
            if (windows.length) lines.push(`codex subscription${plan}: ${windows.join(' · ')}`);
          }
          lines.push(
            'claude subscription: not exposed by Claude Code yet (anthropics/claude-code#44328)',
          );
          append(item(lines.join('\n'), { dim: true }));
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
    [session, append, exit, showDiff, stopAgents, suggestions, mention, selected],
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
              {agent} {statusGlyph(statuses[agent], pausedAgents.has(agent), limitedAgents.has(agent))}
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

      {suggestions.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {suggestions.map((entry, i) => (
            <Text key={entry} color={i === selected ? 'green' : undefined} dimColor={i !== selected}>
              {i === selected ? '▸ ' : '  '}
              {entry}
            </Text>
          ))}
          <Text dimColor>enter/tab complete · ↑↓ move · esc dismiss</Text>
        </Box>
      )}
    </Box>
  );
}
