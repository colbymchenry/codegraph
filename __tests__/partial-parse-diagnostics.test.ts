import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { getParser, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { getKernel, resetKernelForTests, tryKernelExtract, tryKernelExtractRaw } from '../src/extraction/kernel';

const broken = 'export function kept() { return 1; }\nexport const broken = ;\n';
const clean = 'export function kept() { return 1; }\n';
const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const kernelBuilt = fs.existsSync(path.resolve(__dirname, `../codegraph-kernel/prebuilds/${process.platform}-${process.arch}/codegraph-kernel.node`));
const roots: string[] = [];

function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-partial-parse-'));
  roots.push(dir);
  return dir;
}

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['typescript', 'javascript', 'cpp']);
});

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('partial parse diagnostics with surviving symbols (#3019)', () => {
  it.each([
    ['partial.ts', 'typescript', broken],
    ['partial.js', 'javascript', broken],
    ['partial.cpp', 'cpp', 'int kept() { return 1; }\nint broken = ;\n'],
  ] as const)('retains the parser diagnostic for %s', (file, language, source) => {
    const tree = getParser(language)!.parse(source)!;
    try { expect(tree.rootNode.hasError).toBe(true); } finally { tree.delete(); }
    const result = extractFromSource(file, source, language);
    expect(result.nodes.some(n => n.name === 'kept' && n.kind === 'function')).toBe(true);
    expect(result.errors).toEqual([
      expect.objectContaining({ filePath: file, severity: 'warning', code: 'partial_parse' }),
    ]);
  });

  it('exposes partial diagnostics through the public SDK without storing source', () => {
    const cg = CodeGraph.initSync(root());
    try {
      const result = cg.extractFromSource('partial.ts', broken);
      expect(result.nodes.some(n => n.name === 'kept')).toBe(true);
      expect(result.errors).toEqual([expect.objectContaining({ code: 'partial_parse' })]);
      expect(cg.getFiles()).toEqual([]);
      expect(cg.extractFromSource('clean.ts', clean).errors).toEqual([]);
    } finally { cg.close(); }
  });

  it.skipIf(!kernelBuilt)('native error recovery retains the same diagnostics as forced WASM', () => {
    const saved = process.env.CODEGRAPH_KERNEL;
    try {
      delete process.env.CODEGRAPH_KERNEL;
      resetKernelForTests();
      const kernel = getKernel();
      expect(kernel).not.toBeNull();
      expect(() => kernel!.extractFile('partial.ts', broken, 'typescript')).toThrow(/defer:/);
      expect(tryKernelExtractRaw('partial.ts', broken, 'typescript')).toBeNull();
      expect(tryKernelExtract('partial.ts', broken, 'typescript')).toBeNull();
      const routed = extractFromSource('partial.ts', broken, 'typescript');
      process.env.CODEGRAPH_KERNEL = '0';
      const wasm = extractFromSource('partial.ts', broken, 'typescript');
      expect(routed.errors).toEqual([expect.objectContaining({ code: 'partial_parse' })]);
      expect(routed.errors).toEqual(wasm.errors);
    } finally {
      if (saved === undefined) delete process.env.CODEGRAPH_KERNEL;
      else process.env.CODEGRAPH_KERNEL = saved;
      resetKernelForTests();
    }
  });

  it('compiled parse/store workers persist diagnostics, and sync clears them after repair', () => {
    const dir = root();
    fs.writeFileSync(path.join(dir, 'partial.ts'), broken);
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, [BIN, ...args], {
        cwd: dir, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_PARSE_WORKERS: '2', NO_COLOR: '1' },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result.stdout;
    };
    run('init');
    const readFile = () => JSON.parse(run('files', '--json')).find((f: { path: string }) => f.path === 'partial.ts');
    const file = readFile();
    expect(file.nodeCount).toBeGreaterThan(1);
    expect(file.errors).toEqual([expect.objectContaining({ code: 'partial_parse' })]);
    const cg = CodeGraph.openSync(dir, { readOnly: true });
    try {
      expect(cg.getFile('partial.ts')?.errors).toEqual([expect.objectContaining({ code: 'partial_parse' })]);
      expect(cg.getIndexHealth()).toEqual({ needsReindex: [], parseErrors: [] });
    } finally { cg.close(); }
    fs.writeFileSync(path.join(dir, 'partial.ts'), clean);
    run('sync');
    expect(readFile().errors).toEqual([]);
  });
});
