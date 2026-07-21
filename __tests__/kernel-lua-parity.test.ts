/**
 * Kernel↔wasm Lua + Luau extraction parity (R7b batch 4 of the kernel
 * migration).
 *
 * Asserts the native walker (codegraph-kernel/src/lua.rs — one module, two
 * dialects) produces the SAME ExtractionResult as the wasm
 * TreeSitterExtractor — nodes, edges, and unresolved refs compared as
 * canonicalized multisets — over the checked-in torture fixtures
 * (torture.lua: the require quintet incl. Roblox instance paths, the
 * BFS-string-win and .field/dynamic silences, receiver-QN methods
 * `M.sub.deep::chained` and `_G::installed`, the top-level
 * local-vs-global initializer-visibility inversion, body-level
 * `calls "require"`, table fn-ref registries with dedupe and the
 * `M.cb = cb` param-storage skip, the raw-text callee zoo with colon/
 * bracket/call-result callees and the `(handler)` conversion, LuaDoc
 * `- `-keeping docstrings, `<const>` attributes, one-line duplicate-id
 * declarations; torture.luau: `--!strict` docstring joining, `export type`
 * isExported, verbatim `Generic<T>` alias names, the typeof(require(...))
 * alias+import pair, typed signatures with return suffixes, interpolation/
 * if-expression/compound-assign call shapes) and their CRLF variants
 * (derived in-memory — #1329, pinning the block-comment `\r\n` docstring
 * byte), plus glue-chain and defer pins.
 *
 * The full-repo sweeps live in scripts/kernel-parity.mjs (kong/lazy.nvim/
 * lua-resty-core + lune/Fusion for the §5 gate); this suite keeps the
 * invariant alive in `npm test`. Skips when no kernel binary is staged;
 * CODEGRAPH_KERNEL_EXPECT=1 turns that into a failure.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
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

describe.skipIf(!kernelBuilt)('kernel Lua/Luau extraction parity', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['lua', 'luau']);
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

  function assertParity(
    filePath: string,
    source: string,
    lang: Language,
    minNodes = 3
  ): ExtractionResult {
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const viaKernel = tryKernelExtract(filePath, source, lang);
    expect(viaKernel, `kernel extraction failed for ${filePath}`).not.toBeNull();

    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource(filePath, source, lang);
    delete process.env.CODEGRAPH_KERNEL;

    const k = canon(viaKernel!);
    const w = canon(viaWasm);
    expect(k.nodes, `${filePath}: nodes`).toEqual(w.nodes);
    expect(k.edges, `${filePath}: edges`).toEqual(w.edges);
    expect(k.refs, `${filePath}: refs`).toEqual(w.refs);
    expect(viaWasm.nodes.length).toBeGreaterThanOrEqual(minNodes);
    return viaKernel!;
  }

  it('torture.lua: requires, receiver QNs, visibility inversion, callee zoo, fn-refs', () => {
    const file = path.join(FIXTURE_DIR, 'torture.lua');
    const result = assertParity('fixtures/torture.lua', fs.readFileSync(file, 'utf8'), 'lua', 20);

    // Kernel-arm pins so both arms drifting together can't silently lose the
    // dialect-defining quirks (checklist §Require hook / §extractCall):
    const refs = result.unresolvedReferences;
    // Top-level requires became imports; the body-level require is a CALL.
    expect(result.nodes.some((n) => n.kind === 'import' && n.name === 'app.core')).toBe(true);
    expect(refs.some((r) => r.referenceKind === 'calls' && r.referenceName === 'require')).toBe(
      true
    );
    // Roblox instance path → trailing segment; string-win beats the path.
    expect(result.nodes.some((n) => n.kind === 'import' && n.name === 'Signal')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'import' && n.name === 'Child')).toBe(true);
    // Colon callees keep the colon, self never stripped.
    expect(refs.some((r) => r.referenceName === 'self:helperMethod')).toBe(true);
    // Receiver-qualified method QNs are verbatim dotted receivers.
    expect(result.nodes.some((n) => n.kind === 'method' && n.qualifiedName === 'M.sub.deep::chained')).toBe(true);
    // lua functions carry NO isExported (undefined — not false).
    const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'topFn');
    expect(fn?.isExported).toBeUndefined();
    // variables DO carry isExported === false.
    const v = result.nodes.find((n) => n.kind === 'variable' && n.name === 'core');
    expect(v?.isExported).toBe(false);
  });

  it('torture.lua CRLF parity (block-comment docstrings keep interior \\r\\n)', () => {
    const file = path.join(FIXTURE_DIR, 'torture.lua');
    const crlf = fs.readFileSync(file, 'utf8').replace(/(?<!\r)\n/g, '\r\n');
    assertParity('fixtures/torture.lua (crlf)', crlf, 'lua', 20);
  });

  it('torture.luau: type aliases, export flags, typed signatures, typeof-require', () => {
    const file = path.join(FIXTURE_DIR, 'torture.luau');
    const result = assertParity(
      'fixtures/torture.luau',
      fs.readFileSync(file, 'utf8'),
      'luau',
      10
    );

    // luau functions carry isExported === false (present bit); methods stay
    // undefined — the one lua↔luau node-payload flag divergence.
    const fn = result.nodes.find((n) => n.kind === 'function' && n.isExported === false);
    expect(fn).toBeTruthy();
    const method = result.nodes.find((n) => n.kind === 'method');
    if (method) expect(method.isExported).toBeUndefined();
    // export type → isExported true.
    expect(result.nodes.some((n) => n.kind === 'type_alias' && n.isExported === true)).toBe(true);
  });

  it('torture.luau CRLF parity', () => {
    const file = path.join(FIXTURE_DIR, 'torture.luau');
    const crlf = fs.readFileSync(file, 'utf8').replace(/(?<!\r)\n/g, '\r\n');
    assertParity('fixtures/torture.luau (crlf)', crlf, 'luau', 10);
  });

  it('newline-glue chains emit byte-verbatim multi-link refs', () => {
    // Lua's statement ambiguity: a call statement followed by a line starting
    // `(` parses as ONE glued chain — the middle links' "callees" are whole
    // inner function_call texts, embedded newline/tab included.
    const glued = 'local helper = require("app.helper")\nfunction M:go(obj)\n\tobj:foo():bar()\n\t(helper)(4)\nend\n';
    const result = assertParity('fixtures/glue.lua', glued, 'lua', 3);
    const names = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'calls')
      .map((r) => r.referenceName);
    expect(names).toContain('obj:foo():bar()\n\t(helper)');
    expect(names).toContain('obj:foo():bar()');
    expect(names).toContain('obj:foo():bar');
    expect(names).toContain('obj:foo');
  });

  it('one-line duplicate declarations emit duplicate-id rows verbatim', () => {
    const src = 'local x = 1; local x = 2\n';
    const result = assertParity('fixtures/dup.lua', src, 'lua', 2);
    const xs = result.nodes.filter((n) => n.kind === 'variable' && n.name === 'x');
    expect(xs).toHaveLength(2);
    expect(xs[0]!.id).toBe(xs[1]!.id);
  });

  it('cross-dialect syntax defers to the wasm extractor', () => {
    // Luau syntax in a .lua file and a luau default type parameter both
    // ERROR (grammar-inherent, both-arm) — the kernel defers per-file.
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('src/compound.lua', 'x += 1\n', 'lua')).toBeNull();
    expect(
      tryKernelExtract('src/defaultparam.luau', 'type S<T = U> = {}\n', 'luau')
    ).toBeNull();
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('src/compound.lua', 'x += 1\n', 'lua');
    delete process.env.CODEGRAPH_KERNEL;
    expect(viaWasm.nodes.some((n) => n.kind === 'file')).toBe(true);
  });
});
