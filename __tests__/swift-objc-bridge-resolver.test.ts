import { describe, it, expect } from 'vitest';
import type { Node } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import { swiftObjcBridgeResolver } from '../src/resolution/frameworks/swift-objc';

/**
 * Lightweight ResolutionContext mock — implements only the methods the
 * bridge resolver actually calls. Anything else throws so a leaked call
 * surfaces loudly in tests.
 */
function makeContext(nodes: Node[], fileContents: Record<string, string> = {}): ResolutionContext {
  const byName = new Map<string, Node[]>();
  for (const n of nodes) {
    const arr = byName.get(n.name);
    if (arr) arr.push(n);
    else byName.set(n.name, [n]);
  }
  const allFiles = new Set(nodes.map((n) => n.filePath));
  return {
    getNodesInFile: (fp) => nodes.filter((n) => n.filePath === fp),
    getNodesByName: (name) => byName.get(name) ?? [],
    getNodesByQualifiedName: () => { throw new Error('not used'); },
    getNodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
    getNodesByLowerName: () => { throw new Error('not used'); },
    fileExists: (fp) => allFiles.has(fp),
    readFile: (fp) => fileContents[fp] ?? null,
    getProjectRoot: () => '/test',
    getAllFiles: () => Array.from(allFiles),
    getImportMappings: () => [],
  };
}

function method(name: string, language: 'swift' | 'objc', filePath: string, startLine = 10): Node {
  return {
    id: `${language}:${filePath}:${name}:${startLine}`,
    kind: 'method',
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language,
    startLine,
    endLine: startLine + 5,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  } as Node;
}

function ref(name: string, language: 'swift' | 'objc', filePath: string): UnresolvedRef {
  return {
    fromNodeId: `caller:${filePath}`,
    referenceName: name,
    referenceKind: 'calls',
    line: 1,
    column: 0,
    filePath,
    language,
  };
}

