import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';
import { buildBootstrap } from '../src/config/personas.js';

function tempProject(config?: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccx-config-'));
  if (config !== undefined) {
    writeFileSync(path.join(dir, 'ccx.config.json'), JSON.stringify(config));
  }
  return dir;
}

describe('loadConfig', () => {
  it('returns safe defaults with no config files', () => {
    const config = loadConfig(tempProject());
    expect(config.claude.permissionMode).toBe('acceptEdits');
    expect(config.codex.sandbox).toBe('workspace-write');
    expect(config.claude.persona).toBe('');
  });

  it('project config overrides defaults', () => {
    const dir = tempProject({
      claude: { model: 'opus', persona: 'You lean architecture.' },
      codex: { sandbox: 'read-only' },
    });
    const config = loadConfig(dir);
    expect(config.claude.model).toBe('opus');
    expect(config.claude.persona).toBe('You lean architecture.');
    expect(config.codex.sandbox).toBe('read-only');
    // untouched defaults survive
    expect(config.claude.permissionMode).toBe('acceptEdits');
  });

  it('explicit --config file wins over project config', () => {
    const dir = tempProject({ claude: { model: 'sonnet' } });
    const explicit = path.join(tempProject(), 'custom.json');
    writeFileSync(explicit, JSON.stringify({ claude: { model: 'fable' } }));
    expect(loadConfig(dir, explicit).claude.model).toBe('fable');
  });

  it('rejects invalid values loudly', () => {
    const dir = tempProject({ codex: { sandbox: 'yolo' } });
    expect(() => loadConfig(dir)).toThrow(/codex.sandbox/);
  });

  it('rejects unparseable config files instead of silently skipping them', () => {
    const dir = tempProject();
    writeFileSync(path.join(dir, 'ccx.config.json'), '{broken');
    expect(() => loadConfig(dir)).toThrow(/Invalid config/);
  });
});

describe('buildBootstrap', () => {
  it('names the agent, its co-founder, and every hub tool', () => {
    const prompt = buildBootstrap('claude', '');
    expect(prompt).toContain('You are "claude"');
    expect(prompt).toContain('"codex"');
    for (const tool of [
      'post_message',
      'create_task',
      'claim_task',
      'release_task',
      'complete_task',
      'request_review',
    ]) {
      expect(prompt).toContain(tool);
    }
  });

  it('encodes the token discipline and review rules', () => {
    const prompt = buildBootstrap('codex', '');
    expect(prompt).toContain('Silence is a valid reply');
    expect(prompt).toContain('Never approve your own work');
    expect(prompt).toContain('FOUNDERS_NOTES.md');
  });

  it('appends persona and goal when provided', () => {
    const prompt = buildBootstrap('claude', 'You lean testing.', 'Build a login flow');
    expect(prompt).toContain('## Your persona\nYou lean testing.');
    expect(prompt).toContain('## Current goal from the user\nBuild a login flow');
  });
});
