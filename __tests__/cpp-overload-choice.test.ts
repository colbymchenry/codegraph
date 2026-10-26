/**
 * `lib::format("{}", x)` among overloads opened by a namespace macro picks the
 * one the arguments fit: fmt's 1,400 `fmt::format("{}", …)` calls all went to
 * color.h's `format(const text_style&, …)` — the first of the set indexed.
 * A narrow literal fits a `format_string`, a wide one (`L"{}"`) the
 * `wformat_string` overload, and a style argument the style overload.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-overload-'));
  const files: Record<string, string> = {
    'include/lib/base.h': `#pragma once
#define LIB_BEGIN_NAMESPACE namespace lib {
#define LIB_END_NAMESPACE }

LIB_BEGIN_NAMESPACE
template <typename... T> struct format_string {};
template <typename... T> struct wformat_string {};
LIB_END_NAMESPACE
`,
    'include/lib/color.h': `#pragma once
#include "base.h"

LIB_BEGIN_NAMESPACE
struct text_style {};

template <typename... T>
inline auto format(const text_style& ts, format_string<T...> fmt, T&&... args) -> int {
  return 0;
}
LIB_END_NAMESPACE
`,
    'include/lib/format.h': `#pragma once
#include "base.h"

LIB_BEGIN_NAMESPACE
template <typename... T>
inline auto format(format_string<T...> fmt, T&&... args) -> int {
  return 1;
}
LIB_END_NAMESPACE
`,
    'include/lib/xchar.h': `#pragma once
#include "base.h"

LIB_BEGIN_NAMESPACE
template <typename... T>
inline auto format(wformat_string<T...> fmt, T&&... args) -> int {
  return 2;
}
LIB_END_NAMESPACE
`,
    'test/use.cc': `#include "lib/color.h"
#include "lib/format.h"
#include "lib/xchar.h"

int narrow() { return lib::format("{}", 1); }
int wide() { return lib::format(L"{}", 2); }
int styled() { return lib::format(lib::text_style{}, "{}", 3); }
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const formatFileCalledBy = (fn: string): string[] => {
  const node = cg.getNodesInFile('test/use.cc').find((n) => n.name === fn)!;
  return cg.getOutgoingEdges(node.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!)
    .filter((t) => t.name === 'format').map((t) => t.filePath);
};

describe('C++ overloads in a macro-opened namespace', () => {
  it('a narrow literal picks the format_string overload', () => {
    expect(formatFileCalledBy('narrow')).toEqual(['include/lib/format.h']);
  });

  it('a wide literal picks the wformat_string overload', () => {
    expect(formatFileCalledBy('wide')).toEqual(['include/lib/xchar.h']);
  });

  it('a style argument picks the style overload', () => {
    expect(formatFileCalledBy('styled')).toEqual(['include/lib/color.h']);
  });
});
