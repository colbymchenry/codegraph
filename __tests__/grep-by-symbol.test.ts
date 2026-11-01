/**
 * grep-by-symbol: an rg search over the files the index has, with every hit
 * attributed to its innermost enclosing symbol and the groups ranked by
 * in-degree, using a real SQLite index.
 *
 * One fixture repo is indexed once in beforeAll. Its line numbers, spans and
 * edges were checked against the real indexer: Worker::run is L5-L7, helper is
 * called by callerOne and callerTwo, farAway by longOne (each an exact-match
 * call from the target's own file, so certain, not questionable), and
 * notes.txt is not indexed. Paths sort as src/a/... < src/ab/... < src/B.ts
 * under localeCompare (code-unit order would put src/B.ts first), so the cap
 * and ranking vectors also pin the localeCompare rule.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { ToolHandler, tools, __setLoadCodeGraphForTests } from '../src/mcp/tools';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import {
  grepIndex,
  GrepPatternError,
  GrepScopeError,
  GrepIndexError,
  batchPaths,
  CappedHits,
  isCanonicalIndexedPath,
  type RawHit,
} from '../src/search/grep';
import { formatGrepResult, formatGrepHeader, zeroHitNote } from '../src/search/grep-format';

const GREP_TOOL = tools.find(t => t.name === 'codegraph_grep')!;

// Use real MCP dispatch and commander; every child has private global state.
async function handleGrepTool(args: Record<string, unknown>, defaultRoot?: string) {
  const saved = process.env.CODEGRAPH_MCP_TOOLS;
  process.env.CODEGRAPH_MCP_TOOLS = 'explore,grep';
  const handler = new ToolHandler(null);
  try { return await handler.execute('codegraph_grep', { projectPath: defaultRoot, ...args }); }
  finally {
    await handler.closeAll();
    if (saved === undefined) delete process.env.CODEGRAPH_MCP_TOOLS;
    else process.env.CODEGRAPH_MCP_TOOLS = saved;
  }
}

// Multiple CLI child launches can exceed five seconds on a loaded machine.
async function runGrepCommand(argv: string[], cwd: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grep-cli-home-'));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', CODEGRAPH_ALLOW_UNSAFE_NODE: '1', DO_NOT_TRACK: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
    const out = spawnSync(process.execPath, [path.resolve(__dirname, '../dist/bin/codegraph.js'), 'grep', ...argv], { cwd, env, encoding: 'utf8', timeout: 20000 });
    expect(out.error).toBeUndefined();
    return { stdout: out.stdout, stderr: out.stderr, exitCode: out.status };
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

const LONG_LINE = '    const s = "LONGWORD ' + 'x'.repeat(200) + '";';

const FILES: Record<string, string> = {
  'src/a/service.ts': [
    '// service module: TOKEN at module level', // L1 module level
    'export const banner = 1;',
    '',
    'export class Worker {', // L4
    '  run(): string {', // L5
    '    return "TOKEN in run";', // L6
    '  }', // L7
    '}', // L8
    '',
    'export function helper(): string {', // L10
    '  return "TOKEN helper";', // L11
    '}', // L12
    '',
    'export function callerOne(): string {',
    '  return helper();',
    '}',
    '',
    'export function callerTwo(): string {',
    '  return helper();',
    '}',
    '',
    'export function lonely(): string {', // L22
    '  return "TOKEN lonely";', // L23
    '}', // L24
    '',
  ].join('\n'),
  'src/a/meta.ts': ['// call remap(verb: x) and arrow --> here', 'export const META = 1;', ''].join('\n'),
  'src/a/case.ts': [
    'export function cased(): string[] {',
    '  return [',
    '    "MixedCase",',
    '    "mixedcase",',
    '    "MIXEDCASE",',
    '  ];',
    '}',
    '',
  ].join('\n'),
  'src/ab/other.ts': [
    'export function farAway(): string {', // L1
    '  return "TOKEN far";', // L2
    '}', // L3
    '',
    'export function longOne(): string {', // L5
    LONG_LINE, // L6
    '  return s + farAway();',
    '}', // L8
    '',
    'export function zeroAb(): string {', // L10
    '  return "TOKEN zero";', // L11
    '}', // L12
    '',
  ].join('\n'),
  'src/B.ts': ['export function bee(): string {', '  return "TOKEN bee";', '}', ''].join('\n'),
  // Not a source file: the index does not have it, so it must never be searched.
  'notes.txt': 'TOKEN in notes remap(verb: x) --> mixedcase\n',
};

const INDEXED_COUNT = 5;

let root = '';
let unindexedRoot = '';

beforeAll(async () => {
  __setLoadCodeGraphForTests(CodeGraph);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grep-by-symbol-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const cg = await CodeGraph.init(root, { index: true });
  cg.close();
  unindexedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grep-by-symbol-none-'));
});

afterAll(() => {
  __setLoadCodeGraphForTests(null);
  for (const r of [root, unindexedRoot]) if (r) fs.rmSync(r, { recursive: true, force: true });
});

/** Group headers in output order, as `name|kind|path|span|inDegree` (or `module|path|inDegree`). */
const groupKeys = (r: Awaited<ReturnType<typeof grepIndex>>): string[] =>
  r.groups.map((g) =>
    g.symbol
      ? `${g.symbol.name}|${g.symbol.kind}|${g.symbol.path}|${g.symbol.span}|${g.inDegree}`
      : `module|${g.path}|${g.inDegree}`,
  );

