import { AGENT_NAMES, type AgentName } from '../core/types.js';

export type Command =
  | { type: 'message'; text: string; to?: AgentName }
  | { type: 'pause'; agent: AgentName }
  | { type: 'resume'; agent: AgentName }
  | { type: 'tasks' }
  | { type: 'usage' }
  | { type: 'diff' }
  | { type: 'help' }
  | { type: 'quit' }
  | { type: 'error'; message: string };

export const HELP_TEXT = `Commands:
  @claude <msg> / @codex <msg>   message one founder directly
  @path/to/file                  reference a file in a message (validated, both founders told to read it)
  /pause claude|codex            stop delivering work to a founder
  /resume claude|codex           resume a paused founder
  /tasks                         show the task board
  /usage                         token usage + subscription windows
  /diff                          show the current git diff (local only)
  /help                          this help
  /quit                          end the session
Anything else is posted to the founders' chat.
Start with \`ccx --resume\` to continue the previous session in this project.`;

function parseAgent(raw: string | undefined): AgentName | undefined {
  return AGENT_NAMES.find((a) => a === raw?.toLowerCase());
}

/** Parse one line of user input into a command. Pure — trivially testable. */
export function parseInput(raw: string): Command {
  const input = raw.trim();
  if (!input) return { type: 'error', message: 'empty input' };

  if (input.startsWith('@')) {
    const [head, ...rest] = input.split(/\s+/);
    const agent = parseAgent(head?.slice(1));
    const text = rest.join(' ');
    if (!agent) return { type: 'error', message: `unknown founder "${head}"` };
    if (!text) return { type: 'error', message: `say something after ${head}` };
    return { type: 'message', text, to: agent };
  }

  if (!input.startsWith('/')) return { type: 'message', text: input };

  const [command, arg] = input.slice(1).split(/\s+/);
  switch (command?.toLowerCase()) {
    case 'pause':
    case 'resume': {
      const agent = parseAgent(arg);
      if (!agent) return { type: 'error', message: `usage: /${command} claude|codex` };
      return { type: command.toLowerCase() as 'pause' | 'resume', agent };
    }
    case 'tasks':
      return { type: 'tasks' };
    case 'usage':
      return { type: 'usage' };
    case 'diff':
      return { type: 'diff' };
    case 'help':
      return { type: 'help' };
    case 'quit':
    case 'exit':
      return { type: 'quit' };
    default:
      return { type: 'error', message: `unknown command /${command} — try /help` };
  }
}
