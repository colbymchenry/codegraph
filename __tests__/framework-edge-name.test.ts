/**
 * A link a framework or bridge resolver made names that resolver on the edge
 * (`metadata.framework`), as a synthesized channel names itself with
 * `synthesizedBy`: a Swift → Objective-C hop says `swift-objc-bridge`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-framework-edge-'));
  const files: Record<string, string> = {
    'Sources/Cache.h': `#import <Foundation/Foundation.h>
@interface Cache : NSObject
- (id)fetchEntryForKey:(NSString *)key;
@end
`,
    'Sources/Cache.m': `#import "Cache.h"
@implementation Cache
- (id)fetchEntryForKey:(NSString *)key {
    return nil;
}
@end
`,
    'Sources/Caller.swift': `import Foundation

func load(cache: Cache) {
    _ = cache.fetchEntry(forKey: "x")
}
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

describe('framework-resolved edges', () => {
  it('name the resolver that made them', () => {
    const caller = cg.getNodesInFile('Sources/Caller.swift').find((n) => n.name === 'load')!;
    const bridged = cg.getOutgoingEdges(caller.id).find((e) => cg.getNode(e.target)?.name === 'fetchEntryForKey:');
    expect(bridged).toBeDefined();
    expect(bridged!.metadata?.resolvedBy).toBe('framework');
    expect(bridged!.metadata?.framework).toBe('swift-objc-bridge');
  });
});
