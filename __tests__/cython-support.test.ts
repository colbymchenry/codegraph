/**
 * Cython support (#1819)
 *
 * `.pyx`/`.pxd`/`.pxi` files are indexed through the Python grammar — Cython
 * is a Python superset, and riding Python's grammar (the way `.metal`/`.cu`
 * ride C++) means every Python resolution semantic applies unchanged. The
 * Cython-only constructs are handled by `preParseCython` (cython-preparse.ts),
 * an offset-preserving rewrite that either writes the Python construct of the
 * same meaning over the Cython one (`cimport` → `import `, `cdef class` →
 * `class`, `cdef`/`cpdef` function → `def`, `IF`/`ELIF`/`ELSE` → their
 * lowercase spellings) or blanks it whole with spaces (`cdef extern` blocks,
 * `.pxd` prototypes, C aggregate bodies), so node positions stay exact.
 *
 * Two shapes are deliberately left for the grammar's error recovery and read
 * by python.ts's `visitNode` hook: a `ctypedef <C type> <alias>` (a
 * `type_alias`) and a `cdef`/`ctypedef struct|union|enum` declaration (a
 * `struct`/`union`/`enum` node, its body blanked by the preParse).
 *
 * Everything here pins behavior the construction was validated against: each
 * rewrite's exact output, the graph a realistic `.pyx`/`.pxd` fixture yields,
 * and the decoys that must NOT land (a `.pxd` prototype is not a call, an
 * extern block's C signatures are not functions, a misparsed `cdef int x =
 * f(3)` is not a variable named `cdef`).
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction';
import { detectLanguage, isSourceFile, initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { preParseCython } from '../src/extraction/languages/cython-preparse';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Cython files route to Python (#1819)', () => {
  it('maps .pyx/.pxd/.pxi to the python language and counts them as source files', () => {
    expect(detectLanguage('src/fast.pyx')).toBe('python');
    expect(detectLanguage('src/types.pxd')).toBe('python');
    expect(detectLanguage('src/part.pxi')).toBe('python');
    expect(isSourceFile('proj/fast.pyx')).toBe(true);
    expect(isSourceFile('proj/types.pxd')).toBe(true);
    expect(isSourceFile('proj/part.pxi')).toBe(true);
  });

  it('leaves plain Python and non-Cython files alone', () => {
    expect(detectLanguage('src/mod.py')).toBe('python');
    expect(detectLanguage('src/mod.pyw')).toBe('python');
    expect(isSourceFile('proj/notes.txt')).toBe(false);
  });
});

describe('preParseCython rewrites', () => {
  it('writes `import ` over every cimport form (7 bytes, in place)', () => {
    expect(preParseCython('cimport numpy as np\n')).toBe('import  numpy as np\n');
    expect(preParseCython('from libc.math cimport sin, cos\n')).toBe('from libc.math import  sin, cos\n');
    expect(preParseCython('from . cimport sibling\n')).toBe('from . import  sibling\n');
  });

  it('does not touch a cimport that is not a statement keyword', () => {
    // `# cimport` prose, and `mycimport` as one identifier, are not imports.
    expect(preParseCython('# cimport numpy as np\n')).toBe('# cimport numpy as np\n');
    expect(preParseCython('x = mycimport(y)\n')).toBe('x = mycimport(y)\n');
  });

  it('writes `class` over the whole `cdef class` region, at the statement indent column', () => {
    // `cdef class` (10 bytes) → `class` + 5 spaces; the separating space stays.
    expect(preParseCython('cdef class Widget(Base):\n    pass\n')).toBe('class      Widget(Base):\n    pass\n');
    expect(preParseCython('cpdef class Widget:\n    pass\n')).toBe('class       Widget:\n    pass\n');
    // Nested: `class` lands where `cdef` was, so the body stays deeper than it.
    expect(preParseCython('IF x:\n    cdef class WinBox:\n        pass\n')).toBe(
      'if x:\n    class      WinBox:\n        pass\n'
    );
  });

  it('rewrites a cdef/cpdef function header as the def it is, signature positions kept', () => {
    // `def ` covers `cpdef`, the return type region blanks in place, and the
    // `nogil` clause between `)` and `:` goes — every column stays.
    expect(preParseCython('cpdef double add(double a, double b) nogil:\n    return a\n')).toBe(
      'def          add(double a, double b)      :\n    return a\n'
    );
    expect(preParseCython('cdef int helper(int n) except? -1:\n    return n\n')).toBe(
      'def      helper(int n)           :\n    return n\n'
    );
    // Declaration modifiers between the keyword and the return type go too.
    expect(preParseCython('cdef public api double rate(object o):\n    return 1.0\n')).toBe(
      'def                    rate(object o):\n    return 1.0\n'
    );
  });

  it('rewrites a multi-line function header, newlines kept', () => {
    expect(preParseCython('cdef double f(\n        double x) nogil:\n    return x\n')).toBe(
      'def         f(\n        double x)      :\n    return x\n'
    );
  });

  it('blanks a bodiless .pxd prototype whole — it is not a call', () => {
    const out = preParseCython('cpdef double scale(self, double k)\n\ndef real():\n    pass\n');
    expect(out.split('\n')[0]).toMatch(/^[ ]*$/);
    expect(out.split('\n')[1]).toBe('');
  });

  it('blanks a cdef extern block: the header line and its indented C declarations', () => {
    const out = preParseCython('cdef extern from "math.h":\n    double sqrt(double x)\n    void exit(int status)\n\ndef use():\n    pass\n');
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^[ ]*$/);
    expect(lines[1]).toMatch(/^[ ]*$/);
    expect(lines[2]).toMatch(/^[ ]*$/);
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe('def use():');
  });

  it('keeps a C aggregate declaration line but blanks its body and its header colon', () => {
    const out = preParseCython('ctypedef struct Point:\n    double x\n    double y\n\ndef use():\n    pass\n');
    const lines = out.split('\n');
    expect(lines[0]).toBe('ctypedef struct Point ');
    expect(lines[1]).toMatch(/^[ ]*$/);
    expect(lines[2]).toMatch(/^[ ]*$/);
    expect(lines[4]).toBe('def use():');
  });

  it('keeps a ctypedef enum declaration line but blanks its enumerators', () => {
    const out = preParseCython('ctypedef enum Color:\n    RED, GREEN, BLUE\n\ndef use():\n    return RED\n');
    const lines = out.split('\n');
    expect(lines[0]).toBe('ctypedef enum Color ');
    expect(lines[1]).toMatch(/^[ ]*$/);
    expect(lines[3]).toBe('def use():');
  });

  it('leaves a ctypedef alias and a DEF constant for the grammar, untouched', () => {
    expect(preParseCython('ctypedef unsigned long long u64\n')).toBe('ctypedef unsigned long long u64\n');
    expect(preParseCython('DEF MAX_SIZE = 100\n')).toBe('DEF MAX_SIZE = 100\n');
  });

  it('leaves an inline aggregate body whole — its damage stays on its own line', () => {
    expect(preParseCython('ctypedef enum Color: RED, GREEN\n')).toBe('ctypedef enum Color: RED, GREEN\n');
  });

  it('writes if/elif/else over the compile-time conditionals', () => {
    expect(preParseCython('IF x == 1:\n    pass\nELIF x == 2:\n    pass\nELSE:\n    pass\n')).toBe(
      'if x == 1:\n    pass\nelif x == 2:\n    pass\nelse:\n    pass\n'
    );
  });

  it('does not rewrite a capitalized word that is no conditional header', () => {
    // ELSE with no colon is not the directive; a dict's ELSE: key sits inside braces.
    expect(preParseCython('ELSEFOO = 1\n')).toBe('ELSEFOO = 1\n');
    expect(preParseCython('x = {"ELSE": 1}\n')).toBe('x = {"ELSE": 1}\n');
  });

  it('never rewrites a line inside a triple-quoted string — docstrings show cdef examples', () => {
    const doc = 'def f():\n    """\n    Example:\n        cdef class NotReal\n        IF x:\n    """\n    return 1\n';
    expect(preParseCython(doc)).toBe(doc);
  });

  it('preserves every byte offset and newline, blanking with spaces', () => {
    const src = [
      'cimport numpy as np',
      'cdef class Box:',
      '    cdef double size',
      '',
      '    cpdef double area(self) nogil:',
      '        return self.size',
      '',
      'ctypedef enum Kind:',
      '    A, B',
      '',
      'IF x:',
      '    cdef int n = 1',
      '',
    ].join('\n');
    const out = preParseCython(src);
    expect(out.length).toBe(src.length);
    expect(out.replace(/[^\r\n]/g, '')).toBe(src.replace(/[^\r\n]/g, ''));
  });

  it('returns the source unchanged when it holds no Cython keyword', () => {
    const plain = 'import os\n\ndef add(a, b):\n    return a + b\n';
    expect(preParseCython(plain)).toBe(plain);
  });
});

describe('Cython extraction through the Python grammar', () => {
  const PYX = `import os
cimport numpy as np
from libc.math cimport sin

def compute(double x):
    return np.sin(x) + sin(x)

cdef class Accumulator:
    cdef double total

    def __cinit__(self):
        self.total = 0.0

    cpdef double add(self, double amount) nogil:
        self.total += amount
        return self.total

cpdef double scale_all(list values, double k):
    return [v * k for v in values]
`;

  it('extracts imports, classes, methods, and functions from a .pyx file', () => {
    const result = extractFromSource('src/accel.pyx', PYX);
    expect(result.errors).toHaveLength(0);

    const names = result.nodes.map((n) => n.name);
    expect(result.nodes.find((n) => n.kind === 'file')?.name).toBe('accel.pyx');
    const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
    expect(imports).toEqual(expect.arrayContaining(['os', 'numpy', 'libc.math']));
    expect(names).toEqual(expect.arrayContaining(['compute', 'scale_all', 'Accumulator', '__cinit__', 'add']));

    // Blanking is offset-preserving, so positions stay exact.
    expect(result.nodes.find((n) => n.name === 'Accumulator')?.startLine).toBe(8);
    expect(result.nodes.find((n) => n.name === 'add')?.startLine).toBe(14);

    // The typed parameters survive verbatim in the signature.
    expect(result.nodes.find((n) => n.name === 'add')?.signature).toBe('(self, double amount)');
  });

  it('emits the import and call references a .pyx body makes', () => {
    const result = extractFromSource('src/accel.pyx', PYX);
    const refs = result.unresolvedReferences.map((r) => `${r.referenceKind}:${r.referenceName}`);
    expect(refs).toEqual(expect.arrayContaining(['imports:numpy', 'imports:libc.math', 'imports:sin', 'calls:np.sin', 'calls:sin']));
  });

  it('reads a .pxd declaration file: aggregates, aliases, and no phantom members', () => {
    const PXD = `ctypedef unsigned long long u64

cdef struct Point:
    double x
    double y

ctypedef enum Color:
    RED, GREEN, BLUE

cdef class Buffer:
    cdef char* data

    cpdef size_t length(self) nogil
`;
    const result = extractFromSource('src/accel.pxd', PXD);
    const kinds = result.nodes
      .filter((n) => n.kind !== 'file')
      .map((n) => `${n.kind}:${n.name}`)
      .sort();
    expect(kinds).toEqual(['class:Buffer', 'enum:Color', 'struct:Point', 'type_alias:u64']);
    // The prototype is a declaration, not a call: no reference to `length`.
    expect(result.unresolvedReferences.map((r) => r.referenceName)).not.toContain('length');
  });

  it('a misparsed cdef declaration never lands as a variable named cdef', () => {
    // Recovery has two shapes for an initialized `cdef` declaration: the
    // name escapes as the assignment the declaration means (`computed`), or
    // the keyword itself becomes the assignment's left side — a variable
    // named `cdef` — which python.ts's visitNode hook drops with its call.
    const escaping = extractFromSource('src/globals.pyx', 'cdef int computed = compute_value(3)\n\ndef use():\n    return computed\n');
    const escapeNames = escaping.nodes.map((n) => n.name);
    expect(escapeNames).not.toContain('cdef');
    expect(escapeNames).not.toContain('int');
    expect(escapeNames).toContain('use');

    const keywordShaped = extractFromSource(
      'src/other.pyx',
      'cdef extern from "f.h":\n    void f(int a)\n\ncdef int x = f(3)\n\ndef use():\n    return 1\n'
    );
    const shapedNames = keywordShaped.nodes.map((n) => n.name);
    expect(shapedNames).not.toContain('cdef');
    expect(shapedNames).not.toContain('x');
    // The dropped statement's call goes with it — no edge to `f`.
    expect(keywordShaped.unresolvedReferences.map((r) => r.referenceName)).not.toContain('f');
  });

  it('both branches of a compile-time conditional extract, and ELSE is no variable', () => {
    const COND = `IF UNAME_SYSNAME == "Windows":
    def plat():
        return "win"
ELSE:
    def plat():
        return "other"
`;
    const result = extractFromSource('src/conditional.pyx', COND);
    const plats = result.nodes.filter((n) => n.name === 'plat');
    expect(plats.map((n) => n.startLine).sort((a, b) => a - b)).toEqual([2, 5]);
    expect(result.nodes.map((n) => n.name)).not.toContain('ELSE');
  });

  it("a C extern block's signatures are neither functions nor calls", () => {
    const DECOY = `cdef extern from "math.h":
    double sqrt(double x)
    void exit(int status)

def use():
    return sqrt(4.0)
`;
    const result = extractFromSource('src/decoy.pyx', DECOY);
    const names = result.nodes.filter((n) => n.kind !== 'file').map((n) => n.name);
    expect(names).toEqual(['use']);
    // The call in `use` is real; the extern block's `exit(int status)` is not one.
    const refs = result.unresolvedReferences.map((r) => `${r.referenceKind}:${r.referenceName}`);
    expect(refs).toEqual(['calls:sqrt']);
    expect(refs).not.toContain('calls:exit');
  });
});

describe('a Cython project indexes with Python resolution', () => {
  let tempDir: string;
  let cg: CodeGraph | null = null;

  function importEdges(fromFile: string): string[] {
    const file = cg!.getNodesByKind('file').find((n) => n.filePath === fromFile)!;
    expect(file).toBeDefined();
    return cg!
      .getOutgoingEdges(file.id)
      .filter((e) => e.kind === 'imports')
      .map((e) => cg!.getNode(e.target))
      .filter((n): n is NonNullable<typeof n> => !!n)
      .map((n) => `${n.kind}:${n.name}@${n.filePath}`)
      .sort();
  }

  afterEach(() => {
    cg?.close();
    cg = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('links a cimport to the .pyx module it names, and a call into a .py helper', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cython-'));
    const files: Record<string, string> = {
      'geometry.pyx': `from libc.math cimport sqrt

cpdef double distance(double x, double y):
    return sqrt(x * x + y * y)
`,
      'helpers.py': 'def greet(name):\n    return f"hi {name}"\n',
      'app.pyx': `from geometry cimport distance
from helpers import greet

def run():
    d = distance(3.0, 4.0)
    return greet(str(d))
`,
    };
    for (const [rel, source] of Object.entries(files)) {
      fs.writeFileSync(path.join(tempDir, rel), source);
    }
    cg = await CodeGraph.init(tempDir, { index: true });

    // `from geometry cimport distance` binds the importing .pyx to geometry.pyx
    // — the Cython module — and to the distance function it names, exactly as
    // `from helpers import greet` binds helpers.py.
    expect(importEdges('app.pyx')).toEqual([
      'file:geometry.pyx@geometry.pyx',
      'file:helpers.py@helpers.py',
      'function:distance@geometry.pyx',
      'function:greet@helpers.py',
    ]);
    // The call `distance(3.0, 4.0)` resolves into the .pyx implementation.
    const run = cg.getNodesByKind('function').find((n) => n.name === 'run' && n.filePath === 'app.pyx')!;
    expect(run).toBeDefined();
    const callTargets = cg
      .getOutgoingEdges(run.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg!.getNode(e.target))
      .filter((n): n is NonNullable<typeof n> => !!n)
      .map((n) => `${n.name}@${n.filePath}`);
    expect(callTargets).toContain('distance@geometry.pyx');
    expect(callTargets).toContain('greet@helpers.py');
  });

  it('prefers the .pyx implementation over its .pxd declaration sidecar', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cython-pxd-'));
    const files: Record<string, string> = {
      'geometry.pxd': 'cpdef double distance(double x, double y)\n',
      'geometry.pyx': 'cpdef double distance(double x, double y):\n    return x + y\n',
      'app.pyx': 'from geometry cimport distance\n\n\ndef run():\n    return distance(1.0, 2.0)\n',
    };
    for (const [rel, source] of Object.entries(files)) {
      fs.writeFileSync(path.join(tempDir, rel), source);
    }
    cg = await CodeGraph.init(tempDir, { index: true });
    // A .pxd is Cython's declaration sidecar — the module an import binds to is
    // the implementation that carries the symbols (the way `.d.ts` is skipped).
    expect(importEdges('app.pyx')).toContain('function:distance@geometry.pyx');
    expect(importEdges('app.pyx')).not.toContain('file:geometry.pxd@geometry.pxd');
  });
});
