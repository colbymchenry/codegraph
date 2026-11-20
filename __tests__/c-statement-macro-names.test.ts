/**
 * A C macro used as a statement, with a block or the next statement where its
 * `;` would be (`TEST_CONTEXT("…") {` in redis, `XXH_ASSERT(c)` in xxhash), is
 * blanked before parsing: the parser reads a call followed by a block as an
 * error, or as a K&R function. The blank took the macro's name with it, so the
 * function no longer used the macro, and a change to the macro missed it.
 *
 * In a statement of a function body the name stays, as `name;`. Anywhere else a
 * `;` would be the error the blank avoids, so the whole call still goes.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages, getParser } from '../src/extraction/grammars';
import { blankCStatementMacroCalls } from '../src/extraction/languages/c-cpp';
import { EXTRACTORS } from '../src/extraction/languages';

/** The macros a function references, by the value references extraction writes. */
function macrosUsedBy(source: string, fn: string): string[] {
  const result = extractFromSource('t.c', source, 'c');
  const name = (id: string): string | undefined => result.nodes.find((n) => n.id === id)?.name;
  const holder = result.nodes.find((n) => n.name === fn);
  expect(holder, fn).toBeDefined();
  return result.edges
    .filter((e) => e.kind === 'references' && e.source === holder!.id)
    .map((e) => name(e.target)!)
    .sort();
}

