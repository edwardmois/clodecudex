/**
 * Quiet-mode filter for the activity stream. The default TUI shows the
 * founders' conversation and real work (files, tasks, shell commands) and
 * hides plumbing; `--verbose` bypasses all of this.
 */

/** Codex on Windows prefixes every command with the full powershell.exe path. */
const PS_PREFIX = /^"?[A-Za-z]:[\\/]+WINDOWS[\\/].*?powershell(?:\.exe)?"?\s+-Command\s+/i;

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Reduce one agent-activity line for display. Returns undefined when the
 * line is plumbing that quiet mode drops entirely:
 * - `⚒ Tool` glyphs (internal tool calls — results surface as chat/files)
 * - successful `hub → tool` calls (the resulting chat/task update is shown)
 * Warnings (⚠ …) always survive, clamped.
 */
/**
 * The same content often arrives twice: an agent's chat post followed by its
 * turn-ending narration, or an error surfaced both as a message and as the
 * turn result. Treat one containing the other (after normalization) as a
 * duplicate not worth printing again.
 */
export function isNearDuplicate(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length < 12 || nb.length < 12) return na === nb;
  return na.includes(nb) || nb.includes(na);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function formatActivity(text: string, verbose: boolean): string | undefined {
  if (verbose) return text;
  if (text.startsWith('⚒')) return undefined;
  if (text.startsWith('hub → ')) return undefined;
  if (text.startsWith('$ ')) {
    let cmd = text.slice(2).trim().replace(PS_PREFIX, '');
    const quote = cmd[0];
    if ((quote === '"' || quote === "'") && cmd.endsWith(quote) && cmd.length > 1) {
      cmd = cmd.slice(1, -1);
    }
    return clamp(`$ ${cmd.replace(/\s+/g, ' ').trim()}`, 100);
  }
  return clamp(text, 160);
}
