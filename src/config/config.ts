import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const AgentConfigSchema = z.object({
  /** Model override passed to the CLI; omit to use the CLI's default. */
  model: z.string().optional(),
  /** Extra persona text appended to the agent's bootstrap prompt. */
  persona: z.string().default(''),
});

const CcxConfigSchema = z.object({
  claude: AgentConfigSchema.extend({
    permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions']).default('acceptEdits'),
  }).prefault({}),
  codex: AgentConfigSchema.extend({
    sandbox: z
      .enum(['read-only', 'workspace-write', 'danger-full-access'])
      .default('workspace-write'),
    /**
     * Codex's own default is "high", which makes even trivial turns slow.
     * "medium" is the responsiveness sweet spot for co-founder work; raise
     * it per-project when depth matters more than latency.
     */
    reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).default('medium'),
  }).prefault({}),
});

export type CcxConfig = z.infer<typeof CcxConfigSchema>;

function readJsonIfExists(filePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  // A present-but-broken config should stop the session loudly, not be skipped.
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Invalid config at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function mergeSection(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null
    ) {
      result[key] = mergeSection(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Config precedence: defaults < ~/.ccx/config.json < <project>/ccx.config.json
 * < explicit --config file. Validation is strict: unknown shapes fail loudly.
 */
export function loadConfig(projectDir: string, explicitPath?: string): CcxConfig {
  const layers = [
    readJsonIfExists(path.join(homedir(), '.ccx', 'config.json')),
    readJsonIfExists(path.join(projectDir, 'ccx.config.json')),
    explicitPath ? readJsonIfExists(path.resolve(explicitPath)) : {},
  ];
  const merged = layers.reduce(mergeSection, {});
  const result = CcxConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new Error(`Invalid ccx config: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return result.data;
}
