import { execFile } from 'node:child_process';

export interface ProbeResult {
  name: string;
  ok: boolean;
  detail: string;
}

export type ExecRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; failed: boolean }>;

/**
 * execFile with an argument array — no shell, no injection surface. The one
 * exception: npm-installed CLIs on Windows are `.cmd` shims that require a
 * shell to run; those invocations use fixed literal arguments only.
 */
const defaultRunner: ExecRunner = (file, args) => {
  const isWin = process.platform === 'win32';
  const resolved = isWin && file === 'codex' ? 'codex.cmd' : file;
  const options = { timeout: 30_000, windowsHide: true } as const;
  return new Promise((resolve) => {
    const done = (error: Error | null, stdout: string, stderr: string): void => {
      // Some CLIs (codex) report status on stderr; probes read both.
      resolve({ stdout: `${stdout}${stderr}`, failed: error !== null });
    };
    if (resolved.endsWith('.cmd')) {
      // .cmd shims need a shell; args here are fixed literals, never user input.
      execFile([resolved, ...args].join(' '), { ...options, shell: true }, done);
    } else {
      execFile(resolved, args, options, done);
    }
  });
};

export function parseClaudeAuth(stdout: string): { ok: boolean; detail: string } {
  try {
    const status = JSON.parse(stdout) as { loggedIn?: boolean; subscriptionType?: string };
    if (status.loggedIn) {
      return { ok: true, detail: `logged in (${status.subscriptionType ?? 'unknown plan'})` };
    }
    return { ok: false, detail: 'not logged in — run: claude auth login' };
  } catch {
    return { ok: false, detail: 'could not read auth status' };
  }
}

export function parseCodexAuth(stdout: string, failed: boolean): { ok: boolean; detail: string } {
  if (!failed && /logged in/i.test(stdout) && !/not logged in/i.test(stdout)) {
    return { ok: true, detail: stdout.trim() };
  }
  return { ok: false, detail: 'not logged in — run: codex login' };
}

/**
 * Capability probes run before a session starts: both CLIs installed and
 * logged in, and a git repo to work in. Fast checks only — nothing here
 * consumes model tokens.
 */
export async function runDoctor(
  cwd: string,
  run: ExecRunner = defaultRunner,
): Promise<ProbeResult[]> {
  const [claudeVersion, claudeAuth, codexVersion, codexAuth, gitRepo] = await Promise.all([
    run('claude', ['--version']),
    run('claude', ['auth', 'status']),
    run('codex', ['--version']),
    run('codex', ['login', 'status']),
    run('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']),
  ]);

  const claudeAuthParsed = parseClaudeAuth(claudeAuth.stdout);
  const codexAuthParsed = parseCodexAuth(codexAuth.stdout, codexAuth.failed);

  return [
    {
      name: 'Claude Code installed',
      ok: !claudeVersion.failed,
      detail: claudeVersion.failed ? 'claude not found on PATH' : claudeVersion.stdout.trim(),
    },
    { name: 'Claude Code logged in', ok: claudeAuthParsed.ok, detail: claudeAuthParsed.detail },
    {
      name: 'Codex CLI installed',
      ok: !codexVersion.failed,
      detail: codexVersion.failed ? 'codex not found on PATH' : codexVersion.stdout.trim(),
    },
    { name: 'Codex CLI logged in', ok: codexAuthParsed.ok, detail: codexAuthParsed.detail },
    {
      name: 'Git repository',
      ok: !gitRepo.failed,
      detail: gitRepo.failed
        ? 'not a git repository — run: git init (strongly recommended before letting agents edit)'
        : cwd,
    },
  ];
}

export function formatDoctorReport(results: ProbeResult[]): string {
  return results.map((r) => `${r.ok ? '✓' : '✗'} ${r.name} — ${r.detail}`).join('\n');
}
