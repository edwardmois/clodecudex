#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const program = new Command();

program
  .command('doctor')
  .description('Check that Claude Code and Codex CLI are installed, logged in, and ready')
  .action(async () => {
    const { runDoctor, formatDoctorReport } = await import('./doctor.js');
    const results = await runDoctor(process.cwd());
    console.log(formatDoctorReport(results));
    process.exitCode = results.every((r) => r.ok) ? 0 : 1;
  });

program
  .name('ccx')
  .description(
    'Claude Code + Codex CLI as two AI co-founders working simultaneously on your codebase',
  )
  .version(version)
  .option('--yolo', 'skip permission prompts for both agents (dangerous)', false)
  .option('--verbose', 'show raw tool activity (hub calls, tool glyphs, full commands)', false)
  .option('--resume', 'continue the most recent ccx session in this project', false)
  .option('--claude-model <model>', 'model for the Claude founder (e.g. sonnet, opus)')
  .option('--codex-model <model>', 'model for the Codex founder (e.g. gpt-5.2-codex)')
  .option('--config <path>', 'path to a ccx config file')
  .action(async (opts: {
    yolo: boolean;
    verbose: boolean;
    resume: boolean;
    claudeModel?: string;
    codexModel?: string;
    config?: string;
  }) => {
    const { runDoctor, formatDoctorReport } = await import('./doctor.js');
    const results = await runDoctor(process.cwd());
    if (!results.every((r) => r.ok)) {
      console.error(formatDoctorReport(results));
      console.error('\nFix the failing checks above, then run ccx again.');
      process.exit(1);
    }

    const { loadConfig } = await import('./config/config.js');
    const config = loadConfig(process.cwd(), opts.config);
    if (opts.yolo) {
      config.claude.permissionMode = 'bypassPermissions';
      config.codex.sandbox = 'danger-full-access';
    }
    if (opts.claudeModel) config.claude.model = opts.claudeModel;
    if (opts.codexModel) config.codex.model = opts.codexModel;

    const { JournalWriter, journalDir, loadLatestJournal, newJournalPath } = await import(
      './core/journal.js'
    );
    const dir = journalDir(process.cwd());
    let resume;
    let journalPath = newJournalPath(dir);
    if (opts.resume) {
      const latest = loadLatestJournal(dir);
      if (!latest) {
        console.error('No previous ccx session found in this project (.ccx/sessions is empty).');
        process.exit(1);
      }
      resume = latest.data;
      journalPath = latest.path; // keep appending to the same session
    }

    const { Session } = await import('./core/session.js');
    const session = new Session({
      cwd: process.cwd(),
      config,
      journal: new JournalWriter(journalPath),
      ...(resume ? { resume } : {}),
    });
    await session.start();

    const [{ default: React }, { render }, { App }] = await Promise.all([
      import('react'),
      import('ink'),
      import('./tui/App.js'),
    ]);
    const app = render(React.createElement(App, { session, verbose: opts.verbose }), {
      exitOnCtrlC: true,
    });
    await app.waitUntilExit();
    await session.stop();
  });

await program.parseAsync(process.argv);