describe('swiftObjcBridgeResolver integration', () => {
  describe('detect()', () => {
    it('returns true when both .swift and .m files exist', () => {
      const ctx = makeContext([
        method('foo', 'swift', 'A.swift'),
        method('bar', 'objc', 'B.m'),
      ]);
      expect(swiftObjcBridgeResolver.detect(ctx)).toBe(true);
    });

    it('returns false when only .swift files exist', () => {
      const ctx = makeContext([method('foo', 'swift', 'A.swift')]);
      expect(swiftObjcBridgeResolver.detect(ctx)).toBe(false);
    });

    it('returns true when .swift and .mm exist (ObjC++)', () => {
      const ctx = makeContext([
        method('foo', 'swift', 'A.swift'),
        method('bar', 'objc', 'B.mm'),
      ]);
      expect(swiftObjcBridgeResolver.detect(ctx)).toBe(true);
    });
  });

  describe('claimsReference()', () => {
    it('claims selector-shape names (contain :)', () => {
      expect(swiftObjcBridgeResolver.claimsReference?.('fooWithBar:')).toBe(true);
      expect(swiftObjcBridgeResolver.claimsReference?.('tableView:didSelectRowAtIndexPath:')).toBe(true);
      expect(swiftObjcBridgeResolver.claimsReference?.('setName:')).toBe(true);
    });

    it('does not claim bare names (handled by normal name-matcher)', () => {
      expect(swiftObjcBridgeResolver.claimsReference?.('foo')).toBe(false);
      expect(swiftObjcBridgeResolver.claimsReference?.('init')).toBe(false);
    });
  });

  describe('resolve() — Swift → ObjC direction', () => {
    it('resolves Swift call to Cocoa-style ObjC method (fetchEntry → fetchEntryForKey:)', () => {
      // Swift writes `cache.fetchEntry(forKey: "x")` → ref name `fetchEntry`.
      // ObjC method is `fetchEntryForKey:` (preposition-prefix shape).
      // `fetchEntry` is project-specific (not in the generic-names blocklist
      // that filters init/count/description/etc. to avoid Cocoa noise).
      const objcTarget = method('fetchEntryForKey:', 'objc', 'Cache.m');
      const ctx = makeContext([objcTarget]);
      const result = swiftObjcBridgeResolver.resolve(
        ref('fetchEntry', 'swift', 'Caller.swift'),
        ctx
      );
      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe(objcTarget.id);
      expect(result?.resolvedBy).toBe('framework');
      expect(result?.confidence).toBe(0.6);
    });

    it('does NOT bridge generic Cocoa names like "init" or "description"', () => {
      // Bridging Swift `init()` calls to arbitrary ObjC `init*:` methods is
      // noise — every NSObject subclass has them. The regular name-matcher
      // handles `init` on its own.
      const objcInit = method('initWithFrame:', 'objc', 'View.m');
      const ctx = makeContext([objcInit]);
      const result = swiftObjcBridgeResolver.resolve(
        ref('init', 'swift', 'Caller.swift'),
        ctx
      );
      expect(result).toBeNull();
    });

    it('resolves bridged "With" form: Swift `play(song:)` → ObjC `playWithSong:`', () => {
      const objcTarget = method('playWithSong:', 'objc', 'Player.m');
      const ctx = makeContext([objcTarget]);
      const result = swiftObjcBridgeResolver.resolve(
        ref('play', 'swift', 'Caller.swift'),
        ctx
      );
      expect(result?.targetNodeId).toBe(objcTarget.id);
    });

    it('returns null when no matching ObjC method exists', () => {
      const ctx = makeContext([method('unrelated:thing:', 'objc', 'X.m')]);
      const result = swiftObjcBridgeResolver.resolve(
        ref('completelyDifferent', 'swift', 'Caller.swift'),
        ctx
      );
      expect(result).toBeNull();
    });
  });

  describe('resolve() — ObjC → Swift direction', () => {
    it('resolves ObjC selector to @objc-exposed Swift method (exporter form)', () => {
      // Swift @objc export of `func animate(xAxisDuration:, yAxisDuration:)`
      // produces ObjC selector `animateWithXAxisDuration:yAxisDuration:`
      // (always "With" insertion on first explicit label).
      const swiftTarget = method('animate', 'swift', 'Chart.swift', 10);
      const ctx = makeContext([swiftTarget], {
        'Chart.swift':
          '\n'.repeat(8) +
          '@objc open func animate(xAxisDuration: Double, yAxisDuration: Double) {}\n',
      });
      const result = swiftObjcBridgeResolver.resolve(
        ref('animateWithXAxisDuration:yAxisDuration:', 'objc', 'Caller.m'),
        ctx
      );
      expect(result?.targetNodeId).toBe(swiftTarget.id);
      expect(result?.resolvedBy).toBe('framework');
    });

    it('does NOT resolve if the Swift method is not @objc-exposed', () => {
      const swiftTarget = method('animate', 'swift', 'Chart.swift', 10);
      const ctx = makeContext([swiftTarget], {
        // Plain `func` without @objc — bridge correctly skips it
        'Chart.swift':
          '\n'.repeat(8) +
          'func animate(xAxisDuration: Double, yAxisDuration: Double) {}\n',
      });
      const result = swiftObjcBridgeResolver.resolve(
        ref('animateWithXAxisDuration:yAxisDuration:', 'objc', 'Caller.m'),
        ctx
      );
      expect(result).toBeNull();
    });

    it('resolves init selectors to Swift init', () => {
      const swiftTarget = method('init', 'swift', 'MyClass.swift', 10);
      const ctx = makeContext([swiftTarget], {
        'MyClass.swift':
          '\n'.repeat(8) + '@objc init(name: String, age: Int) {}\n',
      });
      const result = swiftObjcBridgeResolver.resolve(
        ref('initWithName:age:', 'objc', 'Caller.m'),
        ctx
      );
      expect(result?.targetNodeId).toBe(swiftTarget.id);
    });

    it('returns null for selectors with no derivable Swift candidates that exist', () => {
      const ctx = makeContext([]);
      const result = swiftObjcBridgeResolver.resolve(
        ref('someUnknownThing:', 'objc', 'Caller.m'),
        ctx
      );
      expect(result).toBeNull();
    });
  });
});
