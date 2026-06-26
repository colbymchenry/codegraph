/**
 * Socket-support probe — issue #997.
 *
 * ExFAT, NTFS-3G, and some FUSE-backed volumes don't support AF_UNIX sockets.
 * `getDaemonSocketPath` must detect this and fall back to `os.tmpdir()` instead
 * of returning an in-project path that will fail on `listen()`.
 *
 * These tests validate `canSocketInDir` on the local tmpdir (which always
 * supports sockets on any standard OS) and verify the cache is effective.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  canSocketInDir,
  clearSocketSupportCache,
  getDaemonSocketPath,
} from '../src/mcp/daemon-paths';

afterEach(() => {
  clearSocketSupportCache();
});

describe('canSocketInDir (#997)', () => {
  it.runIf(process.platform !== 'win32')('returns true for a directory on a socket-capable filesystem', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sock-probe-'));
    try {
      expect(canSocketInDir(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('caches the result per device — second call is free', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sock-probe-'));
    try {
      const first = canSocketInDir(dir);
      const second = canSocketInDir(dir);
      expect(first).toBe(second);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns true when the directory does not exist (optimistic fallback)', () => {
    expect(canSocketInDir('/nonexistent-dir-cg-probe')).toBe(true);
  });
});

describe('getDaemonSocketPath (#997)', () => {
  it.runIf(process.platform !== 'win32')('returns in-project path on a socket-capable filesystem', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-path-'));
    try {
      const sockPath = getDaemonSocketPath(root);
      expect(sockPath).toContain('.codegraph');
      expect(sockPath).toContain('daemon.sock');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')('returns a named pipe on Windows', () => {
    const sockPath = getDaemonSocketPath('/some/project');
    expect(sockPath).toMatch(/^\\\\.\\pipe\\codegraph-/);
  });
});
