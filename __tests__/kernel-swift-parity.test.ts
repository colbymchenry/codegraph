/**
 * Kernel↔wasm Swift extraction parity (R7b of the kernel migration).
 *
 * Asserts the native walker (codegraph-kernel/src/swift.rs) produces the SAME
 * ExtractionResult as the wasm TreeSitterExtractor — nodes, edges, and
 * unresolved refs compared as canonicalized multisets — over the checked-in
 * torture fixture (torture.swift: the DEDICATED in-class property branch
 * (#1020 — computed→property with getter walk, static let/var→constant/
 * variable, stored→field, owner-attributed decorator/type/attr-arg refs,
 * observed-property field + class-attributed observer calls), extensions
 * (multi-segment resolveName, sugar `[Proto]` names, where-clauses),
 * everything-is-extends inheritance, the full call matrix (subscript reads,
 * `defer`, optional-chaining receivers, #750 re-encode, literal-set
 * membership quirks, implicit members), positional return types with the
 * nested-generic failure, present-false isAsync, `open`→internal visibility,
 * multi-case enum first-only minting, `/** *​/` docs ignored-and-chain-
 * breaking, value-ref targets incl. the declared-then-assigned
 * assignment-prune case the swift-nio sweep caught, SWIFT_SPEC fn-refs with
 * the label-forward skip and #selector shapes) and its CRLF variant (derived
 * in-memory — #1329); TortureTry.swift: calls written after `try!`, `try?`
 * and `try`, which the Windows kernels' grammar build misparsed;
 * TortureWrappedCalls.swift: calls through a prefix operator, `try` or
 * `await`, which the grammar wraps around the callee or receiver.
 *
 * The full-repo sweep lives in scripts/kernel-parity.mjs (Alamofire/vapor/
 * swift-nio, --max-deferral 0.3 — swift error incidence is structurally
 * 9–27% on BOTH arms); this suite keeps the invariant alive in `npm test`.
 * Skips when no kernel binary is staged; CODEGRAPH_KERNEL_EXPECT=1 turns
 * that into a failure (kernel-scaffold.test.ts).
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

describe.skipIf(!kernelBuilt)('kernel Swift extraction parity', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['swift']);
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
    const viaKernel = tryKernelExtract(filePath, source, 'swift');
    expect(viaKernel, `kernel extraction failed for ${filePath}`).not.toBeNull();

    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource(filePath, source, 'swift');
    delete process.env.CODEGRAPH_KERNEL;

    const k = canon(viaKernel!);
    const w = canon(viaWasm);
    expect(k.nodes, `${filePath}: nodes`).toEqual(w.nodes);
    expect(k.edges, `${filePath}: edges`).toEqual(w.edges);
    expect(k.refs, `${filePath}: refs`).toEqual(w.refs);
    expect(viaWasm.nodes.length).toBeGreaterThanOrEqual(minNodes);
  }

  it('torture fixture: property branch, extensions, call matrix, value refs, fn-refs', () => {
    const file = path.join(FIXTURE_DIR, 'torture.swift');
    assertParity('fixtures/torture.swift', fs.readFileSync(file, 'utf8'), 40);
  });

  // CRLF variant — the shape every Windows autocrlf checkout has. Derived in
  // memory so no platform or editor can silently normalize it away; pins the
  // JS-multiline-^ docstring semantics for `///` runs (#1329).
  it('torture fixture CRLF parity', () => {
    const file = path.join(FIXTURE_DIR, 'torture.swift');
    const crlf = fs.readFileSync(file, 'utf8').replace(/(?<!\r)\n/g, '\r\n');
    assertParity('fixtures/torture.swift (crlf)', crlf, 40);
  });

  // A composition's `&` line in a type body errored and swallowed the type;
  // the Swift preParse moves the `&` up a line, hoisted so both arms parse the
  // same bytes — and the file no longer defers.
  it('a composition typealias in a type body parses on both arms, LF and CRLF', () => {
    const source = [
      'extension StatusEditor {',
      '    final class EditorStore: NSObject {',
      '        typealias EditorClient = AutocompleteService.Client',
      '          & PostingService.Client',
      '          & CustomEmojiService.Client',
      '        let service: any Uploading',
      '          & Describing',
      '        func post() -> Bool { validate() }',
      '        func validate() -> Bool { true }',
      '    }',
      '}',
      '',
    ].join('\n');
    assertParity('src/EditorStore.swift', source, 5);
    assertParity('src/EditorStore.swift (crlf)', source.replace(/\n/g, '\r\n'), 5);
  });

  // `try!` before a call. The grammar's scanner keeps the `!` for `try!` with
  // a bit mask built as `1UL << 32`, which overflows where `unsigned long` is
  // 32 bits: the MSVC-built Windows kernels read the `!` as a logical not, so
  // `try! Message2(data: d)` was a call of `! Message2` (at the `!`) and
  // `try! Settings.Defaults.load()` lost its receiver. The kernel now compiles
  // the grammar with `1ULL`. Fails on the old Windows kernel only — macOS and
  // Linux have 64-bit longs.
  it('a call after try!, try? or try: same refs on both arms, LF and CRLF', () => {
    const source = fs.readFileSync(path.join(FIXTURE_DIR, 'TortureTry.swift'), 'utf8');
    assertParity('fixtures/TortureTry.swift', source, 10);
    assertParity('fixtures/TortureTry.swift (crlf)', source.replace(/(?<!\r)\n/g, '\r\n'), 10);

    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const refs = tryKernelExtract('fixtures/TortureTry.swift', source, 'swift')!.unresolvedReferences;
    const lines = source.split(/\r?\n/);
    // Where `token` starts on the first line containing `text`.
    const at = (text: string, token: string): { line: number; column: number } => {
      const i = lines.findIndex((l) => l.includes(text));
      expect(i, `fixture line "${text}"`).toBeGreaterThanOrEqual(0);
      return { line: i + 1, column: lines[i]!.indexOf(token, lines[i]!.indexOf(text)) };
    };
    const expectRef = (referenceName: string, referenceKind: string, where: { line: number; column: number }) =>
      expect(refs).toContainEqual(expect.objectContaining({ referenceName, referenceKind, ...where }));

    expectRef('Message2', 'calls', at('let msg2 = try! Message2(data: data!)', 'Message2'));
    expectRef('Realm', 'calls', at('try! Realm()', 'Realm'));
    expectRef('Repository', 'calls', at('static let shared = try! Repository', 'Repository'));
    expectRef('JSONDecoder.make', 'calls', at('try! JSONDecoder.make(', 'JSONDecoder'));
    expectRef('Settings.Defaults.load', 'calls', at('try! Settings.Defaults.load', 'Settings'));
    expectRef('Settings', 'references', at('try! Settings.Defaults.load', 'Settings'));
    expectRef('FileManager', 'references', at('try! FileManager.default', 'FileManager'));
    expectRef('Item', 'calls', at('try! Item(raw: $0)', 'Item'));
    // No callee on a `try!` line keeps the `!`.
    const tryBangLines = new Set(lines.flatMap((l, i) => (l.includes('try!') ? [i + 1] : [])));
    expect(refs.filter((r) => tryBangLines.has(r.line) && r.referenceName.includes('!'))).toEqual([]);
  });

  // A call the grammar wraps. A prefix operator binds to the leftmost operand
  // (`!isReady()` parses as `(!isReady)()`, `!store.contains(id)` as
  // `(!store).contains(id)`), and `try`/`await` before a chain to the part
  // before its last call (`try! Decoder().decode(d)` is
  // `(try! Decoder()).decode(d)`). Both engines read through the wrappers; an
  // implicit member (`.success(x)`) keeps its dot. An operator applied to a
  // parenthesized value parses as a call of the operator: `!(x)` stays a call
  // of `!`, and `-(x)`, which has no callee node, is no call (its argument
  // text used to be read as one: `-(id)` called `id`).
  it('a call through a prefix operator, try or await keeps its name and receiver, LF and CRLF', () => {
    const source = fs.readFileSync(path.join(FIXTURE_DIR, 'TortureWrappedCalls.swift'), 'utf8');
    assertParity('fixtures/TortureWrappedCalls.swift', source, 5);
    assertParity('fixtures/TortureWrappedCalls.swift (crlf)', source.replace(/(?<!\r)\n/g, '\r\n'), 5);

    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const refs = tryKernelExtract('fixtures/TortureWrappedCalls.swift', source, 'swift')!.unresolvedReferences;
    const lines = source.split(/\r?\n/);
    // The `kind` refs on the first line containing `text`, by name.
    const on = (text: string, kind: 'calls' | 'references'): string[] => {
      const i = lines.findIndex((l) => l.includes(text));
      expect(i, `fixture line "${text}"`).toBeGreaterThanOrEqual(0);
      return refs.filter((r) => r.line === i + 1 && r.referenceKind === kind).map((r) => r.referenceName).sort();
    };
    expect(on('let a = !isReady()', 'calls')).toEqual(['isReady']);
    expect(on('let b = !store.contains(id)', 'calls')).toEqual(['store.contains']);
    expect(on('let c = !Config.check()', 'calls')).toEqual(['Config.check']);
    expect(on('let d = -abs(id)', 'calls')).toEqual(['abs']);
    expect(on('let e = !Settings.Defaults.isOn()', 'calls')).toEqual(['Settings.Defaults.isOn']);
    expect(on('let e = !Settings.Defaults.isOn()', 'references')).toEqual(['Settings']);
    expect(on('let h = !Config.shared.isEnabled', 'references')).toEqual(['Config']);
    expect(on('let i = ~Mask.all.rawValue', 'references')).toEqual(['Mask']);
    expect(on('var negated: Bool = !Store.isEmpty()', 'calls')).toEqual(['Store.isEmpty']);
    expect(on('let j = try! Decoder()', 'calls')).toEqual(['Decoder', 'Decoder().decode']);
    expect(on('let k = try Parser.make()', 'calls')).toEqual(['Parser.make', 'Parser.make().parse']);
    expect(on('let l = try! Parser.make().tokens()', 'calls'))
      .toEqual(['Parser.make', 'Parser.make().tokens', 'Parser.make().tokens().first']);
    expect(on('let o = try !isValid(data)', 'calls')).toEqual(['isValid']);
    expect(on('let q = !(items.isEmpty)', 'calls')).toEqual(['!']);
    expect(on('let r = -(id + 1)', 'calls')).toEqual([]);
    expect(on('let s = -(id)', 'calls')).toEqual([]);
    expect(on('return !store.remove(id)', 'calls')).toEqual(['store.remove']);
    expect(on('guard !Task.isCancelled', 'calls')).toEqual(['isReady']);
    expect(on('guard !Task.isCancelled', 'references')).toEqual(['Task']);
    // Unchanged: an implicit member keeps its dot, a lowercase chain stays bare.
    expect(on('let p: Result<Int, Error> = .success(id)', 'calls')).toEqual(['.success']);
    expect(on('let n = await loader.load().items()', 'calls')).toEqual(['items', 'loader.load']);
  });

  it('files with parse errors defer to the wasm extractor (recovery is encoding-dependent)', () => {
    // A NEW-only regression construct (`#if` between enum cases — the swift
    // checklist's grammar-bump delta 5) — errors on the 0.7.3 grammar.
    const broken = 'enum E {\n  case a\n#if DEBUG\n  case b\n#endif\n}\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('src/Broken.swift', broken, 'swift')).toBeNull();
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('src/Broken.swift', broken, 'swift');
    delete process.env.CODEGRAPH_KERNEL;
    expect(viaWasm.nodes.some((n) => n.kind === 'file')).toBe(true);
  });
});
