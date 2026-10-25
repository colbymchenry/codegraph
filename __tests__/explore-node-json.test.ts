/**
 * #1280: `-j/--json` for `codegraph explore` and `codegraph node`.
 *
 * The JSON must carry the SAME information the markdown carries — the summary,
 * the flow, the blast radius, the file sections with their source — structured
 * and ANSI-free, with raw (un-prefixed) source that a consumer can drop. Most
 * tests below run the same query twice (markdown, then JSON) and compare, which
 * is what pins the two modes together.
 *
 * The CLI itself is exercised end-to-end against the built binary so the flag
 * wiring survives refactors.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

/** JSON output must never carry terminal escapes. */
const ANSI = /\u001b\[/;

function runCli(cwd: string, args: string[]): { stdout: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args, '-p', cwd], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, code: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', code: err.status ?? 1 };
  }
}

function fixture(dir: string): void {
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'feature.ts'),
    'export function target() { return 1; }\n' +
    'export function caller() { return target(); }\n');
  fs.writeFileSync(path.join(src, 'feature.test.ts'),
    'import { target } from \'./feature\';\n' +
    'export function checkTarget() { return target(); }\n');
  // A three-symbol call chain — enough for explore's Flow section.
  fs.writeFileSync(path.join(src, 'chain.ts'),
    'export function alpha() { return beta(); }\n' +
    'export function beta() { return gamma(); }\n' +
    'export function gamma() { return 1; }\n');
  // A name defined twice, for the ambiguous-symbol path.
  fs.writeFileSync(path.join(src, 'dupA.ts'), 'export function dup() { return 1; }\n');
  fs.writeFileSync(path.join(src, 'dupB.ts'), 'export function dup() { return 2; }\n');
}

