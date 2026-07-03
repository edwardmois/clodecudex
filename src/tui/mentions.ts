import { statSync } from 'node:fs';
import path from 'node:path';

/** `@claude` / `@codex` (and `@user`) address founders, never files. */
const FOUNDER_MENTIONS = new Set(['claude', 'codex', 'user']);

export interface MentionResult {
  /** Message text with mentions normalized and a referenced-files footer. */
  text: string;
  /** Project-relative posix paths that resolved to real files/dirs. */
  files: string[];
  /** Path-like mentions that don't exist (or escape the project) — typos. */
  missing: string[];
}

/**
 * Expand `@path/to/file` mentions in a user message, Claude Code-style.
 *
 * Design choice: we do NOT inline file contents. Both founders are full
 * agents with their own file tools; a validated path plus an explicit
 * "read these" footer gets them the same information without pushing the
 * same bytes through both context windows (and the chat length clamp).
 *
 * Only path-looking mentions (containing `/`, `\` or `.`) are treated as
 * files — `@someone` in prose passes through untouched.
 */
export function expandFileMentions(text: string, cwd: string): MentionResult {
  const files: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  const out = text.replace(
    /@(?:"([^"]+)"|([^\s"@]+))/g,
    (match, quoted: string | undefined, bare: string | undefined) => {
      const raw = quoted ?? bare ?? '';
      const candidate = raw.replace(/[),.;:!?]+$/, ''); // trailing punctuation isn't path
      const trailing = raw.slice(candidate.length);
      if (!candidate || FOUNDER_MENTIONS.has(candidate.toLowerCase())) return match;
      if (!/[\\/.]/.test(candidate)) return match; // not path-like, leave alone

      const resolved = path.resolve(cwd, candidate);
      const relative = path.relative(cwd, resolved);
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        missing.push(candidate);
        return match;
      }
      try {
        statSync(resolved);
      } catch {
        missing.push(candidate);
        return match;
      }
      const posix = relative.replace(/\\/g, '/');
      if (!seen.has(posix)) {
        seen.add(posix);
        files.push(posix);
      }
      return posix + trailing;
    },
  );

  if (files.length === 0) return { text: out, files, missing };
  const footer = `\n── Files referenced (read them for details) ──\n${files
    .map((f) => `- ${f}`)
    .join('\n')}`;
  return { text: out + footer, files, missing };
}
