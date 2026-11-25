import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { getParser, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

function rawStringSource(delimiter: string): string {
  return `const char* kTemplate = R"${delimiter}(
struct Ignored { int v; };
)${delimiter}";

int after_the_raw_string(int x) {
  return x + 1;
}
`;
}

describe('C++ raw-string delimiter parse collapse (#1522)', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['cpp', 'c']);
  });

  it('warns when a legal 16-character delimiter swallows every symbol', () => {
    const result = extractFromSource('min.cpp', rawStringSource('FILE_TEMPLATE_V1'));

    // The vendored tree-sitter-cpp scanner currently rejects the standard's
    // maximum delimiter length, consuming the following function as ERROR.
    expect(result.nodes.filter((n) => n.kind === 'function')).toEqual([]);
    expect(result.nodes.map((n) => n.kind)).toEqual(['file']);
    expect(result.errors).toEqual([
      {
        message:
          'min.cpp: parse produced no symbols (tree has errors) — ' +
          'the file is indexed but contributes nothing to the graph',
        severity: 'warning',
        code: 'parse_error',
      },
    ]);
  });

  it('extracts the function after a 15-character delimiter without warning', () => {
    const result = extractFromSource('min.cpp', rawStringSource('FILE_TEMPLATE_V'));

    expect(result.nodes.filter((n) => n.kind === 'function').map((n) => n.name))
      .toEqual(['after_the_raw_string']);
    expect(result.errors).toEqual([]);
  });

  it.each(['min.cpp', 'min.c', 'min.h'])('does not warn on a healthy include-only %s', (filePath) => {
    const result = extractFromSource(filePath, '#include <stdio.h>\n#include <stdlib.h>\n');

    expect(result.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'import')).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('does not warn on a healthy empty file with zero symbols', () => {
    const result = extractFromSource('empty.cpp', '');

    expect(result.nodes.map((n) => n.kind)).toEqual(['file']);
    expect(result.errors).toEqual([]);
  });

  it('does not warn on parse errors when a function survives', () => {
    const source = 'int before_the_raw_string() { return 0; }\n' + rawStringSource('FILE_TEMPLATE_V1');
    const tree = getParser('cpp')!.parse(source)!;
    try {
      expect(tree.rootNode.hasError).toBe(true);
    } finally {
      tree.delete();
    }

    const result = extractFromSource('min.cpp', source);

    expect(result.nodes.filter((n) => n.kind === 'function').map((n) => n.name))
      .toEqual(['before_the_raw_string']);
    expect(result.errors).toEqual([]);
  });
});
