/**
 * A file the installer rewrites keeps its mode, and its owner where that may
 * be set. Every write goes to `<path>.tmp.<pid>` and is renamed over the
 * file, and a new file gets the default mode (0644 under the usual umask)
 * and this process's owner: a 0600 `~/.claude.json` or
 * `~/.codex/config.toml` holding tokens came out readable by every account
 * on the machine. Found while fixing #2721, the write-through-links change.
 *
 * Windows has no POSIX modes, so most of these tests report one through a
 * mocked `fs.statSync` and check what the installer asks of the file system
 * for the temp file (its mode when opened, its owner and mode before any
 * content goes in, and the rename over the old file); those run on every
 * machine. The tests that read real modes back run where modes exist.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteFileSync } from '../src/installer/targets/shared';
import { ALL_TARGETS } from '../src/installer/targets/registry';
import { refreshTargets } from '../src/installer';

// A plain copy of `fs`, so single functions can be spied on.
vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>() }));

const POSIX = process.platform !== 'win32';
/** An owner no test account has, so a kept owner is always a change. */
const OWNER = { uid: 4242, gid: 4343 };

const key = (p: fs.PathLike): string => {
  const s = path.resolve(String(p));
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

/** Make `fs.statSync` report the files in `modes` as regular files with that mode and OWNER. */
function reportModes(modes: Map<string, number>): void {
  const realStat = fs.statSync;
  vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    const stats = (realStat as any)(p, ...rest) as fs.Stats | undefined;
    const mode = modes.get(key(p));
    if (!stats || mode === undefined) return stats;
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
      mode: (stats.mode & ~0o7777) | mode,
      ...OWNER,
    });
  }) as typeof fs.statSync);
}

interface TempFile {
  path: string;
  /** What happened to it, in order: `open 600`, `chown 4242:4343`, `chmod 600`, `write`, `close`, `rename`. */
  steps: string[];
  renamedOnto?: string;
}

/**
 * Record, per temp file, what the installer asks of the file system. Every
 * call still goes to the real one (on Windows an owner change is a no-op;
 * on POSIX one this account may not make fails, as it would for real).
 */
function recordTempFiles(): TempFile[] {
  const temps: TempFile[] = [];
  const byFd = new Map<number, TempFile>();
  const real = {
    openSync: fs.openSync, fchownSync: fs.fchownSync, fchmodSync: fs.fchmodSync,
    writeFileSync: fs.writeFileSync, closeSync: fs.closeSync, renameSync: fs.renameSync,
  };
  const isTemp = (p: unknown) => typeof p === 'string' && path.basename(p).includes('.tmp.');
  vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    const fd = real.openSync(p, flags, mode);
    if (isTemp(p)) {
      const temp: TempFile = { path: String(p), steps: [`open ${mode === undefined || mode === null ? 'default' : Number(mode).toString(8)}`] };
      temps.push(temp);
      byFd.set(fd, temp);
    }
    return fd;
  }) as typeof fs.openSync);
  vi.spyOn(fs, 'fchownSync').mockImplementation(((fd: number, uid: number, gid: number) => {
    byFd.get(fd)?.steps.push(`chown ${uid}:${gid}`);
    return real.fchownSync(fd, uid, gid);
  }) as typeof fs.fchownSync);
  vi.spyOn(fs, 'fchmodSync').mockImplementation(((fd: number, mode: fs.Mode) => {
    byFd.get(fd)?.steps.push(`chmod ${Number(mode).toString(8)}`);
    return real.fchmodSync(fd, mode);
  }) as typeof fs.fchmodSync);
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (typeof file === 'number') byFd.get(file)?.steps.push('write');
    if (isTemp(file)) temps.push({ path: String(file), steps: ['write'] });
    return (real.writeFileSync as any)(file, ...rest);
  }) as typeof fs.writeFileSync);
  vi.spyOn(fs, 'closeSync').mockImplementation(((fd: number) => {
    byFd.get(fd)?.steps.push('close');
    byFd.delete(fd);
    return real.closeSync(fd);
  }) as typeof fs.closeSync);
  vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    const temp = [...temps].reverse().find((t) => t.path === String(from));
    if (temp) {
      temp.steps.push('rename');
      temp.renamedOnto = String(to);
    }
    return real.renameSync(from, to);
  }) as typeof fs.renameSync);
  return temps;
}

const KEPT = [`open 600`, `chown ${OWNER.uid}:${OWNER.gid}`, 'chmod 600', 'write', 'close', 'rename'];

