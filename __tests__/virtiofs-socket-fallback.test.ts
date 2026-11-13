import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isFuseFilesystem } from '../src/mcp/index';
import { socketFileExists } from '../src/mcp/proxy';

// Make the fs namespace's exports spyable (vitest 4 ESM namespaces are frozen).
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
}));

const FUSE_SUPER_MAGIC = 0x65735546;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('virtiofs / FUSE socket fallback', () => {
  it('detects a FUSE mount by its statfs magic', () => {
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ type: FUSE_SUPER_MAGIC } as any);
    expect(isFuseFilesystem('/some/project')).toBe(true);
  });

  it('does not flag other filesystems', () => {
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ type: 0xef53 } as any); // ext4
    expect(isFuseFilesystem('/some/project')).toBe(false);
  });

  it('treats a path it cannot inspect as not FUSE', () => {
    vi.spyOn(fs, 'statfsSync').mockImplementation(() => {
      throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
    });
    expect(isFuseFilesystem('/some/project')).toBe(false);
  });

  it('socketFileExists returns false only for a definitive ENOENT', () => {
    const missing = path.join(
      os.tmpdir(),
      `cg-no-such-socket-${process.pid}-${Date.now()}`
    );
    expect(socketFileExists(missing)).toBe(false);
  });

  it('socketFileExists treats any other stat failure as "exists"', () => {
    // virtiofs answers EINVAL for a Unix socket's stat(), which is why
    // fs.existsSync falsely reported the daemon socket missing.
    vi.spyOn(fs, 'statSync').mockImplementation(() => {
      throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
    });
    expect(socketFileExists('/c/Users/me/app/.codegraph/daemon.sock')).toBe(true);
  });

  it('socketFileExists sees a real file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sock-'));
    const file = path.join(dir, 'daemon.sock');
    fs.writeFileSync(file, '');
    try {
      expect(socketFileExists(file)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
