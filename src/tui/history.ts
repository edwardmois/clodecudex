import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 200;

export function historyPath(cwd: string): string {
  return path.join(cwd, '.ccx', 'history.json');
}

/** Past inputs for this project, oldest first. Missing/corrupt → empty. */
export function loadHistory(cwd: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(historyPath(cwd), 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === 'string').slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function saveHistory(cwd: string, entries: string[]): void {
  try {
    const file = historyPath(cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(entries.slice(-MAX_ENTRIES), null, 1));
  } catch {
    // history must never take the session down
  }
}

/**
 * Shell-style ↑/↓ recall over past inputs. Navigating up from a fresh line
 * stashes it as a draft; coming all the way back down restores the draft.
 */
export class InputHistory {
  private readonly entries: string[];
  /** Position in `entries`; `entries.length` = the live draft line. */
  private index: number;
  private draft = '';

  constructor(entries: string[] = []) {
    this.entries = entries.slice(-MAX_ENTRIES);
    this.index = this.entries.length;
  }

  /** Record a submitted input; consecutive duplicates collapse. */
  push(entry: string): void {
    const trimmed = entry.trim();
    if (trimmed && this.entries.at(-1) !== trimmed) {
      this.entries.push(trimmed);
      if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    }
    this.index = this.entries.length;
    this.draft = '';
  }

  /** Step back in time; undefined when already at the oldest entry. */
  up(current: string): string | undefined {
    if (this.index === 0) return undefined;
    if (this.index === this.entries.length) this.draft = current;
    this.index -= 1;
    return this.entries[this.index];
  }

  /** Step forward; returns the stashed draft at the end, undefined past it. */
  down(): string | undefined {
    if (this.index >= this.entries.length) return undefined;
    this.index += 1;
    return this.index === this.entries.length ? this.draft : this.entries[this.index];
  }

  all(): string[] {
    return [...this.entries];
  }
}
