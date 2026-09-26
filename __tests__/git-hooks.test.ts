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

/**
 * Run a hook the way git does, with a fake `codegraph` first on PATH that
 * records its argv and cwd. The hook backgrounds the call, so poll for the log.
 */
function runHookWithFakeCodegraph(hookFile: string, cwd: string): string[] {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fakebin-'));
  const log = path.join(bin, 'calls.log');
  try {
    fs.writeFileSync(
      path.join(bin, 'codegraph'),
      `#!/bin/sh\necho "cwd=$(pwd) args=$*" >> '${log}'\n`,
      { mode: 0o755 },
    );
    try {
      execFileSync(hookFile, [], {
        cwd,
        stdio: 'ignore',
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
      });
    } catch {
      /* a hook that exits non-zero still ran; the log says what it did */
    }
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(log) && Date.now() < deadline) {
      execFileSync('sleep', ['0.05']);
    }
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

describe('git sync hooks — project roots and existing hooks', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-githooks-')));
    gitInit(repo);
  });

  afterEach(() => {
    if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
  });

  const hookFile = (): string => path.join(repo, '.git', 'hooks', 'post-commit');

  it.runIf(process.platform !== 'win32')('syncs the sub-project it was installed for, not the repo top level', () => {
    const sub = path.join(repo, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });

    installGitSyncHook(sub, ['post-commit']);

    // git runs hooks from the top of the work tree
    const calls = runHookWithFakeCodegraph(hookFile(), repo);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`args=sync ${sub}`);
  });

  it('keeps one block per project root, and removes only its own', () => {
    const a = path.join(repo, 'a');
    const b = path.join(repo, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);

    installGitSyncHook(a, ['post-commit']);
    installGitSyncHook(b, ['post-commit']);
    installGitSyncHook(a, ['post-commit']); // re-install stays idempotent per root

    const body = fs.readFileSync(hookFile(), 'utf8');
    expect(body.split('# >>> codegraph sync hook >>>').length - 1).toBe(2);
    expect(isSyncHookInstalled(a, ['post-commit'])).toBe(true);
    expect(isSyncHookInstalled(b, ['post-commit'])).toBe(true);

    removeGitSyncHook(a, ['post-commit']);
    expect(isSyncHookInstalled(a, ['post-commit'])).toBe(false);
    expect(isSyncHookInstalled(b, ['post-commit'])).toBe(true);
  });

  it('does not report a hook installed for another project root', () => {
    const a = path.join(repo, 'a');
    const b = path.join(repo, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);

    installGitSyncHook(a, ['post-commit']);
    expect(isSyncHookInstalled(b, ['post-commit'])).toBe(false);
  });

  it('treats a block from an older install as the top-level project\'s', () => {
    const legacy = [
      '#!/bin/sh',
      '# >>> codegraph sync hook >>>',
      'if command -v codegraph >/dev/null 2>&1; then',
      '  ( codegraph sync >/dev/null 2>&1 & ) >/dev/null 2>&1',
      'fi',
      '# <<< codegraph sync hook <<<',
      '',
    ].join('\n');
    fs.writeFileSync(hookFile(), legacy, { mode: 0o755 });
    const sub = path.join(repo, 'sub');
    fs.mkdirSync(sub);

    expect(isSyncHookInstalled(repo, ['post-commit'])).toBe(true);
    expect(isSyncHookInstalled(sub, ['post-commit'])).toBe(false);

    // Re-installing for the top level replaces the old block rather than adding one.
    installGitSyncHook(repo, ['post-commit']);
    const body = fs.readFileSync(hookFile(), 'utf8');
    expect(body.split('# >>> codegraph sync hook >>>').length - 1).toBe(1);
  });

  it('leaves a hook written in another language untouched', () => {
    const python = '#!/usr/bin/env python3\nprint("my hook")\n';
    fs.writeFileSync(hookFile(), python, { mode: 0o755 });

    const result = installGitSyncHook(repo, ['post-commit']);

    expect(fs.readFileSync(hookFile(), 'utf8')).toBe(python);
    expect(result.installed).toEqual([]);
    expect(result.unsupported).toEqual(['post-commit']);
    expect(isSyncHookInstalled(repo, ['post-commit'])).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('still syncs when the existing shell hook ends with exit', () => {
    fs.writeFileSync(hookFile(), '#!/bin/sh\necho "my hook"\nexit 0\n', { mode: 0o755 });

    installGitSyncHook(repo, ['post-commit']);

    const body = fs.readFileSync(hookFile(), 'utf8');
    expect(body).toContain('echo "my hook"');
    expect(body.startsWith('#!/bin/sh\n')).toBe(true);
    expect(runHookWithFakeCodegraph(hookFile(), repo)).toHaveLength(1);
  });
});
