/**
 * `codegraph orphans` and `codegraph_orphans` as a user reaches them: the
 * opt-in MCP tool through `ToolHandler`, and the command through the built CLI.
 *
 * Fixture: C1 (tagged) holds `helper`, which `useA` calls; C2 adds
 * `lonelyNew`, which nothing uses.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { CodeGraph } from '../src';
import { getStaticTools, ToolHandler, tools } from '../src/mcp/tools';

const ENV = 'CODEGRAPH_MCP_TOOLS';

/** Run git in `root` with a local identity; throws on failure so a broken fixture is loud. */
function git(root: string, ...args: string[]): string {
  const res = spawnSync(
    'git',
    ['-c', 'user.name=orphans-test', '-c', 'user.email=orphans-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
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

const UTIL = 'export function helper(): number {\n  return 1;\n}\n';
const A = "import { helper } from './util';\n\nexport function useA(): number {\n  return helper();\n}\n";

let repo = '';
let firstLine = '';

beforeAll(async () => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphans-surfaces-')));
  git(repo, 'init', '-q');
  write(repo, 'src/util.ts', UTIL);
  write(repo, 'src/a.ts', A);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'C1');
  git(repo, 'tag', 'C1');
  firstLine = `orphans — C1...HEAD (merge base ${git(repo, 'rev-parse', '--short=7', 'C1').trim()})`;
  write(repo, 'src/util.ts', `${UTIL}\nexport function lonelyNew(): number {\n  return 5;\n}\n`);
  git(repo, 'commit', '-q', '-am', 'C2: add lonelyNew');
  const cg = await CodeGraph.init(repo);
  await cg.indexAll();
  cg.close();
});

afterAll(() => {
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
});

describe('codegraph_orphans (MCP)', () => {
  let saved: string | undefined;
  let cg: CodeGraph | null = null;

  beforeEach(() => {
    saved = process.env[ENV];
    process.env[ENV] = 'explore,orphans';
  });

  afterEach(() => {
    cg?.close();
    cg = null;
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  async function call(args: Record<string, unknown>): Promise<string> {
    cg = await CodeGraph.open(repo);
    const res = await new ToolHandler(cg).execute('codegraph_orphans', args);
    expect(res.isError).toBeFalsy();
    return res.content[0].text;
  }

  it('is a read-only tool listed only when the allowlist names it', () => {
    const tool = tools.find((t) => t.name === 'codegraph_orphans');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(['base', 'format', 'projectPath']);
    expect(getStaticTools().map((t) => t.name)).toContain('codegraph_orphans');
    delete process.env[ENV];
    expect(getStaticTools().map((t) => t.name)).toEqual(['codegraph_explore']);
  });

  it('reports the symbols added since the base that nothing uses', async () => {
    const text = await call({ projectPath: repo, base: 'C1' });
    expect(text.split('\n')[0]).toBe(firstLine);
    expect(text).toContain('lonelyNew');
    expect(text).not.toContain('helper');
  });

  it('format json lists lonelyNew as the one orphan', async () => {
    const report = JSON.parse(await call({ projectPath: repo, base: 'C1', format: 'json' })) as {
      basis: string; added: number; orphans: { name: string }[];
    };
    expect(report.basis).toBe('C1...HEAD');
    expect(report.added).toBe(1);
    expect(report.orphans.map((o) => o.name)).toEqual(['lonelyNew']);
  });

  it.each([
    [{}, 'a base ref is required'],
    [{ base: null }, 'a base ref is required'],
    [{ base: 7 }, 'base must be a git ref'],
    [{ base: 'nope' }, 'base ref "nope" is not in this checkout'],
    [{ base: 'C1', format: 'yaml' }, 'format must be text or json'],
    [{ base: 'C1', format: 3 }, 'format must be text or json'],
  ])('answers %j with success-shaped guidance, not isError', async (args, expected) => {
    expect(await call({ projectPath: repo, ...args })).toContain(expected);
  });
});

/** One fast child: no daemon and no wasm-flag re-exec, in a throwaway home. */
function cli(home: string, args: string[]) {
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home,
    CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', CODEGRAPH_ALLOW_UNSAFE_NODE: '1',
    DO_NOT_TRACK: '1', NO_COLOR: '1', FORCE_COLOR: '0',
  };
  return spawnSync(process.execPath, [path.resolve(__dirname, '../dist/bin/codegraph.js'), ...args], {
    env, encoding: 'utf8', timeout: 30_000,
  });
}

describe('codegraph orphans (built CLI)', () => {
  let home = '';
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphans-cli-home-'));
  });
  afterAll(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  it('--help lists orphans', () => {
    const res = cli(home, ['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^\s+orphans\b/m);
  });

  it('prints the text report and exits 0', () => {
    const res = cli(home, ['orphans', '--base', 'C1', '-p', repo]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.split('\n')[0]).toBe(firstLine);
    expect(res.stdout).toContain('lonelyNew');
  });

  it('--json prints the JSON report', () => {
    const res = cli(home, ['orphans', '--base', 'C1', '--json', '-p', repo]);
    expect(res.status, res.stderr).toBe(0);
    expect((JSON.parse(res.stdout) as { orphans: { name: string }[] }).orphans.map((o) => o.name)).toEqual(['lonelyNew']);
  });

  it('without --base exits 1 with the message on stderr and nothing on stdout', () => {
    const res = cli(home, ['orphans', '-p', repo]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('a base ref is required');
    expect(res.stdout).toBe('');
  });

  it('an unknown base exits 1 with the message on stderr', () => {
    const res = cli(home, ['orphans', '--base', 'nope', '-p', repo]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('base ref "nope" is not in this checkout');
    expect(res.stdout).toBe('');
  });
});
