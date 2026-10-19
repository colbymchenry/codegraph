import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isFuseFilesystem } from '../src/mcp/index';
import { socketFileExists } from '../src/mcp/proxy';

describe('virtiofs / FUSE socket fallback', () => {
  it('detects this repo mount as FUSE/virtiofs', () => {
    // The test environment's project lives on a virtiofs mount.
    const repoRoot = path.resolve(__dirname, '..');
    expect(isFuseFilesystem(repoRoot)).toBe(true);
  });

  it('does not flag a normal temp dir as FUSE', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fuse-'));
    // /tmp is an overlay fs, not FUSE.
    expect(isFuseFilesystem(tmp)).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('socketFileExists returns false on ENOENT', () => {
    const p = path.join(os.tmpdir(), 'cg-no-such-socket-' + Date.now());
    expect(socketFileExists(p)).toBe(false);
  });

  it('socketFileExists treats non-ENOENT stat failures as "exists"', () => {
    // Simulate a FUSE-style EINVAL by passing a path whose parent is a file.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fuse2-'));
    const fileAsDir = path.join(tmp, 'file');
    fs.writeFileSync(fileAsDir, 'x');
    const bogus = path.join(fileAsDir, 'sock'); // stat fails ENOTDIR, not ENOENT
    expect(socketFileExists(bogus)).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});