describe('grepIndex: scope', () => {
  it('searches only indexed files; a file on disk the index lacks never hits', async () => {
    const r = await grepIndex(root, 'TOKEN');
    expect(r.filesSearched).toBe(INDEXED_COUNT);
    expect(r.groups.map((g) => g.path)).not.toContain('notes.txt');
    expect(r.totalHits).toBe(7);

    const fixed = await grepIndex(root, 'remap(verb:', { fixed: true });
    expect(fixed.totalHits).toBe(1);
    expect(fixed.groups.map((g) => g.path)).toEqual(['src/a/meta.ts']);
  });

  it('--in is segment-aware: src/a does not reach src/ab', async () => {
    const r = await grepIndex(root, 'TOKEN', { in: 'src/a' });
    expect(r.filesSearched).toBe(3);
    expect(r.totalHits).toBe(4);
    expect([...new Set(r.groups.map((g) => g.path))]).toEqual(['src/a/service.ts']);
  });

  it('--in normalization: leading ./ (repeated) and trailing / are stripped', async () => {
    const plain = await grepIndex(root, 'TOKEN', { in: 'src/a' });
    expect(await grepIndex(root, 'TOKEN', { in: './src/a/' })).toEqual(plain);
    expect(await grepIndex(root, 'TOKEN', { in: '././src/a//' })).toEqual(plain);
  });

  it('an --in of "/" normalizes to the empty prefix and searches everything', async () => {
    const r = await grepIndex(root, 'TOKEN', { in: '/' });
    expect(r.filesSearched).toBe(INDEXED_COUNT);
    expect(r.totalHits).toBe(7);
  });

  it('an --in prefix with nothing indexed under it throws GrepScopeError', async () => {
    const err = await grepIndex(root, 'TOKEN', { in: 'src/nope' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrepScopeError);
    expect((err as Error).message).toBe('nothing indexed under "src/nope/" (or any path prefix)');
  });

  it('a root with no .codegraph index throws GrepIndexError', async () => {
    await expect(grepIndex(unindexedRoot, 'TOKEN')).rejects.toBeInstanceOf(GrepIndexError);
  });
});

describe('grepIndex: pattern', () => {
  it('--fixed matches regex metacharacters literally', async () => {
    const r = await grepIndex(root, 'remap(verb:', { fixed: true });
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].symbol).toBeNull();
    expect(r.groups[0].hits).toEqual([{ line: 1, text: '// call remap(verb: x) and arrow --> here' }]);
  });

  it('the same pattern without --fixed is an invalid regex: GrepPatternError', async () => {
    await expect(grepIndex(root, 'remap(verb:')).rejects.toBeInstanceOf(GrepPatternError);
  });

  it('a pattern starting with "-" is a pattern, not an rg flag', async () => {
    const r = await grepIndex(root, '-->');
    expect(r.totalHits).toBe(1);
    expect(r.groups[0].path).toBe('src/a/meta.ts');
    expect(r.groups[0].hits).toEqual([{ line: 1, text: '// call remap(verb: x) and arrow --> here' }]);
  });

  it('ignoreCase matches every case; without it only the exact case', async () => {
    const exact = await grepIndex(root, 'mixedcase');
    expect(exact.totalHits).toBe(1);
    expect(exact.groups[0].hits).toEqual([{ line: 4, text: '"mixedcase",' }]);

    const ci = await grepIndex(root, 'mixedcase', { ignoreCase: true });
    expect(ci.totalHits).toBe(3);
    expect(groupKeys(ci)).toEqual(['cased|function|src/a/case.ts|L1-L7|0']);
    expect(ci.groups[0].hits).toEqual([
      { line: 3, text: '"MixedCase",' },
      { line: 4, text: '"mixedcase",' },
      { line: 5, text: '"MIXEDCASE",' },
    ]);
  });

  it('hit text is trimmed and capped at 160 characters', async () => {
    const r = await grepIndex(root, 'LONGWORD');
    expect(r.totalHits).toBe(1);
    const text = r.groups[0].hits[0].text;
    expect(text).toBe(LONG_LINE.trim().slice(0, 160));
    expect(text).toHaveLength(160);
    expect(text.startsWith('const s = "LONGWORD x')).toBe(true);
  });
});

describe('grepIndex: cap', () => {
  it('keeps the first maxHits by (path localeCompare, line); counts the rest as truncated', async () => {
    const r = await grepIndex(root, 'TOKEN', { maxHits: 2 });
    expect(r.totalHits).toBe(2);
    expect(r.truncated).toEqual({ files: 0, hits: 5 });
    expect(groupKeys(r)).toEqual([
      'module|src/a/service.ts|0',
      'Worker.run|method|src/a/service.ts|L5-L7|0',
    ]);
  });

  it('for every cap, the kept set is the first maxHits of all hits by (path localeCompare, line)', async () => {
    // 7 TOKEN hits: caps of 1-3 bring the buffer to its 2 * maxHits bound, so the
    // bounded collector trims mid-search and must still keep exactly the right hits.
    const flat = (r: Awaited<ReturnType<typeof grepIndex>>): string[] =>
      r.groups
        .flatMap((g) => g.hits.map((h) => ({ path: g.path, line: h.line })))
        .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
        .map((h) => `${h.path}:${h.line}`);
    const all = flat(await grepIndex(root, 'TOKEN'));
    expect(all).toHaveLength(7);
    for (let k = 1; k <= 7; k++) {
      const r = await grepIndex(root, 'TOKEN', { maxHits: k });
      expect(r.totalHits).toBe(k);
      expect(r.truncated.hits).toBe(7 - k);
      expect(flat(r)).toEqual(all.slice(0, k));
    }
  });

  it('localeCompare order drops src/B.ts first (code-unit order would keep it)', async () => {
    const r = await grepIndex(root, 'TOKEN', { maxHits: 6 });
    expect(r.totalHits).toBe(6);
    expect(r.truncated).toEqual({ files: 0, hits: 1 });
    expect(r.groups.map((g) => g.path)).not.toContain('src/B.ts');
    expect(r.groups.some((g) => g.symbol?.name === 'zeroAb')).toBe(true);
  });

  it('a truncated result prints the truncation note directly under the header', async () => {
    const r = await grepIndex(root, 'TOKEN', { maxHits: 2 });
    expect(formatGrepResult(r)).toBe(
      [
        `"TOKEN" — 2 hits in 2 symbols across 1 files (searched ${INDEXED_COUNT} indexed files)`,
        '(truncated: 5 more hits beyond the cap — narrow with --in or refine the pattern)',
        '',
        'src/a/service.ts (module level) · 0 in-edges',
        '  L1: // service module: TOKEN at module level',
        '',
        'Worker.run · method · src/a/service.ts:L5-L7 · 0 in-edges',
        '  L6: return "TOKEN in run";',
        '',
      ].join('\n'),
    );
  });

  it('the note is singular for one dropped hit', async () => {
    const r = await grepIndex(root, 'TOKEN', { maxHits: 6 });
    expect(formatGrepResult(r).split('\n')[1]).toBe(
      '(truncated: 1 more hit beyond the cap — narrow with --in or refine the pattern)',
    );
  });
});

