/**
 * A call named after a Kotlin modifier keyword at the start of a statement
 * (#3410): Gradle's `allOpen { annotation("…") }` and `noArg { … }`, a class's
 * own `open()`, `inline(…)`. tree-sitter-kotlin 0.3.8 lexed the name as a
 * modifier and the line was a parse error — a build script with nothing else in
 * it warned "parse produced no symbols", and the kernel deferred the file. The
 * grammar since reads the call, while a run of modifiers before a declaration
 * stays modifiers: `actual open class` after the imports, `internal sealed
 * interface`, `@Transient internal val` and `private vararg val` parameters.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract } from '../src/extraction/kernel';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelBuilt = fs.existsSync(KERNEL_PATH);

const GRADLE = `plugins {
    kotlin("plugin.jpa") version "2.1.0"
}

allOpen {
    annotation("jakarta.persistence.Entity")
    annotation("jakarta.persistence.MappedSuperclass")
}

noArg {
    annotation("jakarta.persistence.Entity")
}
`;

const DOOR = `package com.example

import com.example.support.Lock

class Door {
    fun open() {}
    fun close() {}
    fun inline(x: Int): Int = x

    fun reopen() {
        open()
    }

    fun toggle(isOpen: Boolean) {
        if (isOpen) close() else open()
    }

    fun widen(): Int {
        inline(1)
        return 0
    }
}
`;

const MODIFIERS = `package com.example

import com.example.support.Lock

actual open class Lockable {
    internal val lock = Lock()
}

internal sealed interface Argument {
    fun render(): String
}

class Holder(
    @JvmField @Transient internal val coroutine: Any?,
    private vararg val tables: String
)
`;

const callNames = (refs: { referenceKind: string; referenceName: string }[]) =>
  refs.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);

describe('Kotlin calls named after a modifier keyword (#3410)', () => {
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

  it('a Gradle script calling annotation(…) in allOpen / noArg parses clean and keeps the calls', () => {
    const result = extractFromSource('build.gradle.kts', GRADLE, 'kotlin');
    expect(result.errors.filter((e) => e.code === 'parse_error')).toEqual([]);
    const calls = callNames(result.unresolvedReferences);
    expect(calls.filter((n) => n === 'annotation')).toHaveLength(3);
    expect(calls).toEqual(expect.arrayContaining(['allOpen', 'noArg', 'plugins']));
  });

  it.runIf(kernelBuilt)('the kernel extracts that script instead of deferring it, as the wasm does', () => {
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const viaKernel = tryKernelExtract('build.gradle.kts', GRADLE, 'kotlin');
    expect(viaKernel).not.toBeNull();
    expect(callNames(viaKernel!.unresolvedReferences).filter((n) => n === 'annotation')).toHaveLength(3);
  });

  it('a statement-start open() / inline(…) parses as a call, also after else', () => {
    const result = extractFromSource('src/Door.kt', DOOR, 'kotlin');
    expect(result.errors.filter((e) => e.code === 'parse_error')).toEqual([]);
    const calls = callNames(result.unresolvedReferences);
    expect(calls.filter((n) => n === 'open')).toHaveLength(2);
    expect(calls).toContain('inline');
  });

  it('a run of modifiers before a declaration stays modifiers', () => {
    // `actual open class` read as two infix calls, or `@Transient internal`
    // ending the modifier run so `internal` names the parameter, would be a
    // parse error or a lost class here.
    const result = extractFromSource('src/Lockable.kt', MODIFIERS, 'kotlin');
    expect(result.errors.filter((e) => e.code === 'parse_error')).toEqual([]);
    const byName = (name: string) => result.nodes.find((n) => n.name === name);
    expect(byName('Lockable')?.kind).toBe('class');
    expect(byName('lock')?.kind).toBe('field');
    expect(byName('Argument')?.kind).toBe('interface');
    expect(byName('render')?.kind).toBe('method');
    expect(byName('Holder')?.kind).toBe('class');
  });
});

describe('Kotlin calls named after a modifier keyword, end to end (#3410)', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kotlin-modifier-calls-'));
    const files: Record<string, string> = {
      'build.gradle.kts': GRADLE,
      'src/main/kotlin/com/example/Door.kt': DOOR,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('reopen() and toggle() call the class’s own open(), widen() its inline()', () => {
    const fn = (name: string) => cg.getNodesInFile('src/main/kotlin/com/example/Door.kt').find((n) => n.name === name)!;
    const callees = (name: string) =>
      cg.getOutgoingEdgesFrom([fn(name).id]).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.id);
    expect(callees('reopen')).toContain(fn('open').id);
    expect(callees('toggle')).toContain(fn('open').id);
    expect(callees('toggle')).toContain(fn('close').id);
    expect(callees('widen')).toContain(fn('inline').id);
  });
});
