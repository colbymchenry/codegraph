/**
 * Disk-drift guard on code-slice renders (issue #1474).
 *
 * codegraph_node / codegraph_explore read CURRENT bytes from disk but slice
 * them at INDEXED line ranges. When a file changed after its last index sync,
 * that slice is a DIFFERENT symbol's code served under the requested name —
 * `isError: false`, introduced by the "verbatim … do not Read" guarantee. The
 * watcher-based pending banner (#403) cannot cover a project reached via
 * `projectPath` (cross-project instances have no watcher, by construction).
 *
 * The fix verifies freshness at the point of emission from data the index
 * already stores (files.size / modified_at, content_hash on stat mismatch):
 * a drifted file is never rendered as a slice — small files ship whole and
 * current (Read-parity), large ones are omitted with an explicit notice.
 *
 * These tests exercise the full real path: real index + real
 * ToolHandler.execute(), including the cross-project `projectPath` form the
 * issue was filed against.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler, __setLoadCodeGraphForTests } from '../src/mcp/tools';

/** ~1,100-line file: handler0…handler79 plus `orchestrate` at the bottom —
 * mirrors the issue's fixture. Big enough that explore takes the clustered
 * render and codegraph_node's whole-file stale fallback does NOT fit. */
function bigFileContent(): string {
  const parts: string[] = [];
  for (let h = 0; h < 80; h++) {
    parts.push(`/** handler number ${h} */`);
    parts.push(`export function handler${h}(input: string): string {`);
    for (let s = 0; s < 8; s++) {
      parts.push(`  const v${s} = input + "-step${s}-h${h}";`);
    }
    parts.push(`  return v7;`);
    parts.push(`}`);
    parts.push('');
  }
  parts.push(`export function orchestrate(input: string): string {`);
  parts.push(`  handler0(input);`);
  parts.push(`  handler1(input);`);
  parts.push(`  handler2(input);`);
  parts.push(`  handler3(input);`);
  parts.push(`  return input;`);
  parts.push(`}`);
  parts.push('');
  return parts.join('\n');
}

/** 45 lines of new helpers inserted at the top — shifts every symbol down. */
function insertedPrelude(): string {
  const parts: string[] = [];
  for (let h = 0; h < 4; h++) {
    parts.push(`/** inserted helper ${h} */`);
    parts.push(`export function insertedHelper${h}(x: number): number {`);
    for (let s = 0; s < 7; s++) {
      parts.push(`  x = x + ${s};`);
    }
    parts.push(`  return x;`);
    parts.push(`}`);
  }
  parts.push('');
  return parts.join('\n') + '\n';
}

