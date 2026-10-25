/**
 * Export status is answered in ONE place (#1721).
 *
 * Three implementations used to answer "is this name exported from this file",
 * none sharing code, and they disagreed:
 *
 *   1. `isExported` — the AST predicate on the TS/JS extractors, walking the
 *      parent chain for an `export_statement` ancestor. Exact for
 *      `export function f`, blind to everything else: `const x = …; export {
 *      x }` and every CommonJS form left it false.
 *   2. `isExportedLater` — a regex over the file source, existing only because
 *      of that blindness, hand-mirrored in the Rust kernel.
 *   3. A third per-file check in the resolver (`isSealedModule`).
 *
 * The visible damage: a CommonJS module's exports were invisible to the graph
 * as exports, `export { x }` was visible only to store extraction, and the
 * resolver re-derived a coarser version of the same fact from the same text.
 *
 * `src/extraction/export-status.ts` is now the single answer, and
 * `codegraph-kernel/src/tsjs/export_status.rs` mirrors it for the native
 * walker. This file covers the blind spots end to end — through extraction, on
 * BOTH paths — so the mirror cannot drift from the source of truth.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import {
  fileExportsAnything,
  isCommonJsExportedName,
  isEsModuleSource,
  isExportedLaterInSource,
  isSealedModuleSource,
  exportedNamesInSource,
  commonJsExportNameFromAssignment,
  commonJsObjectExportNames,
} from '../src/extraction/export-status';
import type { ExtractionResult, Language } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelBuilt = fs.existsSync(KERNEL_PATH);

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

/** The blind cases: every form the AST parent-walk cannot see. */
const BLIND_CASES: [label: string, source: string, file: string, language: Language][] = [
  ['later export { x }', 'const x = 1;\nexport { x };', 'src/probe.js', 'javascript'],
  ['export default x', 'const x = 1;\nexport default x;', 'src/probe.js', 'javascript'],
  ['module.exports = { x }', 'const x = 1;\nmodule.exports = { x };', 'src/probe.js', 'javascript'],
  ['exports.x = x', 'const x = 1;\nexports.x = x;', 'src/probe.js', 'javascript'],
  ['exports["x"] = x', 'const x = 1;\nexports["x"] = x;', 'src/probe.js', 'javascript'],
  ['ts: later export { x }', 'const x = 1;\nexport { x };', 'src/probe.ts', 'typescript'],
  ['ts: export default x', 'const x = 1;\nexport default x;', 'src/probe.ts', 'typescript'],
];

/** The declaration forms the AST walk is already exact on — must stay exported. */
const DECLARED_CASES: [label: string, source: string, file: string, language: Language][] = [
  ['export function f', 'export function f() {}', 'src/probe.js', 'javascript'],
  ['export const x', 'export const x = 1;', 'src/probe.js', 'javascript'],
  ['exports.fn arrow', 'exports.getItems = async (req, res) => {};', 'src/probe.js', 'javascript'],
];

const exportedFlags = (result: ExtractionResult) =>
  result.nodes.filter((n) => n.kind !== 'file').map((n) => `${n.kind}:${n.name}=${n.isExported}`);