describe('grepIndex: symbols and ranking', () => {
  it('a hit in a method body goes to the method (Class.method), not the class', async () => {
    const r = await grepIndex(root, 'TOKEN in run');
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].symbol).toEqual({
      id: 'src/a/service.ts#Worker.run',
      name: 'Worker.run',
      kind: 'method',
      path: 'src/a/service.ts',
      span: 'L5-L7',
    });
    expect(r.groups[0].path).toBe('src/a/service.ts');
    expect(r.groups[0].hits).toEqual([{ line: 6, text: 'return "TOKEN in run";' }]);
  });

  it('a hit outside every symbol is a module-level group: symbol null, inDegree 0', async () => {
    const r = await grepIndex(root, 'service module');
    expect(r.groups).toEqual([
      {
        symbol: null,
        path: 'src/a/service.ts',
        inDegree: 0,
        hits: [{ line: 1, text: '// service module: TOKEN at module level' }],
      },
    ]);
  });

  it('groups rank by in-degree, then path localeCompare, then creation order', async () => {
    const r = await grepIndex(root, 'TOKEN');
    expect(groupKeys(r)).toEqual([
      'helper|function|src/a/service.ts|L10-L12|2',
      'farAway|function|src/ab/other.ts|L1-L3|1',
      'module|src/a/service.ts|0',
      'Worker.run|method|src/a/service.ts|L5-L7|0',
      'lonely|function|src/a/service.ts|L22-L24|0',
      'zeroAb|function|src/ab/other.ts|L10-L12|0',
      'bee|function|src/B.ts|L1-L3|0',
    ]);
  });

  it('saved sums the indexed size of the distinct group paths', async () => {
    const r = await grepIndex(root, 'TOKEN', { in: 'src/ab' });
    expect(r.saved).toEqual({
      files: 1,
      baselineBytes: fs.statSync(path.join(root, 'src/ab/other.ts')).size,
    });
  });
});

describe('formatting', () => {
  it('exact text for a two-hit, one-file result, ending in a single newline', async () => {
    const r = await grepIndex(root, 'TOKEN', { in: 'src/ab' });
    expect(formatGrepHeader(r)).toBe('"TOKEN" — 2 hits in 2 symbols across 1 files (searched 1 indexed files)');
    expect(formatGrepResult(r)).toBe(
      [
        '"TOKEN" — 2 hits in 2 symbols across 1 files (searched 1 indexed files)',
        '',
        'farAway · function · src/ab/other.ts:L1-L3 · 1 in-edges',
        '  L2: return "TOKEN far";',
        '',
        'zeroAb · function · src/ab/other.ts:L10-L12 · 0 in-edges',
        '  L11: return "TOKEN zero";',
        '',
      ].join('\n'),
    );
  });

  it('exact text for the full ranked result', async () => {
    const r = await grepIndex(root, 'TOKEN');
    const out = formatGrepResult(r);
    expect(out).toBe(
      [
        `"TOKEN" — 7 hits in 7 symbols across 3 files (searched ${INDEXED_COUNT} indexed files)`,
        '',
        'helper · function · src/a/service.ts:L10-L12 · 2 in-edges',
        '  L11: return "TOKEN helper";',
        '',
        'farAway · function · src/ab/other.ts:L1-L3 · 1 in-edges',
        '  L2: return "TOKEN far";',
        '',
        'src/a/service.ts (module level) · 0 in-edges',
        '  L1: // service module: TOKEN at module level',
        '',
        'Worker.run · method · src/a/service.ts:L5-L7 · 0 in-edges',
        '  L6: return "TOKEN in run";',
        '',
        'lonely · function · src/a/service.ts:L22-L24 · 0 in-edges',
        '  L23: return "TOKEN lonely";',
        '',
        'zeroAb · function · src/ab/other.ts:L10-L12 · 0 in-edges',
        '  L11: return "TOKEN zero";',
        '',
        'bee · function · src/B.ts:L1-L3 · 0 in-edges',
        '  L2: return "TOKEN bee";',
        '',
      ].join('\n'),
    );
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('zeroHitNote names the pattern and the indexed file count', async () => {
    const r = await grepIndex(root, 'zzzNoSuchThing');
    expect(r.totalHits).toBe(0);
    expect(r.groups).toEqual([]);
    expect(zeroHitNote(r)).toBe(
      `no hits for "zzzNoSuchThing" in ${INDEXED_COUNT} indexed files. The pattern may be too specific — retry with a bare symbol name or short substring (drop the receiver, full signature, and regex anchors). All selected indexed code was searched; use a raw grep only for unindexed files (docs, configs, brand-new files)`,
    );
  });

  // chmod 0 does not stop root reading the file, and Windows ignores the mode.
  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'an unreadable indexed file counts into truncated.files and the zero-hit note', async () => {
    const bee = path.join(root, 'src/B.ts');
    fs.chmodSync(bee, 0o000);
    try {
      const r = await grepIndex(root, 'bee');
      expect(r.totalHits).toBe(0);
      expect(r.truncated.files).toBe(1);
      expect(zeroHitNote(r).endsWith(
        ' — note: 1 indexed file could not be read (stale index? run codegraph sync)',
      )).toBe(true);
    } finally {
      fs.chmodSync(bee, 0o644);
    }
  },
  );
});

describe('runGrepCommand (CLI)', () => {
  it('text with hits: stdout is formatGrepResult, exit 0', async () => {
    const expected = formatGrepResult(await grepIndex(root, 'TOKEN', { in: 'src/ab' }));
    const out = await runGrepCommand(['TOKEN', '--in', 'src/ab'], root);
    expect(out).toEqual({ stdout: expected, stderr: '', exitCode: 0 });
  });

  it('finds the project root from a nested cwd, and honours --path', async () => {
    const expected = formatGrepResult(await grepIndex(root, 'TOKEN'));
    expect((await runGrepCommand(['TOKEN'], path.join(root, 'src', 'a'))).stdout).toBe(expected);
    expect((await runGrepCommand(['TOKEN', '--path', root], unindexedRoot)).stdout).toBe(expected);
    expect((await runGrepCommand(['TOKEN', '-p', root], unindexedRoot)).stdout).toBe(expected);
  });

  it('--fixed and -i reach the search', async () => {
    const fixed = await runGrepCommand(['remap(verb:', '--fixed'], root);
    expect(fixed.exitCode).toBe(0);
    expect(fixed.stdout).toBe(formatGrepResult(await grepIndex(root, 'remap(verb:', { fixed: true })));
    const ci = await runGrepCommand(['mixedcase', '-i'], root);
    expect(ci.stdout).toBe(formatGrepResult(await grepIndex(root, 'mixedcase', { ignoreCase: true })));
    const ciLong = await runGrepCommand(['mixedcase', '--ignore-case'], root);
    expect(ciLong.stdout).toBe(ci.stdout);
  });

  it('zero hits in text mode: empty stdout, the note on stderr, exit 0', async () => {
    const note = zeroHitNote(await grepIndex(root, 'zzzNoSuchThing'));
    const out = await runGrepCommand(['zzzNoSuchThing'], root);
    expect(out).toEqual({ stdout: '', stderr: note + '\n', exitCode: 0 });
  });

  it('--json prints the result as indented JSON plus a newline, exit 0', async () => {
    const r = await grepIndex(root, 'TOKEN', { in: 'src/ab' });
    const out = await runGrepCommand(['TOKEN', '--in', 'src/ab', '--json'], root);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(JSON.stringify(r, null, 2) + '\n');
  });

  it('--json with zero hits still exits 0 with totalHits 0', async () => {
    const out = await runGrepCommand(['zzzNoSuchThing', '--json'], root);
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.totalHits).toBe(0);
    expect(parsed.groups).toEqual([]);
    expect(parsed.filesSearched).toBe(INDEXED_COUNT);
  });

  it('an invalid pattern: "✗ invalid pattern" on stderr, exit 1', async () => {
    const out = await runGrepCommand(['remap(verb:'], root);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr.startsWith('✗ invalid pattern "remap(verb:": ')).toBe(true);
  });

  it('an unknown --in prefix: "✗ nothing indexed under" on stderr, exit 1', async () => {
    const out = await runGrepCommand(['TOKEN', '--in', 'src/nope'], root);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr.trimEnd()).toBe('✗ nothing indexed under "src/nope/" (or any path prefix)');
  });

  it('a project with no index: "✗ " message on stderr, exit 1', async () => {
    const out = await runGrepCommand(['TOKEN', '--path', unindexedRoot], unindexedRoot);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr.startsWith('✗ ')).toBe(true);
  });

  it('a missing pattern prints usage on stderr, exit 1', async () => {
    const out = await runGrepCommand([], root);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain("missing required argument 'pattern'");
    expect(out.stderr).toContain("missing required argument 'pattern'");
  });
});

