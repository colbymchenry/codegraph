/**
 * offerWatchFallback's `force` option (generalizes git-hooks freshness
 * beyond the WSL2/CODEGRAPH_NO_WATCH-only case — see `--git-hooks` on
 * `codegraph init`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { offerWatchFallback } from '../src/installer';
import { isSyncHookInstalled } from '../src/sync/git-hooks';

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}

function fakeClack() {
  return {
    log: { warn: () => {}, info: () => {}, success: () => {}, error: () => {} },
    select: async () => 'hook' as const,
    isCancel: () => false,
  } as unknown as typeof import('@clack/prompts');
}

describe('offerWatchFallback force option', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-watchfallback-'));
    gitInit(repo);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('does nothing when the watcher is enabled and force is not set', async () => {
    await offerWatchFallback(fakeClack(), repo, { yes: true });
    expect(isSyncHookInstalled(repo)).toBe(false);
  });

  it('installs git sync hooks when force is set, even though the watcher is enabled', async () => {
    await offerWatchFallback(fakeClack(), repo, { yes: true, force: true });
    expect(isSyncHookInstalled(repo)).toBe(true);
  });

  it('is a no-op on a non-git directory even when forced', async () => {
    const nonGitRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-watchfallback-nogit-'));
    try {
      await offerWatchFallback(fakeClack(), nonGitRepo, { yes: true, force: true });
      expect(isSyncHookInstalled(nonGitRepo)).toBe(false);
    } finally {
      fs.rmSync(nonGitRepo, { recursive: true, force: true });
    }
  });
});
