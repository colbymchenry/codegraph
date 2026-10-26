/**
 * An Objective-C class that conforms to a protocol of its own name —
 * SDWebImage's `@interface SDDiskCache : NSObject <SDDiskCache>` — implements
 * the protocol, not itself. The SwiftUI / UIKit / Vapor conventions are
 * Swift's (they took the ObjC ref), and among the protocol's copies the
 * declaring header's own is the one.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const header = `#import <Foundation/Foundation.h>

@protocol SDDiskCache <NSObject>
- (nullable NSData *)dataForKey:(nonnull NSString *)key;
@end

@interface SDDiskCache : NSObject <SDDiskCache>
@end
`;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-objc-protocol-'));
  const files: Record<string, string> = {
    'SDWebImage/Core/SDDiskCache.h': header,
    'SDWebImage/include/SDWebImage/SDDiskCache.h': header,
    'Examples/SwiftUIDemo/ContentView.swift': `import SwiftUI

struct ContentView: View {
    var body: some View { Text("x") }
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

describe('an Objective-C class conforming to its namesake protocol', () => {
  it('implements the protocol in its own header', () => {
    const cls = cg.getNodesInFile('SDWebImage/Core/SDDiskCache.h').find((n) => n.kind === 'class')!;
    const targets = cg.getOutgoingEdgesFrom([cls.id]).filter((e) => e.kind === 'implements').map((e) => cg.getNode(e.target)!);
    expect(targets.map((t) => `${t.kind} ${t.filePath}`)).toEqual(['protocol SDWebImage/Core/SDDiskCache.h']);
  });
});
