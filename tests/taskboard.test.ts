import { describe, expect, it, vi } from 'vitest';
import { TaskBoard } from '../src/core/taskboard.js';

describe('TaskBoard', () => {
  it('creates open tasks with sequential ids', () => {
    const board = new TaskBoard();
    const a = board.createTask('auth middleware', ['src/middleware/**'], 'claude');
    const b = board.createTask('tests', ['tests/**'], 'codex');
    expect(a.id).toBe('T1');
    expect(b.id).toBe('T2');
    expect(a.status).toBe('open');
  });

  it('claim grants ownership; completing releases it', () => {
    const board = new TaskBoard();
    const t = board.createTask('auth', ['src/auth/**'], 'user');
    board.claimTask(t.id, 'claude');
    expect(board.getTask(t.id)?.owner).toBe('claude');
    expect(board.isFileOwnedBy('claude', 'src/auth/jwt.ts')).toBe(true);

    board.completeTask(t.id, 'claude');
    expect(board.getTask(t.id)?.status).toBe('done');
    expect(board.isFileOwnedBy('claude', 'src/auth/jwt.ts')).toBe(false);
  });

  it('rejects claiming a task that is not open', () => {
    const board = new TaskBoard();
    const t = board.createTask('auth', ['src/auth/**'], 'user');
    board.claimTask(t.id, 'claude');
    expect(() => board.claimTask(t.id, 'codex')).toThrow(/not open/i);
  });

  it('rejects a claim whose files collide with the other agent\'s active tasks', () => {
    const board = new TaskBoard();
    const a = board.createTask('auth', ['src/auth/**'], 'user');
    const b = board.createTask('auth tests', ['src/auth/jwt.ts', 'tests/**'], 'user');
    board.claimTask(a.id, 'claude');
    expect(() => board.claimTask(b.id, 'codex')).toThrow(/conflict/i);
  });

  it('allows the same agent to hold overlapping tasks', () => {
    const board = new TaskBoard();
    const a = board.createTask('auth', ['src/auth/**'], 'user');
    const b = board.createTask('auth polish', ['src/auth/jwt.ts'], 'user');
    board.claimTask(a.id, 'claude');
    expect(() => board.claimTask(b.id, 'claude')).not.toThrow();
  });

  describe('canEdit', () => {
    it('blocks editing files owned by the other agent, allows own and unowned', () => {
      const board = new TaskBoard();
      const t = board.createTask('auth', ['src/auth/**'], 'user');
      board.claimTask(t.id, 'claude');

      expect(board.canEdit('claude', 'src/auth/jwt.ts')).toBe(true);
      expect(board.canEdit('codex', 'src/auth/jwt.ts')).toBe(false);
      // unowned file: both may touch it
      expect(board.canEdit('codex', 'package.json')).toBe(true);
    });

    it('normalizes windows-style paths', () => {
      const board = new TaskBoard();
      const t = board.createTask('auth', ['src/auth/**'], 'user');
      board.claimTask(t.id, 'claude');
      expect(board.canEdit('codex', 'src\\auth\\jwt.ts')).toBe(false);
    });

    it('canonicalizes absolute paths against the project root', () => {
      const board = new TaskBoard('/repo');
      const t = board.createTask('auth', ['src/auth/**'], 'user');
      board.claimTask(t.id, 'claude');
      expect(board.canEdit('codex', '/repo/src/auth/jwt.ts')).toBe(false);
      expect(board.isFileOwnedBy('claude', '/repo/src/auth/jwt.ts')).toBe(true);
    });

    it('is not fooled by ../ traversal inside the workspace', () => {
      const board = new TaskBoard('/repo');
      const t = board.createTask('auth', ['src/auth/**'], 'user');
      board.claimTask(t.id, 'claude');
      expect(board.canEdit('codex', 'src/other/../auth/jwt.ts')).toBe(false);
    });

    it('fails closed on paths escaping the project root', () => {
      const board = new TaskBoard('/repo');
      board.claimTask(board.createTask('auth', ['src/auth/**'], 'user').id, 'claude');
      expect(board.canEdit('codex', '../outside/file.ts')).toBe(false);
      expect(board.canEdit('claude', '/etc/passwd')).toBe(false);
      expect(board.isFileOwnedBy('claude', '../outside/file.ts')).toBe(false);
    });

    it('matches case-insensitively (Windows/macOS filesystems)', () => {
      const board = new TaskBoard('/repo');
      const t = board.createTask('auth', ['src/auth/**'], 'user');
      board.claimTask(t.id, 'claude');
      expect(board.canEdit('codex', 'SRC/Auth/JWT.TS')).toBe(false);
    });
  });

  describe('release flow', () => {
    it('owner releases a claimed task back to open, freeing its files', () => {
      const board = new TaskBoard();
      const t = board.createTask('auth', ['src/auth/**'], 'user');
      board.claimTask(t.id, 'claude');
      board.releaseTask(t.id, 'claude');

      expect(board.getTask(t.id)?.status).toBe('open');
      expect(board.getTask(t.id)?.owner).toBeUndefined();
      expect(board.canEdit('codex', 'src/auth/jwt.ts')).toBe(true);
      // and it can be re-claimed by the other agent
      expect(() => board.claimTask(t.id, 'codex')).not.toThrow();
    });

    it('non-owners cannot release', () => {
      const board = new TaskBoard();
      const t = board.createTask('auth', [], 'user');
      board.claimTask(t.id, 'claude');
      expect(() => board.releaseTask(t.id, 'codex')).toThrow(/owner/i);
    });
  });

  describe('review flow', () => {
    it('owner requests review, the other agent approves by completing', () => {
      const board = new TaskBoard();
      const t = board.createTask('auth', ['src/auth/**'], 'user');
      board.claimTask(t.id, 'claude');
      board.requestReview(t.id, 'claude', 'JWT middleware + refresh tokens');

      expect(board.getTask(t.id)?.status).toBe('review');
      // ownership persists during review
      expect(board.canEdit('codex', 'src/auth/jwt.ts')).toBe(false);

      board.completeTask(t.id, 'codex');
      expect(board.getTask(t.id)?.status).toBe('done');
    });

    it('only the owner can request review', () => {
      const board = new TaskBoard();
      const t = board.createTask('auth', ['src/auth/**'], 'user');
      board.claimTask(t.id, 'claude');
      expect(() => board.requestReview(t.id, 'codex', 'x')).toThrow(/owner/i);
    });

    it('the owner cannot self-approve a task in review', () => {
      const board = new TaskBoard();
      const t = board.createTask('auth', ['src/auth/**'], 'user');
      board.claimTask(t.id, 'claude');
      board.requestReview(t.id, 'claude', 'done');
      expect(() => board.completeTask(t.id, 'claude')).toThrow(/other/i);
    });

    it('a non-owner cannot complete a claimed (unreviewed) task', () => {
      const board = new TaskBoard();
      const t = board.createTask('auth', ['src/auth/**'], 'user');
      board.claimTask(t.id, 'claude');
      expect(() => board.completeTask(t.id, 'codex')).toThrow(/owner/i);
    });
  });

  it('emits change events', () => {
    const board = new TaskBoard();
    const seen = vi.fn();
    board.onChange(seen);
    const t = board.createTask('auth', [], 'user');
    board.claimTask(t.id, 'claude');
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
