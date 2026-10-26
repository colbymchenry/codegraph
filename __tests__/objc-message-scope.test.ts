/**
 * An Objective-C message reached by name alone must be in reach:
 *
 * - a message to `self` / `super` (the extractor drops the receiver) is a
 *   method of the sender's class hierarchy — SDWebImage's `[self class]`
 *   went to SDWeakProxy's `class` 71 times;
 * - C call syntax (`completionBlock()`) calls a block, a function or a
 *   function pointer, never a method or property;
 * - a message to an untyped local needs its declaration (`FMResultSet *rs`)
 *   or a receiver named after the class — `[image respondsToSelector:]` is
 *   NSObject's, not the one proxy class that overrides it.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-objc-scope-'));
  const files: Record<string, string> = {
    'Core/SDWeakProxy.h': `#import <Foundation/Foundation.h>
@interface SDWeakProxy : NSProxy
- (Class)class;
- (BOOL)respondsToSelector:(SEL)aSelector;
@end
`,
    'Core/SDWeakProxy.m': `#import "SDWeakProxy.h"
@implementation SDWeakProxy
- (Class)class {
    return nil;
}
- (BOOL)respondsToSelector:(SEL)aSelector {
    return NO;
}
@end
`,
    'Core/SDPrefetchToken.h': `#import <Foundation/Foundation.h>
@interface SDPrefetchToken : NSObject
@property (nonatomic, copy) void (^completionBlock)(void);
@end
`,
    'Core/FMResultSet.h': `#import <Foundation/Foundation.h>
@interface FMResultSet : NSObject
- (BOOL)next;
@end
`,
    'Core/FMResultSet.m': `#import "FMResultSet.h"
@implementation FMResultSet
- (BOOL)next {
    return NO;
}
@end
`,
    'Core/SDBase.h': `#import <Foundation/Foundation.h>
@interface SDBase : NSObject
- (void)prepare;
@end
`,
    'Core/SDBase.m': `#import "SDBase.h"
@implementation SDBase
- (void)prepare {
}
@end
`,
    'Core/SDCache.h': `#import "SDBase.h"
@interface SDCache : SDBase
- (void)storeWithCompletion:(void (^)(void))completionBlock image:(id)image;
@end
`,
    'Core/SDCache.m': `#import "SDCache.h"
#import "FMResultSet.h"
@implementation SDCache
- (void)storeWithCompletion:(void (^)(void))completionBlock image:(id)image {
    Class cls = [self class];
    [super prepare];
    [self helper];
    FMResultSet *rs = [self query];
    while ([rs next]) {
    }
    if ([image respondsToSelector:@selector(copy)]) {
    }
    completionBlock();
}
- (void)helper {
}
- (FMResultSet *)query {
    return nil;
}
@end
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

describe('Objective-C messages reached by name alone', () => {
  it('reach the sender’s hierarchy and typed locals; never a proxy override or a property through C call syntax', () => {
    const method = cg.getNodesInFile('Core/SDCache.m').find((n) => n.name.startsWith('storeWithCompletion'))!;
    const targets = cg
      .getOutgoingEdges(method.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.target)!.qualifiedName)
      .sort();
    expect(targets).toEqual(['FMResultSet::next', 'SDBase::prepare', 'SDCache::helper', 'SDCache::query']);
  });
});
