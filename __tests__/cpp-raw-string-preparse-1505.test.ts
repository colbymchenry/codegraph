import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { getParser, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import {
  blankCppAnnotationMacroCalls,
  blankCppInlineAnnotationMacros,
  blankCStatementMacroCalls,
  blankCTypeKeywordArgs,
  blankCFileScopePrefixedDeclMacros,
  blankCParameterizedAnnotationMacros,
  blankCDesignatedMacroArgs,
  cExtractor,
  cppExtractor,
} from '../src/extraction/languages/c-cpp';

// The original parses cleanly; #1505 is preParse corrupting its short delimiter,
// distinct from the vendored grammar's 16-character delimiter error (#1522).
function scaffoldSource(delimiter = 'GEN'): string {
  return `#include <string>

namespace {
const char* kTpl = R"${delimiter}(
DECLARE_THING(
struct Ignored { int v; };
int nested_fn() { return 1; }
)${delimiter}";
}

int create_scaffold(int x) {
  return x;
}

int helper_after(int y) {
  return y + 1;
}
`;
}

const annotationBlankers = [
  { name: 'line-leading annotations', blank: blankCppAnnotationMacroCalls },
  { name: 'inline annotations', blank: blankCppInlineAnnotationMacros },
];

describe('C/C++ raw strings survive preParse (#1505)', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['cpp']);
  });

  it('indexes both functions after the anonymous namespace without introducing a parse error', () => {
    const source = scaffoldSource();
    const rewritten = cppExtractor.preParse!(source, 'scaffold.cpp');
    for (const text of [source, rewritten]) {
      const tree = getParser('cpp')!.parse(text)!;
      try {
        expect(tree.rootNode.hasError).toBe(false);
      } finally {
        tree.delete();
      }
    }
    const result = extractFromSource('scaffold.cpp', source);
    expect(result.nodes.filter((node) => node.kind === 'function').map((node) => node.name))
      .toEqual(['create_scaffold', 'helper_after']);
    expect(result.nodes.some((node) => node.name === 'Ignored')).toBe(false);
    expect(result.errors).toEqual([]);
    expect(rewritten).toBe(source);
  });

  it('keeps the raw-string terminator at its original offset', () => {
    const source = scaffoldSource('TAG');
    const closer = source.indexOf(')TAG"');
    const blanked = blankCppAnnotationMacroCalls(source);
    expect(blanked.slice(closer, closer + 5)).toBe(')TAG"');
    expect(blanked).toBe(source);
  });

  describe.each(annotationBlankers)('$name', ({ blank }) => {
    it.each(['R', 'LR', 'u8R', 'uR', 'UR'])('leaves %s raw-string contents untouched', (prefix) => {
      const source = `const auto* text = ${prefix}"TAG(
DECLARE_THING(
"quoted ) text" and 'characters' and a backslash \\
)OTHER"
value UPARAM(ref) UE_DEPRECATED(
)TAG";
`;
      expect(blank(source)).toBe(source);
    });

    it.each(['', 'FIFTEEN_CHARS__', 'SIXTEEN_CHARS___'])('protects delimiter %j with CRLF', (delimiter) => {
      const source = `const char* text = R"${delimiter}(\r\nUE_DEPRECATED(\r\n)${delimiter}";\r\n`;
      expect(blank(source)).toBe(source);
    });

    it('leaves an unterminated raw string untouched', () => {
      const source = 'const char* text = R"TAG(\nUE_DEPRECATED(1)\nint example;';
      expect(blank(source)).toBe(source);
    });
  });

  it.each([
    { name: 'line-leading', blank: blankCppAnnotationMacroCalls, head: '', macro: 'ANNOTATE', tail: '\nint helper_after() { return 1; }\n' },
    { name: 'inline', blank: blankCppInlineAnnotationMacros, head: 'using Alias ', macro: 'UE_DEPRECATED', tail: ' = int;\n' },
    { name: 'C parameterized', blank: blankCParameterizedAnnotationMacros, head: 'static void ', macro: '__section', tail: ' helper_after(void) {}\n' },
    { name: 'C iterator', blank: blankCStatementMacroCalls, head: 'void iterate() {\n  ', macro: 'for_each_item', tail: ' {\n    visit();\n  }\n}\n' },
  ])('balances a genuine $name macro containing a raw-string argument', ({ blank, head, macro, tail }) => {
    const annotation = `${macro}(R"TAG(" ) unbalanced ( " \\
UE_DEPRECATED(
)TAG")`;
    expect(blank(head + annotation + tail))
      .toBe(head + annotation.replace(/[^\r\n]/g, ' ') + tail);
  });

  it('balances a C declaration macro with a raw-string argument', () => {
    const macro = 'static DECLARE_THING(R"TAG(" ) unbalanced ( ")TAG");';
    const tail = '\nint helper_after(void) {}\n';
    expect(blankCFileScopePrefixedDeclMacros(macro + tail))
      .toBe(' '.repeat(macro.length) + tail);
  });

  it('preserves a raw argument while blanking a later C type-keyword argument', () => {
    const literal = 'R"TAG(" ), struct Fake, ( ")TAG"';
    const source = `take(${literal}, struct RealType);`;
    expect(blankCTypeKeywordArgs(source)).toBe(`take(${literal},        RealType);`);
  });

  it('only counts designators outside raw arguments when blanking a C macro call', () => {
    const literal = 'R"TAG(" ) .fake = 1 ( ")TAG"';
    const head = 'void reset(void) {\n  RESET_THING(';
    const tail = ');\n}\n';
    expect(blankCDesignatedMacroArgs(head + literal + tail)).toBe(head + literal + tail);
    const args = literal + ', .field = 1';
    expect(blankCDesignatedMacroArgs(head + args + tail))
      .toBe(head + ' '.repeat(args.length) + tail);
  });

  it.each([
    { name: 'C iterator macros', blank: blankCStatementMacroCalls },
    { name: 'C type arguments', blank: blankCTypeKeywordArgs },
    { name: 'C declaration macros', blank: blankCFileScopePrefixedDeclMacros },
    { name: 'C parameterized annotations', blank: blankCParameterizedAnnotationMacros },
    { name: 'C designated initializer arguments', blank: blankCDesignatedMacroArgs },
    { name: 'C preParse', blank: (source: string) => cExtractor.preParse!(source) },
    { name: 'C++ preParse', blank: (source: string) => cppExtractor.preParse!(source, 'template.cpp') },
  ])('$name leaves macro-like raw-string contents untouched', ({ blank }) => {
    const source = `const auto* text = u8R"TAG(
  for_each_item(item, list) {
    visit(item);
  }
static DECLARE_THING(value);
use(struct Example);
  RESET_THING(.field = 1);
class EXAMPLE_API Example {
FORCEINLINE int example() {}
};
FMT_BEGIN_NAMESPACE
int example;
__section(
)TAG";
`;
    expect(blank(source)).toBe(source);
  });

  it('ignores raw-string openers in comments and ordinary literals, then resumes blanking after a real raw string', () => {
    const before = [
      '// R"COMMENT(',
      '/* LR"COMMENT( */',
      'const char* quoted = "escaped R\\"STRING(";',
      "const auto digit = 1'000;",
      'const char quote = \'"\';',
      scaffoldSource(),
    ].join('\n');
    const annotation = 'UPROPERTY(EditAnywhere)';
    const tail = '\nint actual_field;\n';
    expect(blankCppAnnotationMacroCalls(before + annotation + tail))
      .toBe(before + ' '.repeat(annotation.length) + tail);
  });
});
