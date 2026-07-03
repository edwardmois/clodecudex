import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Cumulative token counts for one founder in this ccx session. */
export interface TokenTotals {
  input: number;
  cached: number;
  output: number;
  turns: number;
}

export function emptyTotals(): TokenTotals {
  return { input: 0, cached: 0, output: 0, turns: 0 };
}

export interface RateWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

/** Subscription rate-limit snapshot as codex records it in its session files. */
export interface CodexRateLimits {
  plan_type?: string;
  /** The 5-hour window. */
  primary?: RateWindow;
  /** The weekly window. */
  secondary?: RateWindow;
}

/**
 * Best-effort read of the Codex subscription windows (5h + weekly used %).
 *
 * Codex writes a `rate_limits` snapshot into its local session rollout files
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) as it works — including
 * the turns ccx itself runs. We read the most recent snapshot; no network,
 * no credentials. Claude Code exposes no equivalent yet
 * (anthropics/claude-code#44328), so this is codex-only.
 */
export function readCodexRateLimits(
  codexHome: string = path.join(homedir(), '.codex'),
): CodexRateLimits | undefined {
  const file = newestRolloutFile(path.join(codexHome, 'sessions'));
  if (!file) return undefined;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"rate_limits"')) continue;
    try {
      const found = deepFind(JSON.parse(line) as unknown, 'rate_limits');
      if (found && typeof found === 'object') return found as CodexRateLimits;
    } catch {
      // malformed line — keep scanning
    }
  }
  return undefined;
}

/** Newest .jsonl under sessions/YYYY/MM/DD, walking only the latest branches. */
function newestRolloutFile(sessionsDir: string): string | undefined {
  let dir = sessionsDir;
  try {
    // three date levels: year, month, day — descend into the newest each time
    for (let depth = 0; depth < 3; depth++) {
      const subdirs = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      const newest = subdirs.at(-1);
      if (!newest) return undefined;
      dir = path.join(dir, newest);
    }
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    if (files.length === 0) return undefined;
    let best: { file: string; mtime: number } | undefined;
    for (const f of files) {
      const full = path.join(dir, f);
      const mtime = statSync(full).mtimeMs;
      if (!best || mtime > best.mtime) best = { file: full, mtime };
    }
    return best?.file;
  } catch {
    return undefined;
  }
}

function deepFind(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (key in record && record[key] !== null) return record[key];
  for (const child of Object.values(record)) {
    const found = deepFind(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatWindow(label: string, w: RateWindow | undefined): string | undefined {
  if (!w || w.used_percent === undefined) return undefined;
  let out = `${label} ${Math.round(w.used_percent)}% used`;
  if (w.resets_at) {
    const resets = new Date(w.resets_at * 1000);
    const day = resets.toLocaleDateString(undefined, { weekday: 'short' });
    const time = resets.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    out += ` (resets ${day} ${time})`;
  }
  return out;
}
