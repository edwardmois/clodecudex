import picomatch from 'picomatch';
import { otherAgent, type AgentName, type Participant, type Task } from './types.js';

type ChangeListener = (task: Task) => void;

/** Statuses during which a task's file globs are exclusively owned. */
const ACTIVE: ReadonlySet<Task['status']> = new Set(['claimed', 'review']);

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Two glob patterns "collide" when one matches the other treated as a path.
 * This is a pragmatic check, not full glob-intersection (undecidable in
 * general): it catches the realistic cases — identical patterns, and a
 * concrete file listed under another task's directory glob.
 */
function globsCollide(a: string, b: string): boolean {
  if (a === b) return true;
  return picomatch(a)(b) || picomatch(b)(a);
}

/**
 * Shared task board with exclusive file ownership. Claiming a task grants
 * its owner exclusive write access to the task's file globs until the task
 * is completed; the orchestrator and agent-side hooks enforce this through
 * {@link canEdit}.
 */
export class TaskBoard {
  private readonly tasks = new Map<string, Task>();
  private readonly listeners = new Set<ChangeListener>();
  private nextId = 1;

  createTask(title: string, files: string[], createdBy: Participant): Task {
    const task: Task = {
      id: `T${this.nextId++}`,
      title,
      files: files.map(normalizePath),
      status: 'open',
      createdBy,
    };
    this.tasks.set(task.id, task);
    this.emit(task);
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  listTasks(): Task[] {
    return [...this.tasks.values()];
  }

  claimTask(id: string, agent: AgentName): Task {
    const task = this.mustGet(id);
    if (task.status !== 'open') {
      throw new Error(`Task ${id} is not open (status: ${task.status})`);
    }
    const collision = this.findCollision(task.files, otherAgent(agent));
    if (collision) {
      throw new Error(
        `File conflict: "${collision.glob}" overlaps task ${collision.task.id} ` +
          `("${collision.task.title}") owned by ${collision.task.owner}`,
      );
    }
    task.status = 'claimed';
    task.owner = agent;
    this.emit(task);
    return task;
  }

  requestReview(id: string, agent: AgentName, summary: string): Task {
    const task = this.mustGet(id);
    if (task.owner !== agent) {
      throw new Error(`Only the owner (${task.owner ?? 'nobody'}) can request review of ${id}`);
    }
    if (task.status !== 'claimed') {
      throw new Error(`Task ${id} is not claimed (status: ${task.status})`);
    }
    task.status = 'review';
    task.reviewSummary = summary;
    this.emit(task);
    return task;
  }

  /**
   * Claimed tasks are completed by their owner; tasks in review are approved
   * (and thereby completed) by the *other* agent — never self-approved.
   */
  completeTask(id: string, agent: AgentName): Task {
    const task = this.mustGet(id);
    if (task.status === 'claimed') {
      if (task.owner !== agent) {
        throw new Error(`Only the owner (${task.owner ?? 'nobody'}) can complete ${id}`);
      }
    } else if (task.status === 'review') {
      if (task.owner === agent) {
        throw new Error(`Task ${id} is in review and must be approved by the other founder`);
      }
    } else {
      throw new Error(`Task ${id} cannot be completed (status: ${task.status})`);
    }
    task.status = 'done';
    this.emit(task);
    return task;
  }

  /** True when `path` matches a glob of a task actively owned by `agent`. */
  isFileOwnedBy(agent: AgentName, path: string): boolean {
    const p = normalizePath(path);
    return this.activeGlobs(agent).some((glob) => picomatch(glob)(p));
  }

  /** An agent may edit anything not actively owned by the other agent. */
  canEdit(agent: AgentName, path: string): boolean {
    return !this.isFileOwnedBy(otherAgent(agent), path);
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private activeGlobs(agent: AgentName): string[] {
    return this.listTasks()
      .filter((t) => t.owner === agent && ACTIVE.has(t.status))
      .flatMap((t) => t.files);
  }

  private findCollision(
    globs: string[],
    against: AgentName,
  ): { glob: string; task: Task } | undefined {
    const activeTasks = this.listTasks().filter(
      (t) => t.owner === against && ACTIVE.has(t.status),
    );
    for (const glob of globs) {
      for (const task of activeTasks) {
        if (task.files.some((other) => globsCollide(glob, other))) {
          return { glob, task };
        }
      }
    }
    return undefined;
  }

  private mustGet(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }

  private emit(task: Task): void {
    for (const listener of this.listeners) listener(task);
  }
}
