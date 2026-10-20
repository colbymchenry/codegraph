/**
 * Variables declared in a Go `var ( … )` block were not indexed at all:
 *
 *   var (
 *   	// ErrNoSides is returned for a shape without sides.
 *   	ErrNoSides = errors.New("no sides")
 *   	ErrTooMany = newError("too many sides")
 *   )
 *
 * tree-sitter-go wraps a var group's specs in a `var_spec_list`, unlike a
 * `const ( … )` group's, and both extractors read only the specs directly
 * inside the declaration. So the variables had no nodes, a call in their
 * initializers (`newError(…)`) was never recorded, and code reading them had
 * nothing to point at. Each member is now a variable with its own doc comment
 * (or the group's), its initializer walked under it, as a variable declared on
 * its own already was.
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

import (
	"errors"
	"fmt"
)

// Errors returned by the shapes package.
var (
	// ErrNoSides is returned for a shape without sides.
	ErrNoSides = errors.New("no sides")
	ErrTooMany = newError("too many sides")
)

var (
	registry = map[string]int{}
	// DefaultName is documented inside its group.
	DefaultName string
)

// single is documented above its own declaration.
var single = 3

func newError(msg string) error { return fmt.Errorf("shapes: %s", msg) }

func check(n int) error {
	if n == 0 {
		return ErrNoSides
	}
	return ErrTooMany
}
`;

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('Go variables declared in a var ( … ) block', () => {
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
      const byName = new Map(result.nodes.map((n) => [`${n.kind} ${n.name}`, n]));
      const node = (kind: string, name: string) => {
        const found = byName.get(`${kind} ${name}`);
        expect(found, `${kind} ${name}`).toBeDefined();
        return found!;
      };
      const file = result.nodes.find((n) => n.kind === 'file')!;

      // Every member of a var group is a variable the file contains, with its
      // own doc comment, or the group's when it has none.
      const docs = Object.fromEntries(
        ['ErrNoSides', 'ErrTooMany', 'registry', 'DefaultName', 'single'].map((name) => [
          name,
          node('variable', name).docstring ?? null,
        ])
      );
      expect(docs).toEqual({
        ErrNoSides: 'ErrNoSides is returned for a shape without sides.',
        ErrTooMany: 'Errors returned by the shapes package.',
        registry: null,
        DefaultName: 'DefaultName is documented inside its group.',
        single: 'single is documented above its own declaration.',
      });
      for (const name of ['ErrNoSides', 'ErrTooMany', 'registry', 'DefaultName']) {
        const id = node('variable', name).id;
        expect(
          result.edges.some((e) => e.kind === 'contains' && e.source === file.id && e.target === id),
          `file contains ${name}`
        ).toBe(true);
      }

      // A call in a member's initializer is that variable's.
      const tooMany = node('variable', 'ErrTooMany').id;
      expect(
        result.unresolvedReferences.some(
          (r) => r.fromNodeId === tooMany && r.referenceKind === 'calls' && r.referenceName === 'newError'
        ),
        'ErrTooMany calls newError'
      ).toBe(true);

      // Code reading a member in the same file references it.
      const check = node('function', 'check').id;
      for (const name of ['ErrNoSides', 'ErrTooMany']) {
        const id = node('variable', name).id;
        expect(
          result.edges.some((e) => e.kind === 'references' && e.source === check && e.target === id),
          `check references ${name}`
        ).toBe(true);
      }
    });
  }
});
