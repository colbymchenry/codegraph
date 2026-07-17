/**
 * Grammar-source parity gate (R1, migration plan §3.5).
 *
 * The native kernel compiles grammars from crates.io / vendored sources; the
 * wasm fallback loads grammars from tree-sitter-wasms / src/extraction/wasm.
 * If the two are built from different grammar revisions, a language's graph
 * would depend on WHICH path extracted it — per-language routing (and the
 * kernel-absent fallback) must be graph-neutral.
 *
 * Rather than trusting version metadata, this asserts the grammars are
 * behaviorally identical where extraction can observe them: ABI version and
 * the full node-kind and field tables, compared id by id.
 *
 * Runs wherever a kernel binary is staged (scripts/build-kernel.sh); skips
 * otherwise. CI that builds the kernel sets CODEGRAPH_KERNEL_EXPECT=1 so the
 * skip can't mask a missing build (asserted in kernel-scaffold.test.ts).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { Language as WasmLanguage } from 'web-tree-sitter';
import { getKernel, resetKernelForTests } from '../src/extraction/kernel';
import { initGrammars, loadGrammarsForLanguages, getParser } from '../src/extraction/grammars';
import type { Language } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelBuilt = fs.existsSync(KERNEL_PATH);

// Every kernel-capable language. `jsx` shares the javascript grammar on BOTH
// paths (langs.rs mirrors WASM_GRAMMAR_FILES), so the distinct grammars are:
const GRAMMAR_LANGUAGES: Language[] = ['typescript', 'tsx', 'javascript', 'java', 'python', 'go'];

describe.skipIf(!kernelBuilt)('kernel↔wasm grammar parity', () => {
  beforeAll(async () => {
    resetKernelForTests();
    await initGrammars();
    await loadGrammarsForLanguages(GRAMMAR_LANGUAGES);
  });

  it.each(GRAMMAR_LANGUAGES)('%s: node-kind and field tables are identical', (language) => {
    const kernel = getKernel();
    expect(kernel).not.toBeNull();
    const native = kernel!.grammarInfo(language);
    expect(native, `kernel has no grammar for ${language}`).not.toBeNull();

    const wasmLang = getParser(language)?.language as WasmLanguage | null | undefined;
    expect(wasmLang, `wasm grammar for ${language} not loaded`).toBeTruthy();

    expect(native!.abiVersion, 'grammar ABI version').toBe(wasmLang!.abiVersion);
    expect(native!.nodeKindCount, 'node-kind count').toBe(wasmLang!.nodeTypeCount);
    expect(native!.fieldCount, 'field count').toBe(wasmLang!.fieldCount);

    const wasmKinds: (string | null)[] = [];
    for (let i = 0; i < wasmLang!.nodeTypeCount; i++) wasmKinds.push(wasmLang!.nodeTypeForId(i));
    expect(native!.nodeKinds).toEqual(wasmKinds.map((k) => k ?? ''));

    // Field ids are 1-based on both sides.
    const wasmFields: (string | null)[] = [];
    for (let i = 1; i <= wasmLang!.fieldCount; i++) wasmFields.push(wasmLang!.fieldNameForId(i));
    expect(native!.fieldNames).toEqual(wasmFields.map((f) => f ?? ''));
  });
});
