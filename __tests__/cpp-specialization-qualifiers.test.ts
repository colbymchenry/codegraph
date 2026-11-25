/**
 * A C++ call through a class template's specialization written with its
 * arguments — fmtlib/fmt's `formatter<int>::format(42, ctx)` — is a member of
 * that specialization. The index names every specialization's out-of-line
 * member after the template (`fmt::formatter::format` for `auto
 * fmt::formatter<incomplete_type>::format(…)`), so the call reached a test's
 * `formatter<incomplete_type>` member defined in another file, and when the
 * template had no such member at all a guess by the receiver's name took
 * another class's: `formatter<std::tm, Char>::parse(ctx)` → `native_formatter::parse`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function indexed(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-spec-qualifiers-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

function callable(cg: CodeGraph, qualifiedName: string): Node {
  const node = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('function')].find((n) => n.qualifiedName === qualifiedName);
  if (!node) throw new Error(`no function or method ${qualifiedName}`);
  return node;
}

/** `calls` callees of a function or method, as `qualifiedName` and file. */
function calls(cg: CodeGraph, caller: string): string[] {
  return cg
    .getCallees(callable(cg, caller).id)
    .filter((r) => r.edge.kind === 'calls')
    .map((r) => `${r.node.qualifiedName} (${r.node.filePath})`)
    .sort();
}

const lines = (...l: string[]): string => [...l, ''].join('\n');

/** fmt's primary `formatter` (no members of its own) and the native types' base. */
const BASE = lines(
  'namespace fmt {',
  'template <typename T, typename Char = char, typename Enable = void>',
  'struct formatter {',
  '  formatter() = delete;',
  '};',
  'namespace detail {',
  'template <typename T, typename Char>',
  'struct native_formatter {',
  '  int format(const T& val, int& ctx) const { return ctx; }',
  '  int parse(int& ctx) { return ctx; }',
  '};',
  '}  // namespace detail',
  '}  // namespace fmt',
);

/** format-test.cc's specialization, its member defined out of line. */
const INCOMPLETE = lines(
  '#include "include/fmt/base.h"',
  'struct incomplete_type;',
  'namespace fmt {',
  'template <> struct formatter<incomplete_type> {',
  '  int format(const incomplete_type& x, int& ctx) const;',
  '};',
  '}  // namespace fmt',
  'struct incomplete_type {};',
  'int fmt::formatter<incomplete_type>::format(const incomplete_type&, int& ctx) const {',
  '  return ctx;',
  '}',
  'int Use(const incomplete_type& x, int& ctx) {',
  '  return fmt::formatter<incomplete_type>::format(x, ctx);',
  '}',
);

describe('a C++ call through a written class template specialization', () => {
  it('reproduction: `formatter<int>::format(42, ctx)` is not formatter<incomplete_type>\'s member from another file', async () => {
    const cg = await indexed({
      'include/fmt/base.h': BASE,
      'test/format-test.cc': INCOMPLETE,
      'test/compile-test.cc': lines(
        '#include "include/fmt/base.h"',
        'struct type_with_get {};',
        'namespace fmt {',
        'int FormatInt(int& ctx) {',
        '  return formatter<int>::format(42, ctx);',
        '}',
        '}  // namespace fmt',
      ),
    });
    try {
      expect(calls(cg, 'fmt::FormatInt')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('a specialization the template doesn\'t declare the member for gets no guess: `formatter<std::tm, char>::parse` is not native_formatter::parse', async () => {
    const cg = await indexed({
      'include/fmt/base.h': BASE,
      'include/fmt/chrono.h': lines(
        '#include "include/fmt/base.h"',
        'namespace fmt {',
        'int ParseTm(int& ctx) {',
        '  return formatter<std::tm, char>::parse(ctx);',
        '}',
        '}  // namespace fmt',
      ),
    });
    try {
      expect(calls(cg, 'fmt::ParseTm')).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('the specialization the call names still links its out-of-line member', async () => {
    const cg = await indexed({
      'include/fmt/base.h': BASE,
      'test/format-test.cc': INCOMPLETE,
    });
    try {
      expect(calls(cg, 'Use')).toEqual(['fmt::formatter::format (test/format-test.cc)']);
    } finally {
      cg.close();
    }
  });

  it('a template\'s own member defined out of line, `Box<T>::make`, is what `Box<int>::make()` calls', async () => {
    const cg = await indexed({
      'include/box.h': lines(
        'namespace lib {',
        'template <typename T>',
        'struct Box {',
        '  static int make();',
        '};',
        'template <typename T>',
        'int Box<T>::make() {',
        '  return 1;',
        '}',
        '}  // namespace lib',
      ),
      'src/use.cc': lines(
        '#include "include/box.h"',
        'namespace lib {',
        'int Make() {',
        '  return Box<int>::make();',
        '}',
        '}  // namespace lib',
      ),
    });
    try {
      expect(calls(cg, 'lib::Make')).toEqual(['lib::Box::make (include/box.h)']);
    } finally {
      cg.close();
    }
  });
});
