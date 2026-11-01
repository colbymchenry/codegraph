/**
 * grep marks questionable in-edges.
 *
 * A questionable edge is a `calls` edge resolution's candidate predicate
 * accepts (`candidateEdgeSql` / `isCandidateEdge` in
 * src/graph/suspects.ts): bound by name across files, fuzzy,
 * or an instance-method guess below 0.9. A same-file exact-match call is
 * certain. Without strict, a group's
 * inDegree still counts them and the group carries `questionableInDegree`
 * (present only when > 0), and the text header reads
 * `N in-edges (Q questionable)`. With strict (CLI `--strict`, MCP
 * `strict: true`), inDegree leaves them out, groups rank by that count, and
 * the result carries `strict: true`.
 *
 * Fixture: lib.ts `alpha` is called by three functions in callers.ts that
 * name it without importing it (resolvedBy 'exact-match' across files:
 * questionable) and by `sibling` in lib.ts itself (exact-match in the same
 * file: certain), and has no other in-edge: 4 in-edges, 3 questionable. `beta`
 * is called once from use.ts through an import (resolvedBy 'import': certain),
 * and that file's `import { beta }` adds an `imports` edge onto beta, which
 * grep's in-degree also counts: beta has 2 certain in-edges. alpha's 4 against
 * beta's 2 unstrict, and 1 against 2 strict, keep both rankings free of a tie. Both bodies hold MARKER, so one
 * pattern hits both groups. Indexed once in beforeAll and shared, read-only.
 *
 * Entry points use the built CLI and MCP through
 * ToolHandler.execute('codegraph_grep').
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { candidateEdgeSql, isCandidateEdge } from '../src/graph/suspects';

// node:sqlite through require, as wal-heal.test.ts does: vitest's import transform does not resolve it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const FILES: Record<string, string> = {
  'lib.ts': [
    'export function alpha(): string {',
    "  return 'MARKER alpha';",
    '}',
    '',
    'export function beta(): string {',
    "  return 'MARKER beta';",
    '}',
    '',
    'export function sibling(): string {',
    '  return alpha();',
    '}',
    '',
  ].join('\n'),
  // No import of alpha: each call is bound by name across files.
  'callers.ts': [
    'export function firstCaller(): string {',
    '  return alpha();',
    '}',
    '',
    'export function secondCaller(): string {',
    '  return alpha();',
    '}',
    '',
    'export function thirdCaller(): string {',
    '  return alpha();',
    '}',
    '',
  ].join('\n'),
  'use.ts': [
    "import { beta } from './lib';",
    '',
    'export function useBeta(): string {',
    '  return beta();',
    '}',
    '',
  ].join('\n'),
};

let root: string;
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-questionable-grep-')));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ---------------------------------------------------------------------------
// The predicate's pin.
// ---------------------------------------------------------------------------

/**
 * [kind, metadata, source node id, target node id, questionable?]. NODES gives
 * the ids' files: s and t share one.ts, x is two.ts, and z is in no row (its
 * file reads as null, so the pair is not same-file).
 */
const NODES: Array<[string, string]> = [['s', 'one.ts'], ['t', 'one.ts'], ['x', 'two.ts']];
const fileOf = (id: string): string | null => NODES.find(([n]) => n === id)?.[1] ?? null;
const VECTORS: Array<[string, Record<string, unknown> | null, string, string, boolean]> = [
  ['calls', { resolvedBy: 'exact-match', confidence: 0.9 }, 's', 'x', true],
  ['calls', { resolvedBy: 'exact-match', confidence: 0.9 }, 's', 't', false],
  ['calls', { resolvedBy: 'exact-match' }, 'z', 't', true],
  ['calls', { resolvedBy: 'fuzzy' }, 's', 't', true],
  ['calls', { resolvedBy: 'instance-method', confidence: 0.85 }, 's', 'x', true],
  ['calls', { resolvedBy: 'instance-method' }, 's', 'x', false],
  ['calls', { resolvedBy: 'import' }, 's', 'x', false],
  ['calls', { resolvedBy: 'instance-method', confidence: 0.9 }, 's', 'x', false],
  // Non-numeric confidence follows json_extract: a JSON boolean is 1/0, anything else (null, a string) counts as 1.
  ['calls', { resolvedBy: 'instance-method', confidence: false }, 's', 'x', true],
  ['calls', { resolvedBy: 'instance-method', confidence: true }, 's', 'x', false],
  ['calls', { resolvedBy: 'instance-method', confidence: '0.5' }, 's', 'x', false],
  ['calls', { resolvedBy: 'instance-method', confidence: null }, 's', 'x', false],
  ['references', { resolvedBy: 'exact-match' }, 's', 'x', false],
  ['calls', null, 's', 'x', false],
];