describe('Installer — a rewritten file keeps its mode and owner', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-file-mode-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
      try { fs.chmodSync(path.join(dir, f), 0o700); } catch { /* ignore */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the temp file is opened with the old file\'s mode and given its owner and mode before any content, then renamed over it', () => {
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, 'model = "o3"\n');
    reportModes(new Map([[key(file), 0o600]]));
    const temps = recordTempFiles();

    atomicWriteFileSync(file, 'model = "o3"\n\n[mcp_servers.codegraph]\n');

    expect(temps.map((t) => t.steps)).toEqual([KEPT]);
    expect(temps.map((t) => t.renamedOnto)).toEqual([file]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('model = "o3"\n\n[mcp_servers.codegraph]\n');
    expect(fs.readdirSync(dir)).toEqual(['config.toml']);
  });

  it('through a symbolic link, the file at its end keeps its mode and owner (link simulated)', () => {
    const linkPath = path.join(dir, '.claude.json');
    const target = path.join(dir, 'dotfiles', 'claude.json');
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(linkPath, 'stands in for the link');
    fs.writeFileSync(target, '{}\n');
    const realLstat = fs.lstatSync;
    const realRealpath = fs.realpathSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) =>
      p === linkPath ? ({ isSymbolicLink: () => true } as fs.Stats) : (realLstat as any)(p, ...rest)) as typeof fs.lstatSync);
    vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) =>
      p === linkPath ? target : (realRealpath as any)(p, ...rest)) as typeof fs.realpathSync);
    reportModes(new Map([[key(target), 0o600]]));
    const temps = recordTempFiles();

    atomicWriteFileSync(linkPath, '{\n  "mcpServers": {}\n}\n');

    expect(temps.map((t) => path.dirname(t.path))).toEqual([path.dirname(target)]);
    expect(temps.map((t) => t.steps)).toEqual([KEPT]);
    expect(temps.map((t) => t.renamedOnto)).toEqual([target]);
    expect(fs.readFileSync(target, 'utf-8')).toBe('{\n  "mcpServers": {}\n}\n');
    expect(fs.readFileSync(linkPath, 'utf-8')).toBe('stands in for the link');
  });

  it('an owner change that isn\'t permitted, or a file system without modes, doesn\'t stop the write', () => {
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, 'old\n');
    reportModes(new Map([[key(file), 0o640]]));
    const temps = recordTempFiles();
    const refused: string[] = [];
    const refuse = (what: string) => (): never => {
      refused.push(what);
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    };
    vi.mocked(fs.fchownSync).mockImplementation(refuse('chown'));
    vi.mocked(fs.fchmodSync).mockImplementation(refuse('chmod'));

    atomicWriteFileSync(file, 'new\n');

    expect(refused).toEqual(['chown', 'chmod']);
    // Opened with the old mode, which the umask can only narrow.
    expect(temps.map((t) => t.steps)).toEqual([['open 640', 'write', 'close', 'rename']]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('new\n');
    expect(fs.readdirSync(dir)).toEqual(['config.toml']);
  });

  it('a file that doesn\'t exist yet is created with the default mode, as before', () => {
    const file = path.join(dir, 'new', 'AGENTS.md');
    const temps = recordTempFiles();

    atomicWriteFileSync(file, '# notes\n');

    expect(temps).toHaveLength(1);
    for (const step of temps.flatMap((t) => t.steps)) expect(step).toMatch(/^(open 666|write|close|rename)$/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('# notes\n');
  });

  // Windows' only mode is the read-only attribute, which refuses the rename.
  it.runIf(process.platform === 'win32')('Windows: a read-only file is refused as before, and no temp file is left', () => {
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, 'old\n');
    fs.chmodSync(file, 0o444);

    expect(() => atomicWriteFileSync(file, 'new\n')).toThrow(/EPERM/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('old\n');
    expect(fs.readdirSync(dir)).toEqual(['config.toml']);
  });

  describe.runIf(POSIX)('with real POSIX modes', () => {
    const modeOf = (p: string) => fs.statSync(p).mode & 0o7777;

    it.each(['600', '640', '444', '664'])('a %s file keeps its mode through a rewrite', (octal) => {
      const mode = parseInt(octal, 8);
      const file = path.join(dir, 'config.toml');
      fs.writeFileSync(file, 'old\n');
      fs.chmodSync(file, mode);

      atomicWriteFileSync(file, 'new\n');

      expect(modeOf(file)).toBe(mode);
      expect(fs.readFileSync(file, 'utf-8')).toBe('new\n');
    });

    it('the temp file already has the old mode before it is renamed over the file', () => {
      const file = path.join(dir, '.claude.json');
      fs.writeFileSync(file, '{}\n');
      fs.chmodSync(file, 0o600);
      const seen: number[] = [];
      const realRename = fs.renameSync;
      vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
        seen.push(fs.statSync(from).mode & 0o7777);
        return realRename(from, to);
      }) as typeof fs.renameSync);

      atomicWriteFileSync(file, '{\n  "mcpServers": {}\n}\n');

      expect(seen).toEqual([0o600]);
      expect(modeOf(file)).toBe(0o600);
    });

    it('through a real symbolic link, the linked file keeps its mode and the link stays', () => {
      const target = path.join(dir, 'dotfiles', 'config.toml');
      fs.mkdirSync(path.dirname(target));
      fs.writeFileSync(target, 'model = "o3"\n');
      fs.chmodSync(target, 0o600);
      const linkPath = path.join(dir, 'config.toml');
      fs.symlinkSync(target, linkPath);

      atomicWriteFileSync(linkPath, 'model = "o3"\n\n[mcp_servers.codegraph]\n');

      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(modeOf(target)).toBe(0o600);
      expect(fs.readFileSync(target, 'utf-8')).toContain('[mcp_servers.codegraph]');
    });

    it('a new file gets the same mode a plain write gives one', () => {
      const plain = path.join(dir, 'plain.md');
      fs.writeFileSync(plain, 'x');
      const file = path.join(dir, 'AGENTS.md');

      atomicWriteFileSync(file, '# notes\n');

      expect(modeOf(file)).toBe(modeOf(plain));
    });

    // A group this account belongs to that a new file here wouldn't get.
    const otherGroup = (() => {
      if (!POSIX || !process.getgroups) return undefined;
      const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-file-mode-group-'));
      try {
        fs.writeFileSync(path.join(probe, 'f'), '');
        const fresh = fs.statSync(path.join(probe, 'f')).gid;
        return process.getgroups().find((g) => g !== fresh);
      } finally {
        fs.rmSync(probe, { recursive: true, force: true });
      }
    })();
    it.runIf(otherGroup !== undefined)(`a file's group is kept when this account may set it${otherGroup === undefined ? ' — skipped: this account is in no second group' : ''}`, () => {
      const file = path.join(dir, 'config.toml');
      fs.writeFileSync(file, 'old\n');
      fs.chownSync(file, fs.statSync(file).uid, otherGroup!);
      fs.chmodSync(file, 0o640);

      atomicWriteFileSync(file, 'new\n');

      expect(fs.statSync(file).gid).toBe(otherGroup);
      expect(modeOf(file)).toBe(0o640);
    });
  });
});

