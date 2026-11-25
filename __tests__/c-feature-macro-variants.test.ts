/**
 * A C call the file's headers answer only when the build sets a flag nothing
 * in the project sets reaches the definition the build without it calls.
 * lua-cjson's fpconv.h defines `fpconv_init` under `#ifdef
 * USE_INTERNAL_FPCONV` and otherwise declares it for fpconv.c to define; the
 * included header's definition was taken, though no build of redis compiles
 * it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { Node } from '../src/types';

const lines = (...l: string[]): string => [...l, ''].join('\n');

describe('a C call past a definition only a flag nothing sets compiles', () => {
  let root: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-c-feature-variants-'));
    const write = (file: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    // lua-cjson in redis: the header's definition is for a build that sets USE_INTERNAL_FPCONV.
    write('deps/lua/src/fpconv.h', lines(
      '#ifndef FPCONV_H',
      '#define FPCONV_H',
      '#ifdef USE_INTERNAL_FPCONV',
      'static inline void fpconv_init()',
      '{',
      '}',
      '#else',
      'extern void fpconv_init();',
      '#endif',
      '#endif',
    ));
    write('deps/lua/src/fpconv.c', lines('#include "fpconv.h"', 'void fpconv_init()', '{', '}'));
    // ...nor the internal one's own definition.
    write('deps/lua/src/dtoa_fpconv.c', lines('#ifdef USE_INTERNAL_FPCONV', 'void fpconv_init()', '{', '}', '#endif'));
    write('deps/lua/src/lua_cjson.c', lines('#include "fpconv.h"', 'int luaopen_cjson(void) { fpconv_init(); return 0; }'));
    // hiredis: the header's definition is for the build that leaves the flag off.
    write('deps/hiredis/alloc.h', lines(
      '#ifndef HIREDIS_ALLOC_H',
      '#define HIREDIS_ALLOC_H',
      '#ifndef HIREDIS_EXTERN_ALLOC',
      'static inline void hi_free(void *ptr) {',
      '}',
      '#else',
      'void hi_free(void *ptr);',
      '#endif',
      '#endif',
    ));
    write('deps/hiredis/alloc_ext.c', lines('void hi_free(void *ptr) {', '}'));
    write('deps/hiredis/sds.c', lines('#include "alloc.h"', 'void sdsfree(void *s) { hi_free(s); }'));
    // A flag the project defines may be set.
    write('include/config.h', lines('#define USE_FAST_CRC 1'));
    write('include/crc.h', lines(
      '#ifdef USE_FAST_CRC',
      'static inline unsigned crc32c(unsigned crc) { return crc; }',
      '#else',
      'unsigned crc32c(unsigned crc);',
      '#endif',
    ));
    write('src/crc.c', lines('unsigned crc32c(unsigned crc) { return ~crc; }'));
    write('src/store.c', lines('#include "include/config.h"', '#include "include/crc.h"', 'unsigned checksum(void) { return crc32c(0); }'));
    // So may one a build file names.
    write('lib/Makefile', lines('CFLAGS += -DUSE_SIMD_HASH'));
    write('lib/hash.h', lines('#ifdef USE_SIMD_HASH', 'static inline unsigned hash_bytes(const char *p) { return 0; }', '#endif'));
    write('lib/hash_scalar.c', lines('unsigned hash_bytes(const char *p) { return 1; }'));
    write('lib/table.c', lines('#include "hash.h"', 'unsigned slot(const char *k) { return hash_bytes(k); }'));
    // And one of the platform's.
    write('include/clock.h', lines('#ifdef __linux__', 'static inline long clock_ns(void) { return 0; }', '#else', 'long clock_ns(void);', '#endif'));
    write('src/clock_posix.c', lines('long clock_ns(void) { return 1; }'));
    write('src/timer.c', lines('#include "include/clock.h"', 'long tick(void) { return clock_ns(); }'));
    // `#if` expressions, `#elif` and `#else`.
    write('include/codec.h', lines(
      '#if defined(CODEC_ZSTD) && !defined(CODEC_DISABLE)',
      'static inline int codec_level(void) { return 3; }',
      '#elif CODEC_LZ4',
      'static inline int codec_bound(int n) { return n; }',
      '#else',
      'static inline int codec_name(void) { return 0; }',
      '#endif',
    ));
    write('src/codec_impl.c', lines(
      'int codec_level(void) { return 1; }',
      'int codec_bound(int n) { return n + 1; }',
      'int codec_name(void) { return 1; }',
    ));
    write('src/pack.c', lines('#include "include/codec.h"', 'int pack(void) { return codec_level() + codec_bound(1) + codec_name(); }'));
    // An `#else` after a test that holds.
    write('include/log.h', lines(
      '#ifndef LOG_EXTERNAL',
      'static inline void log_write(const char *m) {}',
      '#else',
      'static inline void log_flush(void) {}',
      '#endif',
    ));
    write('src/log_ext.c', lines('void log_flush(void) {}'));
    write('src/server.c', lines('#include "include/log.h"', 'void shutdown_server(void) { log_flush(); }'));
    // A header that defines the function for either build.
    write('include/prof.h', lines(
      '#ifdef PROF_ENABLED',
      'static inline int prof_tick(void) { return 1; }',
      '#else',
      'static inline int prof_tick(void) { return 0; }',
      '#endif',
    ));
    write('src/prof_impl.c', lines('int prof_tick(void) { return 2; }'));
    write('src/loop.c', lines('#include "include/prof.h"', 'int loop_tick(void) { return prof_tick(); }'));
    // redis's quicklist.c: a call compiled only with the flag reaches what the flag compiles with it.
    write('src/quicklist.c', lines(
      '#ifdef REDIS_TEST',
      'static long long ustime(void) { return 0; }',
      'int quicklistTest(void) { return (int)ustime(); }',
      '#endif',
    ));
    write('src/server_time.c', lines('long long ustime(void) { return 1; }'));
    // ...in another file too.
    write('include/simd.h', lines('#ifdef USE_SIMD_CRC', 'static inline unsigned crc_simd(unsigned c) { return c; }', '#endif'));
    write('src/crc_soft.c', lines('unsigned crc_simd(unsigned c) { return ~c; }'));
    write('src/checksum_simd.c', lines('#include "include/simd.h"', '#ifdef USE_SIMD_CRC', 'unsigned fast_sum(void) { return crc_simd(0); }', '#endif'));
    // A flag another component defines is not this one's.
    write('fpx/Makefile', lines('all: fpx.o use.o'));
    write('fpx/fpx.h', lines('#ifdef FPX_FAST', 'static inline int fpx_round(int v) { return v; }', '#endif'));
    write('fpx/fpx.c', lines('int fpx_round(int v) { return v + 1; }'));
    write('fpx/use.c', lines('#include "fpx.h"', 'int use_round(void) { return fpx_round(1); }'));
    write('other/config.h', lines('#define FPX_FAST 1'));
    // A test in a comment is no test.
    write('include/api.h', lines('/*', '#ifdef OLD_API', '*/', 'static inline int api_version(void) { return 2; }'));
    write('src/api_v1.c', lines('int api_version(void) { return 1; }'));
    write('src/client.c', lines('#include "include/api.h"', 'int client_version(void) { return api_version(); }'));
    cg = await CodeGraph.init(root, { index: true });
  }, 120_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** `<file>:<line>` of what the function `name` calls, sorted. */
  const calls = (name: string): string[] => {
    const caller = cg.getNodesByKind('function').find((n: Node) => n.name === name)!;
    expect(caller, name).toBeDefined();
    return cg.getCallees(caller.id).filter((r) => r.edge.kind === 'calls').map((r) => `${r.node.filePath}:${r.node.startLine}`).sort();
  };

  it('the definition the build without the flag compiles', () => {
    expect(calls('luaopen_cjson')).toEqual(['deps/lua/src/fpconv.c:2']);
    expect(calls('use_round')).toEqual(['fpx/fpx.c:1']);
  });

  it("the header's own, when the build without the flag compiles it", () => {
    expect(calls('sdsfree')).toEqual(['deps/hiredis/alloc.h:4']);
  });

  it("the header's own, when the project or its build may set the flag", () => {
    expect(calls('checksum')).toEqual(['include/crc.h:2']);
    expect(calls('slot')).toEqual(['lib/hash.h:2']);
    expect(calls('tick')).toEqual(['include/clock.h:2']);
  });

  it('reads `#if` expressions, `#elif` and `#else`', () => {
    expect(calls('pack')).toEqual(['include/codec.h:6', 'src/codec_impl.c:1', 'src/codec_impl.c:2']);
    expect(calls('shutdown_server')).toEqual(['src/log_ext.c:1']);
  });

  it('the definition the flag compiles with a call it compiles too', () => {
    expect(calls('quicklistTest')).toEqual(['src/quicklist.c:2']);
    expect(calls('fast_sum')).toEqual(['include/simd.h:2']);
  });

  it("the header's own, when it defines the function for either build", () => {
    const callees = calls('loop_tick');
    expect(callees).toHaveLength(1);
    expect(callees[0]).toMatch(/^include\/prof\.h:/);
  });

  it('reads no test in a comment', () => {
    expect(calls('client_version')).toEqual(['include/api.h:4']);
  });
});
