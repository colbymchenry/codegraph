/**
 * An explicit backing field (Kotlin 2.x): `val state: StateFlow<State>` with
 * `field = MutableStateFlow(State())` under it. The grammar reads it as the
 * property's `backing_field`; its initializer is the property's code, walked
 * like `= …`, so the calls in it come from the property. (The grammar before
 * #3410 made a property named `field` out of it.)
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract } from '../src/extraction/kernel';
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

const SOURCE = `package app

class StatsViewModel : ViewModel() {
    val state: StateFlow<State>
        field = MutableStateFlow(State())

    val refreshing: StateFlow<Boolean>
        field: MutableStateFlow<Boolean> = MutableStateFlow(loading())

    fun loading(): Boolean = false
}

class State
`;

function refsFrom(result: ExtractionResult, name: string): string[] {
  const property = result.nodes.find((n) => n.name === name);
  if (!property) return [];
  return result.unresolvedReferences
    .filter((r) => r.fromNodeId === property.id)
    .map((r) => `${r.referenceKind} ${r.referenceName}`);
}

describe('Kotlin explicit backing fields', () => {
  const savedLangs = process.env.CODEGRAPH_KERNEL_LANGS;
  const savedKernel = process.env.CODEGRAPH_KERNEL;

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['kotlin']);
  });

  afterEach(() => {
    if (savedLangs === undefined) delete process.env.CODEGRAPH_KERNEL_LANGS;
    else process.env.CODEGRAPH_KERNEL_LANGS = savedLangs;
    if (savedKernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = savedKernel;
  });

  it('attribute the initializer’s calls to the property, and mint no `field`', () => {
    const result = extractFromSource('src/StatsViewModel.kt', SOURCE, 'kotlin');
    expect(result.errors.filter((e) => e.code === 'parse_error')).toEqual([]);
    expect(result.nodes.some((n) => n.name === 'field')).toBe(false);
    expect(refsFrom(result, 'state')).toEqual(expect.arrayContaining(['calls MutableStateFlow', 'calls State']));
    expect(refsFrom(result, 'refreshing')).toEqual(expect.arrayContaining(['calls MutableStateFlow', 'calls loading']));
  });

  it.runIf(kernelBuilt)('the kernel reads them the same', () => {
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const viaKernel = tryKernelExtract('src/StatsViewModel.kt', SOURCE, 'kotlin');
    expect(viaKernel).not.toBeNull();
    expect(refsFrom(viaKernel!, 'state')).toEqual(expect.arrayContaining(['calls MutableStateFlow', 'calls State']));
    expect(refsFrom(viaKernel!, 'refreshing')).toEqual(expect.arrayContaining(['calls MutableStateFlow', 'calls loading']));
  });
});
