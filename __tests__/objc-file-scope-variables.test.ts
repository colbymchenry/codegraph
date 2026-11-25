/**
 * Objective-C read a file-scope variable only when its declarator was a bare
 * name (`int plain;`), so its most common globals were never indexed:
 *
 *   NSString *const SDWebImageErrorDomain = @"SDWebImageErrorDomain";
 *   static const NSInteger kMaxRetries = 3;
 *   @implementation SDImageCache
 *   static NSString *const kKey = @"…";   // file-scope C inside @implementation
 *
 * Objective-C now reads a declaration's declarators as C does (initialized,
 * pointer and array ones), keeps its bare names, and reads a declaration
 * written inside an `@implementation` too. A global that a `.m` file defines
 * is that file's, as C makes it: another file reaches it through the header
 * that declares it, and never through a namesake in another `.m`, like a
 * block parameter called `completionHandler(…)`.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

describe('an Objective-C file-scope variable', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['objc']);
  });

  for (const crlf of [false, true]) {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
    const label = crlf ? ' (CRLF)' : '';

    it(`is indexed with its initializer, at file scope and inside an @implementation${label}`, () => {
      const source = [
        '#import <Foundation/Foundation.h>',
        '',
        '/// The error domain.',
        'NSString *const SDWebImageErrorDomain = @"SDWebImageErrorDomain";',
        'static const NSInteger kMaxRetries = 3;',
        'static int counter = 0;',
        'int plain;',
        'static dispatch_queue_t queues[4];',
        'extern NSString *const SDExternDecl;',
        'static void (^gHandler)(void) = ^{ };',
        '',
        '@implementation SDImageCache',
        'static NSString *const kKey = @"key";',
        '- (void)run',
        '{',
        '\tint local = 1;',
        '\t(void)local;',
        '}',
        '@end',
        '',
      ].join('\n');
      const result = extractFromSource('src/SDImageCache.m', eol(source), 'objc');
      const symbols = result.nodes
        .filter((n) => n.kind !== 'file' && n.kind !== 'import')
        .map((n) => `${n.kind} ${n.qualifiedName}${n.signature ? ` ${n.signature}` : ''}`);
      // A block or function-pointer variable reads as a prototype, as in C.
      expect(symbols).toEqual([
        'variable SDWebImageErrorDomain = @"SDWebImageErrorDomain"',
        'constant kMaxRetries = 3',
        'variable counter = 0',
        'variable plain',
        'variable queues',
        'variable SDExternDecl',
        'class SDImageCache',
        'variable SDImageCache::kKey = @"key"',
        'method SDImageCache::run',
      ]);
      expect(result.nodes.find((n) => n.name === 'SDWebImageErrorDomain')?.docstring).toBe('The error domain.');
    });
  }
});

describe('an indexed Objective-C project with globals', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  /** Index `files` and return what a method's edges, `contains` aside, reach. */
  async function indexProject(files: Record<string, string>): Promise<(method: string) => string[]> {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-objc-globals-'));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const graph = (cg = await CodeGraph.init(root, { index: true }));
    return (method: string) => {
      const node = graph.getNodesByName(method).find((n) => n.kind === 'method')!;
      expect(node, method).toBeDefined();
      return graph
        .getOutgoingEdges(node.id)
        .filter((e) => e.kind !== 'contains')
        .map((e) => {
          const t = graph.getNode(e.target)!;
          return `${e.kind} ${t.kind} ${t.name} ${t.filePath}`;
        });
    };
  }

  it('reaches a global through the header that declares it', async () => {
    const targetsOf = await indexProject({
      'Hammerspoon/variables.h': ['#import <Foundation/Foundation.h>', '', 'extern NSString *MJConfigFile;', ''].join('\n'),
      'Hammerspoon/variables.m': ['#import "variables.h"', '', 'NSString *MJConfigFile = @"~/.hammerspoon/init.lua";', ''].join('\n'),
      'Hammerspoon/MJConfigUtils.m': [
        '#import "variables.h"',
        '',
        '@implementation MJConfigUtils',
        '- (NSString *)configPath',
        '{',
        '\treturn [MJConfigFile stringByStandardizingPath];',
        '}',
        '@end',
        '',
      ].join('\n'),
    });
    expect(targetsOf('configPath')).toEqual(['references variable MJConfigFile Hammerspoon/variables.h']);
  }, 60_000);

  it('never reaches a global another .m file defines', async () => {
    const targetsOf = await indexProject({
      'Libraries/RCTPushNotificationManager.m': [
        '#import <Foundation/Foundation.h>',
        '',
        'static NSString *completionHandler = nil;',
        '',
      ].join('\n'),
      'Libraries/RCTBundleAssetImageLoader.m': [
        '#import <Foundation/Foundation.h>',
        '',
        '@implementation RCTBundleAssetImageLoader',
        '- (void)loadWithCompletion:(void (^)(id image))completionHandler',
        '{',
        '\tcompletionHandler(nil);',
        '}',
        '@end',
        '',
      ].join('\n'),
    });
    // The call is the block parameter's.
    expect(targetsOf('loadWithCompletion:')).toEqual([]);
  }, 60_000);
});
