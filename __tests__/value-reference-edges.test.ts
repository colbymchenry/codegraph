/**
 * Value-reference edges (TS/JS): same-file `references` edges from a reader
 * symbol to the file-scope const/var it reads, so impact analysis catches
 * "change this constant, affect its readers". Default on; CODEGRAPH_VALUE_REFS=0
 * disables. See TreeSitterExtractor.flushValueRefs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src';

function valueRefReaders(cg: CodeGraph, constName: string): string[] {
  const target = cg.searchNodes(constName).map((r) => r.node).find((n) => n.name === constName);
  if (!target) return [];
  return cg
    .getIncomingEdges(target.id)
    .filter((e) => e.kind === 'references' && (e.metadata as { valueRef?: boolean } | undefined)?.valueRef)
    .map((e) => cg.getNode(e.source)?.name)
    .filter((n): n is string => Boolean(n));
}

describe('value-reference edges', () => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-valueref-'));
  });
  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function index(): CodeGraph {
    const g = CodeGraph.initSync(dir, { config: { include: ['**/*.ts', '**/*.tsx'], exclude: [] } });
    return g;
  }

  it('edges same-file readers to the file-scope const they read (default on)', async () => {
    fs.writeFileSync(
      path.join(dir, 'config.ts'),
      [
        'export const TABLE_CONFIG = { rows: 10, cols: 4 };',
        'export function rowCount() { return TABLE_CONFIG.rows; }',
        'export function describeTable() { return `${TABLE_CONFIG.rows}x${TABLE_CONFIG.cols}`; }',
        'export const HEADER = TABLE_CONFIG.cols;',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    const readers = valueRefReaders(cg, 'TABLE_CONFIG');
    // rowCount, describeTable, and the HEADER const all read TABLE_CONFIG.
    expect(readers).toEqual(expect.arrayContaining(['rowCount', 'describeTable', 'HEADER']));
  });

  it('surfaces those readers in the impact radius of the const', async () => {
    fs.writeFileSync(
      path.join(dir, 'palette.ts'),
      [
        'export const COLOR_PALETTE = { red: "#f00", blue: "#00f" };',
        'export function pickRed() { return COLOR_PALETTE.red; }',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    const target = cg.searchNodes('COLOR_PALETTE').map((r) => r.node).find((n) => n.name === 'COLOR_PALETTE')!;
    const impacted = [...cg.getImpactRadius(target.id).nodes.values()].map((n) => n.name);
    expect(impacted).toContain('pickRed');
  });

  it('does NOT edge a shadowed const — inner re-declaration makes the name ambiguous', async () => {
    // The Emscripten/bundled pattern: a file-scope `const Module` re-declared as
    // an inner `var Module` / param. Nested readers resolve to the INNER binding,
    // so a file-scope edge would be a false positive. The shadow guard drops it.
    fs.writeFileSync(
      path.join(dir, 'bundled.ts'),
      [
        'const Module = (function () {',
        '  return function (Module) {',
        '    var Module = typeof Module !== "undefined" ? Module : {};',
        '    function locate() { return Module.path; }',
        '    function getFunc() { return Module.lookup; }',
        '    return { locate, getFunc };',
        '  };',
        '})();',
        'export default Module;',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    // No reader should be edged to the outer `const Module`.
    expect(valueRefReaders(cg, 'Module')).toEqual([]);
  });

  it('emits nothing when CODEGRAPH_VALUE_REFS=0', async () => {
    const prev = process.env.CODEGRAPH_VALUE_REFS;
    process.env.CODEGRAPH_VALUE_REFS = '0';
    try {
      fs.writeFileSync(
        path.join(dir, 'config.ts'),
        ['export const TABLE_CONFIG = { rows: 10 };', 'export function rowCount() { return TABLE_CONFIG.rows; }'].join('\n'),
      );
      cg = index();
      await cg.indexAll();
      expect(valueRefReaders(cg, 'TABLE_CONFIG')).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_VALUE_REFS;
      else process.env.CODEGRAPH_VALUE_REFS = prev;
    }
  });
});
