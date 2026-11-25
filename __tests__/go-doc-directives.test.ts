/**
 * A comment directive Go tools read, like `//go:embed testdata` above a
 * variable or `//nolint:unparam` above a function, was stored as part of the
 * declaration's docstring, or as the whole of it:
 *
 *   //go:embed testdata
 *   var testsFs embed.FS
 *
 * gave prometheus's `testsFs` the docstring "go:embed testdata". go doc leaves
 * directives out of a doc comment's text (go/ast's isDirective): a `//`
 * comment with no space after the slashes that is `//line `, `//extern ` or
 * `//export ` followed by text, or a lowercase word and a colon. The comments
 * around a directive still form one doc comment with it.
 *
 * Runs against the native kernel (when built) and the wasm extractor, which
 * must agree.
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
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

const SOURCE = `// Package shapes is documented.
package shapes

import "embed"

//go:embed testdata
var testsFs embed.FS

//nolint:gosec
const secret = "x"

//go:generate stringer -type=Kind
type Kind int

// Area is documented above a directive.
//go:noinline
func Area() int { return 0 }

// Perimeter is documented above a lint directive.
//
//nolint:gocyclo // a long switch
func Perimeter() int { return 0 }

// Join keeps the comments on either side of a directive.
//go:generate stringer -type=Kind
// They are one doc comment.
func Join() {}

//revive:disable:var-naming
func JsonStats() {}

// Inline is documented a blank line above its directive.

//go:noinline
func Inline() {}

//line shapes.go:1
func Line() {}

//export Exported
func Exported() {}

// nolint:errcheck is not a directive when a space follows the slashes.
func Spaced() {}

//TODO: an uppercase word before the colon is not a directive.
func Todo() {}

//https://go.dev/doc/comment is not a directive either.
func Link() {}

/*nolint:all*/
func Block() {}
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('Go doc comments leave out comment directives', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['go']);
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

  function extract(backend: 'kernel' | 'wasm', source: string): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource('shapes/shapes.go', source, 'go');
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract('shapes/shapes.go', source, 'go');
    expect(result, 'kernel extraction').not.toBeNull();
    return result!;
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    it.each(backends)(`%s${crlf ? ' (CRLF)' : ''}`, (backend) => {
      const result = extract(backend, crlf ? SOURCE.replace(/\n/g, '\r\n') : SOURCE);
      const doc = (kind: string, name: string): string | null => {
        const found = result.nodes.filter((n) => n.kind === kind && n.name === name);
        expect(found, `${kind} ${name}`).toHaveLength(1);
        return found[0].docstring ?? null;
      };

      expect({
        // A declaration whose only comment is a directive has no doc.
        testsFs: doc('variable', 'testsFs'),
        secret: doc('constant', 'secret'),
        Kind: doc('type_alias', 'Kind'),
        JsonStats: doc('function', 'JsonStats'),
        Line: doc('function', 'Line'),
        Exported: doc('function', 'Exported'),
        // A directive inside a doc comment is left out of it, and the
        // comments around it stay one doc comment.
        Area: doc('function', 'Area'),
        Perimeter: doc('function', 'Perimeter'),
        Join: doc('function', 'Join'),
        // A directive still decides where the doc comment is: one a blank
        // line separates from the declaration documents nothing.
        Inline: doc('function', 'Inline'),
        // A space after the slashes, an uppercase word, a colon not followed
        // by a lowercase letter or digit, or a block comment: no directive.
        Spaced: doc('function', 'Spaced'),
        Todo: doc('function', 'Todo'),
        Link: doc('function', 'Link'),
        Block: doc('function', 'Block'),
      }).toEqual({
        testsFs: null,
        secret: null,
        Kind: null,
        JsonStats: null,
        Line: null,
        Exported: null,
        Area: 'Area is documented above a directive.',
        Perimeter: 'Perimeter is documented above a lint directive.',
        Join: 'Join keeps the comments on either side of a directive.\nThey are one doc comment.',
        Inline: null,
        Spaced: 'nolint:errcheck is not a directive when a space follows the slashes.',
        Todo: 'TODO: an uppercase word before the colon is not a directive.',
        Link: 'https://go.dev/doc/comment is not a directive either.',
        Block: 'nolint:all',
      });
    });
  }
});
