/**
 * A Go declaration's docstring took every comment written above it, including
 * ones a blank line separates from it. In gin, `Context.Next` sits under a
 * FLOW CONTROL banner of block comments, then a blank line, then its own doc
 * comment, and its docstring began "/\nFLOW CONTROL\n/\n". A section banner, a
 * TODO or commented-out code with nothing under it became the doc of whatever
 * came next.
 *
 * Go's doc comment, the one go doc shows (go/parser's lead comment), is only
 * the comment group that ends on the line right above the declaration:
 * comments on consecutive lines form one group, and a blank line ends it. Go
 * now reads its docstrings that way.
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

const SOURCE = `// Copyright 2026 The Shapes Authors.

// Package shapes is documented.
package shapes

/*** CONTENT NEGOTIATION ***/

// Negotiate is documented right above, under a banner.
func Negotiate() {}

// TODO: a note a blank line separates from the function below.

func Detached() {}

// ====  Shapes START ====

type Bare struct{}

// An orphaned copy of another declaration's doc.

// Point is documented right above.
type Point struct{ X, Y int }

// IsSafe is a hack, documented for something else.

type ReadTx interface{}

// Lengths.

// Len is documented right above a method.
func (p Point) Len() int { return 0 }

// interfaces for sorting

func (p Point) Less() bool { return false }

// Joined starts with a line comment,
/*
continues in a block comment
*/
// and ends right above.
func Joined() {}

/*
Box is documented in a block comment

with a blank line inside it.
*/
type Box struct{}

// Para is documented in two paragraphs.
//
// The second paragraph.
func Para() {}

/* Inline is written on the declaration's own line. */ func Inline() {}

// Limits.

// maxItems is documented right above.
const maxItems = 10

// A note about the registry.

var registry = map[string]int{}

type (
	// Circle is documented a blank line above.

	Circle struct{}
	// Square is documented right above.
	Square struct{}
)

var origin = Point{} // the origin.
// Polygon is documented right below a commented line.
type Polygon struct{}
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('Go doc comments end at a blank line', () => {
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
      // A block comment keeps the line breaks written inside it.
      const eol = (text: string) => (crlf ? text.replace(/\n/g, '\r\n') : text);

      expect({
        // A comment a blank line separates from the declaration is not its
        // doc, whether or not a doc comment comes between them.
        Negotiate: doc('function', 'Negotiate'),
        Detached: doc('function', 'Detached'),
        Bare: doc('struct', 'Bare'),
        Point: doc('struct', 'Point'),
        ReadTx: doc('interface', 'ReadTx'),
        Len: doc('method', 'Len'),
        Less: doc('method', 'Less'),
        maxItems: doc('constant', 'maxItems'),
        registry: doc('variable', 'registry'),
        Circle: doc('struct', 'Circle'),
        Square: doc('struct', 'Square'),
        // Comments on consecutive lines are one doc comment, line and block
        // comments alike, and a blank line inside a block comment or an empty
        // `//` line does not end it.
        Joined: doc('function', 'Joined'),
        Box: doc('struct', 'Box'),
        Para: doc('function', 'Para'),
        // The doc comment ends on the line above the declaration, not on the
        // declaration's own line.
        Inline: doc('function', 'Inline'),
        // A comment after code on its line is that line's, and the doc
        // comment right below it starts after it.
        Polygon: doc('struct', 'Polygon'),
      }).toEqual({
        Negotiate: 'Negotiate is documented right above, under a banner.',
        Detached: null,
        Bare: null,
        Point: 'Point is documented right above.',
        ReadTx: null,
        Len: 'Len is documented right above a method.',
        Less: null,
        maxItems: 'maxItems is documented right above.',
        registry: null,
        Circle: null,
        Square: 'Square is documented right above.',
        Joined: 'Joined starts with a line comment,\ncontinues in a block comment\nand ends right above.',
        Box: eol('Box is documented in a block comment\n\nwith a blank line inside it.'),
        Para: 'Para is documented in two paragraphs.\n\nThe second paragraph.',
        Inline: null,
        Polygon: 'Polygon is documented right below a commented line.',
      });
    });
  }
});