function getText(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

describe('MCP stale-slice guard (#1474)', () => {
  let fixtureDir: string; // the project that goes stale
  let otherDir: string;   // a different indexed project — the server's default
  let cgFixture: CodeGraph;
  let cgOther: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stale-slice-fx-'));
    otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stale-slice-other-'));
    fs.mkdirSync(path.join(fixtureDir, 'src'));
    fs.mkdirSync(path.join(otherDir, 'src'));
    fs.writeFileSync(path.join(fixtureDir, 'src', 'big.ts'), bigFileContent());
    fs.writeFileSync(
      path.join(fixtureDir, 'src', 'small.ts'),
      'export function smallTarget(n: number): number {\n  return n * 2;\n}\n',
    );
    fs.writeFileSync(
      path.join(otherDir, 'src', 'unrelated.ts'),
      'export function unrelated() { return 0; }\n',
    );

    cgFixture = CodeGraph.initSync(fixtureDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cgFixture.indexAll();
    cgOther = CodeGraph.initSync(otherDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cgOther.indexAll();
    // The issue's exact topology: the server's default project is a DIFFERENT
    // project; the stale one is reached via `projectPath` and therefore has no
    // watcher — the #403/#876 banners cannot fire for it by construction.
    // (The seam services ToolHandler's lazy cross-project require, which
    // vitest's module transform can't resolve.)
    __setLoadCodeGraphForTests(CodeGraph);
    handler = new ToolHandler(cgOther);
  });

  afterEach(() => {
    __setLoadCodeGraphForTests(null);
    try { handler.closeAll(); } catch { /* ignore */ }
    try { cgFixture.close(); } catch { /* ignore */ }
    try { cgOther.close(); } catch { /* ignore */ }
    for (const dir of [fixtureDir, otherDir]) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function shiftBigFile(): void {
    const p = path.join(fixtureDir, 'src', 'big.ts');
    fs.writeFileSync(p, insertedPrelude() + fs.readFileSync(p, 'utf-8'));
  }

  it('codegraph_node never serves another symbol\'s body from a drifted file (cross-project)', async () => {
    shiftBigFile();
    const result = await handler.execute('codegraph_node', {
      symbol: 'orchestrate',
      includeCode: true,
      projectPath: fixtureDir,
    });
    const text = getText(result);
    expect(result.isError).toBeFalsy();
    // The pre-fix failure: the indexed range now lands in handler76/handler77.
    expect(text).not.toContain('-h76');
    expect(text).not.toContain('handler77');
    // The drift is announced and the agent is pointed at trustworthy reads.
    expect(text).toContain('changed on disk after it was last indexed');
    expect(text).toContain('orchestrate');
  });

  it('codegraph_node serves the full CURRENT source of a small drifted file (Read-parity fallback)', async () => {
    const p = path.join(fixtureDir, 'src', 'small.ts');
    fs.writeFileSync(p, '/** new first line */\nexport const shift = 1;\n' + fs.readFileSync(p, 'utf-8'));
    const result = await handler.execute('codegraph_node', {
      symbol: 'smallTarget',
      includeCode: true,
      projectPath: fixtureDir,
    });
    const text = getText(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain('full CURRENT source');
    // Current content, including the just-inserted lines the index knows nothing about.
    expect(text).toContain('new first line');
    expect(text).toContain('smallTarget');
  });

  it('an identical rewrite (mtime churn, same bytes) does not trip the guard', async () => {
    const p = path.join(fixtureDir, 'src', 'big.ts');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf-8'));
    const result = await handler.execute('codegraph_node', {
      symbol: 'orchestrate',
      includeCode: true,
      projectPath: fixtureDir,
    });
    const text = getText(result);
    expect(text).not.toContain('changed on disk');
    expect(text).toContain('export function orchestrate');
  });

  it('codegraph_explore omits (never mis-slices) a big drifted file and flags line refs', async () => {
    shiftBigFile();
    const result = await handler.execute('codegraph_explore', {
      query: 'orchestrate handler3',
      projectPath: fixtureDir,
    });
    const text = getText(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain('changed on disk after the last index sync');
    // No sliced body from the drifted file — its step lines must not appear.
    expect(text).not.toMatch(/-step\d-h\d/);
    // Line-reference caveat for the drifted file.
    expect(text).toContain('may be shifted');
  });

  it('re-syncing the project restores normal output with no drift markers', async () => {
    shiftBigFile();
    await cgFixture.sync();
    // Fresh handler: the drift verdict is briefly memoized per handler.
    const freshHandler = new ToolHandler(cgOther);
    try {
      const result = await freshHandler.execute('codegraph_node', {
        symbol: 'orchestrate',
        includeCode: true,
        projectPath: fixtureDir,
      });
      const text = getText(result);
      expect(text).not.toContain('changed on disk');
      expect(text).toContain('export function orchestrate');
      // Location reflects the post-shift position (45 inserted lines).
      expect(text).toMatch(/Location:\*\* src\/big\.ts:\d+/);
    } finally {
      try { freshHandler.closeAll(); } catch { /* ignore */ }
    }
  });

  it('the guard also fires on the default project when no watcher is running', async () => {
    shiftBigFile();
    const direct = new ToolHandler(cgFixture);
    try {
      const result = await direct.execute('codegraph_node', {
        symbol: 'orchestrate',
        includeCode: true,
      });
      const text = getText(result);
      expect(text).not.toContain('handler77');
      expect(text).toContain('changed on disk after it was last indexed');
    } finally {
      try { direct.closeAll(); } catch { /* ignore */ }
    }
  });
});
