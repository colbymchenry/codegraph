import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../src/index';
import { importScipFile, runScipPass } from '../../src/scip';
import type { ScipLanguage } from '../../src/scip/store';

const FIXTURES = path.join(__dirname, '..', 'fixtures');

/**
 * What every merge must hold, whatever the language: the compiler's site and
 * codegraph's site for one call are the same site. When they are keyed apart, a
 * call ends up as two edges — a SCIP edge plus the heuristic one left unverified
 * beside it (commit 1748258: 90 such pairs on codegraph's own source, from
 * multi-line chains). Each fixture has one chain whose callee sits below the
 * line its expression starts on.
 */
const FIXTURE_CHAINS: Array<{ lang: ScipLanguage; dir: string; file: string; caller: string; callee: string; starts: string }> = [
  { lang: 'typescript', dir: 'scip-ts', file: 'src/main.ts', caller: 'chained', callee: 'totalPrice', starts: 'return new Invoice(4)' },
  { lang: 'python', dir: 'scip-py', file: 'shop/main.py', caller: 'chained', callee: 'total_price', starts: 'return (Invoice(4)' },
  { lang: 'go', dir: 'scip-go', file: 'shop/main.go', caller: 'Chained', callee: 'TotalPrice', starts: 'return NewInvoice(4).' },
  { lang: 'rust', dir: 'scip-rust', file: 'src/lib.rs', caller: 'chained', callee: 'total_price', starts: 'Invoice::new(5)' },
];

describe.each(FIXTURE_CHAINS)('SCIP merge invariants ($lang fixture)', ({ lang, dir: fixture, file, caller, callee, starts }) => {
  let dir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-scip-inv-${lang}-`));
    fs.cpSync(path.join(FIXTURES, fixture, 'project'), dir, { recursive: true });
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
    const built = path.join(dir, 'built.scip'); // "built" after the sources were copied in
    fs.copyFileSync(path.join(FIXTURES, fixture, 'index.scip'), built);
    importScipFile(dir, built, lang);
    await cg.scipWrite(db => runScipPass(db, dir));
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never leaves a call as a SCIP edge beside an unverified heuristic edge', () => {
    const pairs = cg.scipReadDb().prepare(`
      SELECT s.name AS source, t.name AS target, a.kind, a.line AS scipLine, b.line AS heuristicLine
      FROM edges a JOIN edges b ON b.source = a.source AND b.target = a.target AND b.kind = a.kind AND b.id <> a.id
      JOIN nodes s ON s.id = a.source JOIN nodes t ON t.id = a.target
      WHERE a.provenance = 'scip' AND (b.provenance IS NULL OR b.provenance = 'tree-sitter')`).all();
    expect(pairs).toEqual([]);
  });

  it('verifies a chained call at the line its expression starts on', () => {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/);
    const line = lines.findIndex(l => l.includes(starts)) + 1;
    expect(line).toBeGreaterThan(0);
    expect(lines[line]).toContain(callee); // the callee really sits on a later line
    const rows = cg.scipReadDb().prepare(`
      SELECT e.line, e.provenance FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
      WHERE e.kind = 'calls' AND s.name = ? AND t.name = ? AND s.file_path = ?`).all(caller, callee, file);
    expect(rows).toEqual([{ line, provenance: 'scip' }]);
  });
});