describe('MCP tool', () => {
  it('is read-only and caps patterns at the 4096-character boundary', async () => {
    expect(GREP_TOOL.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(GREP_TOOL.inputSchema.properties.pattern).toMatchObject({ maxLength: 4096 });
    const tooLong = await handleGrepTool({ pattern: 'x'.repeat(4097) }, root);
    expect(tooLong.content[0].text).toContain('pattern exceeds maximum length of 4096');
    const atLimit = await handleGrepTool({ pattern: 'x'.repeat(4096), fixed: true }, root);
    expect(atLimit.isError).toBeFalsy();
    expect(atLimit.content[0].text).toContain('no hits');
  });

  it('GREP_TOOL is named codegraph_grep, requires pattern, and lists its inputs', () => {
    expect(GREP_TOOL.name).toBe('codegraph_grep');
    expect(GREP_TOOL.description.length).toBeGreaterThan(0);
    const schema = GREP_TOOL.inputSchema as { type: string; properties: Record<string, unknown>; required: string[] };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['pattern']);
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['fixed', 'ignore_case', 'in', 'json', 'pattern', 'projectPath', 'strict'].sort(),
    );
  });

  it('a hit result: content text equals formatGrepResult', async () => {
    const expected = formatGrepResult(await grepIndex(root, 'TOKEN', { in: 'src/ab' }));
    const res = await handleGrepTool({ pattern: 'TOKEN', in: 'src/ab' }, root);
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual([{ type: 'text', text: expected }]);
  });

  it('projectPath, ignore_case and fixed reach the search', async () => {
    const ci = await handleGrepTool({ pattern: 'mixedcase', ignore_case: true, projectPath: root });
    expect(ci.content[0].text).toBe(formatGrepResult(await grepIndex(root, 'mixedcase', { ignoreCase: true })));
    const fixed = await handleGrepTool({ pattern: 'remap(verb:', fixed: true }, root);
    expect(fixed.isError).toBeFalsy();
    expect(fixed.content[0].text).toBe(formatGrepResult(await grepIndex(root, 'remap(verb:', { fixed: true })));
  });

  it('json:true returns the result as JSON text', async () => {
    const r = await grepIndex(root, 'TOKEN', { in: 'src/ab' });
    const res = await handleGrepTool({ pattern: 'TOKEN', in: 'src/ab', json: true }, root);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text)).toEqual(JSON.parse(JSON.stringify(r)));
  });

  it('zero hits are success-shaped and carry the zero-hit note', async () => {
    const note = zeroHitNote(await grepIndex(root, 'zzzNoSuchThing'));
    const res = await handleGrepTool({ pattern: 'zzzNoSuchThing' }, root);
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual([{ type: 'text', text: note }]);
  });

  it('an invalid pattern is success-shaped guidance, not isError', async () => {
    const res = await handleGrepTool({ pattern: 'remap(verb:' }, root);
    expect(res.isError).toBeFalsy();
    expect(res.content).toHaveLength(1);
    expect(res.content[0].text).toContain('remap(verb:');
  });

  it('an unknown --in prefix is success-shaped guidance, not isError', async () => {
    const res = await handleGrepTool({ pattern: 'TOKEN', in: 'src/nope' }, root);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('nothing indexed under "src/nope/"');
  });

  it('a project with no index is success-shaped guidance, not isError', async () => {
    const res = await handleGrepTool({ pattern: 'TOKEN' }, unindexedRoot);
    expect('isError' in res).toBe(false);
    expect(res.content).toHaveLength(1);
    expect(res.content[0].text).toContain("isn't indexed with codegraph");
    expect(res.content[0].text).toContain('.codegraph');
  });
});

/**
 * A second fixture for the edge cases: two same-named functions in one file
 * (the index keeps both, so their `<path>#<name>` ids collide), two paths the
 * collator calls equal (`ab.ts` and `a\u200Db.ts`, a zero-width joiner, which
 * APFS keeps as distinct names), and an indexed file that a test replaces with
 * a directory.
 */
const ZWJ_PATH = 'a\u200Db.ts';
let edgeRoot = '';
let toolsDir = '';

beforeAll(async () => {
  edgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grep-by-symbol-edge-'));
  const write = (rel: string, content: string): void => fs.writeFileSync(path.join(edgeRoot, rel), content);
  write('dup.ts', 'export function dupe(): string {\n  return "DUPTOKEN one";\n}\n\nexport function dupe(): string {\n  return "DUPTOKEN two";\n}\n');
  write('ab.ts', '\n'.repeat(9) + 'export const x = "COLLTOKEN";\n'); // L10
  write(ZWJ_PATH, 'export const y = "COLLTOKEN";\n'); // L1
  write('gone.ts', 'export const g = "GONETOKEN";\n');
  const cg = await CodeGraph.init(edgeRoot, { index: true });
  cg.close();
  toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grep-by-symbol-tools-'));
});

