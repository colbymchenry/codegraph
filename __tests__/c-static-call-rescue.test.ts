/**
 * A C call reaches the function of its name the call's own file sees: its
 * own, else one a header it includes defines, else one with external
 * linkage. jemalloc's tests call the `static inline do_arena_create` of the
 * arena_util.h they include; by directory, the name strategies picked a
 * neighbouring test's own `static do_arena_create`, which no other file can
 * call, and the call was left unlinked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { Node } from '../src/types';

const lines = (...l: string[]): string => [...l, ''].join('\n');

describe("a C call reaches the function its file sees, not another file's static", () => {
  let root: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-c-static-rescue-'));
    const write = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    // jemalloc: a header's static inline helper, and two tests with a static helper of its name.
    write('test/include/test/arena_util.h', lines(
      'static inline unsigned',
      'do_arena_create(long dirty_decay_ms, long muzzy_decay_ms) {',
      '  return 0;',
      '}',
    ));
    write('test/unit/arena_reset.c', lines(
      'static unsigned',
      'do_arena_create(void *hooks) {',
      '  return 1;',
      '}',
      'void test_reset(void) { do_arena_create(0); }',
    ));
    write('test/unit/arena_decay.c', lines(
      '#include "test/include/test/arena_util.h"',
      'void test_decay(void) { unsigned arena = do_arena_create(0, 0); }',
    ));
    // A function declared in a header and defined in another source file.
    write('lib/helper.h', lines('int helper(int x);'));
    write('lib/helper.c', lines('#include "lib/helper.h"', 'int helper(int x) { return x; }'));
    write('app/other.c', lines('static int helper(int x) { return -x; }', 'int other(void) { return helper(1); }'));
    write('app/main.c', lines('#include "lib/helper.h"', 'int run(void) { return helper(2); }'));
    // Two builds' variants of one function: C has no overloads to choose among.
    write('src/posix/log.c', lines('void log_msg(const char* msg) {}'));
    write('src/win/log.c', lines('void log_msg(int level, const char* msg) {}'));
    write('src/posix/app.c', lines('void start(void) { log_msg(1, "up"); }'));
    // The header's function, over one nearer the call that no include brings in.
    write('include/timer.h', lines('static inline long now_ns(void) { return 0; }'));
    write('bench/unit/clock.c', lines('static long now_ns(void) { return 1; }'));
    write('bench/other/fake_clock.c', lines('long now_ns(void) { return 2; }'));
    write('bench/unit/latency.c', lines('#include "include/timer.h"', 'long elapsed(void) { return now_ns(); }'));
    // ...and over one with external linkage the call could reach, where the file's header defines one.
    write('include/ticks.h', lines('static inline long ticks(void) { return 0; }'));
    write('bench/unit/ticks.c', lines('long ticks(void) { return 1; }'));
    write('bench/unit/loop.c', lines('#include "include/ticks.h"', 'long spin(void) { return ticks(); }'));
    // hiredis: a source file that includes another one calls its static functions.
    write('deps/hiredis/dict.c', lines('static unsigned int dictGenHashFunction(const char* key) { return 0; }'));
    write('deps/hiredis/async.c', lines('#include "deps/hiredis/dict.c"', 'unsigned int callbackHash(const char* key) { return dictGenHashFunction(key); }'));
    write('server/dict.c', lines('unsigned int dictGenHashFunction(const char* key) { return 1; }'));
    // jemalloc's sources include `jemalloc/internal/…` headers that only the end of their path names.
    write('deps/jemalloc/include/jemalloc/internal/bit_util.h', lines('static inline unsigned pow2_ceil_u32(unsigned x) { return x; }'));
    write('deps/jemalloc/src/arena.c', lines('#include "jemalloc/internal/bit_util.h"', 'unsigned arena_size(unsigned n) { return pow2_ceil_u32(n); }'));
    write('deps/jemalloc/src/bitmap.c', lines('unsigned pow2_ceil_u32(unsigned x) { return x + 1; }'));
    // ...and its tests a `test/math.h`, which no `#include <math.h>` names.
    write('deps/jemalloc/test/include/test/math.h', lines('static inline double ln_gamma(double x) { return x; }'));
    write('src/sort.c', lines('#include <math.h>', 'int sort_nan(double a) { return a != a; }'));
    // A file's own definition, under another build's configuration than its header's.
    write('include/fast.h', lines('#ifndef HAVE_FAST', 'static inline int fast_add(int a, int b) { return a + b; }', '#endif'));
    write('src/fast.c', lines(
      '#include "include/fast.h"',
      '#ifdef HAVE_FAST',
      'static int fast_add(int a, int b) { return a - b; }',
      '#endif',
      'int use_fast(void) { return fast_add(1, 2); }',
    ));
    cg = await CodeGraph.init(root, { index: true });
  }, 120_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** `<file>:<line>` of what the function `name` calls. */
  const calls = (name: string): string[] => {
    const caller = cg.getNodesByKind('function').find((n: Node) => n.name === name)!;
    expect(caller, name).toBeDefined();
    return cg.getCallees(caller.id).filter((r) => r.edge.kind === 'calls').map((r) => `${r.node.filePath}:${r.node.startLine}`);
  };

  it("the header's function, past a neighbouring file's static", () => {
    expect(calls('test_decay')).toEqual(['test/include/test/arena_util.h:1']);
    // The file's own static stays its own.
    expect(calls('test_reset')).toEqual(['test/unit/arena_reset.c:1']);
  });

  it('a function another source file defines, when no include defines one', () => {
    expect(calls('run')).toEqual(['lib/helper.c:2']);
    expect(calls('other')).toEqual(['app/other.c:1']);
  });

  it('the function picked by where it is, when the file sees it', () => {
    expect(calls('start')).toEqual(['src/posix/log.c:1']);
    expect(calls('use_fast')).toEqual(['src/fast.c:3']);
  });

  it('the static function of a source file the file includes', () => {
    expect(calls('callbackHash')).toEqual(['deps/hiredis/dict.c:1']);
  });

  it('one a header the file includes defines, over a nearer one', () => {
    expect(calls('elapsed')).toEqual(['include/timer.h:1']);
    expect(calls('spin')).toEqual(['include/ticks.h:1']);
  });

  it('one a header defines that the file includes by the end of its path', () => {
    expect(calls('arena_size')).toEqual(['deps/jemalloc/include/jemalloc/internal/bit_util.h:1']);
    // A standard header is not the project's header of its name.
    expect(cg.getFileDependencies('src/sort.c')).not.toContain('deps/jemalloc/test/include/test/math.h');
  });
});
