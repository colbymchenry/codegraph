/**
 * Kernel↔wasm PHP extraction parity (R7b of the kernel migration).
 *
 * Asserts the native walker (codegraph-kernel/src/php.rs) produces the SAME
 * ExtractionResult as the wasm TreeSitterExtractor — nodes, edges, and
 * unresolved refs compared as canonicalized multisets — over the checked-in
 * torture fixtures:
 *
 *  - torture.php          — file-level namespace scoping, the use-import trio
 *    (single/aliased/bare/function/const + grouped incl. the nested `Sub\Deep`
 *    SKIP), include/require ×4, paths built from `__DIR__` / `dirname(__FILE__)`
 *    or `$_SERVER['DOCUMENT_ROOT']` (#3298) + dynamic (nothing), the
 *    visitNode hook (consts
 *    at every scope, trait-use implements WITH filePath — the v2 ref-flag wire
 *    path), interface multi-extends first-only drop, the call-encoding zoo
 *    (`this->prop.m`, DOT-joined scoped calls, `Cls::factory().m` fluent,
 *    nullsafe `?->` nothing, literal receivers kept), instantiation shapes
 *    (qualified verbatim, `new static/self/parent` literal, `$cls`, the
 *    anonymous-class garbage ref + file-level-function methods), static value
 *    reads, php type refs, HOF string/array callables, value-ref targets
 *    (namespaced top-level consts DROPPED), heredoc/nowdoc/interpolation,
 *    attributes shifting node lines without emitting.
 *  - TortureModule.module — drupal extension routing + un-namespaced
 *    top-level const value-ref target + hook-docblocked function.
 *  - TortureHtml.php      — leading/interleaved HTML (absolute row positions),
 *    `<?=` short echo.
 *
 * CRLF variants are derived in-memory (#1329 docblock semantics). The
 * full-repo sweep lives in scripts/kernel-parity.mjs (monolog /
 * laravel-framework / symfony for the §5 gate); this suite keeps the invariant
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

describe.skipIf(!kernelBuilt)('kernel PHP extraction parity', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['php']);
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
    const viaKernel = tryKernelExtract(filePath, source, 'php');
    expect(viaKernel, `kernel extraction failed for ${filePath}`).not.toBeNull();

    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource(filePath, source, 'php');
    delete process.env.CODEGRAPH_KERNEL;

    const k = canon(viaKernel!);
    const w = canon(viaWasm);
    expect(k.nodes, `${filePath}: nodes`).toEqual(w.nodes);
    expect(k.edges, `${filePath}: edges`).toEqual(w.edges);
    expect(k.refs, `${filePath}: refs`).toEqual(w.refs);
    expect(viaWasm.nodes.length).toBeGreaterThanOrEqual(minNodes);
  }

  const FIXTURES: Array<{ file: string; minNodes: number }> = [
    { file: 'torture.php', minNodes: 45 },
    { file: 'TortureModule.module', minNodes: 3 },
    { file: 'TortureHtml.php', minNodes: 2 },
  ];

  for (const { file, minNodes } of FIXTURES) {
    it(`${file}: namespace, hook, imports, call zoo, value refs`, () => {
      const src = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
      assertParity(`fixtures/${file}`, src, minNodes);
    });

    // CRLF variant — the shape every Windows autocrlf checkout has. Derived in
    // memory so no platform or editor can silently normalize it away; pins the
    // JS-multiline-^ docblock semantics (#1329) plus heredoc/nowdoc CRLF
    // parsing through the external scanner.
    it(`${file} CRLF parity`, () => {
      const src = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
      const crlf = src.replace(/(?<!\r)\n/g, '\r\n');
      assertParity(`fixtures/${file} (crlf)`, crlf, minNodes);
    });
  }

  // #3298: an include built from the file's own directory, or from the web
  // server's root. Each source goes through both extractors, and the
  // kernel's include paths are checked against the ones PHP loads, so parity
  // can't hold on two empty outputs.
  // The `dirname` shadow cases each need a file of their own.
  const up15 = '../'.repeat(15);
  const DIR_INCLUDE_CASES: Array<{ name: string; src: string; paths: string[] }> = [
    {
      name: 'forms',
      src: String.raw`<?php
require_once __DIR__ . '/inc/a.php';
require_once dirname(__FILE__) . "/inc/b.php";
include(__DIR__ . DIRECTORY_SEPARATOR . 'inc' . '/c.php');
include_once \dirname(__DIR__, 2) . '/shared/d.php';
require DIRNAME( __FILE__ , 2 , ) . '/../e.php';
require __dir__.'/f.php';
require dirname(__FILE__,) . \DIRECTORY_SEPARATOR . 'g.php';
require (dirname(__FILE__)) . '/paren-head.php';
require __DIR__ . 'no_slash.php';
require __DIR__ . '/dir/';
require __DIR__ . '/inc//double.php';
require dirname(__FILE__, 0) . '/zero.php';
require dirname(__FILE__, 010) . '/octal.php';
require dirname(__FILE__, 17) . '/deep.php';
require dirname(__DIR__, 16) . '/deeper.php';
require dirname(__FILE__, 16) . '/sixteen.php';
require dirname(__FILE__, $n) . '/var.php';
require $_SERVER['DOCUMENT_ROOT'] . '/docroot.php';
require __DIR__ . "/inc/{$name}.php";
require __DIR__ . "/inc/esc\x41.php";
require __DIR__ . '/a.php' . $suffix;
require __DIR__ . ('/paren' . '/tail.php');
require dirname(levels: 2, path: __FILE__) . '/named.php';
require __DIR__ . '/x.php' ?? 'y';
require 'plain.php';
require './dot.php';
function load() {
    require __DIR__ . '/in_function.php';
}
`,
      paths: [
        './inc/a.php', './inc/b.php', './inc/c.php', '../../shared/d.php', '../../e.php', './f.php',
        './g.php', `${up15}sixteen.php`, "$_SERVER['DOCUMENT_ROOT']/docroot.php", 'plain.php', './dot.php',
        './in_function.php',
      ],
    },
    {
      // The web server's root: written behind PHP_DOCUMENT_ROOT for the
      // resolver to place under `codegraph.json`'s `webRoot`.
      name: 'document-root',
      src: String.raw`<?php
require $_SERVER['DOCUMENT_ROOT'] . '/inc/a.php';
require_once($_SERVER["DOCUMENT_ROOT"] . "/inc/b.php");
include $_SERVER[ 'DOCUMENT_ROOT' ] . DIRECTORY_SEPARATOR . 'inc' . \DIRECTORY_SEPARATOR . 'c.php';
include_once $_SERVER['DOCUMENT_ROOT'] . '/../lib/d.php';
require $_SERVER['DOCUMENT_ROOT'] . 'no_slash.php';
require $_SERVER['DOCUMENT_ROOT'] . '/dir/';
require $_SERVER['DOCUMENT_ROOT'] . '/inc//double.php';
require $_SERVER['DOCUMENT_ROOT'];
require $_SERVER['document_root'] . '/lower-key.php';
require $_SERVER['DOCUMENT_ROOT '] . '/spaced-key.php';
require $_SERVER["DOCUMENT_\x52OOT"] . '/escaped-key.php';
require $_server['DOCUMENT_ROOT'] . '/lower-var.php';
require $_ENV['DOCUMENT_ROOT'] . '/env.php';
require $GLOBALS['_SERVER']['DOCUMENT_ROOT'] . '/globals.php';
require $_SERVER['DOCUMENT_ROOT'] . "/inc/{$name}.php";
require $_SERVER['DOCUMENT_ROOT'] . '/a.php' . $suffix;
require "{$_SERVER['DOCUMENT_ROOT']}/interpolated.php";
require '$_SERVER[DOCUMENT_ROOT]/literal.php';
function load() {
    require $_SERVER['DOCUMENT_ROOT'] . '/in_function.php';
}
`,
      paths: [
        "$_SERVER['DOCUMENT_ROOT']/inc/a.php", "$_SERVER['DOCUMENT_ROOT']/inc/b.php",
        "$_SERVER['DOCUMENT_ROOT']/inc/c.php", "$_SERVER['DOCUMENT_ROOT']/../lib/d.php",
        '$_SERVER[DOCUMENT_ROOT]/literal.php', "$_SERVER['DOCUMENT_ROOT']/in_function.php",
      ],
    },
    {
      name: 'declared',
      src: String.raw`<?php
namespace App;
function dirname($p) { return "/srv"; }
require dirname(__FILE__) . "/d.php";
require \dirname(__FILE__) . "/e.php";
require __DIR__ . "/f.php";
`,
      paths: ['./e.php', './f.php'],
    },
    { name: 'imported', src: 'use function Foo\\{dirname};', paths: [] },
    { name: 'listed', src: 'use function Foo\\bar, Foo\\dirname;', paths: [] },
    { name: 'mixed', src: 'use Foo\\ { Bar, function dirname };', paths: [] },
    { name: 'mixed-tight', src: 'use Foo\\{Bar, function dirname};', paths: [] },
    { name: 'nested-group', src: 'use function Foo\\{bar, Sub\\dirname};', paths: [] },
    { name: 'upper', src: 'use FUNCTION Foo\\DIRNAME;', paths: [] },
    { name: 'alias-to', src: 'use function Bar\\x as DirName;', paths: [] },
    { name: 'alias-away', src: 'use function Foo\\dirname as dn;', paths: ['./d.php'] },
    { name: 'global', src: 'use function dirname;', paths: ['./d.php'] },
    { name: 'global-qualified', src: 'use function \\dirname;', paths: ['./d.php'] },
    { name: 'use-const', src: 'use const Foo\\dirname;', paths: ['./d.php'] },
    {
      name: 'method',
      src: '<?php\nrequire dirname(__FILE__) . "/d.php";\nclass Fs { public function dirname($p) {} }\n',
      paths: ['./d.php'],
    },
    {
      name: 'comment',
      src: '<?php\n// function dirname() polyfill lived here\nrequire dirname(__FILE__) . "/d.php";\n',
      paths: ['./d.php'],
    },
    {
      name: 'no-namespace',
      src: '<?php\nif (!function_exists("dirname")) { function dirname($p) {} }\nrequire dirname(__FILE__) . "/d.php";\n',
      paths: ['./d.php'],
    },
    {
      name: 'braced',
      src: '<?php\nnamespace A { function dirname($p) {} }\nnamespace B { require dirname(__FILE__) . "/d.php"; require __DIR__ . "/e.php"; }\n',
      paths: ['./e.php'],
    },
  ].map((c) =>
    // A bare `use` line is a namespaced file that includes `dirname(__FILE__) . "/d.php"`.
    c.src.startsWith('use ')
      ? { ...c, src: `<?php\nnamespace App;\n${c.src}\nrequire dirname(__FILE__) . "/d.php";\n` }
      : c
  );

  function includePaths(result: ExtractionResult): string[] {
    return result.unresolvedReferences
      .filter((r) => r.referenceKind === 'imports' && r.referenceName.endsWith('.php'))
      .map((r) => r.referenceName)
      .sort();
  }

  for (const variant of ['LF', 'CRLF'] as const) {
    it(`include paths built from the file's directory (#3298), ${variant}`, () => {
      for (const { name, src, paths } of DIR_INCLUDE_CASES) {
        const source = variant === 'CRLF' ? src.replace(/\n/g, '\r\n') : src;
        const filePath = `src/web/${name}.php`;
        assertParity(filePath, source, 1);
        process.env.CODEGRAPH_KERNEL_LANGS = 'all';
        delete process.env.CODEGRAPH_KERNEL;
        const viaKernel = tryKernelExtract(filePath, source, 'php');
        expect(includePaths(viaKernel!), name).toEqual([...paths].sort());
      }
    });
  }

  it('trait-use implements refs carry filePath through the v2 ref-flag wire path', () => {
    const src = '<?php\nclass W {\n  use SoftDeletes;\n}\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const viaKernel = tryKernelExtract('src/W.php', src, 'php');
    expect(viaKernel).not.toBeNull();
    const impl = viaKernel!.unresolvedReferences.find((r) => r.referenceKind === 'implements');
    expect(impl?.referenceName).toBe('SoftDeletes');
    expect(impl?.filePath).toBe('src/W.php');
  });

  it('files with parse errors defer to the wasm extractor (recovery is encoding-dependent)', () => {
    const broken = '<?php\nfunction f( {\n  return }} 12 (\n';
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    expect(tryKernelExtract('src/broken.php', broken, 'php')).toBeNull();
    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('src/broken.php', broken, 'php');
    delete process.env.CODEGRAPH_KERNEL;
    expect(viaWasm.nodes.some((n) => n.kind === 'file')).toBe(true);
  });
});
