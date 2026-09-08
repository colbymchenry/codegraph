/**
 * Kernel↔wasm C# extraction parity (R7b of the kernel migration).
 *
 * Asserts the native walker (codegraph-kernel/src/csharp.rs) produces the
 * SAME ExtractionResult as the wasm TreeSitterExtractor — nodes, edges, and
 * unresolved refs compared as canonicalized multisets — over the checked-in
 * torture fixtures:
 *
 *  - Torture.cs        — block namespace + nested/second-namespace quirks,
 *    base_list shapes, records, properties (incl. the bare-identifier
 *    signature loss and never-walked accessor bodies), fields/constants,
 *    events/operators/indexer/destructor (no nodes, calls → class), ctor
 *    initializer hole, explicit interface impl, local functions, the call
 *    zoo (raw member-access texts, chained re-encode, `(myDel)(x)` conv,
 *    `nameof`), instantiation shapes (incl. invisible `new()`/`new {}`/
 *    arrays), static value reads, C# type refs, fn-ref candidates
 *    (`+=` subscription, `this.X` bare-name form, initializer lists),
 *    value-ref targets + local shadow prune, preprocessor passthrough.
 *  - TortureFileScoped.cs — file-scoped namespace, alias-import quirks,
 *    positional records with base args (`BaseDto(Name)` full-text extends),
 *    C#12 primary-ctor base args (`(repo)` garbage extends preserved).
 *  - TortureTopLevel.cs   — top-level statements (zero-emission locals),
 *    top-level local function, trailing partial class.
 *
 * CRLF variants are derived in-memory (#1329 docstring semantics). The
 * full-repo sweep lives in scripts/kernel-parity.mjs (serilog /
 * Newtonsoft.Json / jellyfin for the §5 gate); this suite keeps the invariant
 * alive in `npm test`. Skips when no kernel binary is staged;
 * CODEGRAPH_KERNEL_EXPECT=1 turns that into a failure (kernel-scaffold.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelBuilt = fs.existsSync(KERNEL_PATH);

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'kernel-parity');

function canon(result: ExtractionResult): { nodes: string[]; edges: string[]; refs: string[] } {
  return {
    nodes: result.nodes
      .map(({ updatedAt: _u, ...n }) => JSON.stringify(n, Object.keys(n).sort()))
      .sort(),
    edges: result.edges.map((e) => JSON.stringify(e, Object.keys(e).sort())).sort(),
    refs: result.unresolvedReferences
      .map((r) => JSON.stringify(r, Object.keys(r).sort()))
      .sort(),
  };
}

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;
let savedEnv: Record<string, string | undefined>;

describe.skipIf(!kernelBuilt)('kernel C# extraction parity', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['csharp']);
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

  function assertParity(filePath: string, source: string, minNodes = 3): void {
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const viaKernel = tryKernelExtract(filePath, source, 'csharp');
    expect(viaKernel, `kernel extraction failed for ${filePath}`).not.toBeNull();

    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource(filePath, source, 'csharp');
    delete process.env.CODEGRAPH_KERNEL;

    const k = canon(viaKernel!);
    const w = canon(viaWasm);
    expect(k.nodes, `${filePath}: nodes`).toEqual(w.nodes);
    expect(k.edges, `${filePath}: edges`).toEqual(w.edges);
    expect(k.refs, `${filePath}: refs`).toEqual(w.refs);
    expect(viaWasm.nodes.length).toBeGreaterThanOrEqual(minNodes);
  }

  const FIXTURES: Array<{ file: string; minNodes: number }> = [
    { file: 'Torture.cs', minNodes: 40 },
    { file: 'TortureFileScoped.cs', minNodes: 8 },
    { file: 'TortureTopLevel.cs', minNodes: 2 },
  ];

  for (const { file, minNodes } of FIXTURES) {
    it(`${file}: namespaces, records, calls, holes, refs`, () => {
      const src = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
      assertParity(`fixtures/${file}`, src, minNodes);
    });

    // CRLF variant — the shape every Windows autocrlf checkout has. Derived in
    // memory so no platform or editor can silently normalize it away; pins the
    // JS-multiline-^ docstring semantics for `///` runs (#1329).
    it(`${file} CRLF parity`, () => {
      const src = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
      const crlf = src.replace(/(?<!\r)\n/g, '\r\n');
      assertParity(`fixtures/${file} (crlf)`, crlf, minNodes);
    });
  }

  // Cheap unit pins for the quirks a future grammar bump would silently move
  // (checklist §fixtures item 6) — parity is the assertion; the wasm arm is
  // the behavior oracle.
  const MICROS: Array<{ name: string; source: string; minNodes: number }> = [
    {
      name: 'alias-import to a qualified target keeps generic args in moduleName',
      source: 'using Coll = System.Collections.Generic.Dictionary<string, int>;\n',
      minNodes: 2,
    },
    {
      name: 'alias-import to a bare identifier captures the ALIAS name',
      source: 'using Short = SomeType;\n',
      minNodes: 2,
    },
    {
      name: 'C#12 primary-ctor base args emit the garbage `(repo)` extends ref',
      source: 'public class Svc(IRepo repo) : Base(repo), IThing { }\n',
      minNodes: 2,
    },
    {
      name: 'enum underlying type emits an extends ref named `byte`',
      source: 'public enum E : byte { A = 1, B }\n',
      minNodes: 4,
    },
    {
      name: 'nameof(...) emits a calls ref named `nameof`',
      source: 'public class C { void M() { var n = nameof(C); } }\n',
      minNodes: 3,
    },
    {
      name: 'this./base. callee prefixes are kept raw',
      source: 'public class C { void M() { this.Run(1); base.Go(); } }\n',
      minNodes: 3,
    },
    {
      name: 'bare-identifier-typed property loses its type in the signature',
      source: 'public class C { public Widget Parent { get; set; } }\n',
      minNodes: 3,
    },
    {
      name: 'bodiless struct mints no node; bodiless record still does',
      source: 'public record Empty;\n',
      minNodes: 2,
    },
  ];

  for (const m of MICROS) {
    it(`micro: ${m.name}`, () => {
      assertParity(`micro/${m.name.replace(/[^a-z0-9]+/gi, '-')}.cs`, m.source, m.minNodes);
    });
  }

  it('files with parse errors defer to the wasm extractor (recovery is encoding-dependent)', () => {
    const broken = 'class F { void M( { return }} 12 (\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('src/Broken.cs', broken, 'csharp')).toBeNull();
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('src/Broken.cs', broken, 'csharp');
    delete process.env.CODEGRAPH_KERNEL;
    expect(viaWasm.nodes.some((n) => n.kind === 'file')).toBe(true);
  });
});