afterAll(() => {
  for (const r of [edgeRoot, toolsDir]) if (r) fs.rmSync(r, { recursive: true, force: true });
});

/** An executable stand-in for rg that prints one non-JSON line and exits 0. */
function fakeRg(): string {
  const p = path.join(toolsDir, 'fake-rg.sh');
  fs.writeFileSync(p, '#!/bin/sh\necho -x\nexit 0\n', { mode: 0o755 });
  return p;
}

describe('grepIndex: edge cases', () => {
  it('paths the collator calls equal share a rank, so the line decides the cap', async () => {
    expect(ZWJ_PATH).not.toBe('ab.ts');
    expect('ab.ts'.localeCompare(ZWJ_PATH)).toBe(0);
    expect(fs.readdirSync(edgeRoot)).toEqual(expect.arrayContaining(['ab.ts', ZWJ_PATH]));
    const r = await grepIndex(edgeRoot, 'COLLTOKEN', { maxHits: 1 });
    expect(r.totalHits).toBe(1);
    expect(r.truncated.hits).toBe(1);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].path).toBe(ZWJ_PATH);
    expect(r.groups[0].hits).toEqual([{ line: 1, text: 'export const y = "COLLTOKEN";' }]);
  });

  it('two groups that would share <path>#<name>: the second gets ~2', async () => {
    const r = await grepIndex(edgeRoot, 'DUPTOKEN');
    expect(r.groups.map((g) => [g.symbol?.id, g.symbol?.span])).toEqual([
      ['dup.ts#dupe', 'L1-L3'],
      ['dup.ts#dupe~2', 'L5-L7'],
    ]);
  });

  it('an indexed path that is now a directory is not descended; it counts as one unreadable file', async () => {
    const gone = path.join(edgeRoot, 'gone.ts');
    fs.rmSync(gone);
    fs.mkdirSync(gone);
    fs.writeFileSync(path.join(gone, 'inner.ts'), 'export const d = "DIRTOKEN";\n');
    fs.writeFileSync(path.join(gone, 'more.txt'), 'DIRTOKEN\n');
    try {
      const r = await grepIndex(edgeRoot, 'DIRTOKEN');
      expect(r.totalHits).toBe(0);
      expect(r.groups).toEqual([]);
      expect(r.truncated).toEqual({ files: 1, hits: 0 });
    } finally {
      fs.rmSync(gone, { recursive: true, force: true });
      fs.writeFileSync(gone, 'export const g = "GONETOKEN";\n');
    }
  });

  it.runIf(process.platform !== 'win32')('malformed rg output rejects the search with a plain Error', async () => {
    const err = await grepIndex(root, 'TOKEN', { rgPath: fakeRg() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GrepPatternError);
    expect(err).not.toBeInstanceOf(GrepScopeError);
    expect(err).not.toBeInstanceOf(GrepIndexError);
    expect((err as Error).message).toContain('not its JSON');
  });

  it.runIf(process.platform !== 'win32')('malformed rg output through MCP is isError', async () => {
    const saved = process.env.CODEGRAPH_RG;
    process.env.CODEGRAPH_RG = fakeRg();
    try {
      const res = await handleGrepTool({ pattern: 'TOKEN' }, root);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Tool execution failed:');
      expect(res.content[0].text).toContain('not its JSON');
    } finally {
      if (saved === undefined) delete process.env.CODEGRAPH_RG;
      else process.env.CODEGRAPH_RG = saved;
    }
  });
});

describe('ripgrep safety limits', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.runIf(process.platform !== 'win32')('does not resolve the default executable from relative or project-root PATH entries', async () => {
    const executable = path.join(root, 'rg');
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    vi.stubEnv('PATH', ['.', root].join(path.delimiter));
    vi.stubEnv('CODEGRAPH_RG', undefined);
    try {
      await expect(grepIndex(root, 'TOKEN')).rejects.toMatchObject({ reason: 'rg-missing' });
    } finally {
      fs.rmSync(executable);
    }
  });

  it.runIf(process.platform !== 'win32').each([false, true])('rejects oversized JSON records, newline terminated: %s', async (newline) => {
    const executable = path.join(toolsDir, 'large-rg');
    fs.writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(8 * 1024 * 1024 + 1) + ${JSON.stringify(newline ? '\n' : '')});\n`, { mode: 0o755 });
    await expect(grepIndex(root, 'TOKEN', { rgPath: executable })).rejects.toThrow('8 MiB safety limit');
  });

  it.runIf(process.platform !== 'win32')('bounds retained subprocess diagnostics', async () => {
    const executable = path.join(toolsDir, 'noisy-rg');
    fs.writeFileSync(executable, `#!${process.execPath}\nprocess.stderr.write('z'.repeat(128 * 1024), () => process.exit(2));\n`, { mode: 0o755 });
    const err = await grepIndex(root, 'TOKEN', { rgPath: executable }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('ripgrep failed: ' + 'z'.repeat(64 * 1024));
  });
});

describe('batchPaths', () => {
  it('splits at the byte budget (path bytes + 1 each); no batch is empty', () => {
    expect(batchPaths([], 8)).toEqual([]);
    // costs 5, 3, 7, 2
    expect(batchPaths(['aaaa', 'bb', 'cccccc', 'd'], 8)).toEqual([['aaaa', 'bb'], ['cccccc'], ['d']]);
    expect(batchPaths(['aaaa', 'bb', 'cccccc', 'd'], 6)).toEqual([['aaaa'], ['bb'], ['cccccc'], ['d']]);
    // a path over the budget still gets its own batch
    expect(batchPaths(['x'.repeat(20), 'y'], 4)).toEqual([['x'.repeat(20)], ['y']]);
    // multi-byte paths are measured in UTF-8 bytes: 'é' is 2 bytes, cost 3
    expect(batchPaths(['é', 'é'], 5)).toEqual([['é'], ['é']]);
    expect(batchPaths(['é', 'é'], 6)).toEqual([['é', 'é']]);
  });

  it('the default budget bounds each batch while preserving every path in order', () => {
    const paths = Array.from({ length: 1000 }, (_, i) => `src/dir${i}/file${i}.ts`);
    const batches = batchPaths(paths);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(paths);
    for (const batch of batches) {
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.reduce((bytes, rel) => bytes + Buffer.byteLength(rel) + 1, 0)).toBeLessThanOrEqual(8 * 1024);
    }
  });
});

