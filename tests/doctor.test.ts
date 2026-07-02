import { describe, expect, it } from 'vitest';
import {
  formatDoctorReport,
  parseClaudeAuth,
  parseCodexAuth,
  runDoctor,
  type ExecRunner,
} from '../src/doctor.js';

describe('auth parsers', () => {
  it('reads claude auth status JSON (real output shape)', () => {
    const real = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      subscriptionType: 'pro',
    });
    expect(parseClaudeAuth(real)).toEqual({ ok: true, detail: 'logged in (pro)' });
    expect(parseClaudeAuth(JSON.stringify({ loggedIn: false })).ok).toBe(false);
    expect(parseClaudeAuth('garbage').ok).toBe(false);
  });

  it('reads codex login status text (real output shape)', () => {
    expect(parseCodexAuth('Logged in using ChatGPT', false)).toEqual({
      ok: true,
      detail: 'Logged in using ChatGPT',
    });
    expect(parseCodexAuth('Not logged in', false).ok).toBe(false);
    expect(parseCodexAuth('', true).ok).toBe(false);
  });
});

describe('runDoctor', () => {
  const healthy: ExecRunner = async (file, args) => {
    const key = `${file} ${args.join(' ')}`;
    const outputs: Record<string, string> = {
      'claude --version': '2.1.198 (Claude Code)',
      'claude auth status': JSON.stringify({ loggedIn: true, subscriptionType: 'max' }),
      'codex --version': 'codex-cli 0.142.5',
      'codex login status': 'Logged in using ChatGPT',
    };
    if (key.startsWith('git ')) return { stdout: 'true', failed: false };
    return { stdout: outputs[key] ?? '', failed: !(key in outputs) };
  };

  it('reports all green on a healthy machine', async () => {
    const results = await runDoctor('/repo', healthy);
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(formatDoctorReport(results)).toContain('✓ Claude Code logged in — logged in (max)');
  });

  it('flags missing CLIs and missing git repo', async () => {
    const broken: ExecRunner = async () => ({ stdout: '', failed: true });
    const results = await runDoctor('/repo', broken);
    expect(results.every((r) => !r.ok)).toBe(true);
    const report = formatDoctorReport(results);
    expect(report).toContain('✗ Claude Code installed — claude not found on PATH');
    expect(report).toContain('git init');
  });
});
