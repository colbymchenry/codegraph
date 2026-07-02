/**
 * `codegraph view` — interactive HTML graph renderer.
 *
 * Renders the index as a single self-contained HTML file with vis-network
 * bundled inline (works offline, no CDN). Exercised end-to-end against the
 * built binary, plus the underlying `getGraphView()` projection for the filter
 * modes (whole-graph / --symbol / --file) and the empty-match guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { EmptyGraphViewError } from '../src/graph/viewer';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function runView(cwd: string, extraArgs: string[]): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, 'view', ...extraArgs, '-p', cwd], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.status ?? 1 };
  }
}

describe('codegraph view', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-view-cmd-'));
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src/util.ts'),
      'export function add(a: number, b: number){ return a + b; }\n' +
        'export function calc(x: number){ return add(x, 1); }\n'
    );
    fs.writeFileSync(
      path.join(tempDir, 'src/main.ts'),
      'import { calc } from "./util";\nexport function run(){ return calc(5); }\n'
    );
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a self-contained HTML file with vis-network inlined (no CDN)', () => {
    const out = path.join(tempDir, 'graph.html');
    const { stdout, code } = runView(tempDir, ['-o', out]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Wrote \d+ nodes/);

    const html = fs.readFileSync(out, 'utf-8');
    // vis-network is bundled inline, not pulled from a CDN.
    expect(html).not.toContain('cdnjs');
    expect(html).not.toContain('src="http');
    expect(html).toContain('new vis.Network');
    expect(html).toContain('new vis.DataSet');
    // Bundling the whole minified lib makes the file large.
    expect(html.length).toBeGreaterThan(100_000);
  });

  it('defaults the output into the .codegraph/ directory (not the working tree)', () => {
    const { code } = runView(tempDir, []); // no -o
    expect(code).toBe(0);
    const defaultOut = path.join(tempDir, '.codegraph', 'codegraph_view.html');
    expect(fs.existsSync(defaultOut)).toBe(true);
  });

  it('--symbol scopes the title and payload to that symbol', () => {
    const out = path.join(tempDir, 's.html');
    const { code } = runView(tempDir, ['--symbol', 'add', '-o', out]);
    expect(code).toBe(0);
    const html = fs.readFileSync(out, 'utf-8');
    expect(html).toContain('<title>CodeGraph Viewer — add</title>');
  });

  it('prints a friendly hint (not a crash) when --symbol matches nothing', () => {
    const { stdout, stderr, code } = runView(tempDir, ['--symbol', 'zzz_no_such_symbol']);
    // Graceful: exit 0, hint on stdout, no stack trace.
    expect(code).toBe(0);
    expect(stdout).toMatch(/No symbol found matching/);
    expect(stderr).not.toMatch(/Error:/);
  });

  it('rejects a non-numeric --max-nodes', () => {
    const { stderr, code } = runView(tempDir, ['--max-nodes', 'abc']);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/max-nodes must be a positive integer/);
  });
});

describe('getGraphView() projection', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-view-api-'));
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src/util.ts'),
      'export function add(a: number, b: number){ return a + b; }\n' +
        'export function calc(x: number){ return add(x, 1); }\n'
    );
    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns render-ready nodes/edges/stats for the whole graph', () => {
    const data = cg.getGraphView();
    expect(data.nodes.length).toBeGreaterThan(0);
    expect(data.stats.totalNodes).toBe(data.nodes.length);
    expect(data.stats.totalEdges).toBe(data.edges.length);
    // Every node carries a color + group for the legend.
    for (const n of data.nodes) {
      expect(n.color).toMatch(/^#/);
      expect(typeof n.group).toBe('string');
    }
  });

  it('respects --max-nodes as a cap', () => {
    const data = cg.getGraphView({ maxNodes: 2 });
    expect(data.nodes.length).toBeLessThanOrEqual(2);
  });

  it('throws EmptyGraphViewError for an unknown symbol', () => {
    expect(() => cg.getGraphView({ symbol: 'definitely_not_here' })).toThrow(EmptyGraphViewError);
  });
});
