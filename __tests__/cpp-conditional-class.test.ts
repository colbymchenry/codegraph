/**
 * nlohmann/json's `basic_json` — the class most C++ projects vendor — was lost
 * whole: tree-sitter-cpp cannot read
 *
 * - an access specifier spelled as a macro (`JSON_PRIVATE_UNLESS_TESTED:`),
 * - a lone attribute macro after a template head or after a `/// @sa
 *   https://…/` doc comment (both ends looked like an operator continuing the
 *   line, so the macro wasn't blanked),
 * - a preprocessor conditional in the middle of a declaration: inside a
 *   member-initializer list, or between a template head and its function.
 *
 * The macros are rewritten or blanked, and a mid-declaration conditional keeps
 * its first branch (directives and later branches blanked, offsets intact).
 * An enum member after `A, /* comment *\/` is still an enum member.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { blankLoneMacroLines, flattenMidStatementConditionals } from '../src/extraction/languages/c-cpp';

const HEADER = `#pragma once
#define JSON_PRIVATE_UNLESS_TESTED private
#define JSON_HEDLEY_RETURNS_NON_NULL
#define JSON_HEDLEY_WARN_UNUSED_RESULT

template<typename T>
class basic_json
{
  JSON_PRIVATE_UNLESS_TESTED:
    using lexer = int;

    template<typename U, typename... Args>
    JSON_HEDLEY_RETURNS_NON_NULL
    static U* create(Args&& ... args)
    {
        return nullptr;
    }

    class nesting_depth_guard
    {
      public:
        nesting_depth_guard() noexcept
#ifdef JSON_NO_THREAD_LOCAL
            : m_okay(false)
#else
            : m_okay(depth() < 10)
#endif
        {
        }
      private:
        bool m_okay;
    };

  public:
    /// @brief returns version information on the library
    /// @sa https://json.nlohmann.me/api/basic_json/meta/
    JSON_HEDLEY_WARN_UNUSED_RESULT
    static basic_json meta()
    {
        return basic_json();
    }

    template < typename ValueType >
#if defined(JSON_HAS_CPP_14)
    constexpr
#endif
    auto get() const -> ValueType
    {
        return ValueType();
    }

    void dump() const {}
};
`;

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-conditional-'));
  fs.mkdirSync(path.join(root, 'include'), { recursive: true });
  fs.writeFileSync(path.join(root, 'include/json.hpp'), HEADER);
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('a C++ class written around macros and conditionals', () => {
  it('keeps its members', () => {
    const members = cg.getNodesInFile('include/json.hpp')
      .filter((n) => n.qualifiedName.startsWith('basic_json::') && (n.kind === 'method' || n.kind === 'class'))
      .map((n) => n.name)
      .sort();
    expect(members).toEqual(expect.arrayContaining(['create', 'dump', 'get', 'meta', 'nesting_depth_guard']));
  });

  it('keeps the first branch of a mid-declaration conditional, offsets intact', () => {
    const src = 'A() noexcept\n#ifdef X\n  : a(1)\n#else\n  : a(2)\n#endif\n{}\n';
    const out = flattenMidStatementConditionals(src);
    expect(out.length).toBe(src.length);
    expect(out).toContain('  : a(1)');
    expect(out).not.toContain('a(2)');
    expect(out).not.toContain('#');
    // Between whole declarations a conditional stays.
    const top = 'int a;\n#ifdef X\nint b;\n#endif\n';
    expect(flattenMidStatementConditionals(top)).toBe(top);
  });

  it('does not blank an enum member after a commented line', () => {
    const src = 'typedef enum {\n  CURLE_OK,\n  CURLE_TOO_LARGE, /* 100 */\n  CURL_LAST /* never use! */\n} CURLcode;\n';
    expect(blankLoneMacroLines(src)).toBe(src);
  });
});
