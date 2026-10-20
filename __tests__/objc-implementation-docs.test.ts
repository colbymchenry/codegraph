/**
 * Inside an Objective-C `@implementation`, the parser wraps each method,
 * function and declaration in an `implementation_definition` of its own, and
 * the comment above it is that wrapper's sibling, not the method's. So no
 * method, function or static written in an `@implementation` had its doc
 * comment, while the same comment above an `@interface` property was read.
 * The wrapper is now climbed like an `export` statement's.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

describe('a doc comment inside an Objective-C @implementation', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['objc']);
  });

  for (const crlf of [false, true]) {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
    const label = crlf ? ' (CRLF)' : '';

    it(`documents the method, function or static below it${label}`, () => {
      const source = [
        '@interface Tests : NSObject',
        '/** The number of runs. */',
        '@property (nonatomic) int runs;',
        '@end',
        '',
        '@implementation Tests',
        '',
        '/** Flags the callbacks set. */',
        'static struct {',
        '    int calls;',
        '} g_callbackData;',
        '',
        '/** Runs it. */',
        '- (void)testIt {',
        '}',
        '',
        '// A helper.',
        'static void helper(void) {',
        '}',
        '',
        '/**',
        ' * The shared instance.',
        ' */',
        '+ (instancetype)shared {',
        '    return nil;',
        '}',
        '',
        '/** Synthesized. */',
        '@synthesize runs = _runs;',
        '',
        '- (void)undocumented {',
        '}',
        '',
        '@end',
        '',
      ].join('\n');
      const result = extractFromSource('src/Tests.m', eol(source), 'objc');
      const docs = result.nodes
        .filter((n) => n.kind !== 'file' && n.kind !== 'class')
        .map((n) => `${n.kind} ${n.qualifiedName}: ${n.docstring ?? '-'}`);
      expect(docs).toEqual([
        'property Tests::runs: The number of runs.',
        'struct Tests::g_callbackData: Flags the callbacks set.',
        'variable Tests::g_callbackData: Flags the callbacks set.',
        'method Tests::testIt: Runs it.',
        'function Tests::helper: A helper.',
        'method Tests::shared: The shared instance.',
        'method Tests::undocumented: -',
      ]);
    });
  }
});
