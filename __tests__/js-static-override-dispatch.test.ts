/**
 * The override-dispatch edges (`synthesizedBy: interface-impl`) linked a base
 * class's method to a subclass's method of the same name even when one was
 * `static` and the other not (#2761). In JavaScript and TypeScript a static
 * method is inherited and overridden by the subclass's static method, an
 * instance method by an instance method, and a call to one never runs the
 * other. JavaScript members also never recorded `static` at all, in the
 * kernel or the wasm extractor, so the edges couldn't tell them apart there.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult, Language } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

const MEMBERS = `export class Flags {
  static create() {}
  run() {}
  static handler = () => {};
  callback = () => {};
  static count = 0;
  value = 0;
  static async *stream() {}
  static get size() { return 1; }
  static() {}
}
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('a JS/TS class member records whether it is static (#2761)', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['typescript', 'tsx', 'javascript', 'jsx']);
  });

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

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);
  const variants = [['ts', 'typescript'], ['tsx', 'tsx'], ['js', 'javascript'], ['jsx', 'jsx']] as const;

  for (const backend of backends) {
    it.each(variants)(`in %s, ${backend}`, (ext, language) => {
      const members = extract(backend, `src/flags.${ext}`, MEMBERS, language).nodes
        .filter((n) => n.kind === 'method' || n.kind === 'property')
        .map((n) => `${n.name} ${n.kind} ${n.isStatic ? 'static' : 'instance'}`);
      expect(members).toEqual([
        'create method static', 'run method instance', 'handler method static', 'callback method instance',
        'count property static', 'value property instance', 'stream method static', 'size method static',
        // A member named `static` is an instance method.
        'static method instance',
      ]);
    });
  }

  it.runIf(kernelAvailable)('the kernel and the wasm extractor agree on every node', () => {
    for (const [ext, language] of variants) {
      const canon = (r: ExtractionResult) => r.nodes.map(({ updatedAt: _u, ...n }) => JSON.stringify(n, Object.keys(n).sort())).sort();
      expect(canon(extract('kernel', `src/flags.${ext}`, MEMBERS, language)), ext)
        .toEqual(canon(extract('wasm', `src/flags.${ext}`, MEMBERS, language)));
    }
  });
});

describe('an override pairs a static method with a static one only (#2761)', () => {
  let root = '';
  let graph: CodeGraph | null = null;

  afterEach(() => {
    graph?.close();
    graph = null;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  /** `base -> override` for every interface-impl edge, by qualified name and kind of method. */
  function overrides(g: CodeGraph, file: string): string[] {
    const out: string[] = [];
    const label = (id: string) => {
      const n = g.getNode(id)!;
      return `${n.isStatic ? 'static ' : ''}${n.qualifiedName}`;
    };
    for (const node of g.getNodesInFile(file)) {
      for (const e of g.getOutgoingEdges(node.id)) {
        if (e.kind === 'calls' && e.metadata?.synthesizedBy === 'interface-impl') out.push(`${label(e.source)} -> ${label(e.target)}`);
      }
    }
    return out.sort();
  }

  it('in TypeScript and JavaScript, for methods and callable fields', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-static-override-'));
    const classes = [
      // The issue's reproduction, and the other direction.
      'class B { s() {} }',
      'class A extends B { static s() {} }',
      'class StaticBase { static t() {} }',
      'class InstanceDerived extends StaticBase { t() {} }',
      // A static overriding a static, an instance method an instance one.
      'class SB { static make() {} }',
      'class SD extends SB { static make() {} }',
      'class IB { go() {} }',
      'class ID extends IB { go() {} }',
      // A base with both: each pairs with its own kind.
      'class Mixed { static m() {} m() {} }',
      'class StaticOnly extends Mixed { static m() {} }',
      'class InstanceOnly extends Mixed { m() {} }',
      // A subclass with both, like webpack's modules with a `static
      // deserialize()` beside the instance one: only that one overrides.
      'class Both extends IB { static go() {} go() {} }',
      // Callable class fields.
      'class FieldBase { run = () => {}; static start = () => {}; }',
      'class FieldDerived extends FieldBase { static run = () => {}; start = () => {}; }',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/classes.ts'), classes);
    fs.writeFileSync(path.join(root, 'src/classes.js'), classes);
    fs.writeFileSync(
      path.join(root, 'src/shapes.ts'),
      'export interface Shape { area(): number }\nexport class Square implements Shape { static area(): number { return 0; } }\nexport class Circle implements Shape { area(): number { return 1; } }\n',
    );
    // Java, whose override edges this leaves as they were.
    fs.writeFileSync(path.join(root, 'src/Base.java'), 'class Base { static void s() {} void r() {} }\nclass Derived extends Base { static void s() {} void r() {} }\n');
    graph = await CodeGraph.init(root, { index: true });

    const expected = [
      'IB::go -> Both::go',
      'IB::go -> ID::go',
      'Mixed::m -> InstanceOnly::m',
      'static Mixed::m -> static StaticOnly::m',
      'static SB::make -> static SD::make',
    ];
    expect(overrides(graph, 'src/classes.ts')).toEqual(expected);
    expect(overrides(graph, 'src/classes.js')).toEqual(expected);
    expect(overrides(graph, 'src/shapes.ts')).toEqual(['Shape::area -> Circle::area']);
    expect(overrides(graph, 'src/Base.java')).toEqual(['Base::r -> Derived::r', 'static Base::s -> static Derived::s']);
  }, 120_000);
});
