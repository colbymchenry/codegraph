/**
 * A C function whose return type is written as a macro call: cJSON's
 * `CJSON_PUBLIC(char *) cJSON_Print(const cJSON *item)`, libgit2's
 * `GIT_EXTERN(int) git_blob_dup(…);`. The pre-parse blank for line-leading
 * markup macros (Unreal's `UPROPERTY(…)`, redis's `REDIS_NO_SANITIZE("bounds")`)
 * took the macro for markup and blanked it with the return type it wraps. What
 * was left, `cJSON_Print(…)` and a block, parses as a call: the function had
 * no node, its callers resolved to nothing, and a header's prototype read as
 * a call from the header (#2470).
 *
 * Markup above a declaration is still blanked: one with a type of its own,
 * and jemalloc's attribute between a type on the line above and the name.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { Node } from '../src/types';
import { blankCppAnnotationMacroCalls } from '../src/extraction/languages/c-cpp';

const lines = (...l: string[]): string => [...l, ''].join('\n');

/** The 1-based line of `text` that contains `needle`, or is exactly it with `exact` (exactly one must). */
const lineOf = (text: string, needle: string, exact = false): number => {
  const at = text.split('\n').map((l, i) => ((exact ? l === needle : l.includes(needle)) ? i + 1 : 0)).filter(Boolean);
  if (at.length !== 1) throw new Error(`${JSON.stringify(needle)} is on ${at.length} lines`);
  return at[0]!;
};

// The issue's reproduction, then shapes around it.
const LIB_C = lines(
  '#define EXPORT(type) type',
  '#define ATTR_FORMAT(a, b)',
  '#define ATTR(x)',
  '#define REDIS_NO_SANITIZE(s)',
  '',
  'EXPORT(char *) make_name(int id)',
  '{',
  '    return id > 0 ? "named" : "anonymous";',
  '}',
  '',
  'EXPORT(int) version(void)',
  '{',
  '    return 3;',
  '}',
  '',
  '/* GNU style: the name on its own line. */',
  'EXPORT(const char *)',
  'label_for(int id)',
  '{',
  '    return id ? "x" : "y";',
  '}',
  '',
  'EXPORT(int) checked_sum(int a, int b) __attribute__((warn_unused_result));',
  'EXPORT(int) checked_sum(int a, int b)',
  '{',
  '    return a + b;',
  '}',
  '',
  'ATTR_FORMAT(1, 2)',
  'void log_line(const char *fmt, ...)',
  '{',
  '}',
  '',
  'REDIS_NO_SANITIZE("bounds")',
  'int key_slot(const char *key)',
  '{',
  '    return key[0];',
  '}',
  '',
  'unsigned long',
  'ATTR(pure)',
  'usable_size(const void *ptr)',
  '{',
  '    return ptr != 0;',
  '}',
  '',
  'int caller(void)',
  '{',
  '    log_line("%d", version());',
  '    return make_name(1) != 0 && usable_size(0) && label_for(2) && checked_sum(1, 2) && key_slot("k");',
  '}',
);

// libgit2's header shape: prototypes after a lone macro line and after a doc comment.
const API_H = lines(
  '#ifndef API_H',
  '#define API_H',
  '#define GIT_EXTERN(type) extern type',
  '#define GIT_BEGIN_DECL',
  'GIT_BEGIN_DECL',
  '',
  'GIT_EXTERN(int) git_blob_dup(int **out, int *source);',
  '',
  '/** Looks the name up. */',
  'GIT_EXTERN(const char *) git_name(int id);',
  '#endif',
);

const API_C = lines(
  '#include "api.h"',
  'int git_blob_dup(int **out, int *source) { *out = source; return 0; }',
  'const char *git_name(int id) { return id ? "a" : "b"; }',
  'int use_api(void) { int *p = 0; return git_blob_dup(&p, 0) + (git_name(1) != 0); }',
);

