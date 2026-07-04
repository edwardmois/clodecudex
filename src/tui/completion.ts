import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

/** An `@token` currently being typed at the end of the input line. */
export interface MentionQuery {
  /** Index of the `@` in the input string. */
  start: number;
  /** What follows the `@` (may be empty right after typing `@`). */
  query: string;
}

const MAX_INDEX = 5000;
const INDEX_TTL_MS = 5000;
const MAX_SUGGESTIONS = 8;

/** Directories never worth suggesting; the git path avoids these via
 * .gitignore — this set only matters for the non-git fallback walk. */
const IGNORED_DIRS = new Set([
  '.git',
  '.ccx',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
]);

/**
 * Find the `@token` being typed at the end of the input, if any.
 * Only the trailing token is completable — earlier mentions are done.
 */
export function extractMentionQuery(input: string): MentionQuery | undefined {
  const at = input.lastIndexOf('@');
  if (at === -1) return undefined;
  // mid-word `@` is an email or handle, not a mention
  if (at > 0 && !/\s/.test(input[at - 1] ?? '')) return undefined;
  const token = input.slice(at + 1);
  // a space or quote means the token is finished (or hand-quoted) — nothing to complete
  if (/[\s"]/.test(token)) return undefined;
  return { start: at, query: token };
}

/**
 * Rank index entries against the query: full-path prefix beats basename
 * prefix beats basename substring beats path substring; shorter paths win
 * ties so shallow files surface first. Empty query lists shallow paths.
 */
export function rankCompletions(
  query: string,
  candidates: string[],
  limit = MAX_SUGGESTIONS,
): string[] {
  const q = query.toLowerCase();
  const scored: { entry: string; score: number }[] = [];
  for (const entry of candidates) {
    const lower = entry.toLowerCase();
    const base = path.posix.basename(entry.endsWith('/') ? entry.slice(0, -1) : entry).toLowerCase();
    let score: number;
    if (!q) score = 3;
    else if (lower.startsWith(q)) score = 0;
    else if (base.startsWith(q)) score = 1;
    else if (base.includes(q)) score = 2;
    else if (lower.includes(q)) score = 3;
    else continue;
    scored.push({ entry, score });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score || a.entry.length - b.entry.length || a.entry.localeCompare(b.entry),
  );
  return scored.slice(0, limit).map((s) => s.entry);
}

/**
 * Replace the trailing `@token` with the chosen completion. Directories
 * (trailing `/`) stay "open" so typing continues into them; files get a
 * trailing space to end the mention. Paths with spaces are quoted the way
 * the mention parser expects.
 */
export function applyCompletion(
  input: string,
  mention: MentionQuery,
  completion: string,
): string {
  const inserted = /\s/.test(completion) ? `"${completion}"` : completion;
  const trailer = completion.endsWith('/') ? '' : ' ';
  return `${input.slice(0, mention.start)}@${inserted}${trailer}`;
}

/**
 * Project file/directory index for `@` autocomplete. Prefers
 * `git ls-files` (tracked + untracked, .gitignore respected); falls back
 * to a bounded directory walk outside git repos. Rebuilt lazily and
 * cached briefly so per-keystroke ranking never touches the disk.
 */
export class FileIndex {
  private entries: string[] = [];
  private builtAt = 0;

  constructor(private readonly cwd: string) {}

  candidates(): string[] {
    if (Date.now() - this.builtAt > INDEX_TTL_MS) {
      this.builtAt = Date.now();
      const files = this.gitFiles() ?? this.walkFiles();
      this.entries = [...deriveDirs(files), ...files].slice(0, MAX_INDEX);
    }
    return this.entries;
  }

  private gitFiles(): string[] | undefined {
    // -z: NUL-separated, no quoting — spaces and unicode arrive verbatim
    const result = spawnSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: this.cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 3000 },
    );
    if (result.error || result.status !== 0) return undefined;
    return result.stdout.split('\0').filter(Boolean).slice(0, MAX_INDEX);
  }

  private walkFiles(): string[] {
    const out: string[] = [];
    const walk = (rel: string): void => {
      if (out.length >= MAX_INDEX) return;
      let dirents;
      try {
        dirents = readdirSync(path.join(this.cwd, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of dirents) {
        if (out.length >= MAX_INDEX) return;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) walk(childRel);
        } else if (entry.isFile()) {
          out.push(childRel);
        }
      }
    };
    walk('');
    return out;
  }
}

/** Every ancestor directory of the given files, as `dir/` entries. */
function deriveDirs(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    let dir = path.posix.dirname(file);
    while (dir !== '.' && dir !== '/' && !dirs.has(dir)) {
      dirs.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  return [...dirs].sort().map((d) => `${d}/`);
}
