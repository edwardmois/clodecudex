import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { MessageBus } from '../core/bus.js';
import type { TaskBoard } from '../core/taskboard.js';
import { AGENT_NAMES, otherAgent, type AgentName, type ChatMessage, type Task } from '../core/types.js';

export interface FoundersHubOptions {
  bus: MessageBus;
  board: TaskBoard;
}

interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function formatMessage(m: ChatMessage): string {
  const target = m.to ? ` → ${m.to}` : '';
  return `[${m.from}${target}] ${m.text}`;
}

function formatTask(t: Task): string {
  const owner = t.owner ? ` @${t.owner}` : '';
  const files = t.files.length ? ` (${t.files.join(', ')})` : '';
  return `${t.id} [${t.status}]${owner} ${t.title}${files}`;
}

/**
 * The meeting room: a local MCP server both agents connect to. Each agent
 * gets its own URL (identity is baked into the path), and every tool
 * response piggybacks that agent's unread chat digest — so founders catch
 * up on the conversation as a side effect of doing work, with no dedicated
 * delivery turns.
 */
export class FoundersHub {
  private readonly bus: MessageBus;
  private readonly board: TaskBoard;
  private readonly token = randomBytes(16).toString('hex');
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();
  private httpServer: Server | undefined;
  private port = 0;

  constructor(options: FoundersHubOptions) {
    this.bus = options.bus;
    this.board = options.board;
  }

  urlFor(agent: AgentName): string {
    if (!this.port) throw new Error('FoundersHub is not started');
    return `http://127.0.0.1:${this.port}/hub/${this.token}/${agent}`;
  }

  async start(): Promise<void> {
    if (this.httpServer) throw new Error('FoundersHub already started');
    const server = createServer((req, res) => {
      this.route(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(error) }));
        }
      });
    });
    this.httpServer = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Failed to determine FoundersHub port');
    }
    this.port = address.port;
  }

  async stop(): Promise<void> {
    for (const transport of this.transports.values()) await transport.close();
    this.transports.clear();
    await new Promise<void>((resolve, reject) => {
      if (!this.httpServer) return resolve();
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    this.httpServer = undefined;
    this.port = 0;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const parts = url.pathname.split('/').filter(Boolean); // [hub, token, agent]
    const agent = parts[2] as AgentName | undefined;
    if (
      parts.length !== 3 ||
      parts[0] !== 'hub' ||
      parts[1] !== this.token ||
      !agent ||
      !AGENT_NAMES.includes(agent)
    ) {
      res.writeHead(404).end();
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? this.transports.get(sessionId) : undefined;

    if (req.method === 'POST') {
      const body: unknown = await readJsonBody(req);
      if (existing) {
        await existing.handleRequest(req, res, body);
        return;
      }
      if (isInitializeRequest(body)) {
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            this.transports.set(id, transport);
          },
          onsessionclosed: (id) => {
            this.transports.delete(id);
          },
        });
        await this.buildServer(agent).connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'No valid MCP session' }));
      return;
    }

    if ((req.method === 'GET' || req.method === 'DELETE') && existing) {
      await existing.handleRequest(req, res);
      return;
    }
    res.writeHead(405).end();
  }

  private buildServer(agent: AgentName): McpServer {
    const server = new McpServer({ name: 'founders-hub', version: '0.1.0' });
    const board = this.board;
    const bus = this.bus;

    /** Wrap a handler: catch errors, append the caller's unread chat digest. */
    const respond = (fn: () => string): ToolResult => {
      let text: string;
      let isError = false;
      try {
        text = fn();
      } catch (error) {
        text = `Error: ${error instanceof Error ? error.message : String(error)}`;
        isError = true;
      }
      const unread = bus.drainFor(agent);
      if (unread.length > 0) {
        text += `\n\n── New chat messages ──\n${unread.map(formatMessage).join('\n')}`;
      }
      return isError
        ? { content: [{ type: 'text', text }], isError: true }
        : { content: [{ type: 'text', text }] };
    };

    server.registerTool(
      'post_message',
      {
        description:
          'Say something in the founders chat. Keep it terse — status lines, not essays. ' +
          'Address someone directly with `to`; omit it to speak to everyone.',
        inputSchema: {
          text: z.string().min(1),
          to: z.enum(['user', 'claude', 'codex']).optional(),
        },
      },
      async ({ text, to }) =>
        respond(() => {
          bus.post(to !== undefined ? { from: agent, text, to } : { from: agent, text });
          return 'Posted.';
        }),
    );

    server.registerTool(
      'create_task',
      {
        description:
          'Add a task to the shared board. `files` are the glob patterns the task will own ' +
          'while claimed (e.g. ["src/auth/**", "tests/auth.test.ts"]).',
        inputSchema: {
          title: z.string().min(1),
          files: z.array(z.string()).default([]),
        },
      },
      async ({ title, files }) =>
        respond(() => formatTask(board.createTask(title, files, agent))),
    );

    server.registerTool(
      'claim_task',
      {
        description:
          'Claim an open task. Grants you exclusive ownership of its files until completed. ' +
          'Fails if the files overlap a task the other founder currently owns.',
        inputSchema: { id: z.string() },
      },
      async ({ id }) => respond(() => formatTask(board.claimTask(id, agent))),
    );

    server.registerTool(
      'request_review',
      {
        description:
          'Ask the other founder to review your claimed task before it closes. ' +
          'Include a short summary of what changed; they will read the diff themselves.',
        inputSchema: { id: z.string(), summary: z.string().min(1) },
      },
      async ({ id, summary }) =>
        respond(() => {
          const task = board.requestReview(id, agent, summary);
          bus.post({
            from: agent,
            to: otherAgent(agent),
            text: `Review requested for ${task.id} ("${task.title}"): ${summary}`,
          });
          return formatTask(task);
        }),
    );

    server.registerTool(
      'complete_task',
      {
        description:
          'Complete a task. Owners complete their own claimed tasks; tasks in review are ' +
          'approved (and closed) by the other founder.',
        inputSchema: { id: z.string() },
      },
      async ({ id }) => respond(() => formatTask(board.completeTask(id, agent))),
    );

    server.registerTool(
      'list_tasks',
      { description: 'List all tasks on the shared board.', inputSchema: {} },
      async () =>
        respond(() => {
          const tasks = board.listTasks();
          return tasks.length ? tasks.map(formatTask).join('\n') : 'Board is empty.';
        }),
    );

    return server;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
