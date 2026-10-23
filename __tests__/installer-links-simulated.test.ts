/**
 * The installer writes through a symbolic link instead of replacing it
 * (#2721) — checked here with the link SIMULATED, so it runs on every machine.
 *
 * The real-link tests in `installer-targets.test.ts` need to create file
 * symlinks, which Windows only allows with Developer Mode or admin rights;
 * where it can't, they are skipped. These two still run: the file system
 * reports one path as a link (lstat) and says where it points (realpath /
 * readlink), and the write must land there, leaving the link's own path alone.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteFileSync } from '../src/installer/targets/shared';

// A plain copy of `fs`, so single functions can be spied on.
vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>() }));

describe('Installer — writes land on the file a link points to (link simulated) (#2721)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-link-sim-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Make the file system report `linkPath` as a symbolic link. */
  function reportAsLink(linkPath: string, opts: { realpath: () => string; readlink?: string }): void {
    const realLstat = fs.lstatSync;
    const realRealpath = fs.realpathSync;
    const realReadlink = fs.readlinkSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) =>
      p === linkPath ? ({ isSymbolicLink: () => true } as fs.Stats) : (realLstat as any)(p, ...rest)) as typeof fs.lstatSync);
    vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) =>
      p === linkPath ? opts.realpath() : (realRealpath as any)(p, ...rest)) as typeof fs.realpathSync);
    vi.spyOn(fs, 'readlinkSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) =>
      p === linkPath ? opts.readlink : (realReadlink as any)(p, ...rest)) as typeof fs.readlinkSync);
  }

  it('a live link: the file it points to is replaced, and the link\'s own path is never written', () => {
    const linkPath = path.join(dir, 'AGENTS.md');
    const target = path.join(dir, 'dotfiles', 'AGENTS.md');
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(linkPath, 'stands in for the link');
    fs.writeFileSync(target, '# shared\n');
    reportAsLink(linkPath, { realpath: () => target });

    atomicWriteFileSync(linkPath, '# shared\nwith codegraph\n');

    expect(fs.readFileSync(target, 'utf-8')).toBe('# shared\nwith codegraph\n');
    expect(fs.readFileSync(linkPath, 'utf-8')).toBe('stands in for the link');
    expect(fs.readdirSync(path.dirname(target))).toEqual(['AGENTS.md']);
  });

  it('a dangling relative link: its file is created relative to the link\'s folder, and a missing folder is an error', () => {
    const linkPath = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(linkPath, 'stands in for the link');
    fs.mkdirSync(path.join(dir, 'dotfiles'));
    const enoent = (): never => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); };
    reportAsLink(linkPath, { realpath: enoent, readlink: path.join('dotfiles', 'AGENTS.md') });

    atomicWriteFileSync(linkPath, 'block\n');
    expect(fs.readFileSync(path.join(dir, 'dotfiles', 'AGENTS.md'), 'utf-8')).toBe('block\n');
    expect(fs.readFileSync(linkPath, 'utf-8')).toBe('stands in for the link');

    vi.restoreAllMocks();
    reportAsLink(linkPath, { realpath: enoent, readlink: path.join('not-cloned', 'AGENTS.md') });
    expect(() => atomicWriteFileSync(linkPath, 'block\n')).toThrow(/is a symbolic link to .*not-cloned.*its folder does not exist/);
    expect(fs.existsSync(path.join(dir, 'not-cloned'))).toBe(false);
    expect(fs.readFileSync(linkPath, 'utf-8')).toBe('stands in for the link');
  });
});
