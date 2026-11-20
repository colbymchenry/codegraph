/**
 * CommonJS export assignments name the function they hold (#1675).
 *
 * `exports.getItems = async (req, res) => {…}` and `module.exports.x =
 * function () {…}` are how Express controllers are commonly written. The
 * arrow is anonymous only syntactically — the export property is the name
 * every `router.get('/items', getItems)` resolves — so it gets the same
 * treatment `const getItems = () => {}` already has: a function node, exported,
 * with its calls attributed to it rather than to the file.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult, Language } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';
const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);
const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

function extract(backend: 'kernel' | 'wasm', file: string, source: string, language: Language): ExtractionResult {
  if (backend === 'wasm') {
    process.env.CODEGRAPH_KERNEL = '0';
    return extractFromSource(file, source, language);
  }
  delete process.env.CODEGRAPH_KERNEL;
  process.env.CODEGRAPH_KERNEL_LANGS = 'all';
  const result = tryKernelExtract(file, source, language);
  expect(result, `kernel extraction of ${file}`).not.toBeNull();
  return result!;
}

const refsFrom = (result: ReturnType<typeof extractFromSource>, id: string) =>
  result.unresolvedReferences.filter((r) => r.fromNodeId === id).map((r) => r.referenceName);

describe('CommonJS export assignments', () => {
  it('indexes exports.X / module.exports.X functions as exported function nodes', () => {
    const code = `
const { findItems, removeItem } = require('./db');

exports.getItems = async (req, res) => {
  res.json(await findItems());
};

module.exports.deleteItem = function (req, res) {
  removeItem(req.params.id);
  res.end();
};

exports.plain = 42;
module.exports = { legacy: 1 };
`;
    const result = extractFromSource('src/controller.js', code);
    const fns = result.nodes.filter((n) => n.kind === 'function');
    expect(fns.map((n) => n.name).sort()).toEqual(['deleteItem', 'getItems']);

    const getItems = fns.find((n) => n.name === 'getItems')!;
    const deleteItem = fns.find((n) => n.name === 'deleteItem')!;
    expect(getItems.startLine).toBe(4);
    expect(getItems.isExported).toBe(true);
    expect(deleteItem.isExported).toBe(true);
    expect(getItems.isAsync).toBe(true);

    // The handlers' calls are their own, not the file's.
    expect(refsFrom(result, getItems.id)).toContain('findItems');
    expect(refsFrom(result, deleteItem.id)).toContain('removeItem');
    const file = result.nodes.find((n) => n.kind === 'file')!;
    expect(refsFrom(result, file.id)).not.toContain('findItems');
    expect(refsFrom(result, file.id)).not.toContain('removeItem');

    // A non-function export is not a function, and nothing is left anonymous.
    expect(result.nodes.map((n) => n.name)).not.toContain('<anonymous>');
  });

  it('leaves other member assignments alone', () => {
    const code = `
const handlers = {};
handlers.onSave = () => { persist(); };
app.locals.format = function () { return 1; };
`;
    const result = extractFromSource('src/other.js', code);
    expect(result.nodes.filter((n) => n.kind === 'function')).toEqual([]);
  });
});

describe('CommonJS export assignments with the name in quotes', () => {
  // `exports["getItems"] = …` is the same export as `exports.getItems = …`,
  // but only the dotted form named its function: the bracket form left the
  // handler without a node, so its calls belonged to the file and nothing
  // could reach it.
  let savedEnv: Record<string, string | undefined> = {};
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

  const code = `
const { findItems, removeItem } = require('./db');

exports["getItems"] = async (req, res) => {
  res.json(await findItems());
};

module.exports['deleteItem'] = function (req, res) {
  removeItem(req.params.id);
  res.end();
};

exports["not-a-name"] = () => { skipped(); };
exports[key] = () => { computed(); };
exports[\`tpl\`] = () => { template(); };
handlers["onSave"] = () => { persist(); };
`;

  const summary = (result: ExtractionResult) =>
    result.nodes
      .filter((n) => n.kind === 'function')
      .map((n) => `${n.name}@${n.startLine} exported=${n.isExported} async=${n.isAsync}`)
      .sort();

  it.each(backends)('names the function an identifier in quotes exports: %s', (backend) => {
    for (const [file, language] of [['src/controller.js', 'javascript'], ['src/controller.ts', 'typescript']] as const) {
      const result = extract(backend, file, code, language);
      expect(summary(result), file).toEqual(['deleteItem@8 exported=true async=false', 'getItems@4 exported=true async=true']);

      const fn = (name: string) => result.nodes.find((n) => n.kind === 'function' && n.name === name)!;
      expect(refsFrom(result, fn('getItems').id)).toContain('findItems');
      expect(refsFrom(result, fn('deleteItem').id)).toContain('removeItem');
      const fileNode = result.nodes.find((n) => n.kind === 'file')!;
      expect(refsFrom(result, fileNode.id)).not.toContain('findItems');
      expect(refsFrom(result, fileNode.id)).not.toContain('removeItem');
    }
  });

  it.runIf(kernelAvailable)('reads the same in both engines', () => {
    for (const [file, language] of [['src/controller.js', 'javascript'], ['src/controller.ts', 'typescript']] as const) {
      const kernel = extract('kernel', file, code, language);
      const wasm = extract('wasm', file, code, language);
      const nodes = (r: ExtractionResult) => r.nodes.map((n) => `${n.kind} ${n.qualifiedName} ${n.startLine}-${n.endLine} ${n.isExported}`).sort();
      const refs = (r: ExtractionResult) => r.unresolvedReferences.map((x) => `${x.referenceKind} ${x.referenceName} ${x.line}:${x.column} ${x.fromNodeId}`).sort();
      expect(nodes(kernel), file).toEqual(nodes(wasm));
      expect(refs(kernel), file).toEqual(refs(wasm));
    }
  });
});
