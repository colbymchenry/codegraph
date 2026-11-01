/**
 * `codegraph blast` and `codegraph_blast` as a user reaches them: the opt-in
 * MCP tool through `ToolHandler`, and the command through the built CLI.
 *
 * Fixture: src/util.ts holds `helper`, which `useA` in src/a.ts calls through
 * an import, and `target`, which `loose` in src/loose.ts calls by name without
 * importing it (a questionable call). C1 is tagged; C2 edits the bodies of
 * `helper` and `target`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../src';
import { getStaticTools, ToolHandler, tools } from '../src/mcp/tools';

const ENV = 'CODEGRAPH_MCP_TOOLS';
const FIRST_LINE = 'blast radius — C1...HEAD (depth 2)';

/** Run git in `root` with a local identity; throws on failure so a broken fixture is loud. */
function git(root: string, ...args: string[]): string {
  const res = spawnSync(
    'git',
    ['-c', 'user.name=blast-test', '-c', 'user.email=blast-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const UTIL = 'export function helper(): number {\n  return 1;\n}\n\nexport function target(): number {\n  return 2;\n}\n';
const A = "import { helper } from './util';\n\nexport function useA(): number {\n  return helper();\n}\n";
const LOOSE = 'export function loose(): number {\n  return target();\n}\n';

let repo = '';

beforeAll(async () => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-surfaces-')));
  git(repo, 'init', '-q');
  write(repo, 'src/util.ts', UTIL);
  write(repo, 'src/a.ts', A);
  write(repo, 'src/loose.ts', LOOSE);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'C1');
  git(repo, 'tag', 'C1');
  write(repo, 'src/util.ts', UTIL.replace('return 1;', 'return 42;').replace('return 2;', 'return 43;'));
  git(repo, 'commit', '-q', '-am', 'C2: helper and target bodies');
  const cg = await CodeGraph.init(repo);
  await cg.indexAll();
  cg.close();
});

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe('codegraph_blast (MCP)', () => {
  let saved: string | undefined;
  let cg: CodeGraph | null = null;

  beforeEach(() => {
    saved = process.env[ENV];
    process.env[ENV] = 'explore,blast';
  });

  afterEach(() => {
    cg?.close();
    cg = null;
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  async function call(args: Record<string, unknown>): Promise<string> {
    cg = await CodeGraph.open(repo);
    const res = await new ToolHandler(cg).execute('codegraph_blast', args);
    expect(res.isError).toBeFalsy();
    return res.content[0].text;
  }

  it('is a read-only tool listed only when the allowlist names it', () => {
    const tool = tools.find((t) => t.name === 'codegraph_blast');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(['base', 'depth', 'format', 'projectPath', 'strict']);
    expect(getStaticTools().map((t) => t.name)).toContain('codegraph_blast');
    delete process.env[ENV];
    expect(getStaticTools().map((t) => t.name)).toEqual(['codegraph_explore']);
  });

  it('reports the dependents of the lines changed since the base', async () => {
    const text = await call({ projectPath: repo, base: 'C1' });
    expect(text.split('\n')[0]).toBe(FIRST_LINE);
    expect(text).toContain('← useA (src/a.ts:');
  });

  it('resolves a projectPath inside the project to the project root', async () => {
    expect((await call({ projectPath: path.join(repo, 'src'), base: 'C1' })).split('\n')[0]).toBe(FIRST_LINE);
  });

  it('treats null optional arguments as absent', async () => {
    const text = await call({ projectPath: repo, base: null, depth: null, format: null, strict: null });
    // No base and a clean tree: the last commit, C2, at the default depth and format.
    expect(text.split('\n')[0]).toBe('blast radius — HEAD~1...HEAD (depth 2)');
    expect(text).not.toContain(' must be ');
  });

  it('takes depth as a number or a string', async () => {
    expect((await call({ projectPath: repo, base: 'C1', depth: 1 })).split('\n')[0]).toBe('blast radius — C1...HEAD (depth 1)');
    expect((await call({ projectPath: repo, base: 'C1', depth: 'all' })).split('\n')[0]).toBe('blast radius — C1...HEAD (full closure)');
  });

  it.each([
    [{ base: 'nope' }, 'base ref "nope" is not in this checkout'],
    [{ base: 7 }, 'base must be a git ref'],
    [{ depth: 0 }, 'depth must be a positive number'],
    [{ depth: true }, 'depth must be a positive number'],
    [{ format: 'yaml' }, 'format must be text, markdown or json'],
    [{ strict: 'yes' }, 'strict must be true or false'],
  ])('answers %j with success-shaped guidance, not isError', async (args, expected) => {
    expect(await call({ projectPath: repo, ...args })).toContain(expected);
  });
});

/** One fast child: no daemon and no wasm-flag re-exec, in a throwaway home. */
function cli(home: string, args: string[], cwd?: string) {
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home,
    CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', CODEGRAPH_ALLOW_UNSAFE_NODE: '1',
    DO_NOT_TRACK: '1', NO_COLOR: '1', FORCE_COLOR: '0',
  };
  return spawnSync(process.execPath, [path.resolve(__dirname, '../dist/bin/codegraph.js'), ...args], {
    env, cwd, encoding: 'utf8', timeout: 30_000,
  });
}

describe('codegraph blast (built CLI)', () => {
  let home = '';
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-cli-home-'));
  });
  afterAll(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  it('--help lists blast', () => {
    const res = cli(home, ['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^\s+blast\b/m);
  });

  it('prints the text report and exits 0', () => {
    const res = cli(home, ['blast', '--base', 'C1', '-p', repo]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.split('\n')[0]).toBe(FIRST_LINE);
    expect(res.stdout).toContain('← useA (src/a.ts:');
  });

  it('--format json marks the questionable dependent, and --strict leaves it out', () => {
    const plain = cli(home, ['blast', '--base', 'C1', '--format', 'json', '-p', repo]);
    expect(plain.status, plain.stderr).toBe(0);
    const report = JSON.parse(plain.stdout) as { depth: number; basis: string; strict?: true; impacted: { name: string; questionable?: true }[] };
    expect(report.basis).toBe('C1...HEAD');
    expect(report.depth).toBe(2);
    expect(report.impacted.find((s) => s.name === 'loose')?.questionable).toBe(true);
    expect(report.impacted.find((s) => s.name === 'useA')?.questionable).toBeUndefined();
    const strict = cli(home, ['blast', '--base', 'C1', '--format', 'json', '--strict', '-p', repo]);
    expect(strict.status, strict.stderr).toBe(0);
    const strictReport = JSON.parse(strict.stdout) as typeof report;
    expect(strictReport.strict).toBe(true);
    expect(strictReport.impacted.map((s) => s.name)).toContain('useA');
    expect(strictReport.impacted.map((s) => s.name)).not.toContain('loose');
  });

  it('an unknown base exits 1 with the message on stderr and nothing on stdout', () => {
    const res = cli(home, ['blast', '--base', 'nope', '-p', repo]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('base ref "nope" is not in this checkout');
    expect(res.stdout).toBe('');
  });

  it('with no -p uses the working directory, and a subdirectory resolves to its project', () => {
    const inSub = cli(home, ['blast', '--base', 'C1'], path.join(repo, 'src'));
    expect(inSub.status, inSub.stderr).toBe(0);
    expect(inSub.stdout.split('\n')[0]).toBe(FIRST_LINE);
  });
});
