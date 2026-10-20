/**
 * A macro alone on its line in Objective-C, like `NS_ASSUME_NONNULL_BEGIN`,
 * `OF_SUBCLASSING_RESTRICTED` or `RCT_EXTERN_C_BEGIN`, reads to the parser as
 * the start of a declaration. It swallowed what follows:
 *
 *   NS_ASSUME_NONNULL_BEGIN
 *   typedef struct { … } SDImageSize;       // a variable `typedef` and a variable `SDImageSize`
 *   OF_SUBCLASSING_RESTRICTED
 *   @interface SDImageCache : NSObject <NSCacheDelegate> { … }   // a function `NSCacheDelegate`
 *
 * so a header's classes, properties and conformances went missing. C and C++
 * blank such a macro before parsing; Objective-C now does too, with its own
 * reading of the lines around it: the code below may be a directive
 * (`@interface`, `@end`), and an `#import <…>` above it continues nothing. A
 * macro that is a method's whole body stays: blanking it changed how the
 * parser recovered elsewhere in the file.
 *
 * A class now starts at an attribute macro written above its `@interface`
 * (`NS_SWIFT_NAME(…)`), so a message to `super` looks for the superclass on
 * the `@interface` line, not the class's first line.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { blankLoneMacroLines, OBJC_LONE_MACROS } from '../src/extraction/languages/c-cpp';
import type { ExtractionResult } from '../src/types';

/** `<kind> <qualifiedName>` for every symbol, file and imports aside. */
function symbols(result: ExtractionResult): string[] {
  return result.nodes
    .filter((n) => n.kind !== 'file' && n.kind !== 'import')
    .map((n) => `${n.kind} ${n.qualifiedName}`);
}

const HEADER = [
  '#import <Foundation/Foundation.h>',
  '',
  'NS_ASSUME_NONNULL_BEGIN',
  '',
  'typedef struct {',
  '    int width;',
  '} SDImageSize;',
  '',
  'OF_SUBCLASSING_RESTRICTED',
  '@interface SDImageCache : NSObject <NSCacheDelegate>',
  '{',
  '    int _count;',
  '}',
  '@property (nonatomic) int limit;',
  '- (void)clear;',
  '@end',
  '',
  'NS_ASSUME_NONNULL_END',
  '',
].join('\n');

describe('a macro alone on its line in Objective-C', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['objc']);
  });

  for (const crlf of [false, true]) {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
    const label = crlf ? ' (CRLF)' : '';

    it(`no longer swallows the typedef or the @interface below it${label}`, () => {
      const result = extractFromSource('src/SDImageCache.h', eol(HEADER), 'objc');
      expect(symbols(result)).toEqual(['struct SDImageSize', 'class SDImageCache', 'property SDImageCache::limit']);
      const supertypes = result.unresolvedReferences
        .filter((r) => r.referenceKind === 'extends' || r.referenceKind === 'implements')
        .map((r) => `${r.referenceKind} ${r.referenceName}`);
      expect(supertypes).toEqual(['extends NSObject', 'implements NSCacheDelegate']);
    });

    it(`is blanked in place, and stays when it is a method's whole body${label}`, () => {
      const source = eol([
        '#import <Foundation/Foundation.h>',
        'NS_ASSUME_NONNULL_BEGIN',
        '@implementation SDImageCache',
        '- (void)clear',
        '{',
        '\tOF_UNRECOGNIZED_SELECTOR',
        '}',
        'OF_SINGLETON_METHODS',
        '@end',
        'NS_ASSUME_NONNULL_END',
        '',
      ].join('\n'));
      const blanked = blankLoneMacroLines(source, OBJC_LONE_MACROS);
      expect(blanked.length).toBe(source.length);
      expect(blanked).not.toMatch(/NS_ASSUME_NONNULL_BEGIN|NS_ASSUME_NONNULL_END|OF_SINGLETON_METHODS/);
      expect(blanked).toContain('\tOF_UNRECOGNIZED_SELECTOR');
    });
  }
});

describe('an indexed Objective-C project with lone macro lines', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('sends `super` to the superclass of a class an attribute macro opens', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-objc-lone-macros-'));
    const files: Record<string, string> = {
      'src/KSInstallation.h': [
        '#import <Foundation/Foundation.h>',
        '',
        'NS_ASSUME_NONNULL_BEGIN',
        '',
        '@interface KSInstallation : NSObject',
        '- (BOOL)validate;',
        '@end',
        '',
        'NS_ASSUME_NONNULL_END',
        '',
      ].join('\n'),
      'src/KSInstallation.m': ['#import "KSInstallation.h"', '', '@implementation KSInstallation', '- (BOOL)validate', '{', '\treturn YES;', '}', '@end', ''].join('\n'),
      'src/KSStandardInstallation.h': [
        '#import <Foundation/Foundation.h>',
        '#import "KSInstallation.h"',
        '',
        'NS_ASSUME_NONNULL_BEGIN',
        '',
        'NS_SWIFT_NAME(StandardInstallation)',
        '@interface KSStandardInstallation : KSInstallation',
        '@end',
        '',
        'NS_ASSUME_NONNULL_END',
        '',
      ].join('\n'),
      'src/KSStandardInstallation.m': [
        '#import "KSStandardInstallation.h"',
        '',
        '@implementation KSStandardInstallation',
        '- (BOOL)validate',
        '{',
        '\treturn [super validate];',
        '}',
        '@end',
        '',
      ].join('\n'),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });

    const classes = cg.getNodesByName('KSStandardInstallation').filter((n) => n.kind === 'class').map((n) => n.filePath).sort();
    expect(classes).toEqual(['src/KSStandardInstallation.h', 'src/KSStandardInstallation.m']);
    const caller = cg.getNodesByName('validate').find((n) => n.qualifiedName === 'KSStandardInstallation::validate')!;
    expect(caller).toBeDefined();
    const callees = cg
      .getOutgoingEdges(caller.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg!.getNode(e.target)?.qualifiedName);
    expect(callees).toEqual(['KSInstallation::validate']);
  }, 60_000);
});
