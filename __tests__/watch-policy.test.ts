/**
 * Watch Policy Tests
 *
 * Covers the decision of whether the live file watcher runs, including the
 * WSL2 /mnt auto-detect and the env-var escape hatches (issue #199), plus
 * that FileWatcher.start() honors the decision.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { watchDisabledReason } from '../src/sync/watch-policy';
import { FileWatcher } from '../src/sync/watcher';
import type { CodeGraphConfig } from '../src/types';

describe('watchDisabledReason', () => {
  it('returns a reason when CODEGRAPH_NO_WATCH=1', () => {
    const reason = watchDisabledReason('/home/me/project', {
      env: { CODEGRAPH_NO_WATCH: '1' },
      isWsl: false,
    });
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/CODEGRAPH_NO_WATCH/);
  });

  it('auto-disables on a WSL2 /mnt drive', () => {
    const reason = watchDisabledReason('/mnt/d/code/project', { env: {}, isWsl: true });
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/mnt/);
  });

  it('does NOT disable on a native WSL home path', () => {
    expect(watchDisabledReason('/home/me/project', { env: {}, isWsl: true })).toBeNull();
  });

  it('does NOT disable on /mnt when not running under WSL', () => {
    // A real Linux box may legitimately have a fast /mnt mount.
    expect(watchDisabledReason('/mnt/d/code/project', { env: {}, isWsl: false })).toBeNull();
  });

  it('does NOT treat /mnt/wsl (fast Linux mount) as a Windows drive', () => {
    expect(watchDisabledReason('/mnt/wsl/project', { env: {}, isWsl: true })).toBeNull();
  });

  it('CODEGRAPH_FORCE_WATCH=1 overrides WSL auto-detect', () => {
    const reason = watchDisabledReason('/mnt/d/code/project', {
      env: { CODEGRAPH_FORCE_WATCH: '1' },
      isWsl: true,
    });
    expect(reason).toBeNull();
  });

  it('CODEGRAPH_NO_WATCH wins over CODEGRAPH_FORCE_WATCH', () => {
    const reason = watchDisabledReason('/home/me/project', {
      env: { CODEGRAPH_NO_WATCH: '1', CODEGRAPH_FORCE_WATCH: '1' },
      isWsl: false,
    });
    expect(reason).toBeTruthy();
  });
});

describe('FileWatcher honors the watch policy', () => {
  let testDir: string;

  const baseConfig: CodeGraphConfig = {
    version: 1,
    rootDir: '.',
    include: ['**/*.ts'],
    exclude: ['**/node_modules/**'],
    languages: [],
    frameworks: [],
    maxFileSize: 1024 * 1024,
    extractDocstrings: true,
    trackCallSites: true,
  };

  afterEach(() => {
    delete process.env.CODEGRAPH_NO_WATCH;
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('does not start when CODEGRAPH_NO_WATCH=1', () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-nowatch-'));
    process.env.CODEGRAPH_NO_WATCH = '1';

    const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
    const watcher = new FileWatcher(testDir, baseConfig, syncFn);

    expect(watcher.start()).toBe(false);
    expect(watcher.isActive()).toBe(false);
  });
});
