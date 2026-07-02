#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const program = new Command();

program
  .name('ccx')
  .description(
    'Claude Code + Codex CLI as two AI co-founders working simultaneously on your codebase',
  )
  .version(version)
  .option('--yolo', 'skip permission prompts for both agents (dangerous)', false)
  .option('--config <path>', 'path to a ccx config file')
  .action(async (opts: { yolo: boolean; config?: string }) => {
    // TUI entry is wired in a later phase; for now prove the toolchain works.
    console.log(`ccx v${version} — two co-founders, one terminal`);
    console.log('Session startup not implemented yet.');
    if (opts.yolo) console.log('(yolo mode requested)');
  });

await program.parseAsync(process.argv);
