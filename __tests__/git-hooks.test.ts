/**
 * Git Sync Hooks Tests
 *
 * Covers installing/removing the opt-in commit/merge/checkout hooks that
 * keep the index fresh when the live watcher is disabled (issue #199).
 * Exercises real git repos in temp dirs — no mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  installGitSyncHook,
  removeGitSyncHook,
  isSyncHookInstalled,
  isGitRepo,
  DEFAULT_SYNC_HOOKS,
} from '../src/sync/git-hooks';

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}

function isExecutable(file: string): boolean {
  if (process.platform === 'win32') return true; // mode bits not meaningful
  return (fs.statSync(file).mode & 0o111) !== 0;
}

describe('git sync hooks', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-githooks-'));
  });

  afterEach(() => {
    if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('installs all default hooks, executable, invoking codegraph sync', () => {
    gitInit(repo);
    const result = installGitSyncHook(repo);

    expect(result.installed.sort()).toEqual([...DEFAULT_SYNC_HOOKS].sort());
    expect(result.skipped).toBeUndefined();

    for (const hook of DEFAULT_SYNC_HOOKS) {
      const file = path.join(repo, '.git', 'hooks', hook);
      expect(fs.existsSync(file)).toBe(true);
      const body = fs.readFileSync(file, 'utf8');
      expect(body).toContain('codegraph sync');
      expect(body).toContain('command -v codegraph'); // no-op when not on PATH
      expect(isExecutable(file)).toBe(true);
    }
    expect(isSyncHookInstalled(repo)).toBe(true);
  });

  it('is idempotent — re-install does not duplicate the block', () => {
    gitInit(repo);
    installGitSyncHook(repo);
    installGitSyncHook(repo);

    const body = fs.readFileSync(path.join(repo, '.git', 'hooks', 'post-commit'), 'utf8');
    const occurrences = body.split('# >>> codegraph sync hook >>>').length - 1;
    expect(occurrences).toBe(1);
  });

  it('preserves a pre-existing user hook and appends our block', () => {
    gitInit(repo);
    const file = path.join(repo, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(file, '#!/bin/sh\necho "my custom hook"\n', { mode: 0o755 });

    installGitSyncHook(repo, ['post-commit']);

    const body = fs.readFileSync(file, 'utf8');
    expect(body).toContain('echo "my custom hook"');
    expect(body).toContain('codegraph sync');
  });

  it('remove strips our block; deletes a hook that was only ours', () => {
    gitInit(repo);
    installGitSyncHook(repo, ['post-commit']);
    const file = path.join(repo, '.git', 'hooks', 'post-commit');
    expect(fs.existsSync(file)).toBe(true);

    const result = removeGitSyncHook(repo, ['post-commit']);
    expect(result.installed).toEqual(['post-commit']);
    expect(fs.existsSync(file)).toBe(false); // was ours-only → deleted
    expect(isSyncHookInstalled(repo)).toBe(false);
  });

  it('remove keeps user content when the hook is shared', () => {
    gitInit(repo);
    const file = path.join(repo, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(file, '#!/bin/sh\necho "keep me"\n', { mode: 0o755 });
    installGitSyncHook(repo, ['post-commit']);

    removeGitSyncHook(repo, ['post-commit']);

    expect(fs.existsSync(file)).toBe(true);
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toContain('echo "keep me"');
    expect(body).not.toContain('codegraph sync');
  });

  it('honors core.hooksPath', () => {
    gitInit(repo);
    const customHooks = path.join(repo, '.husky');
    fs.mkdirSync(customHooks);
    execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: repo, stdio: 'ignore' });

    const result = installGitSyncHook(repo, ['post-commit']);
    expect(result.hooksDir).toBe(customHooks);
    expect(fs.existsSync(path.join(customHooks, 'post-commit'))).toBe(true);
    // The default .git/hooks dir should NOT have received the hook.
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'post-commit'))).toBe(false);
  });

  it('skips cleanly when not a git repository', () => {
    expect(isGitRepo(repo)).toBe(false);
    const result = installGitSyncHook(repo);
    expect(result.installed).toEqual([]);
    expect(result.hooksDir).toBeNull();
    expect(result.skipped).toMatch(/not a git repository/);
    expect(isSyncHookInstalled(repo)).toBe(false);
  });
});