describe('export-status source scan', () => {
  it('reads every ESM and CommonJS export form', () => {
    expect(isExportedLaterInSource('const x = 1;\nexport { x };', 'javascript', 'x')).toBe(true);
    expect(isExportedLaterInSource('const x = 1;\nexport default x;', 'javascript', 'x')).toBe(true);
    expect(isExportedLaterInSource('const x = 1;\nexport { x as default };', 'javascript', 'x')).toBe(true);
    expect(isCommonJsExportedName('const x = 1;\nexports.x = x;', 'x')).toBe(true);
    expect(isCommonJsExportedName('module.exports.x = 1;', 'x')).toBe(true);
    expect(isCommonJsExportedName('exports["x"] = 1;', 'x')).toBe(true);
    expect(isCommonJsExportedName('const x = 1;\nmodule.exports = { x };', 'x')).toBe(true);
    expect(isCommonJsExportedName('module.exports = { x: impl };', 'x')).toBe(true);
    expect(isCommonJsExportedName("module.exports = { 'x': impl };", 'x')).toBe(true);
  });

  it('does not read a name that is merely mentioned', () => {
    expect(isExportedLaterInSource('const x = 1;\nexport { y };', 'javascript', 'x')).toBe(false);
    expect(isExportedLaterInSource('const x = 1;\nexport { items$ };', 'javascript', 'items')).toBe(false);
    expect(isCommonJsExportedName('exports.y = 1;', 'x')).toBe(false);
    expect(isCommonJsExportedName('module.exports = { y };', 'x')).toBe(false);
  });

  it('is not fooled by a comment or a string', () => {
    expect(fileExportsAnything('// export { x }\nconst x = 1;', 'javascript')).toBe(false);
    expect(fileExportsAnything("const s = 'export { x }';\nconst x = 1;", 'javascript')).toBe(false);
    expect(isExportedLaterInSource('// export { x }\nconst x = 1;', 'javascript', 'x')).toBe(false);
  });

  it('answers the per-file questions the resolver asks', () => {
    expect(fileExportsAnything('export const x = 1;', 'javascript')).toBe(true);
    expect(fileExportsAnything('module.exports = { x };', 'javascript')).toBe(true);
    expect(fileExportsAnything('declare global { interface Window {} }', 'typescript')).toBe(true);
    expect(fileExportsAnything('const x = 1;', 'javascript')).toBe(false);

    // A module that imports and exports nothing is sealed; a classic script is not.
    expect(isSealedModuleSource("import { a } from './a';\nconst x = 1;", 'javascript')).toBe(true);
    expect(isSealedModuleSource('const x = 1;\nwindow.x = x;', 'javascript')).toBe(false);
    // CommonJS is exempt — `module.exports` counts as an export.
    expect(isSealedModuleSource("const a = require('./a');\nmodule.exports = { a };", 'javascript')).toBe(false);
    // Other languages have no equivalent boundary.
    expect(isSealedModuleSource('import os\nx = 1', 'python')).toBe(false);

    expect(isEsModuleSource('export const x = 1;', 'javascript')).toBe(true);
    expect(isEsModuleSource('module.exports = { x };', 'javascript')).toBe(false);
  });

  it('reads a CommonJS assignment name from either the dot or the bracket form', () => {
    expect(commonJsExportNameFromAssignment('exports.x')).toBe('x');
    expect(commonJsExportNameFromAssignment('module.exports.x')).toBe('x');
    expect(commonJsExportNameFromAssignment('exports["x"]')).toBe('x');
    expect(commonJsExportNameFromAssignment("exports['x']")).toBe('x');
    expect(commonJsExportNameFromAssignment('other.x')).toBe(null);
    expect(commonJsExportNameFromAssignment('exports.x.y')).toBe(null);
  });

  it('lists object-literal export names, skipping a spread it cannot know', () => {
    expect(commonJsObjectExportNames('{ x, y: impl, ...rest }')).toEqual(['x', 'y']);
    expect(commonJsObjectExportNames('notAnObject')).toBe(null);
  });

  it('collects every exported name, including both sides of an alias', () => {
    const names = exportedNamesInSource(
      'const a = 1;\nexport { a, b as c };\nexport const d = 2;',
      'javascript'
    );
    // `b as c` contributes BOTH: `b` is the local binding and `c` the exported
    // name, and a caller asking "is this name exported" may mean either.
    expect([...names].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('export status through extraction', () => {
  it.each([...DECLARED_CASES, ...BLIND_CASES])(
    '%s: the declaration is exported',
    (_label, source, file, language) => {
      const result = extractFromSource(file, source, language);
      const flags = exportedFlags(result);
      expect(flags.length, `no node extracted for ${file}`).toBeGreaterThan(0);
      for (const flag of flags) expect(flag, `${file}: ${flag}`).toMatch(/=true$/);
    }
  );

  it('names a CommonJS function export after its property, not the file', () => {
    const result = extractFromSource('src/probe.js', 'exports.getItems = async (req, res) => {};');
    const fn = result.nodes.find((n) => n.kind === 'function');
    expect(fn?.name).toBe('getItems');
    expect(fn?.isExported).toBe(true);
  });
});

/**
 * The drift guard for the Rust mirror. The kernel answers export status from
 * its own port of the same scan (codegraph-kernel/src/tsjs/export_status.rs);
 * if the two disagree on any form, the graph would depend on which path
 * extracted the file. Compares the whole ExtractionResult, canonicalized.
 */
describe.skipIf(!kernelBuilt)('kernel↔wasm export-status parity', () => {
  const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetKernelForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetKernelForTests();
  });

  const canon = (result: ExtractionResult) => ({
    nodes: result.nodes
      .map(({ updatedAt: _u, ...n }) => JSON.stringify(n, Object.keys(n).sort()))
      .sort(),
    edges: result.edges.map((e) => JSON.stringify(e, Object.keys(e).sort())).sort(),
    refs: result.unresolvedReferences.map((r) => JSON.stringify(r, Object.keys(r).sort())).sort(),
  });

  it.each([...DECLARED_CASES, ...BLIND_CASES])(
    '%s: the kernel and the wasm path agree',
    (_label, source, file, language) => {
      process.env.CODEGRAPH_KERNEL_LANGS = 'all';
      delete process.env.CODEGRAPH_KERNEL;
      const viaKernel = tryKernelExtract(file, source, language);
      expect(viaKernel, `kernel extraction failed for ${file}`).not.toBeNull();

      process.env.CODEGRAPH_KERNEL = '0';
      const viaWasm = extractFromSource(file, source, language);
      delete process.env.CODEGRAPH_KERNEL;

      expect(canon(viaKernel!)).toEqual(canon(viaWasm));
    }
  );
});