describe('codegraph_explore --json (#1280)', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-explore-json-'));
    fixture(testDir);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('markdown stays the default; format \'json\' parses and carries no ANSI', async () => {
    const md = await handler.execute('codegraph_explore', { query: 'target' });
    expect(md.content[0].text).toContain('**Exploration:');

    const js = await handler.execute('codegraph_explore', { query: 'target', format: 'json' });
    expect(js.content[0].text).not.toMatch(ANSI);
    const payload = JSON.parse(js.content[0].text);
    expect(payload.query).toBe('target');
    expect(typeof payload.summary).toBe('string');
    expect(Array.isArray(payload.files)).toBe(true);
    expect(Array.isArray(payload.blastRadius)).toBe(true);
    expect(Array.isArray(payload.flow)).toBe(true);
    expect(Array.isArray(payload.notShown)).toBe(true);
    expect(Array.isArray(payload.notes)).toBe(true);
    expect(typeof payload.truncated).toBe('boolean');
  });

  it('the JSON summary is the markdown summary line, verbatim', async () => {
    const md = await handler.execute('codegraph_explore', { query: 'target' });
    const js = await handler.execute('codegraph_explore', { query: 'target', format: 'json' });
    const summaryLine = md.content[0].text.split('\n').find((l) => l.startsWith('Found '));
    expect(summaryLine).toBeDefined();
    expect(JSON.parse(js.content[0].text).summary).toBe(summaryLine);
  });

  it('the files array mirrors the markdown file sections, with raw locatable source', async () => {
    const md = await handler.execute('codegraph_explore', { query: 'target' });
    const js = await handler.execute('codegraph_explore', { query: 'target', format: 'json' });
    const text = md.content[0].text;
    // Every file section header in the markdown, in order.
    const mdPaths = [...text.matchAll(/\*\*`([^`]+)`\*\* —/g)].map((m) => m[1]);
    expect(mdPaths.length).toBeGreaterThan(0);

    const files = JSON.parse(js.content[0].text).files;
    expect(files.map((f: any) => f.path)).toEqual(mdPaths);

    for (const f of files) {
      const fileLines = fs.readFileSync(path.join(testDir, f.path), 'utf-8').split('\n');
      // The header's symbol names are reported, each with its location.
      expect(f.symbols.length).toBeGreaterThan(0);
      for (const s of f.symbols) {
        expect(text).toContain(s.name);
        expect(s.filePath).toBe(f.path);
        expect(s.startLine).toBeGreaterThan(0);
      }
      // Raw source: no `<line>\t` presentation prefixes.
      expect(f.source).not.toMatch(/^\d+\t/m);
      // A contiguous section is byte-identical to the file's own lines at the
      // reported range — the numbers travel alongside, nothing is lost.
      if (f.ranges.length === 1) {
        const r = f.ranges[0];
        expect(f.source).toBe(fileLines.slice(r.start - 1, r.end).join('\n'));
      }
    }
  });

  it('the source fields are present and droppable, leaving the structure intact', async () => {
    const js = await handler.execute('codegraph_explore', { query: 'target', format: 'json' });
    const full = js.content[0].text;
    const payload = JSON.parse(full);
    const withSource = payload.files.reduce((n: number, f: any) => n + (f.source?.length ?? 0), 0);
    expect(withSource).toBeGreaterThan(0);

    for (const f of payload.files) delete f.source;
    const dropped = JSON.stringify(payload, null, 2);
    expect(() => JSON.parse(dropped)).not.toThrow();
    expect(dropped.length).toBeLessThan(full.length);
    // What a structure-only consumer keeps still answers the question.
    const kept = JSON.parse(dropped);
    expect(kept.files[0].path).toBe('src/feature.ts');
    expect(kept.blastRadius.length).toBeGreaterThan(0);
  });

  it('the blast radius array mirrors the markdown section', async () => {
    const md = await handler.execute('codegraph_explore', { query: 'target' });
    const js = await handler.execute('codegraph_explore', { query: 'target', format: 'json' });
    const text = md.content[0].text;
    const br = JSON.parse(js.content[0].text).blastRadius;
    expect(br.length).toBeGreaterThan(0);
    const entry = br[0];
    expect(text).toContain('`' + entry.symbol + '`');
    expect(text).toMatch(new RegExp(entry.callers + ' callers?'));
    for (const t of entry.tests) expect(text).toContain(t);
    for (const f of entry.callerFiles) expect(text).toContain(f);
    expect(entry.location).toMatch(/^src\/feature\.ts:\d+$/);
  });

  it('the flow array mirrors the markdown Flow section hop for hop', async () => {
    const md = await handler.execute('codegraph_explore', { query: 'alpha beta gamma' });
    const js = await handler.execute('codegraph_explore', { query: 'alpha beta gamma', format: 'json' });
    const text = md.content[0].text;
    expect(text).toContain('**Flow (call path among the symbols you queried)**');
    const flow = JSON.parse(js.content[0].text).flow;
    expect(flow.length).toBe(2);
    for (const hop of flow) {
      expect(text).toContain(hop.from + ' (' + hop.fromLocation + ')');
      expect(text).toContain(hop.to + ' (' + hop.toLocation + ')');
      expect(text).toContain('↓ ' + hop.via);
    }
    // The chain reads end to end: each hop's head is the previous hop's tail.
    expect(flow[1].from).toBe(flow[0].to);
  });

  it('an empty answer is JSON with the miss note, not a parse error', async () => {
    const js = await handler.execute('codegraph_explore', { query: 'zzzznotathing', format: 'json' });
    const payload = JSON.parse(js.content[0].text);
    expect(payload.files).toEqual([]);
    expect(payload.summary).toContain('No relevant code found');
  });
});

describe('codegraph_node --json (#1280)', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-node-json-'));
    fixture(testDir);
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('symbol mode: details, raw source and the trail, ANSI-free', async () => {
    const md = await handler.execute('codegraph_node', { symbol: 'caller', includeCode: true });
    const js = await handler.execute('codegraph_node', { symbol: 'caller', includeCode: true, format: 'json' });
    expect(js.content[0].text).not.toMatch(ANSI);
    const payload = JSON.parse(js.content[0].text);

    expect(payload.mode).toBe('symbol');
    expect(payload.symbol.name).toBe('caller');
    expect(payload.symbol.kind).toBe('function');
    expect(payload.symbol.filePath).toBe('src/feature.ts');
    expect(payload.symbol.startLine).toBe(2);
    expect(payload.stale).toBe(false);

    // Raw source — no `<line>\t` prefixes; the real start line rides alongside.
    expect(payload.source).toBe('export function caller() { return target(); }');
    expect(payload.sourceStartLine).toBe(2);
    expect(payload.source).not.toMatch(/^\d+\t/m);

    // The trail mirrors the markdown's Calls → line.
    expect(md.content[0].text).toContain('**Calls →** target (src/feature.ts:1)');
    expect(payload.calls.map((c: any) => c.name)).toEqual(['target']);
    expect(payload.calls[0].filePath).toBe('src/feature.ts');
    expect(payload.calls[0].startLine).toBe(1);
  });

  it('file mode: the read window, symbol map and dependents as data', async () => {
    const md = await handler.execute('codegraph_node', { file: 'src/feature.ts' });
    const js = await handler.execute('codegraph_node', { file: 'src/feature.ts', format: 'json' });
    expect(js.content[0].text).not.toMatch(ANSI);
    const payload = JSON.parse(js.content[0].text);

    expect(payload.mode).toBe('file');
    expect(payload.path).toBe('src/feature.ts');
    expect(payload.complete).toBe(true);
    expect(payload.startLine).toBe(1);

    // The source is the file's own bytes — the numbered markdown body with its
    // `<n>\t` prefixes stripped is exactly it.
    const onDisk = fs.readFileSync(path.join(testDir, 'src/feature.ts'), 'utf-8');
    expect(payload.source).toBe(onDisk);
    const numbered = md.content[0].text.split('\n').slice(2).join('\n');
    expect(numbered.replace(/^\d+\t/gm, '')).toBe(payload.source);

    // Symbol map + dependents, the blast radius the markdown header carries.
    expect(payload.symbols.map((s: any) => s.name)).toEqual(['target', 'caller']);
    expect(payload.dependents).toEqual(['src/feature.test.ts']);
  });

  it('file mode with offset/limit narrows the window like Read', async () => {
    const js = await handler.execute('codegraph_node', {
      file: 'src/feature.ts', offset: 2, limit: 1, format: 'json',
    });
    const payload = JSON.parse(js.content[0].text);
    expect(payload.startLine).toBe(2);
    expect(payload.endLine).toBe(2);
    expect(payload.complete).toBe(false);
    expect(payload.source).toBe('export function caller() { return target(); }');
  });

  it('symbolsOnly returns the structural map with no source', async () => {
    const js = await handler.execute('codegraph_node', {
      file: 'src/feature.ts', symbolsOnly: true, format: 'json',
    });
    const payload = JSON.parse(js.content[0].text);
    expect(payload.mode).toBe('file');
    expect(payload.symbolsOnly).toBe(true);
    expect(payload.symbols.map((s: any) => s.name)).toEqual(['target', 'caller']);
    expect(payload.source).toBeUndefined();
    expect(payload.dependents).toEqual(['src/feature.test.ts']);
  });

  it('a missing symbol is a JSON error, still exiting non-zero from the CLI', async () => {
    const js = await handler.execute('codegraph_node', { symbol: 'noSuchSymbol', format: 'json' });
    expect(js.isError).toBe(true);
    const payload = JSON.parse(js.content[0].text);
    expect(payload.error).toContain('noSuchSymbol');
    expect(payload.error).toContain('not found');
  });

  it('multiple definitions: every body the markdown packs, as data', async () => {
    const md = await handler.execute('codegraph_node', { symbol: 'dup', includeCode: true });
    const js = await handler.execute('codegraph_node', { symbol: 'dup', includeCode: true, format: 'json' });
    const text = md.content[0].text;
    const payload = JSON.parse(js.content[0].text);

    expect(payload.mode).toBe('symbol');
    expect(payload.ambiguous).toBe(true);
    expect(payload.definitions.length).toBe(2);
    // Both bodies the markdown renders in full are here, raw.
    for (const def of payload.definitions) {
      expect(text).toContain(def.symbol.filePath);
      expect(def.source).not.toMatch(/^\d+\t/m);
      expect(def.source.length).toBeGreaterThan(0);
    }
    expect(payload.definitions.map((d: any) => d.symbol.filePath).sort())
      .toEqual(['src/dupA.ts', 'src/dupB.ts']);
  });
});

describe('codegraph explore/node -j end-to-end (#1280)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-json-cli-'));
    fixture(testDir);
    const cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    cg.close();
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('explore -j prints parseable, ANSI-free JSON with source-bearing files', () => {
    const { stdout, code } = runCli(testDir, ['explore', 'target', '-j']);
    expect(code).toBe(0);
    expect(stdout).not.toMatch(ANSI);
    const payload = JSON.parse(stdout);
    expect(payload.files.length).toBeGreaterThan(0);
    expect(payload.files[0].source).toContain('export function target');
    expect(payload.blastRadius.length).toBeGreaterThan(0);
  });

  it('node -j (symbol) and node -f -j (file) print parseable JSON', () => {
    const sym = runCli(testDir, ['node', 'caller', '-j']);
    expect(sym.code).toBe(0);
    const symPayload = JSON.parse(sym.stdout);
    expect(symPayload.mode).toBe('symbol');
    expect(symPayload.symbol.name).toBe('caller');
    expect(symPayload.source).toContain('export function caller');

    const file = runCli(testDir, ['node', '-f', 'src/feature.ts', '-j']);
    expect(file.code).toBe(0);
    const filePayload = JSON.parse(file.stdout);
    expect(filePayload.mode).toBe('file');
    expect(filePayload.path).toBe('src/feature.ts');
    expect(filePayload.source).toContain('export function target');
  });

  it('the --json long form works for both commands', () => {
    const explore = runCli(testDir, ['explore', 'target', '--json']);
    expect(explore.code).toBe(0);
    expect(() => JSON.parse(explore.stdout)).not.toThrow();

    const node = runCli(testDir, ['node', 'caller', '--json']);
    expect(node.code).toBe(0);
    expect(JSON.parse(node.stdout).mode).toBe('symbol');
  });
});
