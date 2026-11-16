/**
 * `codegraph targets add|list|remove`, and a target registered that way
 * reaching `codegraph install` and `codegraph uninstall`, against the built
 * binary. Every run points HOME and the targets file at a throwaway dir, so
 * nothing on the machine running the suite is touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const PREUNINSTALL = path.resolve(__dirname, '../dist/bin/uninstall.js');

interface RunResult {
  status: number;
  out: string;
}

const SPEC = {
  id: 'zcode',
  displayName: 'ZCode',
  family: 'mcp-json',
  configDir: '~/.zcode/cli',
  configFileName: 'config.json',
  localConfigDir: '.zcode',
  serversKey: 'mcp.servers',
  instructionsFile: null,
};

describe('codegraph targets', () => {
  let home: string;
  let cwd: string;
  const targetsFile = () => path.join(home, 'targets.json');

  /** Run the CLI with stdin closed, so a prompt would fail instead of hang. */
  function run(args: string[], script = BIN): RunResult {
    try {
      const stdout = execFileSync(process.execPath, [script, ...args], {
        cwd,
        encoding: 'utf-8',
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CODEGRAPH_TARGETS_FILE: targetsFile(),
          CODEGRAPH_NO_DAEMON: '1',
          CODEGRAPH_TELEMETRY: '0',
          DO_NOT_TRACK: '1',
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
      return { status: 0, out: stdout };
    } catch (err) {
      const e = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
      return { status: e.status ?? -1, out: `${String(e.stdout ?? '')}${String(e.stderr ?? '')}` };
    }
  }

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-targets-home-')));
    cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-targets-cwd-')));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('list says when nothing is registered, and names the file', () => {
    const r = run(['targets', 'list']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('No user defined targets are registered');
    expect(r.out).toContain(targetsFile());
    expect(r.out).toContain('codegraph targets add <spec.json>');
  });

  it('add from a file, then from inline JSON, then list, then remove', () => {
    const specFile = path.join(cwd, 'zcode.json');
    fs.writeFileSync(specFile, JSON.stringify(SPEC));

    const added = run(['targets', 'add', specFile]);
    expect(added.status, added.out).toBe(0);
    expect(added.out).toContain('Added target "zcode"');
    expect(added.out).toContain('codegraph install --target zcode');
    expect(JSON.parse(fs.readFileSync(targetsFile(), 'utf-8'))).toEqual({ targets: [SPEC] });

    const updated = run(['targets', 'add', JSON.stringify({ ...SPEC, displayName: 'ZCode by Z.ai' })]);
    expect(updated.status, updated.out).toBe(0);
    expect(updated.out).toContain('Updated target "zcode"');

    const listed = run(['targets', 'list']);
    expect(listed.status, listed.out).toBe(0);
    expect(listed.out).toContain('zcode: ZCode by Z.ai (mcp-json family)');
    expect(listed.out).toContain(`global: ${path.join(home, '.zcode', 'cli', 'config.json')}`);
    expect(listed.out).toContain(`local: ${path.join(cwd, '.zcode', 'config.json')}`);

    const removed = run(['targets', 'remove', 'zcode']);
    expect(removed.status, removed.out).toBe(0);
    expect(removed.out).toContain('Removed target "zcode"');
    expect(JSON.parse(fs.readFileSync(targetsFile(), 'utf-8'))).toEqual({ targets: [] });

    const again = run(['targets', 'remove', 'zcode']);
    expect(again.status, again.out).toBe(0);
    expect(again.out).toContain('No target "zcode" is registered');
  });

  it('add refuses a bad spec, bad JSON and a missing file, and writes nothing', () => {
    const bad = run(['targets', 'add', JSON.stringify({ ...SPEC, id: 'Bad Id', configDir: 'relative' })]);
    expect(bad.status).toBe(1);
    expect(bad.out).toContain('Invalid custom target spec');
    expect(bad.out).toContain('"id" must be');
    expect(bad.out).toContain('"configDir" must be');

    const notJson = run(['targets', 'add', '{ half']);
    expect(notJson.status).toBe(1);
    expect(notJson.out).toContain('not valid JSON');

    const missing = run(['targets', 'add', path.join(cwd, 'nope.json')]);
    expect(missing.status).toBe(1);
    expect(missing.out).toContain('Spec file not found');

    expect(fs.existsSync(targetsFile())).toBe(false);
  });

  it('a registered target reaches install --print-config, install and uninstall', () => {
    expect(run(['targets', 'add', JSON.stringify(SPEC)]).status).toBe(0);
    const file = path.join(home, '.zcode', 'cli', 'config.json');

    const printed = run(['install', '--print-config', 'zcode']);
    expect(printed.status, printed.out).toBe(0);
    expect(printed.out).toContain(`# Add to ${file}`);
    expect(printed.out).toContain('"mcp": {');
    expect(printed.out).toContain('"servers": {');

    const installed = run(['install', '--yes', '--target', 'zcode']);
    expect(installed.status, installed.out).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
      mcp: { servers: { codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] } } },
    });

    const removed = run(['uninstall', '--yes', '--target', 'zcode', '--keep-cli']);
    expect(removed.status, removed.out).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('the npm preuninstall cleanup takes out a registered target\'s global entry', () => {
    expect(run(['targets', 'add', JSON.stringify(SPEC)]).status).toBe(0);
    const file = path.join(home, '.zcode', 'cli', 'config.json');
    expect(run(['install', '--yes', '--target', 'zcode']).status).toBe(0);
    expect(fs.existsSync(file)).toBe(true);

    const cleaned = run([], PREUNINSTALL);
    expect(cleaned.status, cleaned.out).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('an unknown id in --print-config lists the registered targets with the builtin ones', () => {
    expect(run(['targets', 'add', JSON.stringify(SPEC)]).status).toBe(0);
    const r = run(['install', '--print-config', 'nope']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/Known: .*claude.*zcode/);
  });
});