describe('DB closed on every path', () => {
  afterEach(() => vi.restoreAllMocks());

  const closes = async (run: () => Promise<unknown>): Promise<number> => {
    const spy = vi.spyOn(DatabaseConnection.prototype, 'close');
    await run().catch(() => undefined);
    return spy.mock.calls.length;
  };

  it('success', async () => {
    expect(await closes(() => grepIndex(root, 'TOKEN'))).toBe(1);
  });

  it('GrepScopeError', async () => {
    await expect(grepIndex(root, 'TOKEN', { in: 'src/nope' })).rejects.toBeInstanceOf(GrepScopeError);
    expect(await closes(() => grepIndex(root, 'TOKEN', { in: 'src/nope' }))).toBe(1);
  });

  it('a pattern JS accepts and rg refuses (lookbehind): GrepPatternError', async () => {
    await expect(grepIndex(root, '(?<=a)b')).rejects.toBeInstanceOf(GrepPatternError);
    expect(await closes(() => grepIndex(root, '(?<=a)b'))).toBe(1);
  });

  it.runIf(process.platform !== 'win32')('malformed rg output', async () => {
    expect(await closes(() => grepIndex(root, 'TOKEN', { rgPath: fakeRg() }))).toBe(1);
  });
});

describe('MCP tool: project path refusal', () => {
  it('a projectPath under a sensitive home folder is refused with isError', async () => {
    // HOME is the test sandbox's (setup-home-sandbox.ts), so this ~/.ssh is a throwaway.
    const ssh = path.join(os.homedir(), '.ssh', 'cg-grep-proj');
    fs.mkdirSync(ssh, { recursive: true });
    try {
      const res = await handleGrepTool({ pattern: 'TOKEN', projectPath: ssh }, root);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Refusing to operate on sensitive directory');
    } finally {
      fs.rmSync(ssh, { recursive: true, force: true });
    }
  });

  it('an ordinary fixture projectPath still searches', async () => {
    const res = await handleGrepTool({ pattern: 'TOKEN', projectPath: path.join(root, 'src') });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe(formatGrepResult(await grepIndex(root, 'TOKEN')));
  });
});