describe('a C function whose return type is a macro call', () => {
  const roots: string[] = [];
  const graphs: CodeGraph[] = [];

  afterEach(() => {
    for (const cg of graphs.splice(0)) cg.close();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const index = async (files: Record<string, string>): Promise<CodeGraph> => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-c-macro-return-'));
    roots.push(root);
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), text);
    const cg = await CodeGraph.init(root, { index: true });
    graphs.push(cg);
    return cg;
  };

  it('is indexed as a function on its line, and its callers reach it', async () => {
    const cg = await index({ 'lib.c': LIB_C });
    const functions = cg.getNodesInFile('lib.c').filter((n: Node) => n.kind === 'function')
      .map((n) => `${n.name}@${n.startLine}`).sort();
    expect(functions).toEqual([
      `caller@${lineOf(LIB_C, 'int caller(void)')}`,
      `checked_sum@${lineOf(LIB_C, 'EXPORT(int) checked_sum(int a, int b)', true)}`,
      `key_slot@${lineOf(LIB_C, 'int key_slot(')}`,
      `label_for@${lineOf(LIB_C, 'EXPORT(const char *)')}`,
      `log_line@${lineOf(LIB_C, 'void log_line(')}`,
      `make_name@${lineOf(LIB_C, 'make_name(int id)')}`,
      `usable_size@${lineOf(LIB_C, 'unsigned long')}`,
      `version@${lineOf(LIB_C, 'EXPORT(int) version(void)')}`,
    ].sort());
    const caller = cg.getNodesInFile('lib.c').find((n: Node) => n.name === 'caller')!;
    const callees = cg.getCallees(caller.id).filter((r) => r.edge.kind === 'calls').map((r) => r.node.name).sort();
    expect(callees).toEqual(['checked_sum', 'key_slot', 'label_for', 'log_line', 'make_name', 'usable_size', 'version']);
  }, 120_000);

  it('a header prototype declares it, and is no call from the header', async () => {
    const cg = await index({ 'api.h': API_H, 'api.c': API_C });
    const header = cg.getNodesInFile('api.h').find((n: Node) => n.kind === 'file')!;
    expect(cg.getOutgoingEdgesFrom([header.id]).filter((e) => e.kind === 'calls')).toEqual([]);
    const useApi = cg.getNodesInFile('api.c').find((n: Node) => n.name === 'use_api')!;
    expect(cg.getCallees(useApi.id).filter((r) => r.edge.kind === 'calls').map((r) => `${r.node.name}@${r.node.filePath}`).sort())
      .toEqual(['git_blob_dup@api.c', 'git_name@api.c']);
  }, 120_000);

  it('the pre-parse blank leaves it alone, and still blanks markup', () => {
    const keep = (text: string): string => blankCppAnnotationMacroCalls(text, { keepCReturnTypes: true });
    const blank = (text: string): string => text.replace(/[^\n\r]/g, ' ');
    const kept = [
      'CJSON_PUBLIC(char *) cJSON_Print(const cJSON *item)\n{\n}\n',
      'GIT_EXTERN(int) git_blob_dup(git_blob **out, git_blob *source);\n',
      'GIT_INLINE(void) git_free(void *p)\n{\n}\n',
    ];
    for (const text of kept) expect(keep(text)).toBe(text);
    // Markup: not a type, a declaration with its own type, the type on the line above, a statement in a body.
    expect(keep('ATTR_FORMAT(1, 2)\nvoid log_line(const char *fmt, ...);\n'))
      .toBe(`${blank('ATTR_FORMAT(1, 2)')}\nvoid log_line(const char *fmt, ...);\n`);
    expect(keep('ATTR(cold) void die(void);\n')).toBe(`${blank('ATTR(cold)')} void die(void);\n`);
    expect(keep('size_t JEMALLOC_NOTHROW\nJEMALLOC_ATTR(pure)\nje_sallocx(const void *ptr, int flags) {\n}\n'))
      .toBe(`size_t JEMALLOC_NOTHROW\n${blank('JEMALLOC_ATTR(pure)')}\nje_sallocx(const void *ptr, int flags) {\n}\n`);
    expect(keep('void f(void) {\n    FOREACH(node) visit(node);\n}\n'))
      .toBe(`void f(void) {\n    ${blank('FOREACH(node)')} visit(node);\n}\n`);
    // C++ gets no exemption.
    expect(blankCppAnnotationMacroCalls('GIT_EXTERN(int) git_blob_dup(void);\n')).toBe(`${blank('GIT_EXTERN(int)')} git_blob_dup(void);\n`);
  });
});