/** A small file of the user's own, in the format of `file`, for an agent to add its entry to. */
function userContent(file: string): string {
  if (/\.jsonc?$/.test(file)) return '{\n  "userSetting": true\n}\n';
  if (file.endsWith('.toml')) return 'model = "o3"\n';
  if (/\.ya?ml$/.test(file)) return 'model: default\n';
  return '# my notes\n';
}

describe('Installer — every agent\'s install and uninstall keep the mode and owner of the files they rewrite', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'HERMES_HOME', 'COPILOT_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'];

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-file-mode-home-'));
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-file-mode-cwd-'));
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    for (const k of ENV) saved[k] = process.env[k];
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.env.APPDATA = path.join(tmpHome, '.config');
    process.env.LOCALAPPDATA = path.join(tmpHome, 'AppData', 'Local');
    process.env.XDG_CONFIG_HOME = path.join(tmpHome, '.config');
    for (const k of ['HERMES_HOME', 'COPILOT_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) delete process.env[k];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  for (const target of ALL_TARGETS) {
    for (const location of (['global', 'local'] as const).filter((l) => target.supportsLocation(l))) {
      it(`${target.id} (${location})`, () => {
        // Each of its files already holds the user's own settings, as a 0600 file of theirs.
        const files = target.describePaths(location);
        for (const f of files) {
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, userContent(f));
        }
        reportModes(new Map(files.map((f) => [key(f), 0o600])));
        const temps = recordTempFiles();

        target.install(location, { autoAllow: true });
        const installWrites = temps.length;
        target.uninstall(location);

        // Install rewrote at least one of them, and every rewrite was a
        // temp file given the old mode and owner, renamed over the file.
        expect(installWrites).toBeGreaterThan(0);
        for (const temp of temps) {
          expect(files.map(key), temp.path).toContain(key(temp.renamedOnto ?? temp.path));
          expect(temp.steps, temp.path).toEqual(KEPT);
        }
      });
    }
  }

  it('a refresh rewriting a stale entry keeps the mode and owner of ~/.claude.json and ~/.codex/config.toml', () => {
    const claude = ALL_TARGETS.find((t) => t.id === 'claude')!;
    const codex = ALL_TARGETS.find((t) => t.id === 'codex')!;
    claude.install('global', { autoAllow: true });
    codex.install('global', { autoAllow: true });
    const claudeJson = path.join(tmpHome, '.claude.json');
    const codexToml = path.join(tmpHome, '.codex', 'config.toml');
    // Entries as an older version left them, in files the user keeps private.
    const json = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    json.mcpServers.codegraph.args = ['serve'];
    fs.writeFileSync(claudeJson, JSON.stringify(json, null, 2) + '\n');
    fs.writeFileSync(codexToml, fs.readFileSync(codexToml, 'utf-8').replace(/^args = .*$/m, 'args = ["serve"]'));
    reportModes(new Map([[key(claudeJson), 0o600], [key(codexToml), 0o600]]));
    const temps = recordTempFiles();

    const reports = refreshTargets([claude, codex], 'global');

    expect(reports.flatMap((r) => r.changedPaths)).toEqual(expect.arrayContaining([claudeJson, codexToml]));
    for (const f of [claudeJson, codexToml]) {
      expect(temps.find((t) => t.renamedOnto !== undefined && key(t.renamedOnto) === key(f))?.steps, f).toEqual(KEPT);
    }
  });
});
