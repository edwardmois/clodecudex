#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const program = new Command();

program
  .command('sessions')
  .description('List past ccx sessions in this project (resume one with ccx --resume <n>)')
  .action(async () => {
    const { journalDir, listJournals } = await import('./core/journal.js');
    const sessions = listJournals(journalDir(process.cwd()));
    if (sessions.length === 0) {
      console.log('No past ccx sessions in this project (.ccx/sessions is empty).');
      return;
    }
    for (const [i, s] of sessions.entries()) {
      const when = new Date(s.updatedAt).toLocaleString();
      const goal = s.firstGoal ? ` — "${s.firstGoal}"` : '';
      console.log(
        `${String(i + 1).padStart(2)}. ${when} · ${s.messages} msg · ${s.openTasks} open task(s)${goal}`,
      );
    }
    console.log('\nResume the latest with `ccx --resume`, or a specific one with `ccx --resume <n>`.');
  });

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
  .option(
    '--resume [n]',
    'continue a previous ccx session (latest, or #n from `ccx sessions`)',
    false,
  )
  .option('--claude-model <model>', 'model for the Claude founder (e.g. sonnet, opus)')
  .option('--codex-model <model>', 'model for the Codex founder (e.g. gpt-5.2-codex)')
  .option('--config <path>', 'path to a ccx config file')
  .action(async (opts: {
    yolo: boolean;
    verbose: boolean;
    resume: boolean | string;
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

    const { JournalWriter, journalDir, listJournals, loadJournal, newJournalPath } = await import(
      './core/journal.js'
    );
    const dir = journalDir(process.cwd());
    let resume;
    let journalPath = newJournalPath(dir);
    if (opts.resume !== false) {
      const sessions = listJournals(dir);
      if (sessions.length === 0) {
        console.error('No previous ccx session found in this project (.ccx/sessions is empty).');
        process.exit(1);
      }
      let picked = sessions[0]; // bare --resume = latest
      if (typeof opts.resume === 'string') {
        const n = Number(opts.resume);
        if (!Number.isInteger(n) || n < 1 || n > sessions.length) {
          console.error(
            `No session #${opts.resume} — this project has ${sessions.length}. Run \`ccx sessions\` to list them.`,
          );
          process.exit(1);
        }
        picked = sessions[n - 1];
      }
      const loaded = picked ? loadJournal(picked.path) : undefined;
      if (!loaded) {
        console.error('That session journal could not be read.');
        process.exit(1);
      }
      resume = loaded.data;
      journalPath = loaded.path; // keep appending to the same session
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
      // ctrl+c is handled in the TUI: first press warns, second quits cleanly
      exitOnCtrlC: false,
    });
    await app.waitUntilExit();
    await session.stop();
  });

await program.parseAsync(process.argv);
