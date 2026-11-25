/**
 * `[super init]` goes past the class it is written in: to the superclass's
 * `init`, or — for an NSObject subclass — to no project method at all.
 * SDWebImage's NSObject subclasses sent `[super init]` to SDDiskCache's
 * `init` (their `@implementation` range was lost, so no hierarchy was read
 * and any `init` passed), and SDDiskCache's own `[super init]` came back to
 * itself.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-objc-super-'));
  const files: Record<string, string> = {
    'Base.h': `#import <Foundation/Foundation.h>
@interface Base : NSObject
- (instancetype)init;
@end
`,
    'Base.m': `#import "Base.h"
@implementation Base
- (instancetype)init {
    self = [super init];
    return self;
}
@end
`,
    'Child.h': `#import "Base.h"
@interface Child : Base
@end
`,
    'Child.m': `#import "Child.h"
@implementation Child
- (instancetype)init {
    self = [super init];
    return self;
}
@end
`,
    'Other.m': `#import <Foundation/Foundation.h>
@interface Other : NSObject
@end
@implementation Other
- (instancetype)init {
    self = [super init];
    return self;
}
@end
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `Owner::member` of every call edge out of a file. */
function callsFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('Objective-C messages to super', () => {
  it('reach the superclass, never the sender itself or an unrelated class', () => {
    expect(callsFrom('Child.m')).toEqual(['Base::init']);
    expect(callsFrom('Base.m')).toEqual([]);
    expect(callsFrom('Other.m')).toEqual([]);
  });
});
