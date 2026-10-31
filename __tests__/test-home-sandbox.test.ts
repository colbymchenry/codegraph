/**
 * The suite's home-dir sandbox (`setup-home-sandbox.ts`, #2275) is in force:
 * nothing a test runs — in-process or spawned — resolves the developer's real
 * home, Claude profile, daemon registry or git identity.
 */
import { describe, it, expect, inject } from 'vitest';
import type { TestProject } from 'vitest/node';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeTarget } from '../src/installer/targets/claude';
import { getRegistryDir } from '../src/mcp/daemon-registry';
import setupHomeSandboxRun from './global-setup-home-sandbox';

const tmpRoot = fs.realpathSync(os.tmpdir());
const under = (p: string, dir: string): boolean => path.resolve(p).startsWith(dir + path.sep);
/** The sandbox home — asserted to be one, so the checks below can't pass on a real home. */
function sandboxHome(): string {
  const home = os.homedir();
  expect(under(home, tmpRoot), home).toBe(true);
  return home;
}

describe('test home sandbox', () => {
  it('os.homedir() is a throwaway dir under the temp root, not the real home', () => {
    const home = sandboxHome();
    expect(path.basename(home)).toMatch(/^codegraph-test-home-/);
    // The account's profile dir, which ignores HOME / USERPROFILE.
    expect(home).not.toBe(os.userInfo().homedir);
  });

  it('the global Claude profile and the daemon registry resolve inside it', () => {
    const home = sandboxHome();
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(under(claudeTarget.detect('global').configPath, home)).toBe(true);
    expect(under(getRegistryDir(), home)).toBe(true);
  });

  it('a spawned child sees the same home', () => {
    const childHome = execFileSync(process.execPath, ['-p', 'require("os").homedir()'], {
      encoding: 'utf-8',
      windowsHide: true,
    }).trim();
    expect(childHome).toBe(sandboxHome());
  });

  it("git's global config is the seeded sandbox file", () => {
    const gitConfig = process.env.GIT_CONFIG_GLOBAL ?? '';
    expect(under(gitConfig, sandboxHome())).toBe(true);
    const name = execFileSync('git', ['config', '--global', '--get', 'user.name'], {
      encoding: 'utf-8',
      windowsHide: true,
    }).trim();
    expect(name).toBe('CodeGraph Test');
  });

  // os.homedir() reads USERPROFILE there, and git falls back to
  // HOMEDRIVE+HOMEPATH — a HOME-only sandbox would not hold.
  it.runIf(process.platform === 'win32')('covers the Windows home variables', () => {
    const home = sandboxHome();
    expect(process.env.USERPROFILE).toBe(home);
    expect(`${process.env.HOMEDRIVE}${process.env.HOMEPATH}`).toBe(home);
    expect(under(process.env.APPDATA ?? '', home)).toBe(true);
    expect(under(process.env.LOCALAPPDATA ?? '', home)).toBe(true);
  });

  // A file whose every test is skipped runs no hooks, so its own afterAll never
  // removes its home: the end of the run removes every home still listed.
  it("records this file's home in the run's registry", () => {
    const home = sandboxHome();
    const entry = path.join(inject('homeSandboxRegistry'), path.basename(home));
    expect(fs.readFileSync(entry, 'utf8')).toBe(home);
  });

  it('the end of the run removes every home still listed, then the registry', () => {
    let registry = '';
    const teardown = setupHomeSandboxRun({
      provide(_key: string, value: string) { registry = value; },
    } as unknown as TestProject);
    const homes = ['skipped', 'held'].map((label) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-test-home-${label}-`));
      fs.writeFileSync(path.join(home, '.gitconfig'), '');
      fs.writeFileSync(path.join(registry, path.basename(home)), home);
      return home;
    });
    teardown();
    expect(homes.filter((home) => fs.existsSync(home))).toEqual([]);
    expect(fs.existsSync(registry)).toBe(false);
  });
});