describe('a C macro used as a statement', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['c']);
  });

  it('is still used by a function that writes it before a block', () => {
    const source = [
      '#define TEST_CONTEXT(context) printf("%s", context);',
      'int use(const char *s);',
      'int mstrTest(void) {',
      '    TEST_CONTEXT("Create simple short mstr") {',
      '        use("foo");',
      '    }',
      '    return 0;',
      '}',
      '',
    ].join('\n');
    expect(macrosUsedBy(source, 'mstrTest')).toEqual(['TEST_CONTEXT']);
    const result = extractFromSource('t.c', source, 'c');
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName)).toContain('use');
  });

  it('is still used when the next statement stands where its `;` would be', () => {
    const source = [
      '#define XXH_ASSERT(c) ((void)0)',
      'int h(int len) {',
      '    int a = len;',
      '    XXH_ASSERT(a != 0)',
      '    {   int b = a;',
      '        return b;',
      '    }',
      '}',
      '',
    ].join('\n');
    expect(macrosUsedBy(source, 'h')).toEqual(['XXH_ASSERT']);
  });

  it('is still used in a run of them, each without its `;`', () => {
    const source = [
      '#define check_len(c) ((void)0)',
      'int h(int len) {',
      '    check_len(len != 0)',
      '    check_len(len != 1)',
      '    {',
      '        return len;',
      '    }',
      '}',
      '',
    ].join('\n');
    expect(blankCStatementMacroCalls(source).match(/check_len;/g)).toHaveLength(2);
    expect(macrosUsedBy(source, 'h')).toEqual(['check_len']);
  });

  it('is still used over lines, after a label and in a nested block', () => {
    const source = [
      '#define EACH(a, b) for (;;)',
      'void f(int x, void *head) {',
      '    EACH(x,',
      '         head) {',
      '        x--;',
      '    }',
      '}',
      'void g(int x) {',
      '    if (x) {',
      '        EACH(x, 0) {',
      '            x--;',
      '        }',
      '    } else',
      '        EACH(x, 1) {',
      '            x++;',
      '        }',
      '    do',
      '        EACH(x, 2) {',
      '            x++;',
      '        }',
      '    while (x);',
      'out:',
      '    EACH(x, 3) {',
      '        x++;',
      '    }',
      '}',
      '',
    ].join('\n');
    expect(macrosUsedBy(source, 'f')).toEqual(['EACH']);
    expect(macrosUsedBy(source, 'g')).toEqual(['EACH']);
    const output = blankCStatementMacroCalls(source);
    expect(output.length).toBe(source.length);
    expect(output.match(/EACH;/g)).toHaveLength(3);
    const tree = getParser('c')!.parse(EXTRACTORS.c!.preParse!(source))!;
    expect(tree.rootNode.hasError).toBe(false);
  });

  it('is still used in the block of an `else`, a `do`, a `case` and a statement expression', () => {
    const source = [
      '#define EACH(a) for (;;)',
      'int g(int x) {',
      '    if (x) {',
      '        x--;',
      '    } else {',
      '        EACH(x) {',
      '            x--;',
      '        }',
      '    }',
      '    do {',
      '        EACH(x) {',
      '            x--;',
      '        }',
      '    } while (x);',
      '    switch (x) {',
      '    case 1:',
      '        EACH(x) {',
      '            x--;',
      '        }',
      '        break;',
      '    }',
      '    return ({',
      '        EACH(x) {',
      '            x--;',
      '        }',
      '        x;',
      '    });',
      '}',
      '',
    ].join('\n');
    expect(blankCStatementMacroCalls(source).match(/EACH;/g)).toHaveLength(4);
    expect(getParser('c')!.parse(EXTRACTORS.c!.preParse!(source))!.rootNode.hasError).toBe(false);
  });

  it('goes whole as the body of a control statement, whose `else` or `while` comes after it', () => {
    const source = [
      'void g(int x) {',
      '    if (x)',
      '        EACH(x, 0) {',
      '            x--;',
      '        }',
      '    else',
      '        EACH(x, 1) {',
      '            x++;',
      '        }',
      '    do',
      '        EACH(x, 2) {',
      '            x++;',
      '        }',
      '    while (x);',
      '}',
      '',
    ].join('\n');
    expect(blankCStatementMacroCalls(source)).not.toContain('EACH');
    expect(getParser('c')!.parse(EXTRACTORS.c!.preParse!(source))!.rootNode.hasError).toBe(false);
  });

  it('goes whole where no statement can stand', () => {
    const parses = (source: string): void => {
      const preParsed = EXTRACTORS.c!.preParse!(source);
      expect(preParsed).not.toMatch(/\b(?:entry|members|values|inner|tail);/);
      expect(getParser('c')!.parse(preParsed)!.rootNode.hasError).toBe(false);
    };
    // In an initializer.
    parses(['static const int table[] = {', '    entry(a)', '    entry(b)', '    last', '};', ''].join('\n'));
    // In a struct's or an enum's body.
    parses(['struct s {', '    members(a)', '    int x;', '};', ''].join('\n'));
    parses(['enum e {', '    values(a)', '    last', '};', ''].join('\n'));
    // In a function, in an initializer again.
    parses(['void f(void) {', '    int t[] = {', '        entry(a)', '        entry(b)', '        last', '    };', '    (void)t;', '}', ''].join('\n'));
    // In the arguments of another macro.
    parses(['void f(void) {', '    OUTER(', '        inner(a)', '        inner(b)', '        last', '    );', '}', ''].join('\n'));
    // In an expression over lines.
    parses(['int f(int a, int b) {', '    return a +', '        tail(a)', '        b;', '}', ''].join('\n'));
  });

  it('keeps every line and column, and a `\\r\\n` line end', () => {
    const source = 'void f(void) {\r\n    EACH(1) {\r\n    }\r\n    ASSERT(2)\r\n    g();\r\n}\r\n';
    const output = blankCStatementMacroCalls(source);
    expect(output).toBe('void f(void) {\r\n    EACH;   {\r\n    }\r\n    ASSERT;  \r\n    g();\r\n}\r\n');
  });

  it('reads a branch of `#if` that leaves a brace open as no statement, without losing the rest of the file', () => {
    const source = [
      'void f(int a) {',
      '#ifdef X',
      '    if (a) {',
      '#else',
      '    if (!a) {',
      '#endif',
      '        a--;',
      '    }',
      '}',
      'void g(int a) {',
      '    EACH(a) {',
      '        a--;',
      '    }',
      '}',
      '',
    ].join('\n');
    expect(blankCStatementMacroCalls(source)).toContain('    EACH;   {');
  });
});
