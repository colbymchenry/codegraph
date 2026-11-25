/**
 * A macro alone on its line right below an `#include <…>`, like GLib's
 *
 *   #include <glib/gtypes.h>
 *
 *   G_BEGIN_DECLS
 *
 *   typedef struct _GBytes GBytes;
 *
 * stayed in C and C++, while the same macro below any other line was blanked
 * before parsing: the directive ends in `>`, which read as an operator going
 * on into the macro. The parser then took `G_BEGIN_DECLS typedef struct
 * _GBytes GBytes;` for one broken declaration, so the first declaration of
 * nearly every GLib header was missing, and the error kept the file off the
 * native kernel. A preprocessor directive ends at its own line, as
 * Objective-C already read it. Runs against the native kernel (when built)
 * and the wasm extractor, which must agree.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import { blankLoneMacroLines } from '../src/extraction/languages/c-cpp';
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

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

describe('a macro alone on its line below an #include <…>', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['c', 'cpp']);
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

  it('is blanked, as below any other line, unless the directive goes on with a backslash', () => {
    const blanked = (source: string, macro: string) => !blankLoneMacroLines(source).includes(macro);
    expect(blanked(['#include <glib/gtypes.h>', '', 'G_BEGIN_DECLS', '', 'typedef struct _GBytes GBytes;', ''].join('\n'), 'G_BEGIN_DECLS')).toBe(true);
    expect(blanked(['#include <type_traits>', 'FMT_BEGIN_NAMESPACE', 'class buffer;', ''].join('\r\n'), 'FMT_BEGIN_NAMESPACE')).toBe(true);
    expect(blanked(['#define G_BEGIN_DECLS \\', '  G_EXTERN_BEGIN', 'int x;', ''].join('\n'), 'G_EXTERN_BEGIN')).toBe(false);
  });

  function extract(backend: 'kernel' | 'wasm', file: string, source: string): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource(file, source, 'c');
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract(file, source, 'c');
    expect(result, `kernel extraction of ${file}`).not.toBeNull();
    return result!;
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const backend of backends) {
    for (const crlf of [false, true]) {
      const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
      it(`leaves the header's first declaration in place on ${backend}${crlf ? ' (CRLF)' : ''}`, () => {
        const source = [
          '#include <glib/gtypes.h>',
          '',
          'G_BEGIN_DECLS',
          '',
          'typedef struct _GBytes GBytes;',
          'typedef struct _GArray GArray;',
          '',
          'struct _GArray',
          '{',
          '  gchar *data;',
          '  guint len;',
          '};',
          '',
          'G_END_DECLS',
          '',
        ].join('\n');
        const result = extract(backend, 'glib/garray.h', eol(source));
        const symbols = result.nodes
          .filter((n) => n.kind !== 'file' && n.kind !== 'import')
          .map((n) => `${n.kind} ${n.qualifiedName}`);
        expect(symbols).toEqual(['type_alias GBytes', 'type_alias GArray', 'struct _GArray']);
      });
    }
  }
});
