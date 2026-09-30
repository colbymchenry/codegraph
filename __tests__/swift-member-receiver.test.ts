/**
 * A Swift call on a property the enclosing type declares with a type —
 * Kingfisher's `var cache: ImageCache!` — is a member of that type (or of
 * what it inherits): `cache.imageCachedType(forKey:)` is ImageCache's, not a
 * test subclass's override (`EvictingPrefetchCache`) that shared its name.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-swift-member-'));
  const files: Record<string, string> = {
    'Sources/Cache/ImageCache.swift': `open class ImageCache {
    open func imageCachedType(forKey key: String) -> Int {
        return 0
    }
}
`,
    'Tests/KingfisherTests/ImagePrefetcherTests.swift': `class EvictingPrefetchCache: ImageCache {
    override func imageCachedType(forKey key: String) -> Int {
        return 1
    }
}
`,
    'Tests/KingfisherTests/ImageCacheTests.swift': `class ImageCacheTests {
    var cache: ImageCache!

    func testCachedType() {
        _ = cache.imageCachedType(forKey: "a")
        _ = self.cache.imageCachedType(forKey: "b")
    }
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

describe('Swift calls on a typed property', () => {
  it('reach the declared type’s method, not a subclass override elsewhere', () => {
    const ids = cg.getNodesInFile('Tests/KingfisherTests/ImageCacheTests.swift').map((n) => n.id);
    const targets = [...new Set(cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.target)!.qualifiedName))];
    expect(targets).toEqual(['ImageCache::imageCachedType']);
  });
});
