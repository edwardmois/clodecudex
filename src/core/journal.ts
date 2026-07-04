import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatMessage, Task } from './types.js';

/**
 * Everything ccx needs to resume a session — deliberately tiny. The heavy
 * state (each agent's full conversation) already lives in the CLIs' own
 * local histories; we only keep the ids to reattach to them, plus the
 * shared state the CLIs don't know about: the founders' chat and the board.
 */
export interface SessionJournalData {
  version: 1;
  startedAt: number;
  updatedAt: number;
  claudeSessionId?: string;
  codexThreadId?: string;
  transcript: ChatMessage[];
  tasks: Task[];
}

export function journalDir(cwd: string): string {
  return path.join(cwd, '.ccx', 'sessions');
}

export function newJournalPath(dir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${stamp}.json`);
}

/** Load one journal file; undefined when missing/corrupt/foreign. */
export function loadJournal(
  filePath: string,
): { path: string; data: SessionJournalData } | undefined {
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8')) as SessionJournalData;
    if (data.version !== 1) return undefined;
    return { path: filePath, data };
  } catch {
    return undefined;
  }
}

/** Load the most recent journal in `dir`, or undefined when none exist. */
export function loadLatestJournal(
  dir: string,
): { path: string; data: SessionJournalData } | undefined {
  const newest = listJournals(dir)[0];
  return newest ? loadJournal(newest.path) : undefined;
}

/** One line per past session, for `ccx sessions` / the --resume picker. */
export interface JournalSummary {
  path: string;
  startedAt: number;
  updatedAt: number;
  messages: number;
  openTasks: number;
  /** First thing the user asked for — the session's human-readable handle. */
  firstGoal?: string;
}

/** All sessions in `dir`, newest first. Corrupt files are skipped. */
export function listJournals(dir: string): JournalSummary[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const summaries: JournalSummary[] = [];
  for (const file of files) {
    const loaded = loadJournal(path.join(dir, file));
    if (!loaded) continue;
    const { data } = loaded;
    const firstGoal = data.transcript.find((m) => m.from === 'user')?.text.slice(0, 60);
    summaries.push({
      path: loaded.path,
      startedAt: data.startedAt,
      updatedAt: data.updatedAt,
      messages: data.transcript.length,
      openTasks: data.tasks.filter((t) => t.status !== 'done').length,
      ...(firstGoal ? { firstGoal } : {}),
    });
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Debounced single-file journal. Chat and board events arrive in bursts;
 * one atomic-enough JSON write a few hundred ms later is plenty — losing
 * the last instant of chat on a hard crash is acceptable, the agents' own
 * histories (the expensive part) are persisted by the CLIs themselves.
 */
export class JournalWriter {
  private timer: NodeJS.Timeout | undefined;
  private pending: SessionJournalData | undefined;

  constructor(
    readonly filePath: string,
    private readonly debounceMs = 400,
  ) {}

  schedule(data: SessionJournalData): void {
    this.pending = data;
    this.timer ??= setTimeout(() => this.flush(), this.debounceMs);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const data = this.pending;
    this.pending = undefined;
    if (!data) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(data, null, 1));
    } catch {
      // journaling must never take the session down
    }
  }
}
