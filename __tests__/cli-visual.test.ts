/**
 * `codegraph visual` — writes `.codegraph/visual.html` with a file-level D3 graph.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getCodeGraphDir } from '../src/directory';
import { buildVisualPayload, FILE_LINK_CAP, renderVisualHtml } from '../src/visual';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

describe('codegraph visual', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-visual-'));
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src/a.ts'),
      'export function alpha() { return beta(); }\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src/b.ts'),
      'export function beta() { return 1; }\n',
    );
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    cg.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('buildVisualPayload includes the file graph', () => {
    const db = DatabaseConnection.open(getDatabasePath(tempDir));
    const queries = new QueryBuilder(db.getDb());
    const payload = buildVisualPayload(queries);
    db.close();

    expect(payload.nodes.length).toBeGreaterThanOrEqual(2);
    expect(payload.nodes.some((n) => n.path.endsWith('a.ts') || n.id.endsWith('a.ts'))).toBe(true);
    expect(payload.nodes.every((n) => n.kind === 'file')).toBe(true);

    const nodeIds = new Set(payload.nodes.map((n) => n.id));
    for (const link of payload.links) {
      expect(nodeIds.has(link.source)).toBe(true);
      expect(nodeIds.has(link.target)).toBe(true);
    }
    expect(payload.links.length).toBeLessThanOrEqual(FILE_LINK_CAP);

    const html = renderVisualHtml(payload);
    expect(html).toContain('cdn.jsdelivr.net/npm/d3@7');
    expect(html).toContain('invertX');
    expect(html).not.toContain('File-Level');
    expect(html).not.toContain('Symbol-Level');
    expect(html).toContain('"nodes"');
    expect(html).toContain('"links"');
  });

  it('drops cross-file links whose endpoints are missing from files', () => {
    const db = DatabaseConnection.open(getDatabasePath(tempDir));
    const raw = db.getDb();
    // Plant an edge between symbols whose file_path is not in `files`
    // (mid-sync orphan shape) so the visual builder must skip it.
    const insertNode = raw.prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, is_exported, is_async, is_static, is_abstract, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertNode.run(
      'orphan-src', 'function', 'orphanSrc', 'orphanSrc', 'missing/src.ts', 'typescript',
      1, 1, 0, 0, 0, 0, 0, 0, Date.now(),
    );
    insertNode.run(
      'orphan-tgt', 'function', 'orphanTgt', 'orphanTgt', 'missing/tgt.ts', 'typescript',
      1, 1, 0, 0, 0, 0, 0, 0, Date.now(),
    );
    raw.prepare(`INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)`).run(
      'orphan-src',
      'orphan-tgt',
      'calls',
    );

    const queries = new QueryBuilder(raw);
    const payload = buildVisualPayload(queries);
    db.close();

    const nodeIds = new Set(payload.nodes.map((n) => n.id));
    expect(nodeIds.has('missing/src.ts')).toBe(false);
    expect(payload.links.every((l) => nodeIds.has(l.source) && nodeIds.has(l.target))).toBe(true);
    expect(
      payload.links.some((l) => l.source === 'missing/src.ts' || l.target === 'missing/tgt.ts'),
    ).toBe(false);
  });

  it('CodeGraph.writeVisualHtml writes .codegraph/visual.html', async () => {
    const cg = await CodeGraph.open(tempDir);
    const out = cg.writeVisualHtml();
    cg.close();

    const expected = path.join(getCodeGraphDir(tempDir), 'visual.html');
    expect(out).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
    const html = fs.readFileSync(expected, 'utf8');
    expect(html).toContain('d3@7');
    expect(html).not.toContain('Symbol-Level');
    expect(html).not.toContain('id="tabs"');
  });

  it('CLI visual command writes the HTML file', () => {
    const out = execFileSync(process.execPath, [BIN, 'visual', tempDir], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toMatch(/Wrote /);
    const htmlPath = path.join(getCodeGraphDir(tempDir), 'visual.html');
    expect(fs.existsSync(htmlPath)).toBe(true);
    const html = fs.readFileSync(htmlPath, 'utf8');
    expect(html).toContain('d3@7');
    expect(html).not.toContain('Symbol-Level');
    expect(html).toContain('"nodes"');
    expect(html).not.toContain('"symbols"');
  });
});
