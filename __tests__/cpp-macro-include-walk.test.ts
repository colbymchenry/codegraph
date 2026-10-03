/**
 * #2127 — the C/C++ macro-visibility walk must stay bounded on deep include
 * graphs.
 *
 * A header whose guard the walk cannot decide — `#define X_H 1` (the OSG /
 * osgEarth idiom, which the guard reader does not take for a guard), or any
 * header reached under an unknown `#if` — used to be re-scanned on every
 * inclusion path: a layered include graph where each header includes the two
 * of the next layer cost 2^depth header scans and grew the timeline with
 * every one of them, which is how "Resolving refs" ran out of heap on
 * osgEarth. The answers must not change: a macro definitely visible at the
 * call site is still a macro, and an unknown one still is not.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { isVisibleCppMacro } from '../src/resolution/cpp-macro-visibility';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';

type Guard = 'value' | 'bare' | 'unknown-flag';

/** `depth` layers of two headers; each includes both headers of the next layer. */
function layeredHeaders(depth: number, guard: Guard): Record<string, string> {
  const files: Record<string, string> = {};
  for (let d = 0; d < depth; d++) {
    for (const side of ['a', 'b']) {
      const g = `H_${d}_${side}`;
      const open =
        guard === 'value' ? `#ifndef ${g}\n#define ${g} 1\n` :
        guard === 'bare' ? `#ifndef ${g}\n#define ${g}\n` :
        `#ifdef USE_${d}\n`;
      const next = d + 1 < depth ? `#include "h${d + 1}_a.h"\n#include "h${d + 1}_b.h"\n` : '';
      files[`h${d}_${side}.h`] = `${open}${next}#define M_${d}_${side}(x) (x)\nint f_${d}_${side}(int);\n#endif\n`;
    }
  }
  return files;
}

/** A context over in-memory files where every name is both a macro and a function. */
function contextOver(files: Record<string, string>): ResolutionContext {
  return {
    getNodesByName: (name: string) => [
      { kind: 'constant', signature: `#define ${name}(v) (v)` },
      { kind: 'function' },
    ],
    readFile: (f: string) => files[f] ?? null,
    fileExists: (f: string) => f in files,
    getAllFiles: () => Object.keys(files),
  } as unknown as ResolutionContext;
}

const call = (name: string, line: number): UnresolvedRef =>
  ({ language: 'cpp', referenceKind: 'calls', referenceName: name, filePath: 'unit.cpp', line }) as UnresolvedRef;

describe('#2127 — the macro-visibility include walk is bounded', () => {
  it.each(['value', 'bare', 'unknown-flag'] as const)(
    'a 40-layer include graph (2^40 inclusion paths) is walked in well under a second (%s guards)',
    (guard) => {
      const files = {
        ...layeredHeaders(40, guard),
        'trace.h': '#define TRACE(v) ((void)(v))\n',
        'unit.cpp': '#include "h0_a.h"\n#include "h0_b.h"\n#include "trace.h"\nvoid unit() { TRACE(1); }\n',
      };
      const context = contextOver(files);
      const started = performance.now();
      // Before the fix this walk never finished (2^40 header scans).
      expect(isVisibleCppMacro(call('TRACE', 4), context)).toBe(true);
      expect(performance.now() - started).toBeLessThan(1000);
      // A header macro under an undecidable guard is not definitely visible,
      // and a call above the include that defines TRACE is still a call.
      expect(isVisibleCppMacro(call('M_39_a', 4), context)).toBe(guard === 'bare');
      expect(isVisibleCppMacro(call('TRACE', 2), context)).toBe(false);
    },
  );

  it('a walk that cannot be shortened stops at its budget and suppresses nothing past it', () => {
    // No guards and a known flag toggled on every inclusion: each visit
    // changes the state, so no re-entry repeats an earlier one and the real
    // preprocessor would expand all 2^22 paths too. The walk gives up instead:
    // before the exploding include the macro is still known, after it nothing is.
    const files: Record<string, string> = {
      'toggle.h': '#ifdef T\n#undef T\n#else\n#define T\n#endif\n',
      'unit.cpp': '#define T\n#define TRACE(v) ((void)(v))\nvoid before() { TRACE(1); }\n#include "h0.h"\nvoid after() { TRACE(2); }\n',
    };
    for (let d = 0; d < 22; d++) {
      files[`h${d}.h`] = d + 1 < 22 ? `#include "toggle.h"\n#include "h${d + 1}.h"\n#include "h${d + 1}.h"\n` : '#include "toggle.h"\n';
    }
    const context = contextOver(files);
    const started = performance.now();
    expect(isVisibleCppMacro(call('TRACE', 3), context)).toBe(true);
    expect(isVisibleCppMacro(call('TRACE', 5), context)).toBe(false);
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

describe('#2127 — indexing a deep include graph keeps #1838 macro suppression', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('the macro reached through value-guarded headers still does not bind to the decoy function', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-walk-'));
    roots.push(root);
    const files = {
      ...layeredHeaders(24, 'value'),
      'trace.h': '#define TRACE(v) ((void)(v))\n',
      'unit.cpp': '#include "h0_a.h"\n#include "h0_b.h"\n#include "trace.h"\nvoid unit() { TRACE(1); }\n',
      'decoy.cpp': 'void TRACE(int v) {}\nvoid caller() { TRACE(2); }\n',
    };
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), content);
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const fn = (name: string) => cg.getNodesByKind('function').find((n) => n.name === name)!;
      const callees = (name: string) =>
        cg.getCallees(fn(name).id).filter((r) => r.edge.kind === 'calls').map((r) => r.node.filePath);
      expect(callees('unit')).toEqual([]);
      expect(callees('caller')).toEqual(['decoy.cpp']);
    } finally {
      cg.close();
    }
  }, 60_000);
});