describe('isCandidateEdge and candidateEdgeSql', () => {
  for (const [kind, metadata, source, target, want] of VECTORS) {
    it(`isCandidateEdge(${kind}, ${JSON.stringify(metadata)}, ${source}->${target}) is ${want}`, () => {
      expect(isCandidateEdge(kind, metadata, fileOf(source), fileOf(target))).toBe(want);
    });
  }

  it('candidateEdgeSql agrees with isCandidateEdge on every vector (in-memory node:sqlite)', () => {
    const db = new DatabaseSync(':memory:');
    try {
      // candidateEdgeSql reads each end's file through subselects on nodes(id, file_path).
      db.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY, file_path TEXT)');
      const insert = db.prepare('INSERT INTO nodes (id, file_path) VALUES (?, ?)');
      for (const [id, file] of NODES) insert.run(id, file);
      const stmt = db.prepare(
        `SELECT ${candidateEdgeSql('e')} AS q FROM (SELECT ? AS source, ? AS target, ? AS kind, ? AS metadata) e`,
      );
      for (const [kind, metadata, source, target, want] of VECTORS) {
        const row = stmt.get(source, target, kind, metadata === null ? null : JSON.stringify(metadata)) as { q: number | bigint | null };
        const label = `${kind} ${JSON.stringify(metadata)} ${source}->${target}`;
        expect(Number(row.q ?? 0) !== 0, label).toBe(want);
        expect(isCandidateEdge(kind, metadata, fileOf(source), fileOf(target)), label).toBe(want);
      }
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture premise.
// ---------------------------------------------------------------------------

describe('fixture premise', () => {
  it('alpha has three cross-file exact-match (questionable) call edges and one same-file exact-match (certain) call; beta one import-resolved call and one imports edge, neither questionable', () => {
    const db = new DatabaseSync(path.join(root, '.codegraph', 'codegraph.db'), { readOnly: true });
    try {
      const rows = db.prepare(
        `SELECT t.name AS target, s.name AS source, e.kind AS kind, e.metadata AS metadata,
                s.file_path AS sf, t.file_path AS tf
           FROM edges e JOIN nodes t ON t.id = e.target JOIN nodes s ON s.id = e.source
          WHERE e.kind IN ('calls', 'references', 'imports', 'implements', 'extends') AND t.name IN ('alpha', 'beta')
          ORDER BY t.name, e.kind, s.name`,
      ).all() as Array<{ target: string; source: string; kind: string; metadata: string | null; sf: string; tf: string }>;
      const seen = rows.map(r => {
        const meta = r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null;
        return { target: r.target, kind: r.kind, source: r.source, resolvedBy: meta?.resolvedBy, questionable: isCandidateEdge(r.kind, meta, r.sf, r.tf) };
      });
      // The imports edge's source is use.ts's file node; its metadata is not pinned, only that it is not questionable.
      const beta = seen.filter(e => e.target === 'beta');
      expect(seen.filter(e => e.target === 'alpha')).toEqual([
        { target: 'alpha', kind: 'calls', source: 'firstCaller', resolvedBy: 'exact-match', questionable: true },
        { target: 'alpha', kind: 'calls', source: 'secondCaller', resolvedBy: 'exact-match', questionable: true },
        { target: 'alpha', kind: 'calls', source: 'sibling', resolvedBy: 'exact-match', questionable: false },
        { target: 'alpha', kind: 'calls', source: 'thirdCaller', resolvedBy: 'exact-match', questionable: true },
      ]);
      expect(beta).toHaveLength(2);
      expect(beta[0]).toEqual({ target: 'beta', kind: 'calls', source: 'useBeta', resolvedBy: 'import', questionable: false });
      expect(beta[1]).toMatchObject({ target: 'beta', kind: 'imports', questionable: false });
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The gate: CLI and MCP.
// ---------------------------------------------------------------------------

interface Group { symbol: { name: string } | null; inDegree: number; questionableInDegree?: number }
interface Result { groups: Group[]; strict?: boolean }

function groupNamed(r: Result, name: string): Group {
  const g = r.groups.find(x => x.symbol?.name === name);
  expect(g, `group ${name}`).toBeDefined();
  return g!;
}
function rankOf(r: Result, name: string): number {
  return r.groups.findIndex(x => x.symbol?.name === name);
}
function headerLine(text: string, name: string): string {
  const line = text.split(/\r?\n/).find(l => l.startsWith(`${name} · `));
  expect(line, `header for ${name} in:\n${text}`).toBeDefined();
  return line!;
}

describe('grep questionable marks', () => {
  beforeEach(() => {
    vi.stubEnv('CODEGRAPH_MCP_TOOLS', 'explore,grep');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });
  // Real CLI launches may exceed five seconds under heavy machine load.
  async function runCommand(argv: string[]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grep-marks-home-'));
    try {
      const env = { ...process.env, HOME: home, USERPROFILE: home, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', CODEGRAPH_ALLOW_UNSAFE_NODE: '1', DO_NOT_TRACK: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
      const out = spawnSync(process.execPath, [path.resolve(__dirname, '../dist/bin/codegraph.js'), ...argv], { env, encoding: 'utf8', timeout: 20000 });
      expect(out.error).toBeUndefined();
      return { stdout: out.stdout, stderr: out.stderr, exitCode: out.status };
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }


  async function cliJson(extra: string[]): Promise<Result> {
    const out = await runCommand(['grep', '--json', ...extra, '-p', root, 'MARKER']);
    expect(out.stderr).toBe('');
    expect(out.exitCode).toBe(0);
    return JSON.parse(out.stdout) as Result;
  }
  async function mcpText(args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
    const res = await new ToolHandler(cg).execute('codegraph_grep', { pattern: 'MARKER', projectPath: root, ...args });
    return { text: res.content[0]!.text, isError: res.isError };
  }
  async function mcpJson(args: Record<string, unknown>): Promise<Result> {
    const res = await mcpText({ json: true, ...args });
    expect(res.isError).toBeFalsy();
    return JSON.parse(res.text) as Result;
  }

  function expectMarkedJson(r: Result): void {
    const alpha = groupNamed(r, 'alpha');
    const beta = groupNamed(r, 'beta');
    expect(alpha.inDegree).toBe(4);
    expect(alpha.questionableInDegree).toBe(3);
    expect(beta.inDegree).toBe(2);
    expect('questionableInDegree' in beta).toBe(false);
    expect(rankOf(r, 'alpha')).toBeLessThan(rankOf(r, 'beta'));
    expect('strict' in r).toBe(false);
  }
  function expectMarkedText(text: string): void {
    expect(headerLine(text, 'alpha')).toContain('· 4 in-edges (3 questionable)');
    const beta = headerLine(text, 'beta');
    expect(beta).toContain('· 2 in-edges');
    expect(beta).not.toContain('questionable');
  }
  function expectStrictJson(r: Result): void {
    const alpha = groupNamed(r, 'alpha');
    const beta = groupNamed(r, 'beta');
    expect(alpha.inDegree).toBe(1); // the same-file sibling call is certain and stays
    expect('questionableInDegree' in alpha).toBe(false);
    expect(beta.inDegree).toBe(2);
    expect('questionableInDegree' in beta).toBe(false);
    expect(rankOf(r, 'beta')).toBeLessThan(rankOf(r, 'alpha'));
    expect(r.strict).toBe(true);
  }

  it('CLI --json without --strict: alpha inDegree 4 with questionableInDegree 3, beta 2 unmarked, alpha first, no strict key', async () => {
    expectMarkedJson(await cliJson([]));
  });

  it('MCP json without strict: alpha inDegree 4 with questionableInDegree 3, beta 2 unmarked, alpha first, no strict key', async () => {
    expectMarkedJson(await mcpJson({}));
  });

  it('CLI text without --strict: alpha header reads "4 in-edges (3 questionable)", beta "2 in-edges" unmarked', async () => {
    const out = await runCommand(['grep', '-p', root, 'MARKER']);
    expect(out.exitCode).toBe(0);
    expectMarkedText(out.stdout);
  });

  it('MCP text without strict: alpha header reads "4 in-edges (3 questionable)", beta "2 in-edges" unmarked', async () => {
    const res = await mcpText({});
    expect(res.isError).toBeFalsy();
    expectMarkedText(res.text);
  });

  it('CLI --json --strict: alpha inDegree 1 (the same-file call) unmarked, beta 2, beta first, strict: true', async () => {
    expectStrictJson(await cliJson(['--strict']));
  });

  it('MCP json strict: true: alpha inDegree 1 (the same-file call) unmarked, beta 2, beta first, strict: true', async () => {
    expectStrictJson(await mcpJson({ strict: true }));
  });

  it('MCP strict: null behaves as no strict (marked, unstrict ranking), not isError', async () => {
    expectMarkedJson(await mcpJson({ strict: null }));
  });

  it('MCP strict: "yes" (not a boolean) answers success-shaped guidance, not isError', async () => {
    const res = await mcpText({ strict: 'yes' });
    expect(res.isError).toBeFalsy();
    expect(res.text).toMatch(/strict/);
  });
});
