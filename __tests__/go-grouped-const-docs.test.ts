/**
 * A constant declared inside a `const ( … )` group lost the doc comment
 * written above it:
 *
 *   const (
 *   	// ErrorTypeBind is used when Context.Bind() fails.
 *   	ErrorTypeBind ErrorType = 1 << 63
 *
 * gin's `ErrorTypeBind` had no docstring, because both extractors read every
 * member's docstring from the comment above `const (`, the group's. A member's
 * own doc comment, the one go doc prints beside it, is now its docstring; a
 * member without one keeps the group's comment, as before.
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

// Kinds of shapes. The comment documents the group.
const (
	// Circle is documented on its own.
	Circle = iota
	Square
	Pentagon = 5 // five sides
	Heptagon
	// A note a blank line separates from Hexagon.

	Hexagon
	// Octagon is documented on its own.
	//nolint:revive
	Octagon
)

const (
	// Red is documented, and its group is not.
	Red  = "red"
	Blue = "blue"
)

// Answer is documented above its own declaration.
const Answer = 42

// Lone is the only member of its group.
const (
	Lone = 1
)

// Own's group comment.
const (
	// Own is documented inside its group of one.
	Own = 2
)

// limit is documented above its own declaration.
var limit = 10
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('Go constants in a group keep their own doc comment', () => {
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
      const group = 'Kinds of shapes. The comment documents the group.';

      expect({
        // A member's own doc comment is its docstring, read the way go doc
        // reads one: without a directive, and ended by a blank line.
        Circle: doc('constant', 'Circle'),
        Octagon: doc('constant', 'Octagon'),
        Red: doc('constant', 'Red'),
        Own: doc('constant', 'Own'),
        // A member without one keeps the group's comment, if there is one; a
        // comment after the code on the line above, or one a blank line
        // separates from the member, is not its doc.
        Square: doc('constant', 'Square'),
        Heptagon: doc('constant', 'Heptagon'),
        Hexagon: doc('constant', 'Hexagon'),
        Blue: doc('constant', 'Blue'),
        Lone: doc('constant', 'Lone'),
        // A declaration on its own is read as before.
        Answer: doc('constant', 'Answer'),
        limit: doc('variable', 'limit'),
      }).toEqual({
        Circle: 'Circle is documented on its own.',
        Octagon: 'Octagon is documented on its own.',
        Red: 'Red is documented, and its group is not.',
        Own: 'Own is documented inside its group of one.',
        Square: group,
        Heptagon: group,
        Hexagon: group,
        Blue: null,
        Lone: 'Lone is the only member of its group.',
        Answer: 'Answer is documented above its own declaration.',
        limit: 'limit is documented above its own declaration.',
      });
    });
  }
});
