/**
 * A Go type declared on its own lost its doc comment in both extractors:
 *
 *   // Foo is documented.
 *   type Foo struct{}
 *
 * tree-sitter-go wraps every type in a `type_declaration`, and the comment is
 * that declaration's previous sibling. The node is made from the spec inside
 * it, whose only predecessor is the `type` keyword, so the docstring walk
 * found nothing. A type inside a `type ( … )` group kept its comment, which
 * sits beside it in the parentheses.
 *
 * A declaration holding one spec is now read from outside, as go doc reads
 * it. A group's leading comment stays the group's: it documents the group,
 * not its first member.
 *
 * Reading from outside the declaration exposed a gap Go functions already
 * had: a comment written after code on the line above (`const sides = 4 //
 * sides of a square.`) belongs to that line, not to the declaration below
 * it, and the docstring now starts after it.
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

type Bare struct{}

// Point is documented on its own.
type Point struct{ X, Y int }

// Shape is an interface documented on its own.
type Shape interface {
	Area() float64
}

// ID is a defined type documented on its own.
type ID int

// Set is a generic type documented on its own.
type Set[T comparable] map[T]struct{}

/*
Box is documented in a block comment.
*/
type Box struct{}

// Kinds of shapes. The comment documents the group.
type (
	Circle struct{}

	// Square is documented inside the group.
	Square struct{}
)

// Lone is the only member of its group.
type (
	Lone int
)

// A group of one whose member has its own comment.
type (
	// Own is documented inside its group.
	Own int
)

// Pair groups a type with its alias.
type (
	First  int
	Second = First
)

type (
	Celsius float64 // degrees C.
	Kelvin  float64
)

// sides is documented above its line.
const sides = 4 /* four */ // sides of a square.

// Rect is documented below a constant's line.
type Rect struct{}

var origin = Point{} // the origin.
type Polygon struct{}

// Area is documented as before.
func Area(s Shape) float64 { return s.Area() }

// Norm is documented as before.
func (p Point) Norm() int { return p.X } // Norm's line comment.
func Next() int { return 0 }
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('Go doc comments on types declared on their own', () => {
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
        // A type declared on its own takes the comment above `type`, and the
        // file's header and package comment stay before the package clause.
        Bare: doc('struct', 'Bare'),
        Point: doc('struct', 'Point'),
        Shape: doc('interface', 'Shape'),
        ID: doc('type_alias', 'ID'),
        Set: doc('type_alias', 'Set'),
        Box: doc('struct', 'Box'),
        // A group's comment is the group's; a member's own comment is found
        // beside it. A group of one is that type's declaration, as in go doc,
        // unless its member has a comment of its own.
        Circle: doc('struct', 'Circle'),
        Square: doc('struct', 'Square'),
        Lone: doc('type_alias', 'Lone'),
        Own: doc('type_alias', 'Own'),
        // An alias is one of a group's members too.
        First: doc('type_alias', 'First'),
        // A comment after code is that line's, whatever comes below it.
        Celsius: doc('type_alias', 'Celsius'),
        Kelvin: doc('type_alias', 'Kelvin'),
        sides: doc('constant', 'sides'),
        Rect: doc('struct', 'Rect'),
        Polygon: doc('struct', 'Polygon'),
        Area: doc('function', 'Area'),
        Norm: doc('method', 'Norm'),
        Next: doc('function', 'Next'),
      }).toEqual({
        Bare: null,
        Point: 'Point is documented on its own.',
        Shape: 'Shape is an interface documented on its own.',
        ID: 'ID is a defined type documented on its own.',
        Set: 'Set is a generic type documented on its own.',
        Box: 'Box is documented in a block comment.',
        Circle: null,
        Square: 'Square is documented inside the group.',
        Lone: 'Lone is the only member of its group.',
        Own: 'Own is documented inside its group.',
        First: null,
        Celsius: null,
        Kelvin: null,
        sides: 'sides is documented above its line.',
        Rect: "Rect is documented below a constant's line.",
        Polygon: null,
        Area: 'Area is documented as before.',
        Norm: 'Norm is documented as before.',
        Next: null,
      });
    });
  }
});