describe('MCP tool: resolved-root refusal', () => {
  it('a missing child of an indexed project under a sensitive folder: the root it walks up to is refused with isError', async () => {
    // The child does not exist, so the input-path check is skipped; only the
    // check on the indexed root the walk lands on can refuse it.
    const proj = path.join(os.homedir(), '.ssh', 'cg-grep-indexed');
    fs.mkdirSync(path.join(proj, '.codegraph'), { recursive: true });
    for (const f of ['codegraph.db', 'codegraph.db-wal', 'codegraph.db-shm']) {
      const src = path.join(root, '.codegraph', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(proj, '.codegraph', f));
    }
    const missing = path.join(proj, 'no', 'such', 'child');
    expect(fs.existsSync(missing)).toBe(false);
    try {
      const res = await handleGrepTool({ pattern: 'TOKEN', projectPath: missing }, root);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Refusing to operate on sensitive directory');
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});

describe('grepIndex: maxHits validation', () => {
  it.each([1.5, NaN, -1, Infinity])('maxHits %s throws a TypeError naming the value', async (v) => {
    const err = await grepIndex(root, 'TOKEN', { maxHits: v }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(GrepPatternError);
    expect((err as Error).message).toBe(`maxHits must be a non-negative integer, got ${String(v)}`);
  });

  it('maxHits 0 keeps no hits and counts every hit as truncated', async () => {
    const r = await grepIndex(root, 'TOKEN', { maxHits: 0 });
    expect(r.totalHits).toBe(0);
    expect(r.groups).toEqual([]);
    expect(r.truncated).toEqual({ files: 0, hits: 7 });
  });
});

describe('CappedHits (bounded retention)', () => {
  // Ten paths, two of them sharing a rank (as collator-equal paths do), 100
  // lines each, fed in DESCENDING order so every add is a new worst-so-far
  // best: the buffer fills and trims as often as it can.
  const paths = ['p0.ts', 'p0b.ts', ...Array.from({ length: 8 }, (_, i) => `p${i + 1}.ts`)];
  const ranks = new Map(paths.map((p, i) => [p, i === 0 ? 0 : i - 1]));
  const rank = (p: string): number => ranks.get(p) as number;
  const all: RawHit[] = [];
  for (let i = paths.length - 1; i >= 0; i--) {
    for (let line = 100; line >= 1; line--) all.push({ path: paths[i] as string, line, text: `${paths[i]}:${line}` });
  }
  // The stated order: path rank, line, path code-unit order (arrival never decides here: no two hits share path+line).
  const ordered = [...all].sort(
    (a, b) => rank(a.path) - rank(b.path) || a.line - b.line || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );

  it.each([1, 7, 50, 300])('maxHits %i: never holds more than 2 * maxHits, keeps the first maxHits by the order', (maxHits) => {
    const c = new CappedHits(ranks, maxHits);
    let peakSeen = 0;
    for (const h of all) {
      c.add(h);
      peakSeen = Math.max(peakSeen, c.peak);
      expect(c.peak).toBeLessThanOrEqual(2 * maxHits);
    }
    expect(all.length).toBeGreaterThan(2 * maxHits);
    expect(peakSeen).toBe(2 * maxHits);
    expect(c.total).toBe(all.length);
    expect(c.kept()).toEqual(ordered.slice(0, maxHits));
  });

  it('maxHits 0 holds nothing and still counts every hit', () => {
    const c = new CappedHits(ranks, 0);
    for (const h of all) c.add(h);
    expect(c.peak).toBe(0);
    expect(c.total).toBe(all.length);
    expect(c.kept()).toEqual([]);
  });
});

describe('grepIndex: batchBytes', () => {
  const posix = process.platform !== 'win32';
  /** A stand-in rg that logs one line per process to `log`, then runs the real rg. */
  const countingRg = (name: string, log: string): string => {
    const p = path.join(toolsDir, name);
    const real = process.env.CODEGRAPH_RG ?? 'rg';
    fs.writeFileSync(p, `#!/bin/sh\necho run >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
    return p;
  };
  const runs = (log: string): number =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;

  it.runIf(posix)('a budget that forces >= 3 rg processes returns the single-batch result', async () => {
    const indexed = Object.keys(FILES).filter((f) => f !== 'notes.txt');
    expect(indexed).toHaveLength(INDEXED_COUNT);
    expect(batchPaths(indexed, 20).length).toBeGreaterThanOrEqual(3);
    const oneLog = path.join(toolsDir, 'one.log');
    const manyLog = path.join(toolsDir, 'many.log');
    const oneRg = countingRg('one-rg.sh', oneLog);
    const manyRg = countingRg('many-rg.sh', manyLog);
    for (const opts of [{}, { maxHits: 2 }, { maxHits: 5 }, { in: 'src/a' }]) {
      fs.rmSync(oneLog, { force: true });
      fs.rmSync(manyLog, { force: true });
      const single = await grepIndex(root, 'TOKEN', { ...opts, rgPath: oneRg });
      const multi = await grepIndex(root, 'TOKEN', { ...opts, rgPath: manyRg, batchBytes: 20 });
      expect(runs(oneLog)).toBe(1);
      expect(runs(manyLog)).toBeGreaterThanOrEqual(3);
      expect(multi).toEqual(single);
      expect(single.totalHits).toBeGreaterThan(0);
    }
  });
});

describe('grepIndex: symlinks leading out of the project', () => {
  const posix = process.platform !== 'win32';
  let outside = '';
  beforeAll(() => {
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grep-by-symbol-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const s = "ESCAPETOKEN";\n');
    fs.mkdirSync(path.join(outside, 'dir'));
    fs.writeFileSync(path.join(outside, 'dir', 'other.ts'), 'export const o = "ESCDIRTOKEN";\n');
  });
  afterAll(() => {
    if (outside) fs.rmSync(outside, { recursive: true, force: true });
  });

  /** Replace edgeRoot/gone.ts with a symlink to `target` for the duration of `run`. */
  const withGoneAsLink = async (target: string, run: () => Promise<void>): Promise<void> => {
    const gone = path.join(edgeRoot, 'gone.ts');
    fs.rmSync(gone);
    fs.symlinkSync(target, gone);
    try {
      await run();
    } finally {
      fs.rmSync(gone, { force: true });
      fs.writeFileSync(gone, 'export const g = "GONETOKEN";\n');
    }
  };

  /** Replace root/src/ab with a symlink to `target` (the real folder parked at src/ab-parked) for `run`. */
  const withAbAsLink = async (target: string, run: () => Promise<void>): Promise<void> => {
    const ab = path.join(root, 'src', 'ab');
    const parked = path.join(root, 'src', 'ab-parked');
    fs.renameSync(ab, parked);
    fs.symlinkSync(target, ab);
    try {
      await run();
    } finally {
      fs.rmSync(ab, { force: true });
      fs.renameSync(parked, ab);
    }
  };

  it.runIf(posix)('an indexed file that is a symlink to a file outside: not searched, counts as unreadable', async () => {
    await withGoneAsLink(path.join(outside, 'secret.ts'), async () => {
      const r = await grepIndex(edgeRoot, 'ESCAPETOKEN');
      expect(r.totalHits).toBe(0);
      expect(r.groups).toEqual([]);
      expect(r.truncated.files).toBe(1);
    });
  });

  it.runIf(posix)('a dangling symlink counts as unreadable', async () => {
    await withGoneAsLink(path.join(outside, 'no-such-file.ts'), async () => {
      const r = await grepIndex(edgeRoot, 'GONETOKEN');
      expect(r.totalHits).toBe(0);
      expect(r.truncated.files).toBe(1);
    });
  });

  it.runIf(posix)('a symlink to a file inside the project is still searched', async () => {
    fs.writeFileSync(path.join(edgeRoot, 'inside.txt'), 'INTOKEN here\n');
    try {
      await withGoneAsLink('inside.txt', async () => {
        const r = await grepIndex(edgeRoot, 'INTOKEN');
        expect(r.totalHits).toBe(1);
        expect(r.groups.map((g) => [g.path, g.hits])).toEqual([['gone.ts', [{ line: 1, text: 'INTOKEN here' }]]]);
        expect(r.truncated.files).toBe(0);
      });
    } finally {
      fs.rmSync(path.join(edgeRoot, 'inside.txt'), { force: true });
    }
  });

  it.runIf(posix)('an indexed file under a symlinked folder that leads outside: not searched, counts as unreadable', async () => {
    await withAbAsLink(path.join(outside, 'dir'), async () => {
      const r = await grepIndex(root, 'ESCDIRTOKEN');
      expect(r.totalHits).toBe(0);
      expect(r.groups).toEqual([]);
      expect(r.truncated.files).toBe(1);
    });
  });

  it.runIf(posix)('an indexed file under a symlinked folder inside the project is still searched', async () => {
    await withAbAsLink('ab-parked', async () => {
      const r = await grepIndex(root, 'TOKEN far');
      expect(r.totalHits).toBe(1);
      expect(r.groups[0].path).toBe('src/ab/other.ts');
      expect(r.groups[0].hits).toEqual([{ line: 2, text: 'return "TOKEN far";' }]);
      expect(r.truncated.files).toBe(0);
    });
  });
});

describe('isCanonicalIndexedPath', () => {
  it('accepts relative /-separated paths whose segments are all real names', () => {
    for (const p of ['a.ts', 'src/a/b.ts', 'a..b.ts', '..a', '.hidden/x.ts', 'a b/c.ts']) {
      expect([p, isCanonicalIndexedPath(p)]).toEqual([p, true]);
    }
  });

  it('refuses empty, ., .. and empty segments, absolute paths in posix and win32 form, and a NUL byte', () => {
    const refused = [
      '', '.', '..', './a.ts', 'a/./b.ts', 'a/../b.ts', '../a.ts', 'a//b.ts', 'a/', 'link/../secret.txt',
      '/a.ts', '/etc/passwd', 'C:\\x.ts', 'C:/x.ts', '\\x.ts', '\\\\server\\share\\x.ts', 'a\0b.ts',
    ];
    for (const p of refused) expect([p, isCanonicalIndexedPath(p)]).toEqual([p, false]);
  });

  it.runIf(process.platform === 'win32')('on win32, \\ separates segments and a drive-relative path is refused', () => {
    for (const p of ['a\\..\\b.ts', 'a\\\\b.ts', 'a\\.\\b.ts', 'C:x.ts']) expect([p, isCanonicalIndexedPath(p)]).toEqual([p, false]);
    expect(isCanonicalIndexedPath('a\\b.ts')).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('on posix, \\ is part of a name, not a separator', () => {
    expect(isCanonicalIndexedPath('a\\..\\b.ts')).toBe(true);
  });
});

/**
 * files rows the indexer never writes, inserted straight into a dedicated
 * fixture's database for one test at a time. The containment check resolves a
 * path lexically (path.resolve collapses `..`), but rg opens the path as given
 * and the OS follows each segment in turn, so a non-canonical row can check as
 * one file and open as another.
 */
describe('grepIndex: non-canonical indexed paths and special files', () => {
  const posix = process.platform !== 'win32';
  let ncRoot = '';
  let ncOutside = '';
  beforeAll(async () => {
    ncRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grep-by-symbol-nc-'));
    fs.mkdirSync(path.join(ncRoot, 'sub'));
    fs.writeFileSync(path.join(ncRoot, 'a.ts'), 'export const a = "CANONTOKEN";\n');
    fs.writeFileSync(path.join(ncRoot, 'sub', 'b.ts'), 'export const b = "SUBTOKEN";\n');
    const cg = await CodeGraph.init(ncRoot, { index: true });
    cg.close();
    // Made after indexing, so the index has none of them. `link` leads to
    // `<outside>/inner`, so the OS reads `link/../secret.txt` as
    // `<outside>/secret.txt` (`..` is taken from where `link` points), while a
    // lexical resolve of it lands on the decoy `<root>/secret.txt`.
    ncOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grep-by-symbol-nc-outside-'));
    fs.mkdirSync(path.join(ncOutside, 'inner'));
    fs.writeFileSync(path.join(ncOutside, 'secret.txt'), 'DOTDOTSECRET outside\n');
    fs.writeFileSync(path.join(ncRoot, 'secret.txt'), 'decoy\n');
    if (posix) fs.symlinkSync(path.join(ncOutside, 'inner'), path.join(ncRoot, 'link'));
  });
  afterAll(() => {
    for (const r of [ncRoot, ncOutside]) if (r) fs.rmSync(r, { recursive: true, force: true });
  });

  const INSERT_LIKE_A =
    'INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors, generated) ' +
    "SELECT ?, content_hash, language, size, modified_at, indexed_at, node_count, errors, generated FROM files WHERE path = 'a.ts'";
  const editRows = (sql: string, paths: string[]): void => {
    const conn = DatabaseConnection.open(getDatabasePath(ncRoot));
    try {
      const stmt = conn.getDb().prepare(sql);
      for (const p of paths) expect(stmt.run(p).changes).toBe(1);
    } finally {
      conn.close();
    }
  };
  /** Add `paths` as files rows (every other column copied from a.ts's row) for the duration of `run`. */
  const withRows = async (paths: string[], run: () => Promise<void>): Promise<void> => {
    editRows(INSERT_LIKE_A, paths);
    try {
      await run();
    } finally {
      editRows('DELETE FROM files WHERE path = ?', paths);
    }
  };

  it.runIf(posix)('link/../secret.txt, with link leading outside, is refused: no hit from the outside file, one unreadable', async () => {
    // The fixture is armed: the OS reads the outside file through the row's
    // path, while a lexical resolve of the same row lands on the decoy.
    expect(fs.readFileSync(`${ncRoot}/link/../secret.txt`, 'utf8')).toBe('DOTDOTSECRET outside\n');
    expect(fs.readFileSync(path.resolve(ncRoot, 'link/../secret.txt'), 'utf8')).toBe('decoy\n');
    await withRows(['link/../secret.txt'], async () => {
      const r = await grepIndex(ncRoot, 'DOTDOTSECRET');
      expect(r.totalHits).toBe(0);
      expect(r.groups).toEqual([]);
      expect(r.truncated.files).toBe(1);
    });
  });

  it('./a.ts, an absolute path and paths with a . , .. or empty segment are refused; the canonical rows still search', async () => {
    const rows = ['./a.ts', path.join(ncRoot, 'a.ts'), 'sub/../a.ts', 'sub/./b.ts', 'sub//b.ts'];
    await withRows(rows, async () => {
      const r = await grepIndex(ncRoot, 'CANONTOKEN|SUBTOKEN');
      expect(r.groups.map((g) => [g.path, g.hits.map((h) => h.line)])).toEqual([
        ['a.ts', [1]],
        ['sub/b.ts', [1]],
      ]);
      expect(r.totalHits).toBe(2);
      expect(r.truncated.files).toBe(rows.length);
    });
  });

  /**
   * grepIndex's result, or 'hung' if it has not settled within 3 s (rg blocks
   * opening a FIFO that has no writer). On 'hung' the FIFO is opened for
   * writing and closed, which hands the blocked rg end-of-file, so no process
   * outlives the test.
   */
  const grepOrHang = async (fifo: string, pattern: string): Promise<Awaited<ReturnType<typeof grepIndex>> | 'hung'> => {
    let timer: NodeJS.Timeout | undefined;
    const hung = new Promise<'hung'>((resolve) => {
      timer = setTimeout(() => resolve('hung'), 3000);
    });
    const outcome = await Promise.race([grepIndex(ncRoot, pattern), hung]);
    clearTimeout(timer);
    if (outcome === 'hung') {
      try {
        fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
      } catch {
        // ENXIO: no reader is blocked on it any more.
      }
    }
    return outcome;
  };
  /** Replace sub/b.ts by what `make` builds there for the duration of `run`. */
  const withB = async (make: (p: string) => void, run: () => Promise<void>): Promise<void> => {
    const b = path.join(ncRoot, 'sub', 'b.ts');
    fs.rmSync(b);
    make(b);
    try {
      await run();
    } finally {
      fs.rmSync(b, { force: true });
      fs.writeFileSync(b, 'export const b = "SUBTOKEN";\n');
    }
  };

  it.runIf(posix)('an indexed file replaced by a FIFO is not opened: the search returns and counts it unreadable', async () => {
    const b = path.join(ncRoot, 'sub', 'b.ts');
    await withB((p) => execFileSync('mkfifo', [p]), async () => {
      expect(fs.lstatSync(b).isFIFO()).toBe(true);
      const r = await grepOrHang(b, 'CANONTOKEN|SUBTOKEN');
      expect(r).not.toBe('hung');
      if (r === 'hung') return;
      expect(r.groups.map((g) => g.path)).toEqual(['a.ts']);
      expect(r.truncated.files).toBe(1);
    });
  });

  it.runIf(posix)('an indexed symlink to a FIFO inside the project is not opened: the search returns and counts it unreadable', async () => {
    const pipe = path.join(ncRoot, 'pipe');
    execFileSync('mkfifo', [pipe]);
    try {
      await withB((p) => fs.symlinkSync('../pipe', p), async () => {
        const r = await grepOrHang(pipe, 'CANONTOKEN|SUBTOKEN');
        expect(r).not.toBe('hung');
        if (r === 'hung') return;
        expect(r.groups.map((g) => g.path)).toEqual(['a.ts']);
        expect(r.truncated.files).toBe(1);
      });
    } finally {
      fs.rmSync(pipe, { force: true });
    }
  });
});
