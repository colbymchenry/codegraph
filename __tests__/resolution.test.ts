/**
 * Resolution Module Tests
 *
 * Tests for Phase 3: Reference Resolution
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { Node, UnresolvedReference } from '../src/types';
import { ReferenceResolver, createResolver, ResolutionContext } from '../src/resolution';
import { matchReference, resolveMethodOnType, matchByQualifiedName, preferCallSiteFile, matchMethodCall } from '../src/resolution/name-matcher';
import { resolveImportPath, extractImportMappings, resolveJvmImport, loadCppIncludeDirs, clearCppIncludeDirCache, isPhpIncludePathRef } from '../src/resolution/import-resolver';
import type { UnresolvedRef } from '../src/resolution/types';
import { detectFrameworks, getAllFrameworkResolvers } from '../src/resolution/frameworks';
import { QueryBuilder } from '../src/db/queries';
import { DatabaseConnection } from '../src/db';

describe('Resolution Module', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolution-test-'));
  });

  afterEach(() => {
    // Clean up
    if (cg) {
      cg.destroy();
    } else if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('Name Matcher', () => {
    it('should match exact name references', () => {
      // Create a mock context
      const mockNodes: Node[] = [
        {
          id: 'func:test.ts:myFunction:10',
          kind: 'function',
          name: 'myFunction',
          qualifiedName: 'test.ts::myFunction',
          filePath: 'test.ts',
          language: 'typescript',
          startLine: 10,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        getNodesInFile: () => mockNodes,
        getNodesByName: (name) => mockNodes.filter((n) => n.name === name),
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => ['test.ts'],
      };

      const ref = {
        fromNodeId: 'caller:main.ts:caller:5',
        referenceName: 'myFunction',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'main.ts',
        language: 'typescript' as const,
      };

      const result = matchReference(ref, context);

      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('func:test.ts:myFunction:10');
      expect(result?.resolvedBy).toBe('exact-match');
    });

    it('should resolve Erlang -behaviour refs only to module namespaces', () => {
      // On emqx, `-behaviour(supervisor)` (OTP behaviour, not in the repo)
      // fell through to bare-name matching and resolved to a
      // `-define(supervisor, ...)` macro constant in an unrelated app.
      const macroConstant: Node = {
        id: 'constant:apps/bridge/src/impl.erl:supervisor:61',
        kind: 'constant',
        name: 'supervisor',
        qualifiedName: 'impl::supervisor',
        filePath: 'apps/bridge/src/impl.erl',
        language: 'erlang',
        startLine: 61,
        endLine: 61,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };
      const behaviourModule: Node = {
        id: 'namespace:src/my_behaviour.erl:my_behaviour:1',
        kind: 'namespace',
        name: 'my_behaviour',
        qualifiedName: 'my_behaviour',
        filePath: 'src/my_behaviour.erl',
        language: 'erlang',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };
      const nodes = [macroConstant, behaviourModule];
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => nodes.filter((n) => n.name === name),
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };
      const mkRef = (name: string) => ({
        fromNodeId: 'namespace:src/worker.erl:worker:1',
        referenceName: name,
        referenceKind: 'implements' as const,
        line: 2,
        column: 0,
        filePath: 'src/worker.erl',
        language: 'erlang' as const,
      });

      // Out-of-repo behaviour whose name collides with a macro constant:
      // stays unresolved instead of linking the constant.
      expect(matchReference(mkRef('supervisor'), context)).toBeNull();
      // In-repo behaviour module resolves to its namespace.
      const resolved = matchReference(mkRef('my_behaviour'), context);
      expect(resolved?.targetNodeId).toBe(behaviourModule.id);

      // The same module-only rule covers refs emitted by .app/.app.src
      // resource files: on emqx, the `ssl` OTP app dependency resolved to a
      // test helper FUNCTION named ssl. A colliding non-module name stays
      // unresolved; a real umbrella-sibling module resolves.
      nodes.push({
        id: 'function:test/ldap_SUITE.erl:ssl:12',
        kind: 'function',
        name: 'ssl',
        qualifiedName: 'ldap_SUITE::ssl',
        filePath: 'test/ldap_SUITE.erl',
        language: 'erlang',
        startLine: 12,
        endLine: 14,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      });
      const appRef = (name: string) => ({
        fromNodeId: 'file:src/myapp.app.src',
        referenceName: name,
        referenceKind: 'imports' as const,
        line: 6,
        column: 0,
        filePath: 'src/myapp.app.src',
        language: 'erlang' as const,
      });
      expect(matchReference(appRef('ssl'), context)).toBeNull();
      expect(matchReference(appRef('my_behaviour'), context)?.targetNodeId).toBe(behaviourModule.id);
    });

    it('should prefer same-module candidates over cross-module matches', () => {
      // Simulates a Python monorepo where multiple apps define navigate()
      const candidateA: Node = {
        id: 'func:apps/app_a/src/server.py:navigate:10',
        kind: 'function',
        name: 'navigate',
        qualifiedName: 'apps/app_a/src/server.py::navigate',
        filePath: 'apps/app_a/src/server.py',
        language: 'python',
        startLine: 10,
        endLine: 20,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const candidateB: Node = {
        id: 'func:apps/app_b/src/server.py:navigate:15',
        kind: 'function',
        name: 'navigate',
        qualifiedName: 'apps/app_b/src/server.py::navigate',
        filePath: 'apps/app_b/src/server.py',
        language: 'python',
        startLine: 15,
        endLine: 25,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => name === 'navigate' ? [candidateA, candidateB] : [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      // Reference from app_a should resolve to app_a's navigate, not app_b's
      const ref = {
        fromNodeId: 'func:apps/app_a/src/handler.py:handler:5',
        referenceName: 'navigate',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'apps/app_a/src/handler.py',
        language: 'python' as const,
      };

      const result = matchReference(ref, context);

      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('func:apps/app_a/src/server.py:navigate:10');
      expect(result?.resolvedBy).toBe('exact-match');
    });

    it('should lower confidence for cross-module exact matches', () => {
      // Only one candidate but in a completely different module
      const candidates: Node[] = [
        {
          id: 'func:apps/app_b/src/server.py:navigate:10',
          kind: 'function',
          name: 'navigate',
          qualifiedName: 'apps/app_b/src/server.py::navigate',
          filePath: 'apps/app_b/src/server.py',
          language: 'python',
          startLine: 10,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
        {
          id: 'func:apps/app_c/src/server.py:navigate:10',
          kind: 'function',
          name: 'navigate',
          qualifiedName: 'apps/app_c/src/server.py::navigate',
          filePath: 'apps/app_c/src/server.py',
          language: 'python',
          startLine: 10,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => name === 'navigate' ? candidates : [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      // Reference from app_a — neither candidate is in the same module
      const ref = {
        fromNodeId: 'func:apps/app_a/src/handler.py:handler:5',
        referenceName: 'navigate',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'apps/app_a/src/handler.py',
        language: 'python' as const,
      };

      const result = matchReference(ref, context);

      // Should still resolve but with low confidence
      expect(result).not.toBeNull();
      expect(result?.confidence).toBeLessThanOrEqual(0.4);
    });

    it('should match qualified name references', () => {
      const mockClassNode: Node = {
        id: 'class:user.ts:User:5',
        kind: 'class',
        name: 'User',
        qualifiedName: 'user.ts::User',
        filePath: 'user.ts',
        language: 'typescript',
        startLine: 5,
        endLine: 30,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const mockMethodNode: Node = {
        id: 'method:user.ts:User.save:15',
        kind: 'method',
        name: 'save',
        qualifiedName: 'user.ts::User::save',
        filePath: 'user.ts',
        language: 'typescript',
        startLine: 15,
        endLine: 25,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const context: ResolutionContext = {
        getNodesInFile: (fp) => fp === 'user.ts' ? [mockClassNode, mockMethodNode] : [],
        getNodesByName: (name) => {
          if (name === 'User') return [mockClassNode];
          if (name === 'save') return [mockMethodNode];
          return [];
        },
        getNodesByQualifiedName: (qn) => {
          if (qn === 'user.ts::User::save') return [mockMethodNode];
          return [];
        },
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => ['user.ts'],
      };

      const ref = {
        fromNodeId: 'caller:main.ts:main:5',
        referenceName: 'User.save',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'main.ts',
        language: 'typescript' as const,
      };

      const result = matchReference(ref, context);

      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('method:user.ts:User.save:15');
    });
  });

  describe('Ubiquitous-name ceiling (#999)', () => {
    // A vendored theme/SDK re-declares the same method name across thousands of
    // files (Metronic's `init`/`update`/… on every widget). The fuzzy strategies
    // used to score every same-named candidate per ref — O(K) per ref, O(K²)
    // total — which pinned a core for 15-28 min at "Resolving refs … 94%". Above
    // the ceiling they must DECLINE instead, since no proximity/word-overlap
    // score can pick the one true target among thousands anyway.
    const CEILING = 500;

    // A spy context: counts how many nodes the strategy actually inspects, so we
    // can assert the cap short-circuits BEFORE the O(K) scoring (not just that it
    // returns null).
    const makeManyMethods = (n: number, name: string): Node[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `method:widget${i}.js:Widget${i}.${name}:1`,
        kind: 'method' as const,
        name,
        qualifiedName: `widget${i}.js::Widget${i}::${name}`,
        filePath: `static/theme/widget${i}.js`,
        language: 'javascript' as const,
        startLine: 1,
        endLine: 5,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      }));

    const spyContext = (nodes: Node[]): { ctx: ResolutionContext; lookups: () => number } => {
      let scanned = 0;
      const ctx: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => {
          const hit = nodes.filter((n) => n.name === name);
          scanned += hit.length;
          return hit;
        },
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };
      return { ctx, lookups: () => scanned };
    };

    it('declines a method call (`obj.init`) above the ceiling instead of scoring K candidates', () => {
      const { ctx } = spyContext(makeManyMethods(CEILING + 1, 'init'));
      const ref = {
        fromNodeId: 'method:caller.js:caller:1',
        referenceName: 'widget.init',
        referenceKind: 'calls' as const,
        line: 2,
        column: 4,
        filePath: 'static/theme/caller.js',
        language: 'javascript' as const,
      };
      expect(matchReference(ref, ctx)).toBeNull();
    });

    it('declines a bare exact-name ref above the ceiling', () => {
      const { ctx } = spyContext(makeManyMethods(CEILING + 1, 'render'));
      const ref = {
        fromNodeId: 'method:caller.js:caller:1',
        referenceName: 'render',
        referenceKind: 'calls' as const,
        line: 2,
        column: 4,
        filePath: 'static/theme/caller.js',
        language: 'javascript' as const,
      };
      expect(matchReference(ref, ctx)).toBeNull();
    });

    it('still resolves a SAME-FILE definition when one exists (precise path unaffected)', () => {
      // Strategy 1 (class-name) and same-file matching are precise — a ubiquitous
      // name with an unambiguous local target still resolves.
      const nodes = makeManyMethods(CEILING + 1, 'init');
      const local: Node = {
        id: 'class:static/theme/caller.js:Widgetly:1',
        kind: 'class',
        name: 'Widgetly',
        qualifiedName: 'static/theme/caller.js::Widgetly',
        filePath: 'static/theme/caller.js',
        language: 'javascript',
        startLine: 1, endLine: 9, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };
      const localMethod: Node = {
        id: 'method:static/theme/caller.js:Widgetly.init:2',
        kind: 'method',
        name: 'init',
        qualifiedName: 'static/theme/caller.js::Widgetly::init',
        filePath: 'static/theme/caller.js',
        language: 'javascript',
        startLine: 2, endLine: 4, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };
      const all = [...nodes, local, localMethod];
      const ctx: ResolutionContext = {
        getNodesInFile: (fp) => all.filter((n) => n.filePath === fp),
        getNodesByName: (name) => all.filter((n) => n.name === name),
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };
      // `Widgetly.init` names the class explicitly → Strategy 1 resolves it.
      const ref = {
        fromNodeId: 'method:static/theme/caller.js:caller:6',
        referenceName: 'Widgetly.init',
        referenceKind: 'calls' as const,
        line: 6,
        column: 4,
        filePath: 'static/theme/caller.js',
        language: 'javascript' as const,
      };
      const result = matchReference(ref, ctx);
      expect(result?.targetNodeId).toBe('method:static/theme/caller.js:Widgetly.init:2');
    });

    it('still scores normally JUST below the ceiling (no behavior change for normal repos)', () => {
      // Real repos top out near ~40 same-named methods; this proves a sub-ceiling
      // collision still resolves via proximity, so the cap is invisible to them.
      const nodes = makeManyMethods(CEILING - 1, 'update');
      // Make ONE candidate share the caller's directory so proximity picks it.
      nodes[0] = {
        ...nodes[0]!,
        id: 'method:static/theme/app/Widget0.update:1',
        qualifiedName: 'static/theme/app/widget.js::Widget0::update',
        filePath: 'static/theme/app/widget.js',
      };
      const ctx: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => nodes.filter((n) => n.name === name),
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };
      const ref = {
        fromNodeId: 'method:static/theme/app/caller.js:caller:1',
        referenceName: 'update',
        referenceKind: 'calls' as const,
        line: 2,
        column: 4,
        filePath: 'static/theme/app/caller.js',
        language: 'javascript' as const,
      };
      // Below the ceiling the fuzzy path runs and resolves SOMETHING (not capped).
      expect(matchReference(ref, ctx)).not.toBeNull();
    });
  });

  describe('Import Resolver', () => {
    it('should resolve relative import paths', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'src/components/utils.ts' || p === 'src/components/utils/index.ts',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['src/components/utils.ts', 'src/components/utils/index.ts'],
      };

      const result = resolveImportPath(
        './utils',
        'src/components/Button.ts',
        'typescript',
        context
      );

      expect(result).toBe('src/components/utils.ts');
    });

    it('should resolve parent directory imports', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'src/helpers.ts' || p === 'src/helpers/index.ts',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['src/helpers.ts', 'src/helpers/index.ts'],
      };

      const result = resolveImportPath(
        '../helpers',
        'src/components/Button.ts',
        'typescript',
        context
      );

      expect(result).toBe('src/helpers.ts');
    });

    it('should extract JS/TS import mappings', () => {
      const content = `
import { foo } from './foo';
import bar from '../bar';
import * as utils from './utils';
import { baz, qux } from './baz';
`;

      const mappings = extractImportMappings(
        'src/index.ts',
        content,
        'typescript'
      );

      expect(mappings.length).toBeGreaterThan(0);
      expect(mappings.some((m) => m.localName === 'foo')).toBe(true);
      expect(mappings.some((m) => m.localName === 'bar')).toBe(true);
    });

    it('should extract Python import mappings', () => {
      const content = `
from utils import helper
from .models import User
import os
from ..services import auth_service
`;

      const mappings = extractImportMappings(
        'src/main.py',
        content,
        'python'
      );

      expect(mappings.length).toBeGreaterThan(0);
      expect(mappings.some((m) => m.localName === 'helper')).toBe(true);
      expect(mappings.some((m) => m.localName === 'User')).toBe(true);
    });
  });

  describe('JVM FQN Import Resolution', () => {
    // Build a ResolutionContext stub whose getNodesByQualifiedName answers
    // from a fixed table — the only context method resolveJvmImport touches.
    const makeContext = (byQName: Record<string, Node[]>): ResolutionContext => ({
      getNodesInFile: () => [],
      getNodesByName: () => [],
      getNodesByQualifiedName: (q) => byQName[q] ?? [],
      getNodesByKind: () => [],
      fileExists: () => false,
      readFile: () => null,
      getProjectRoot: () => '',
      getAllFiles: () => [],
    });
    const node = (id: string, name: string, qualifiedName: string, kind: Node['kind'] = 'class', language: Node['language'] = 'kotlin'): Node => ({
      id, kind, name, qualifiedName,
      filePath: 'Models.kt', language,
      startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
      updatedAt: 0,
    });
    const importRef = (referenceName: string, language: Node['language'] = 'kotlin'): UnresolvedRef => ({
      fromNodeId: 'caller',
      referenceName,
      referenceKind: 'imports',
      line: 1, column: 0,
      filePath: 'Caller.kt',
      language,
    });

    it('resolves a Kotlin class import by FQN regardless of filename', () => {
      const target = node('n1', 'Bar', 'com.example.foo::Bar');
      const ctx = makeContext({ 'com.example.foo::Bar': [target] });
      const result = resolveJvmImport(importRef('com.example.foo.Bar'), ctx);
      expect(result?.targetNodeId).toBe('n1');
      expect(result?.resolvedBy).toBe('import');
    });

    it('resolves a Kotlin top-level function import by FQN', () => {
      const util = node('n2', 'util', 'com.example.foo::util', 'function');
      const ctx = makeContext({ 'com.example.foo::util': [util] });
      const result = resolveJvmImport(importRef('com.example.foo.util'), ctx);
      expect(result?.targetNodeId).toBe('n2');
    });

    it('resolves a Java import by FQN', () => {
      const target = node('n3', 'Bar', 'com.example.foo::Bar', 'class', 'java');
      const ctx = makeContext({ 'com.example.foo::Bar': [target] });
      const result = resolveJvmImport(importRef('com.example.foo.Bar', 'java'), ctx);
      expect(result?.targetNodeId).toBe('n3');
    });

    it('resolves cross-language: Kotlin importing a Java class', () => {
      // The Kotlin file declares `import com.example.JavaBar` — the target is
      // a Java class node. JVM interop means the resolver doesn't care about
      // the source language of the target, only that the FQN matches.
      const target = node('n4', 'JavaBar', 'com.example::JavaBar', 'class', 'java');
      const ctx = makeContext({ 'com.example::JavaBar': [target] });
      const result = resolveJvmImport(importRef('com.example.JavaBar'), ctx);
      expect(result?.targetNodeId).toBe('n4');
    });

    it('disambiguates a name collision across packages', () => {
      // Two classes named `Bar` in different packages. Each import resolves
      // to the one whose FQN matches — not to "whichever was found first".
      const barA = node('n5a', 'Bar', 'com.example.alpha::Bar');
      const barB = node('n5b', 'Bar', 'com.example.beta::Bar');
      const ctx = makeContext({
        'com.example.alpha::Bar': [barA],
        'com.example.beta::Bar': [barB],
      });
      expect(resolveJvmImport(importRef('com.example.alpha.Bar'), ctx)?.targetNodeId).toBe('n5a');
      expect(resolveJvmImport(importRef('com.example.beta.Bar'), ctx)?.targetNodeId).toBe('n5b');
    });

    it('returns null for wildcard imports', () => {
      const ctx = makeContext({});
      expect(resolveJvmImport(importRef('com.example.foo.*'), ctx)).toBeNull();
    });

    it('returns null for unqualified names', () => {
      // A single-segment name has no package; nothing to look up by FQN.
      const ctx = makeContext({ 'Bar': [node('n6', 'Bar', 'Bar')] });
      expect(resolveJvmImport(importRef('Bar'), ctx)).toBeNull();
    });

    it('returns null for non-JVM languages', () => {
      const target = node('n7', 'Bar', 'com.example::Bar');
      const ctx = makeContext({ 'com.example::Bar': [target] });
      expect(resolveJvmImport(importRef('com.example.Bar', 'typescript'), ctx)).toBeNull();
    });

    it('returns null for non-imports reference kinds', () => {
      // The resolver intentionally only acts on `imports` refs; ordinary
      // `calls`/`extends` refs fall through to the framework + name-matcher
      // strategies.
      const target = node('n8', 'Bar', 'com.example::Bar');
      const ctx = makeContext({ 'com.example::Bar': [target] });
      const ref: UnresolvedRef = {
        fromNodeId: 'caller', referenceName: 'com.example.Bar',
        referenceKind: 'calls', line: 1, column: 0,
        filePath: 'Caller.kt', language: 'kotlin',
      };
      expect(resolveJvmImport(ref, ctx)).toBeNull();
    });

    it('returns null when the FQN is not in the index', () => {
      const ctx = makeContext({});
      expect(resolveJvmImport(importRef('com.example.Unknown'), ctx)).toBeNull();
    });
  });

  describe('Framework Detection', () => {
    it('should detect React framework', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({
              dependencies: { react: '^18.0.0' },
            });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/App.tsx'],
      };

      const frameworks = detectFrameworks(context);
      expect(frameworks.some((f) => f.name === 'react')).toBe(true);
    });

    it('should detect Express framework', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({
              dependencies: { express: '^4.18.0' },
            });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/app.js'],
      };

      const frameworks = detectFrameworks(context);
      expect(frameworks.some((f) => f.name === 'express')).toBe(true);
    });

    it('should detect Laravel framework', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'artisan',
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => ['artisan', 'app/Http/Kernel.php'],
      };

      const frameworks = detectFrameworks(context);
      expect(frameworks.some((f) => f.name === 'laravel')).toBe(true);
    });

    it('should return all framework resolvers', () => {
      const resolvers = getAllFrameworkResolvers();
      expect(resolvers.length).toBeGreaterThan(0);
      expect(resolvers.some((r) => r.name === 'react')).toBe(true);
      expect(resolvers.some((r) => r.name === 'express')).toBe(true);
      expect(resolvers.some((r) => r.name === 'laravel')).toBe(true);
    });
  });

  describe('React Framework Resolver', () => {
    it('should resolve React component references', () => {
      const mockNodes: Node[] = [
        {
          id: 'component:src/Button.tsx:Button:5',
          kind: 'component',
          name: 'Button',
          qualifiedName: 'src/Button.tsx::Button',
          filePath: 'src/Button.tsx',
          language: 'tsx',
          startLine: 5,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        getNodesInFile: (fp) => (fp === 'src/Button.tsx' ? mockNodes : []),
        getNodesByName: () => mockNodes,
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({ dependencies: { react: '^18.0.0' } });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/Button.tsx', 'src/App.tsx'],
      };

      const frameworks = detectFrameworks(context);
      const reactResolver = frameworks.find((f) => f.name === 'react');
      expect(reactResolver).toBeDefined();

      const ref = {
        fromNodeId: 'component:src/App.tsx:App:1',
        referenceName: 'Button',
        referenceKind: 'renders' as const,
        line: 10,
        column: 5,
        filePath: 'src/App.tsx',
        // Refs extracted from .tsx files carry language 'tsx' — component
        // resolution is gated to JSX-capable refs (#764: PascalCase TYPE refs
        // from plain .ts files were resolving to arbitrary same-named classes).
        language: 'tsx' as const,
      };

      const result = reactResolver!.resolve(ref, context);
      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('component:src/Button.tsx:Button:5');

      // The same PascalCase name referenced from a plain .ts file is a TYPE
      // reference, not a component usage — component resolution must decline
      // and leave it to proximity-aware name matching (#764: a .ts GraphQL
      // types file's own `Account` alias was losing to an arbitrary same-named
      // class in another monorepo package).
      const tsRef = { ...ref, filePath: 'src/models.ts', language: 'typescript' as const };
      expect(reactResolver!.resolve(tsRef, context)).toBeNull();
    });

    it('should resolve custom hook references', () => {
      const mockNodes: Node[] = [
        {
          id: 'hook:src/hooks/useAuth.ts:useAuth:1',
          kind: 'function',
          name: 'useAuth',
          qualifiedName: 'src/hooks/useAuth.ts::useAuth',
          filePath: 'src/hooks/useAuth.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        getNodesInFile: (fp) => (fp.includes('useAuth') ? mockNodes : []),
        getNodesByName: () => mockNodes,
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({ dependencies: { react: '^18.0.0' } });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/hooks/useAuth.ts'],
      };

      const frameworks = detectFrameworks(context);
      const reactResolver = frameworks.find((f) => f.name === 'react');

      const ref = {
        fromNodeId: 'component:src/App.tsx:App:1',
        referenceName: 'useAuth',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'src/App.tsx',
        language: 'typescript' as const,
      };

      const result = reactResolver!.resolve(ref, context);
      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('hook:src/hooks/useAuth.ts:useAuth:1');
    });
  });

  describe('Integration Tests', () => {
    it('should create resolver from CodeGraph instance', async () => {
      // Create a simple TypeScript project
      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test', dependencies: { react: '^18.0.0' } })
      );

      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir);

      // Create utility file
      fs.writeFileSync(
        path.join(srcDir, 'utils.ts'),
        `export function formatDate(date: Date): string {
  return date.toISOString();
}

export function parseDate(str: string): Date {
  return new Date(str);
}`
      );

      // Create main file that uses utils
      fs.writeFileSync(
        path.join(srcDir, 'main.ts'),
        `import { formatDate, parseDate } from './utils';

function processDate(input: string): string {
  const date = parseDate(input);
  return formatDate(date);
}`
      );

      // Initialize and index
      cg = await CodeGraph.init(tempDir, { index: true });

      // Check that resolver detected React framework
      const frameworks = cg.getDetectedFrameworks();
      expect(frameworks).toContain('react');

      // Get stats to verify indexing worked
      const stats = cg.getStats();
      expect(stats.fileCount).toBe(2);
      expect(stats.nodeCount).toBeGreaterThan(0);
    });

    it('should resolve references after indexing', async () => {
      // Create a project with references
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(
        path.join(srcDir, 'helper.ts'),
        `export function helperFunction(): void {
  console.log('helper');
}`
      );

      fs.writeFileSync(
        path.join(srcDir, 'main.ts'),
        `import { helperFunction } from './helper';

function main(): void {
  helperFunction();
}`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      // Run reference resolution
      const result = cg.resolveReferences();

      // Should have attempted resolution
      expect(result.stats.total).toBeGreaterThanOrEqual(0);
    });

    it('promotes calls→instantiates when target resolves to a class (Python)', async () => {
      // Python has no `new` keyword — `Foo()` is the standard
      // instantiation syntax. Extraction can't tell that apart from
      // a function call without symbol info, so it emits a `calls`
      // ref. Resolution promotes it to `instantiates` once the
      // target is known to be a class.
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(
        path.join(srcDir, 'app.py'),
        `class UserService:
    def __init__(self):
        self.db = None

def bootstrap():
    return UserService()
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const bootstrap = cg
        .getNodesByKind('function')
        .find((n) => n.name === 'bootstrap');
      expect(bootstrap).toBeDefined();

      const outgoing = cg.getOutgoingEdges(bootstrap!.id);
      const instantiates = outgoing.find((e) => e.kind === 'instantiates');
      expect(instantiates).toBeDefined();
      // Same edge must NOT also appear as a `calls` edge — promotion
      // replaces the kind, doesn't duplicate.
      const callsToUserService = outgoing.filter(
        (e) => e.kind === 'calls' && e.target === instantiates!.target
      );
      expect(callsToUserService).toHaveLength(0);
    });

    it('records instantiates for C++ stack/brace construction, targeting the class (#1035)', async () => {
      // `Calculator calc(0)` (direct-init) and `Widget w{1, 2}` (brace-init)
      // carry the constructor args directly on the declarator — there's no
      // call/new node — so they recorded no `instantiates` edge, while heap
      // `new Calculator(0)` did. Both stack forms now do.
      fs.writeFileSync(
        path.join(tempDir, 'm.cpp'),
        `class Calculator { public: Calculator(int seed) {} int add(int a, int b){ return a+b; } };
class Widget { public: Widget(int a, int b) {} };

int runStack(int a, int b) { Calculator calc(0); return calc.add(a, b); }
int runBrace() { Widget w{1, 2}; return 0; }
int runHeap(int a, int b) { Calculator* c = new Calculator(0); return c->add(a, b); }
void noise() { int x(5); int y{6}; Calculator deferred; }
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });

      const fn = (name: string) => cg.getNodesByKind('function').find((n) => n.name === name)!;
      const instTargets = (name: string) =>
        cg
          .getOutgoingEdges(fn(name).id)
          .filter((e) => e.kind === 'instantiates')
          .map((e) => cg.getNode(e.target)!);

      // Direct-init (the issue) and brace-init both instantiate, targeting the
      // CLASS node — not the same-named constructor method.
      const stack = instTargets('runStack');
      expect(stack.map((n) => `${n.kind}:${n.name}`)).toContain('class:Calculator');
      expect(instTargets('runBrace').map((n) => `${n.kind}:${n.name}`)).toContain('class:Widget');
      // Heap still works (regression guard).
      expect(instTargets('runHeap').map((n) => `${n.kind}:${n.name}`)).toContain('class:Calculator');
      // Primitives (`int x(0)`/`int y{6}`) and bare default construction
      // (`Calculator deferred;`) must NOT mint an instantiates edge.
      expect(instTargets('noise')).toHaveLength(0);
    });

    it('resolves a cross-file static method call to the method, not the class (#825)', async () => {
      // `Foo.bar()` where `Foo` is an imported class must link to the static
      // method `Foo::bar`, NOT to the class `Foo`. Previously the import
      // resolver dropped the `.bar` member and resolved to `Foo`, which the
      // calls→instantiates promotion then turned into `run instantiates Foo`,
      // leaving the static method with zero callers and a hollow impact radius.
      fs.writeFileSync(
        path.join(tempDir, 'helpers.ts'),
        `export class Foo {\n  static bar(x: number) { return x + 1; }\n}\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'caller.ts'),
        `import { Foo } from './helpers';\nexport function run() { return Foo.bar(41); }\n`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const bar = cg.getNodesByKind('method').find((n) => n.name === 'bar');
      const foo = cg.getNodesByKind('class').find((n) => n.name === 'Foo');
      const run = cg.getNodesByKind('function').find((n) => n.name === 'run');
      expect(bar).toBeDefined();
      expect(foo).toBeDefined();
      expect(run).toBeDefined();

      // `run` is reported as a caller of the static method `Foo.bar`.
      const barCallers = cg.getCallers(bar!.id).map((c) => c.node.name);
      expect(barCallers).toContain('run');

      // And the call is NOT mis-promoted to `run instantiates Foo`.
      const outgoing = cg.getOutgoingEdges(run!.id);
      expect(
        outgoing.filter((e) => e.kind === 'instantiates' && e.target === foo!.id)
      ).toHaveLength(0);
      // The real edge is a `calls` edge to the method.
      expect(
        outgoing.some((e) => e.kind === 'calls' && e.target === bar!.id)
      ).toBe(true);
    });

    it('resolves Go cross-package qualified calls via go.mod module path (#388)', async () => {
      // Pre-#388, every `pkga.FuncX(...)` call in a Go monorepo was flagged
      // external (isExternalImport returned true for any non-`/internal/`
      // import without `.`-prefix) and resolution fell through to name-match
      // with path proximity — recall on cross-package callers was ~<1%.
      fs.writeFileSync(
        path.join(tempDir, 'go.mod'),
        'module github.com/example/myproject\n\ngo 1.21\n'
      );

      const pkgaDir = path.join(tempDir, 'pkga');
      const pkgbDir = path.join(tempDir, 'pkgb');
      const pkgcDir = path.join(tempDir, 'pkgc');
      fs.mkdirSync(pkgaDir);
      fs.mkdirSync(pkgbDir);
      fs.mkdirSync(pkgcDir);

      // Same-name exported function in two packages — only the imported one
      // should resolve. Exercises disambiguation, not just connectivity.
      fs.writeFileSync(
        path.join(pkgaDir, 'conv.go'),
        'package pkga\nfunc Convert(x int) int { return x * 2 }\n'
      );
      fs.writeFileSync(
        path.join(pkgbDir, 'conv.go'),
        'package pkgb\nfunc Convert(x int) int { return x + 1 }\n'
      );
      fs.writeFileSync(
        path.join(pkgcDir, 'use.go'),
        `package pkgc

import "github.com/example/myproject/pkga"

func UsePkga() {
  pkga.Convert(5)
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      const usePkga = cg.getNodesByKind('function').filter((n) => n.name ==='UsePkga')[0];
      expect(usePkga).toBeDefined();

      const outgoing = cg.getOutgoingEdges(usePkga!.id);
      const callEdges = outgoing.filter((e) => e.kind === 'calls');
      expect(callEdges).toHaveLength(1);

      const target = cg.getNode(callEdges[0]!.target);
      expect(target?.name).toBe('Convert');
      // Critical: the resolver must pick the imported pkga's Convert,
      // not pkgb's. With the broken (pre-fix) resolver this lands on
      // whichever Convert happens to be cheaper under path proximity.
      expect(target?.filePath.replace(/\\/g, '/')).toBe('pkga/conv.go');
    });

    it('resolves Go aliased imports across packages (#388)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'go.mod'),
        'module github.com/example/myproject\n\ngo 1.21\n'
      );
      fs.mkdirSync(path.join(tempDir, 'pkgb'));
      fs.mkdirSync(path.join(tempDir, 'pkgd'));

      fs.writeFileSync(
        path.join(tempDir, 'pkgb', 'lib.go'),
        'package pkgb\nfunc Compute(x int) int { return x }\n'
      );
      fs.writeFileSync(
        path.join(tempDir, 'pkgd', 'use.go'),
        `package pkgd

import (
  "fmt"
  alias "github.com/example/myproject/pkgb"
)

func UseAliased() {
  fmt.Println("hi")
  alias.Compute(3)
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      const useAliased = cg.getNodesByKind('function').filter((n) => n.name ==='UseAliased')[0];
      expect(useAliased).toBeDefined();
      const calls = cg.getOutgoingEdges(useAliased!.id).filter((e) => e.kind === 'calls');
      // fmt.Println is stdlib — must stay external. alias.Compute must resolve.
      expect(calls).toHaveLength(1);
      const target = cg.getNode(calls[0]!.target);
      expect(target?.name).toBe('Compute');
      expect(target?.filePath.replace(/\\/g, '/')).toBe('pkgb/lib.go');
    });

    it('resolves Python module-attribute calls after `from pkg import module` (#578)', async () => {
      // Pre-#578, a `module.func()` call where `module` was bound via
      // `from pkg import module` dropped its `calls` edge. The file→file import
      // edge resolved (resolveModuleImportToFile falls back to a dotted-module
      // file lookup for absolute package paths), but resolvePythonModuleMember
      // had no such fallback — resolveImportPath returns null for an absolute
      // package path like `pkg.module`, so the member never resolved and
      // callers/callees/impact on the target came back empty. Same root-cause
      // class as the Go cross-package qualified call (#388).
      fs.mkdirSync(path.join(tempDir, 'pkg'));
      fs.writeFileSync(path.join(tempDir, 'pkg', '__init__.py'), '');
      fs.writeFileSync(
        path.join(tempDir, 'pkg', 'module.py'),
        'def func():\n    return 1\n'
      );
      fs.writeFileSync(
        path.join(tempDir, 'main.py'),
        `from pkg import module
import os


def caller():
    return module.func()


def external_caller():
    return os.getcwd()
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      const caller = cg.getNodesByKind('function').filter((n) => n.name === 'caller')[0];
      expect(caller).toBeDefined();
      const calls = cg.getOutgoingEdges(caller!.id).filter((e) => e.kind === 'calls');
      // module.func() must resolve to the real function in the submodule file.
      expect(calls).toHaveLength(1);
      const target = cg.getNode(calls[0]!.target);
      expect(target?.name).toBe('func');
      expect(target?.filePath.replace(/\\/g, '/')).toBe('pkg/module.py');

      // The flip side of the fix: an attribute call through a *stdlib* module
      // (`os.getcwd()`) must still create no edge — the fallback only matches
      // real in-repo module files.
      const externalCaller = cg.getNodesByKind('function').filter((n) => n.name === 'external_caller')[0];
      expect(externalCaller).toBeDefined();
      const externalCalls = cg.getOutgoingEdges(externalCaller!.id).filter((e) => e.kind === 'calls');
      expect(externalCalls).toHaveLength(0);
    });

    it('attaches Go methods to their receiver type across files (#583, cross-file half)', async () => {
      // In Go a type's methods are commonly declared in a different file from the
      // `type` declaration (`type Box` in box.go, `func (b *Box) Get()` in
      // box_methods.go). Extraction only attaches the struct→method `contains`
      // edge when the type is in the SAME file (the owner lookup is file-scoped),
      // so a cross-file method was orphaned from its struct — breaking member
      // outlines and any callers/callees/impact traversal through `contains`. A
      // resolution-phase pass now links them within the package (= directory).
      fs.writeFileSync(
        path.join(tempDir, 'box.go'),
        'package main\n\ntype Box struct{ v int }\n'
      );
      fs.writeFileSync(
        path.join(tempDir, 'box_methods.go'),
        'package main\n\nfunc (b *Box) Get() int { return b.v }\nfunc (b *Box) Set(x int) { b.v = x }\n'
      );
      // Generic receiver declared cross-file too — exercises #583 half A
      // (generic `*Stack[T]` receiver parsing) and half B (cross-file) together.
      fs.writeFileSync(
        path.join(tempDir, 'stack.go'),
        'package main\n\ntype Stack[T any] struct {\n\titems []T\n}\n'
      );
      fs.writeFileSync(
        path.join(tempDir, 'stack_push.go'),
        'package main\n\nfunc (s *Stack[T]) Push(v T) { s.items = append(s.items, v) }\n'
      );
      // A same-named type in another package must NOT capture this package's
      // methods — the link is scoped to the receiver type's own directory.
      fs.mkdirSync(path.join(tempDir, 'other'));
      fs.writeFileSync(
        path.join(tempDir, 'other', 'box.go'),
        'package other\n\ntype Box struct{ w int }\n'
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      const methodsOf = (typeName: string, file: string): string[] => {
        const node = cg
          .getNodesByKind('struct')
          .find((n) => n.name === typeName && n.filePath.replace(/\\/g, '/') === file);
        expect(node, `${typeName} @ ${file}`).toBeDefined();
        return cg
          .getOutgoingEdges(node!.id)
          .filter((e) => e.kind === 'contains')
          .map((e) => cg.getNode(e.target))
          .filter((n) => !!n && n.kind === 'method')
          .map((n) => n!.name)
          .sort();
      };

      // Cross-file (non-generic) methods now attach to their struct.
      expect(methodsOf('Box', 'box.go')).toEqual(['Get', 'Set']);
      // Generic + cross-file.
      expect(methodsOf('Stack', 'stack.go')).toEqual(['Push']);
      // Cross-package isolation: other/Box defines no methods of its own.
      expect(methodsOf('Box', 'other/box.go')).toEqual([]);
    });

    it('TS type_alias object-shape members resolve method calls (#359)', async () => {
      // Pre-#359, `recorder.stop()` (recorder: RecorderHandle) attached
      // to `StdioMcpClient.stop` in a sibling directory via path-proximity
      // because the type_alias had no `stop` node — only the unrelated
      // class did. Now type_alias produces member nodes (property/method),
      // so the camelCase receiver↔type word overlap pulls the call to
      // `RecorderHandle::stop` instead of the look-alike class.
      fs.mkdirSync(path.join(tempDir, 'voice'));
      fs.mkdirSync(path.join(tempDir, 'codegraph'));

      fs.writeFileSync(
        path.join(tempDir, 'voice', 'recorder.ts'),
        `export type RecorderHandle = {
  wavPath: string;
  stop: () => Promise<{ ok: true }>;
};
`
      );
      fs.writeFileSync(
        path.join(tempDir, 'voice', 'controller.ts'),
        `import type { RecorderHandle } from "./recorder";
export async function finaliseRecording(recorder: RecorderHandle) {
  return await recorder.stop();
}
`
      );
      fs.writeFileSync(
        path.join(tempDir, 'codegraph', 'stdio-client.ts'),
        `export class StdioMcpClient {
  private stopped = false;
  async stop(): Promise<void> { this.stopped = true; }
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      const handleStop = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName === 'RecorderHandle::stop');
      expect(handleStop).toBeDefined();

      const clientStop = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName === 'StdioMcpClient::stop');
      expect(clientStop).toBeDefined();

      const handleCallers = cg.getIncomingEdges(handleStop!.id).filter((e) => e.kind === 'calls');
      const clientCallers = cg.getIncomingEdges(clientStop!.id).filter((e) => e.kind === 'calls');
      expect(handleCallers.length).toBeGreaterThanOrEqual(1);
      // The class method must have NO callers — voice/'s call must NOT
      // mis-attribute. A non-empty list would mean the false-positive
      // path is still firing.
      expect(clientCallers).toHaveLength(0);

      // Function-typed property surfaces as a `method` node, not `property`,
      // because `stop()` semantics at the call site are method semantics.
      expect(handleStop!.kind).toBe('method');
    });

    it('Java import disambiguates same-name classes across modules (#314)', async () => {
      // Pre-#314 the import resolver had no Java branch at all, so a
      // multi-module Maven repo where `dao/converter/FooConverter` and
      // `service/converter/FooConverter` both export a `convert` method
      // resolved by file-path proximity — picking whichever class was
      // closer to the caller, which is wrong any time the caller lives
      // in an equidistant cross-cutting module.
      const daoDir = path.join(tempDir, 'dao/src/main/java/com/example/dao/converter');
      const serviceDir = path.join(tempDir, 'service/src/main/java/com/example/service/converter');
      const webDir = path.join(tempDir, 'web/src/main/java/com/example/web');
      fs.mkdirSync(daoDir, { recursive: true });
      fs.mkdirSync(serviceDir, { recursive: true });
      fs.mkdirSync(webDir, { recursive: true });

      fs.writeFileSync(
        path.join(daoDir, 'FooConverter.java'),
        `package com.example.dao.converter;
public class FooConverter { public String convert(String x) { return "dao:" + x; } }
`
      );
      fs.writeFileSync(
        path.join(serviceDir, 'FooConverter.java'),
        `package com.example.service.converter;
public class FooConverter { public String convert(String x) { return "svc:" + x; } }
`
      );
      // The caller imports the SERVICE version — even though dao is
      // alphabetically/lexically first in the candidate list, the
      // import must trump that order.
      fs.writeFileSync(
        path.join(webDir, 'Handler.java'),
        `package com.example.web;

import com.example.service.converter.FooConverter;

public class Handler {
  private FooConverter fooConverter;
  public String use() { return fooConverter.convert("input"); }
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      const use = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName === 'com.example.web::Handler::use');
      expect(use).toBeDefined();
      const calls = cg.getOutgoingEdges(use!.id).filter((e) => e.kind === 'calls');
      expect(calls.length).toBeGreaterThanOrEqual(1);

      const target = cg.getNode(calls[0]!.target);
      expect(target?.name).toBe('convert');
      expect(target?.filePath.replace(/\\/g, '/')).toBe(
        'service/src/main/java/com/example/service/converter/FooConverter.java'
      );
    });

    it('C# extracts references from method/property/field types (#381)', async () => {
      // Pre-#381, every C# project produced ZERO `references` edges:
      // csharp.ts was missing returnField, and the type-leaf walker
      // only recognized TS/Java's `type_identifier` nodes — C# uses
      // `identifier`/`predefined_type`/`qualified_name`/`generic_name`.
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(
        path.join(srcDir, 'Dtos.cs'),
        `namespace MyApp;
public class SessionInfoDto { public string Id { get; set; } = ""; }
public class UserDto { public string Name { get; set; } = ""; }
`
      );
      fs.writeFileSync(
        path.join(srcDir, 'Service.cs'),
        `using System.Threading.Tasks;
namespace MyApp;
public class DataExporter
{
  public SessionInfoDto Build(UserDto user, SessionInfoDto session) { return session; }
  public Task<SessionInfoDto> BuildAsync(UserDto user) { return Task.FromResult(new SessionInfoDto()); }
  public SessionInfoDto Latest { get; set; } = new();
  private UserDto _cached;
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      const sessionDto = cg
        .getNodesByKind('class')
        .find((n) => n.name === 'SessionInfoDto');
      const userDto = cg
        .getNodesByKind('class')
        .find((n) => n.name === 'UserDto');
      expect(sessionDto).toBeDefined();
      expect(userDto).toBeDefined();

      const sessionIncoming = cg
        .getIncomingEdges(sessionDto!.id)
        .filter((e) => e.kind === 'references');
      const userIncoming = cg
        .getIncomingEdges(userDto!.id)
        .filter((e) => e.kind === 'references');

      // SessionInfoDto: Build return, Build param, BuildAsync return (inside Task<>), Latest property.
      // UserDto: Build param, BuildAsync param, _cached field.
      expect(sessionIncoming.length).toBeGreaterThanOrEqual(4);
      expect(userIncoming.length).toBeGreaterThanOrEqual(3);
    });

    it('C# primary-constructor parameters record their type dependencies (#237)', async () => {
      // C# 12 primary constructors declare a type's injected dependencies inline
      // (`class Svc(IRepo repo, [FromKeyedServices("k")] ICache cache)`). Each
      // ctor parameter's type is recorded as a `references` edge from the class,
      // so a DI-registered contract reached only through a primary ctor is no
      // longer reported as having no dependents.
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'Contracts.cs'),
        `namespace App;
public interface IRepo { }
public class ICache { }
`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', 'OrderService.cs'),
        `namespace App;
public sealed class OrderService(IRepo repo, [FromKeyedServices("primary")] ICache cache)
{
  public void Run() { }
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      const svc = cg.getNodesByKind('class').find((n) => n.name === 'OrderService');
      expect(svc).toBeDefined();
      // The class itself must index (it used to vanish under the old grammar).
      const out = cg.getOutgoingEdges(svc!.id).filter((e) => e.kind === 'references');
      const depNames = out.map((e) => cg.getNode(e.target)?.name);
      expect(depNames).toContain('IRepo');
      expect(depNames).toContain('ICache'); // the keyed-DI ([FromKeyedServices]) dependency
    });

    it('Go: leaves stdlib calls (fmt.Println, etc.) external', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'go.mod'),
        'module github.com/example/myproject\n\ngo 1.21\n'
      );
      fs.writeFileSync(
        path.join(tempDir, 'main.go'),
        `package main

import "fmt"

func main() {
  fmt.Println("hi")
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });

      const mainFn = cg.getNodesByKind('function').filter((n) => n.name ==='main')[0];
      const calls = cg.getOutgoingEdges(mainFn!.id).filter((e) => e.kind === 'calls');
      // No spurious in-project edge — fmt.* must stay unresolved/external.
      expect(calls).toHaveLength(0);
    });
  });

  describe('Same-name method disambiguation (#1079)', () => {
    // resolveMethodOnType picks among several methods that share a
    // `Type::method` qualifiedName. The precedence is:
    //   1. preferredFqn (Java/Kotlin import — target is intentionally in
    //      ANOTHER file, #314),
    //   2. the call site's OWN file (language-agnostic, #1079),
    //   3. matches[0] (first-indexed) as a last resort.
    const methodNode = (
      id: string,
      filePath: string,
      language: Node['language'] = 'cpp',
      qualifiedName = 'Logger::log',
      name = 'log',
    ): Node => ({
      id, kind: 'method', name, qualifiedName, filePath, language,
      startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0,
    });
    const callRef = (filePath: string, language: Node['language'] = 'cpp'): UnresolvedRef => ({
      fromNodeId: 'caller', referenceName: 'lg.log', referenceKind: 'calls',
      line: 2, column: 0, filePath, language,
    });
    const ctxFor = (candidates: Node[]): ResolutionContext => ({
      getNodesInFile: () => [],
      getNodesByName: (name) => candidates.filter((c) => c.name === name),
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: () => false,
      readFile: () => null,
      getProjectRoot: () => '',
      getAllFiles: () => [],
    });

    it('prefers the definition in the call site\'s own file (#1079)', () => {
      // matches[0] is the a/ definition; the call comes from b/, so it must
      // resolve to b/ — not collapse onto the first-indexed match.
      const logA = methodNode('m:a', 'a/svc.cpp');
      const logB = methodNode('m:b', 'b/svc.cpp');
      const result = resolveMethodOnType(
        'Logger', 'log', callRef('b/svc.cpp'), ctxFor([logA, logB]), 0.9, 'instance-method',
      );
      expect(result?.targetNodeId).toBe('m:b');
    });

    it('lets an import FQN pin a cross-file target over the same-file preference (#314)', () => {
      // Java: two `Bar::doIt` in different packages. The import FQN pins the
      // alpha package; even though the call site lives in beta's file, the FQN
      // must win — the same-file preference runs only AFTER preferredFqn.
      const alpha = methodNode('m:alpha', 'com/example/alpha/Bar.java', 'java', 'Bar::doIt', 'doIt');
      const beta = methodNode('m:beta', 'com/example/beta/Bar.java', 'java', 'Bar::doIt', 'doIt');
      const result = resolveMethodOnType(
        'Bar', 'doIt', callRef('com/example/beta/Bar.java', 'java'),
        ctxFor([alpha, beta]), 0.9, 'instance-method', 'com.example.alpha.Bar',
      );
      expect(result?.targetNodeId).toBe('m:alpha');
    });

    it('falls back to the first match when nothing disambiguates', () => {
      // Call site is a third file: no FQN, no same-file candidate → matches[0].
      const logA = methodNode('m:a', 'a/svc.cpp');
      const logB = methodNode('m:b', 'b/svc.cpp');
      const result = resolveMethodOnType(
        'Logger', 'log', callRef('c/other.cpp'), ctxFor([logA, logB]), 0.9, 'instance-method',
      );
      expect(result?.targetNodeId).toBe('m:a');
    });

    it('resolves C++ calls end-to-end to same-named classes in different files (#1079)', async () => {
      // The exact repro from the issue: two files, each with its own
      // `Logger::log`. Before the fix both callers pointed at the first def.
      fs.mkdirSync(path.join(tempDir, 'a'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'b'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'a', 'svc.cpp'),
        `class Logger { public: void log() { int a = 1; } };\nvoid useA() { Logger lg; lg.log(); }\n`,
      );
      fs.writeFileSync(
        path.join(tempDir, 'b', 'svc.cpp'),
        `class Logger { public: void log() { int b = 2; } };\nvoid useB() { Logger lg; lg.log(); }\n`,
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const logInDir = (dir: string) =>
        cg.getNodesByKind('method').find(
          (n) => n.name === 'log' && n.filePath.replace(/\\/g, '/').endsWith(`${dir}/svc.cpp`),
        )!;
      const callTargets = (fnName: string) =>
        cg
          .getOutgoingEdges(cg.getNodesByKind('function').find((n) => n.name === fnName)!.id)
          .filter((e) => e.kind === 'calls')
          .map((e) => e.target);

      const logA = logInDir('a');
      const logB = logInDir('b');
      expect(logA).toBeDefined();
      expect(logB).toBeDefined();
      expect(logA.id).not.toBe(logB.id);

      // Each caller resolves to the Logger::log in its OWN file.
      expect(callTargets('useA')).toContain(logA.id);
      expect(callTargets('useB')).toContain(logB.id);
    });

    it('preferCallSiteFile puts same-file candidates first and is otherwise a no-op', () => {
      const a = methodNode('m:a', 'a/svc.cpp');
      const b = methodNode('m:b', 'b/svc.cpp');
      // Same-file first; the rest keep their original order (stable).
      expect(preferCallSiteFile([a, b], 'b/svc.cpp').map((n) => n.id)).toEqual(['m:b', 'm:a']);
      expect(preferCallSiteFile([a, b], 'a/svc.cpp').map((n) => n.id)).toEqual(['m:a', 'm:b']);
      // No same-file match → unchanged; <2 candidates → returned as-is.
      expect(preferCallSiteFile([a, b], 'c/other.cpp').map((n) => n.id)).toEqual(['m:a', 'm:b']);
      expect(preferCallSiteFile([a], 'z/none.cpp')).toHaveLength(1);
    });

    it('matchByQualifiedName prefers the same-file target when a qualified name is ambiguous (#1079)', () => {
      // Two `Logger::log` definitions; an explicit `Logger::log()` call from b/
      // must resolve to b/'s definition, not the first-indexed one.
      const a = methodNode('m:a', 'a/svc.cpp');
      const b = methodNode('m:b', 'b/svc.cpp');
      const ctx: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => [a, b].filter((n) => n.name === name),
        getNodesByQualifiedName: (q) => (q === 'Logger::log' ? [a, b] : []),
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => [],
      };
      const ref: UnresolvedRef = {
        fromNodeId: 'caller', referenceName: 'Logger::log', referenceKind: 'calls',
        line: 2, column: 0, filePath: 'b/svc.cpp', language: 'cpp',
      };
      expect(matchByQualifiedName(ref, ctx)?.targetNodeId).toBe('m:b');
    });

    it('resolves a static/class-receiver call to the class in the caller\'s file (#1079)', async () => {
      // `Logger.log()` — the receiver is the class NAME, so this routes through
      // the class-name-receiver strategy (not the C++ instance path). It was
      // file-blind across languages; verified here on TypeScript.
      fs.mkdirSync(path.join(tempDir, 'a'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'b'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'a', 'svc.ts'),
        `class Logger { static log() { return 1; } }\nexport function useA() { return Logger.log(); }\n`,
      );
      fs.writeFileSync(
        path.join(tempDir, 'b', 'svc.ts'),
        `class Logger { static log() { return 2; } }\nexport function useB() { return Logger.log(); }\n`,
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const logInDir = (dir: string) =>
        cg.getNodesByKind('method').find(
          (n) => n.name === 'log' && n.filePath.replace(/\\/g, '/').endsWith(`${dir}/svc.ts`),
        )!;
      const callTargets = (fnName: string) =>
        cg
          .getOutgoingEdges(cg.getNodesByKind('function').find((n) => n.name === fnName)!.id)
          .filter((e) => e.kind === 'calls')
          .map((e) => e.target);

      const logA = logInDir('a');
      const logB = logInDir('b');
      expect(logA?.id).not.toBe(logB?.id);
      expect(callTargets('useA')).toContain(logA.id);
      expect(callTargets('useB')).toContain(logB.id);
    });

    it('resolves an explicitly-qualified call to the definition in the caller\'s file (#1079)', async () => {
      // `Logger::log()` with two `Logger::log` definitions routes through the
      // qualified-name strategy, whose partial match previously picked the first.
      fs.mkdirSync(path.join(tempDir, 'a'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'b'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'a', 'svc.cpp'),
        `class Logger { public: static void log() { int a = 1; } };\nvoid useA() { Logger::log(); }\n`,
      );
      fs.writeFileSync(
        path.join(tempDir, 'b', 'svc.cpp'),
        `class Logger { public: static void log() { int b = 2; } };\nvoid useB() { Logger::log(); }\n`,
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const logInDir = (dir: string) =>
        cg.getNodesByKind('method').find(
          (n) => n.name === 'log' && n.filePath.replace(/\\/g, '/').endsWith(`${dir}/svc.cpp`),
        )!;
      const callTargets = (fnName: string) =>
        cg
          .getOutgoingEdges(cg.getNodesByKind('function').find((n) => n.name === fnName)!.id)
          .filter((e) => e.kind === 'calls')
          .map((e) => e.target);

      const logA = logInDir('a');
      const logB = logInDir('b');
      expect(logA?.id).not.toBe(logB?.id);
      expect(callTargets('useA')).toContain(logA.id);
      expect(callTargets('useB')).toContain(logB.id);
    });
  });

  describe('Watchdog-safe resolution on collision-heavy repos (#1122)', () => {
    // On a large Java-style repo, per-ref resolution cost is unbounded in the
    // worst case (a colliding method name whose candidate set misses the LRU
    // re-fetches tens of thousands of rows, and receiver inference re-splits
    // the whole source file). v1.2.0 yielded only every 500 refs, so a dense
    // pocket multiplied that cost past the #850 watchdog window and a VALID
    // `init` was SIGKILLed at "Resolving refs". These pin the three guards:
    // per-ref yield checkpoints, the (type, method) match memo, and the
    // per-file lines cache with its generated/minified-line skip.
    const methodNode = (
      id: string,
      filePath: string,
      qualifiedName: string,
      name: string,
      language: Node['language'] = 'typescript',
      kind: Node['kind'] = 'method',
    ): Node => ({
      id, kind, name, qualifiedName, filePath, language,
      startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0,
    });

    it('resolveMethodOnType consults the method-match memo and still disambiguates per call site', () => {
      const logA = methodNode('m:a', 'a/svc.ts', 'Logger::log', 'log');
      const logB = methodNode('m:b', 'b/svc.ts', 'Logger::log', 'log');
      const shared = [logA, logB]; // one cached array served to every caller
      let memoCalls = 0;
      let rawNameLookups = 0;
      const ctx: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => { rawNameLookups++; return shared; },
        getMethodMatches: () => { memoCalls++; return shared; },
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => [],
      };
      const refFrom = (filePath: string): UnresolvedRef => ({
        fromNodeId: 'caller', referenceName: 'lg.log', referenceKind: 'calls',
        line: 2, column: 0, filePath, language: 'typescript',
      });

      // Both call sites read the SAME memoized array, yet each still resolves
      // to its own file — per-ref disambiguation runs after the memo (#1079).
      const fromA = resolveMethodOnType('Logger', 'log', refFrom('a/svc.ts'), ctx, 0.9, 'instance-method');
      const fromB = resolveMethodOnType('Logger', 'log', refFrom('b/svc.ts'), ctx, 0.9, 'instance-method');
      expect(fromA?.targetNodeId).toBe('m:a');
      expect(fromB?.targetNodeId).toBe('m:b');
      expect(memoCalls).toBe(2);
      expect(rawNameLookups).toBe(0); // memo bypasses the unbounded name fetch
    });

    it('the production resolver context memoizes method matches per (language, type, method)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'svc.ts'),
        `class Logger { log() { return 1; } }\nexport function use() { const lg = new Logger(); return lg.log(); }\n`,
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      const resolver = (cg as unknown as { resolver: ReferenceResolver }).resolver;
      const ctx = (resolver as unknown as { context: ResolutionContext }).context;

      const first = ctx.getMethodMatches!('Logger', 'log', 'typescript');
      const second = ctx.getMethodMatches!('Logger', 'log', 'typescript');
      expect(first.map((n) => n.qualifiedName)).toEqual(['Logger::log']);
      // Same array instance = served from the memo, not recomputed.
      expect(second).toBe(first);

      resolver.clearCaches();
      const afterClear = ctx.getMethodMatches!('Logger', 'log', 'typescript');
      expect(afterClear).not.toBe(first);
      expect(afterClear.map((n) => n.qualifiedName)).toEqual(['Logger::log']);
    });

    it('resolveBatchYielding offers a yield checkpoint for every ref', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'a.ts'),
        `export function fnA() { return 1; }\nexport function fnB() { return fnA(); }\nexport function fnC() { return fnB(); }\n`,
      );
      fs.writeFileSync(
        path.join(tempDir, 'b.ts'),
        `import { fnA } from './a';\nexport function fnD() { return fnA(); }\n`,
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      const resolver = (cg as unknown as { resolver: ReferenceResolver }).resolver;

      // `init({ index: true })` already ran resolution, so feed the batch
      // directly — resolveBatchYielding takes it as an argument; whether each
      // ref resolves is irrelevant to the checkpoint contract.
      const refs: UnresolvedReference[] = ['fnA', 'fnB', 'nosuchFn', 'fnA', 'alsoMissing'].map((name, i) => ({
        fromNodeId: `caller-${i}`,
        referenceName: name,
        referenceKind: 'calls',
        line: i + 1,
        column: 0,
        filePath: 'a.ts',
        language: 'typescript',
      }));

      let checkpoints = 0;
      const countingYield = async () => { checkpoints++; };
      const result = await (resolver as unknown as {
        resolveBatchYielding(batch: UnresolvedReference[], maybeYield: () => Promise<void>): Promise<{ stats: { total: number } }>;
      }).resolveBatchYielding(refs, countingYield);

      // One checkpoint per ref: a pocket of pathologically slow refs can never
      // run more than ONE ref past the yield budget before the heartbeat gets
      // a window — the #1122 kill required 500.
      expect(checkpoints).toBe(refs.length);
      expect(result.stats.total).toBe(refs.length);
    });

    it('receiver inference reads lines through getFileLines when the context provides it', () => {
      const loggerClass = methodNode('c:logger', 'svc.ts', 'Logger', 'Logger', 'typescript', 'class');
      const logMethod = methodNode('m:log', 'svc.ts', 'Logger::log', 'log');
      const otherLog = methodNode('m:other', 'other.ts', 'Other::log', 'log');
      const byName: Record<string, Node[]> = {
        Logger: [loggerClass],
        log: [logMethod, otherLog], // ambiguous bare name → only inference can resolve
      };
      const lines = ['const lg = new Logger();', 'lg.log();'];
      const ctx: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => byName[name] ?? [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        // Reading the raw source must not be needed when lines are provided.
        readFile: () => { throw new Error('readFile must not be called when getFileLines exists'); },
        getFileLines: () => lines,
        getProjectRoot: () => '',
        getAllFiles: () => [],
      };
      const ref: UnresolvedRef = {
        fromNodeId: 'caller', referenceName: 'lg.log', referenceKind: 'calls',
        line: 2, column: 0, filePath: 'svc.ts', language: 'typescript',
      };
      expect(matchMethodCall(ref, ctx)?.targetNodeId).toBe('m:log');
    });

    it('receiver inference skips generated/minified lines instead of regex-scanning them', () => {
      const loggerClass = methodNode('c:logger', 'svc.ts', 'Logger', 'Logger', 'typescript', 'class');
      const logMethod = methodNode('m:log', 'svc.ts', 'Logger::log', 'log');
      const otherLog = methodNode('m:other', 'other.ts', 'Other::log', 'log');
      const byName: Record<string, Node[]> = {
        Logger: [loggerClass],
        log: [logMethod, otherLog],
      };
      const ctxWithLines = (lines: string[]): ResolutionContext => ({
        getNodesInFile: () => [],
        getNodesByName: (name) => byName[name] ?? [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: () => null,
        getFileLines: () => lines,
        getProjectRoot: () => '',
        getAllFiles: () => [],
      });
      const ref: UnresolvedRef = {
        fromNodeId: 'caller', referenceName: 'lg.log', referenceKind: 'calls',
        line: 1, column: 0, filePath: 'svc.ts', language: 'typescript',
      };

      // Control: the declaration on a normal-length line resolves.
      const normal = matchMethodCall(ref, ctxWithLines(['const lg = new Logger(); lg.log();']));
      expect(normal?.targetNodeId).toBe('m:log');

      // The same declaration buried in a >10K-char generated/minified line is
      // skipped — no resolution, and no per-ref regex pass over the huge line.
      const minified = 'var pad="' + 'x'.repeat(10_000) + '";const lg = new Logger(); lg.log();';
      expect(matchMethodCall(ref, ctxWithLines([minified]))).toBeNull();
    });
  });

  describe('Local-variable receiver-type inference (#1108)', () => {
    // `lg.log()` where `lg` is a local whose type is inferred from its
    // declaration/initializer. Before this, only C++ resolved these; every
    // other language produced no method edge. Each case is one file with a
    // single Logger + a caller using a local-variable receiver — a correct
    // resolution makes the caller a caller of `log`.
    const cases: Array<{ lang: string; file: string; src: string }> = [
      { lang: 'TypeScript (= new T)', file: 'svc.ts',
        src: `class Logger { log() { return 1; } }\nexport function use() { const lg = new Logger(); return lg.log(); }\n` },
      { lang: 'JavaScript (= new T)', file: 'svc.js',
        src: `class Logger { log() { return 1; } }\nexport function use() { const lg = new Logger(); return lg.log(); }\n` },
      { lang: 'Python (= T())', file: 'svc.py',
        src: `class Logger:\n    def log(self):\n        return 1\ndef use():\n    lg = Logger()\n    return lg.log()\n` },
      { lang: 'Java (T x = new T)', file: 'Svc.java',
        src: `class Logger { void log() { int a = 1; } }\nclass Use { void run() { Logger lg = new Logger(); lg.log(); } }\n` },
      { lang: 'C# (var x = new T)', file: 'Svc.cs',
        src: `class Logger { void Log() { int a = 1; } }\nclass Use { void Run() { var lg = new Logger(); lg.Log(); } }\n` },
      { lang: 'Kotlin (val x = T())', file: 'Svc.kt',
        src: `class Logger { fun log(): Int { return 1 } }\nfun use(): Int { val lg = Logger(); return lg.log() }\n` },
      { lang: 'Swift (let x = T())', file: 'svc.swift',
        src: `class Logger { func log() -> Int { return 1 } }\nfunc use() -> Int { let lg = Logger(); return lg.log() }\n` },
      { lang: 'Go (x := T{})', file: 'svc.go',
        src: `package a\ntype Logger struct{}\nfunc (l Logger) Log() int { return 1 }\nfunc Use() int { lg := Logger{}; return lg.Log() }\n` },
      { lang: 'Rust (let x = T{})', file: 'svc.rs',
        src: `pub struct Logger { n: i32 }\nimpl Logger { pub fn log(&self) -> i32 { self.n } }\npub fn use_it() -> i32 { let lg = Logger { n: 1 }; lg.log() }\n` },
      { lang: 'Dart (var x = T())', file: 'svc.dart',
        src: `class Logger { int log() { return 1; } }\nint use() { var lg = Logger(); return lg.log(); }\n` },
      { lang: 'PHP ($x = new T)', file: 'svc.php',
        src: `<?php\nclass Logger { function log() { return 1; } }\nfunction useIt() { $lg = new Logger(); return $lg->log(); }\n` },
      { lang: 'Scala (val x = new T)', file: 'Svc.scala',
        src: `class Logger { def log(): Int = 1 }\nobject A { def use(): Int = { val lg = new Logger(); lg.log() } }\n` },
      { lang: 'Ruby (x = T.new)', file: 'svc.rb',
        src: `class Logger\n  def log\n    1\n  end\nend\ndef use\n  lg = Logger.new\n  lg.log\nend\n` },
      { lang: 'Lua (x = T.new(); x:log())', file: 'svc.lua',
        src: `local Logger = {}\nLogger.__index = Logger\nfunction Logger.new() return setmetatable({}, Logger) end\nfunction Logger:log() return 1 end\nlocal function use() local lg = Logger.new(); return lg:log() end\nreturn use\n` },
      { lang: 'Luau (x = T.new(); x:log())', file: 'svc.luau',
        src: `local Logger = {}\nLogger.__index = Logger\nfunction Logger.new() return setmetatable({}, Logger) end\nfunction Logger:log(): number return 1 end\nlocal function use(): number local lg = Logger.new(); return lg:log() end\nreturn use\n` },
      { lang: 'R (x <- T$new(); x$log())', file: 'svc.R',
        src: `Logger <- R6::R6Class("Logger", public = list(log = function() 1))\nuse <- function() { lg <- Logger$new(); lg$log() }\n` },
      { lang: 'Pascal (var x: T; x.Method)', file: 'svc.pas',
        src: `unit A;\ninterface\ntype TLogger = class function Log: Integer; end;\nimplementation\nfunction TLogger.Log: Integer; begin Result := 1; end;\nprocedure Use;\nvar lg: TLogger;\nbegin\n  lg := TLogger.Create;\n  lg.Log;\nend;\nend.\n` },
    ];

    for (const c of cases) {
      it(`resolves a local-variable method call — ${c.lang}`, async () => {
        fs.writeFileSync(path.join(tempDir, c.file), c.src);
        cg = await CodeGraph.init(tempDir, { index: true });
        cg.resolveReferences();

        const logMethod = cg
          .getNodesByKind('method')
          .find((n) => n.name.toLowerCase() === 'log');
        expect(logMethod, `${c.lang}: log method should be indexed`).toBeDefined();

        // The enclosing caller resolves through the local variable to `log`.
        const callers = cg.getCallers(logMethod!.id).map((x) => x.node.name);
        expect(
          callers.length,
          `${c.lang}: log should have a caller (got [${callers.join(', ')}])`,
        ).toBeGreaterThan(0);
      });
    }

    it('Ruby: builds receiver.method and keeps Foo.new as an instantiation', async () => {
      // The Ruby extractor previously took the receiver as the callee and
      // dropped the method name (`lg.log()` -> a call to `lg`). Now it builds
      // `lg.log`, while `Logger.new` must still record an instantiation.
      fs.writeFileSync(
        path.join(tempDir, 'svc.rb'),
        `class Logger\n  def log\n    1\n  end\nend\ndef run\n  lg = Logger.new\n  lg.log\nend\n`,
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const run = cg.getNodesByKind('function').find((n) => n.name === 'run')!;
      const logMethod = cg.getNodesByKind('method').find((n) => n.name === 'log')!;
      const logger = cg.getNodesByKind('class').find((n) => n.name === 'Logger')!;
      const out = cg.getOutgoingEdges(run.id);

      // lg.log resolved to the method (the receiver-type inference kicked in).
      expect(out.some((e) => e.kind === 'calls' && e.target === logMethod.id)).toBe(true);
      // Logger.new is still an instantiation of the class.
      expect(out.some((e) => e.kind === 'instantiates' && e.target === logger.id)).toBe(true);
    });

    it('TypeScript: infers a typed-parameter receiver, disambiguating same-named methods (#1125)', async () => {
      // A typed function parameter used as a receiver — `function use(lg: Logger)`
      // — never matched the old TS/JS pattern (it required a const|let|var
      // prefix), so `lg.log()` fell through to no edge once a second class shared
      // the method name. Two ambiguous classes are load-bearing here: a
      // single-class version resolves via a same-name fallback even without
      // inference, so only the collision proves type inference actually fired.
      fs.writeFileSync(
        path.join(tempDir, 'svc.ts'),
        `class Logger { log() { return 1; } }\n` +
          `class Other { log() { return 2; } }\n` +
          `export function use(lg: Logger) { return lg.log(); }\n` +
          `export function useOther(o: Other) { return o.log(); }\n`,
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const classes = cg.getNodesByKind('class');
      const logger = classes.find((n) => n.name === 'Logger')!;
      const other = classes.find((n) => n.name === 'Other')!;
      const logs = cg.getNodesByKind('method').filter((n) => n.name === 'log');
      expect(logs.length, 'both log methods should be indexed').toBe(2);

      // Associate each same-named `log` with its class by line containment.
      const inClass = (m: (typeof logs)[number], c: typeof logger) =>
        m.startLine >= c.startLine && m.startLine <= (c.endLine ?? c.startLine);
      const loggerLog = logs.find((m) => inClass(m, logger))!;
      const otherLog = logs.find((m) => inClass(m, other))!;
      expect(loggerLog, "Logger's log").toBeDefined();
      expect(otherLog, "Other's log").toBeDefined();

      const loggerCallers = cg.getCallers(loggerLog.id).map((x) => x.node.name);
      const otherCallers = cg.getCallers(otherLog.id).map((x) => x.node.name);

      // Each typed-param call routes to its OWN class's method, not the other's.
      expect(loggerCallers).toContain('use');
      expect(loggerCallers).not.toContain('useOther');
      expect(otherCallers).toContain('useOther');
      expect(otherCallers).not.toContain('use');
    });

    // The same typed-parameter gap existed in every language whose pattern set
    // only matched keyword-anchored locals (let/var/:=/= new), not the bare
    // parameter form — Rust, Go, Dart, PHP (#1125). Each case: two classes
    // sharing a method name + two functions taking one as a typed param; a
    // correct fix routes each call to its OWN type's method (the collision is
    // load-bearing — a single class resolves via the same-name fallback either
    // way). Method↔type association is by qualifiedName, robust where the method
    // lives outside the type's line range (Rust `impl`, Go method decl).
    const typedParamCases: Array<{
      lang: string; file: string; method: string; callerA: string; callerB: string; src: string;
    }> = [
      { lang: 'Rust (fn f(x: &T))', file: 'svc.rs', method: 'log', callerA: 'use_it', callerB: 'use_other',
        src: `pub struct Logger { n: i32 }\nimpl Logger { pub fn log(&self) -> i32 { self.n } }\npub struct Other { n: i32 }\nimpl Other { pub fn log(&self) -> i32 { self.n } }\npub fn use_it(lg: &Logger) -> i32 { lg.log() }\npub fn use_other(o: &Other) -> i32 { o.log() }\n` },
      { lang: 'Go (func f(x T))', file: 'svc.go', method: 'Log', callerA: 'UseIt', callerB: 'UseOther',
        src: `package a\ntype Logger struct{}\nfunc (l Logger) Log() int { return 1 }\ntype Other struct{}\nfunc (o Other) Log() int { return 2 }\nfunc UseIt(lg Logger) int { return lg.Log() }\nfunc UseOther(o Other) int { return o.Log() }\n` },
      { lang: 'Dart (T f(U x))', file: 'svc.dart', method: 'log', callerA: 'useIt', callerB: 'useOther',
        src: `class Logger { int log() { return 1; } }\nclass Other { int log() { return 2; } }\nint useIt(Logger lg) { return lg.log(); }\nint useOther(Other o) { return o.log(); }\n` },
      { lang: 'PHP (f(T $x))', file: 'svc.php', method: 'log', callerA: 'useIt', callerB: 'useOther',
        src: `<?php\nclass Logger { function log() { return 1; } }\nclass Other { function log() { return 2; } }\nfunction useIt(Logger $lg) { return $lg->log(); }\nfunction useOther(Other $o) { return $o->log(); }\n` },
    ];

    for (const c of typedParamCases) {
      it(`infers a typed-parameter receiver, disambiguating same-named methods — ${c.lang} (#1125)`, async () => {
        fs.writeFileSync(path.join(tempDir, c.file), c.src);
        cg = await CodeGraph.init(tempDir, { index: true });
        cg.resolveReferences();

        const methods = cg.getNodesByKind('method').filter((n) => n.name === c.method);
        expect(methods.length, `${c.lang}: both ${c.method} methods indexed`).toBe(2);

        const loggerLog = methods.find((m) => /Logger/.test(m.qualifiedName ?? ''));
        const otherLog = methods.find((m) => /Other/.test(m.qualifiedName ?? ''));
        expect(loggerLog, `${c.lang}: Logger's ${c.method}`).toBeDefined();
        expect(otherLog, `${c.lang}: Other's ${c.method}`).toBeDefined();

        const loggerCallers = cg.getCallers(loggerLog!.id).map((x) => x.node.name);
        const otherCallers = cg.getCallers(otherLog!.id).map((x) => x.node.name);

        expect(loggerCallers, `${c.lang}: Logger callers`).toContain(c.callerA);
        expect(loggerCallers, `${c.lang}: Logger callers`).not.toContain(c.callerB);
        expect(otherCallers, `${c.lang}: Other callers`).toContain(c.callerB);
        expect(otherCallers, `${c.lang}: Other callers`).not.toContain(c.callerA);
      });
    }

    // Lua/Luau: a PascalCase method call (`lg:Log()`, the Roblox convention)
    // is the identical `receiver:Name` shape as a Luau type annotation, so it
    // self-matched the annotation pattern on the call's own line and inferred
    // "type = Log" (#1124). Two things are load-bearing in these fixtures:
    // the declaration sits on an EARLIER line than the call (on one line,
    // pattern order resolves it — the `.new` pattern wins first), and TWO
    // classes share the method name (a single class resolves via the
    // same-name fallback even when inference misfires). Luau's `useLogger`
    // takes a typed param instead of calling `.new()`, pinning that the
    // gated pattern still matches a genuine annotation.
    const pascalMethodCases: Array<{ lang: string; file: string; src: string }> = [
      { lang: 'Lua', file: 'svc.lua',
        src: `local Logger = {}\nLogger.__index = Logger\nfunction Logger.new() return setmetatable({}, Logger) end\nfunction Logger:Log() return 1 end\n\nlocal Other = {}\nOther.__index = Other\nfunction Other.new() return setmetatable({}, Other) end\nfunction Other:Log() return 2 end\n\nlocal function useLogger()\n\tlocal lg = Logger.new()\n\treturn lg:Log()\nend\n\nlocal function useOther()\n\tlocal o = Other.new()\n\treturn o:Log()\nend\n\nreturn useLogger, useOther\n` },
      { lang: 'Luau', file: 'svc.luau',
        src: `local Logger = {}\nLogger.__index = Logger\nfunction Logger.new() return setmetatable({}, Logger) end\nfunction Logger:Log(): number return 1 end\n\nlocal Other = {}\nOther.__index = Other\nfunction Other.new() return setmetatable({}, Other) end\nfunction Other:Log(): number return 2 end\n\nlocal function useLogger(lg: Logger): number\n\treturn lg:Log()\nend\n\nlocal function useOther(): number\n\tlocal o = Other.new()\n\treturn o:Log()\nend\n\nreturn useLogger, useOther\n` },
    ];

    for (const c of pascalMethodCases) {
      it(`resolves a PascalCase method call without self-matching the annotation pattern — ${c.lang} (#1124)`, async () => {
        fs.writeFileSync(path.join(tempDir, c.file), c.src);
        cg = await CodeGraph.init(tempDir, { index: true });
        cg.resolveReferences();

        const methods = cg.getNodesByKind('method').filter((n) => n.name === 'Log');
        expect(methods.length, `${c.lang}: both Log methods indexed`).toBe(2);

        const loggerLog = methods.find((m) => /Logger/.test(m.qualifiedName ?? ''));
        const otherLog = methods.find((m) => /Other/.test(m.qualifiedName ?? ''));
        expect(loggerLog, `${c.lang}: Logger's Log`).toBeDefined();
        expect(otherLog, `${c.lang}: Other's Log`).toBeDefined();

        const loggerCallers = cg.getCallers(loggerLog!.id).map((x) => x.node.name);
        const otherCallers = cg.getCallers(otherLog!.id).map((x) => x.node.name);

        expect(loggerCallers, `${c.lang}: Logger callers`).toContain('useLogger');
        expect(loggerCallers, `${c.lang}: Logger callers`).not.toContain('useOther');
        expect(otherCallers, `${c.lang}: Other callers`).toContain('useOther');
        expect(otherCallers, `${c.lang}: Other callers`).not.toContain('useLogger');
      });
    }
  });

  describe('Name Matcher: kind bias for new ref kinds', () => {
    const baseContext = (candidates: Node[]): ResolutionContext => ({
      getNodesInFile: () => [],
      getNodesByName: (name) => candidates.filter((c) => c.name === name),
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: () => true,
      readFile: () => null,
      getProjectRoot: () => '/test',
      getAllFiles: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
    });

    it('prefers a class candidate over a function for `instantiates` refs', () => {
      // A class and a function share a name across the codebase.
      // Without the kind bias, the function (which gets the +25 `calls`
      // bonus historically applied to all candidates of that kind) would
      // win. Now the instantiates branch reverses it.
      const fn: Node = {
        id: 'func:utils.ts:Logger:5', kind: 'function', name: 'Logger',
        qualifiedName: 'utils.ts::Logger', filePath: 'utils.ts', language: 'typescript',
        startLine: 5, endLine: 7, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };
      const cls: Node = {
        id: 'class:logger.ts:Logger:10', kind: 'class', name: 'Logger',
        qualifiedName: 'logger.ts::Logger', filePath: 'logger.ts', language: 'typescript',
        startLine: 10, endLine: 30, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };

      const ref = {
        fromNodeId: 'func:main.ts:bootstrap:1',
        referenceName: 'Logger',
        referenceKind: 'instantiates' as const,
        line: 5, column: 0, filePath: 'main.ts', language: 'typescript' as const,
      };

      const result = matchReference(ref, baseContext([fn, cls]));
      expect(result?.targetNodeId).toBe('class:logger.ts:Logger:10');
    });

    it('prefers a function candidate over a non-function for `decorates` refs', () => {
      const variable: Node = {
        id: 'var:config.ts:Inject:5', kind: 'variable', name: 'Inject',
        qualifiedName: 'config.ts::Inject', filePath: 'config.ts', language: 'typescript',
        startLine: 5, endLine: 5, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };
      const decorator: Node = {
        id: 'func:di.ts:Inject:10', kind: 'function', name: 'Inject',
        qualifiedName: 'di.ts::Inject', filePath: 'di.ts', language: 'typescript',
        startLine: 10, endLine: 20, startColumn: 0, endColumn: 0, updatedAt: Date.now(),
      };

      const ref = {
        fromNodeId: 'class:svc.ts:UserService:1',
        referenceName: 'Inject',
        referenceKind: 'decorates' as const,
        line: 5, column: 0, filePath: 'svc.ts', language: 'typescript' as const,
      };

      const result = matchReference(ref, baseContext([variable, decorator]));
      expect(result?.targetNodeId).toBe('func:di.ts:Inject:10');
    });
  });

  describe('tsconfig path aliases', () => {
    it('resolves an aliased import to the alias-mapped file (not a same-named file elsewhere)', async () => {
      // Two same-named exports in different directories. Without alias
      // resolution, name-matcher would pick whichever it finds first;
      // with alias resolution, the import path uniquely picks one.
      fs.mkdirSync(path.join(tempDir, 'src/utils'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'src/legacy'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/utils/format.ts'),
        `export function pickMe(): number { return 1; }\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/legacy/format.ts'),
        `export function pickMe(): number { return 99; }\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/main.ts'),
        `import { pickMe } from '@utils/format';\nexport function go(): number { return pickMe(); }\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: './src',
            paths: { '@utils/*': ['utils/*'] },
          },
        })
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      // The two pickMe nodes live in different files. The aliased
      // import should attach the call edge to the @utils-mapped one,
      // not the legacy duplicate.
      const all = cg.getNodesByKind('function').filter((n) => n.name === 'pickMe');
      const utilsNode = all.find((n) => n.filePath === 'src/utils/format.ts');
      const legacyNode = all.find((n) => n.filePath === 'src/legacy/format.ts');
      expect(utilsNode).toBeDefined();
      expect(legacyNode).toBeDefined();

      const utilsCallers = cg.getCallers(utilsNode!.id);
      const legacyCallers = cg.getCallers(legacyNode!.id);
      expect(utilsCallers.length).toBeGreaterThan(0);
      expect(utilsCallers.some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
      // The legacy node should NOT have a caller from src/main.ts —
      // the alias correctly picked the utils version.
      expect(legacyCallers.some((c) => c.node.filePath === 'src/main.ts')).toBe(false);
    });

    it('falls back gracefully when tsconfig is absent', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/a.ts'),
        `export function aFn(): void {}\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/b.ts'),
        `import { aFn } from './a';\nexport function bFn(): void { aFn(); }\n`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      // No tsconfig present — index should still complete and the
      // relative-import-based call edge should be created.
      const aFn = cg.getNodesByKind('function').find((n) => n.name === 'aFn');
      expect(aFn).toBeDefined();
      const callers = cg.getCallers(aFn!.id);
      expect(callers.some((c) => c.node.filePath === 'src/b.ts')).toBe(true);
    });
  });

  describe('re-export chain following', () => {
    it('chases a 3-hop barrel chain (wildcard → named → declaration)', async () => {
      // main.ts → all.ts (wildcard) → index.ts (named) → auth.ts (declaration).
      // Without chain following, `signIn` resolves to nothing because
      // none of the barrel files declare it directly.
      fs.mkdirSync(path.join(tempDir, 'src/services'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/services/auth.ts'),
        `export function signIn(): void {}\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/services/index.ts'),
        `export { signIn } from './auth';\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/all.ts'),
        `export * from './services/index';\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/main.ts'),
        `import { signIn } from './all';\nexport function go(): void { signIn(); }\n`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const signInNode = cg
        .getNodesByKind('function')
        .find((n) => n.name === 'signIn' && n.filePath === 'src/services/auth.ts');
      expect(signInNode).toBeDefined();
      const callers = cg.getCallers(signInNode!.id);
      expect(callers.some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
    });

    it('follows a renamed named re-export (export { foo as bar } from ...)', async () => {
      // The chase has to look up `foo` in the upstream module even
      // though the importer asked for `bar` — exercises the rename
      // branch of findExportedSymbol.
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/auth.ts'),
        `export function signIn(): void {}\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/index.ts'),
        `export { signIn as login } from './auth';\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/main.ts'),
        `import { login } from './index';\nexport function go(): void { login(); }\n`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const signInNode = cg
        .getNodesByKind('function')
        .find((n) => n.name === 'signIn' && n.filePath === 'src/auth.ts');
      expect(signInNode).toBeDefined();
      const callers = cg.getCallers(signInNode!.id);
      expect(callers.some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
    });

    it('follows a default re-export of a .svelte component (export { default as Foo } from ./RealButton.svelte) (#629)', async () => {
      // The ubiquitous Svelte/React component-barrel form. The leaf is a
      // .svelte component (extracted as kind 'component', the default
      // export). The re-export ALIAS (`Foo`) deliberately differs from the
      // component's real name (`RealButton`) so the name-matcher fallback
      // can't coincidentally connect them — the only path to the edge is
      // the import-chase, which must match a `component` (not just
      // function/class) for the default export. Otherwise the
      // consumer↔component edge is never created and `callers` returns a
      // false 0.
      fs.mkdirSync(path.join(tempDir, 'src/lib'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/lib/RealButton.svelte'),
        `<script lang="ts">\n  export let label: string = '';\n</script>\n\n<button>{label}</button>\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/lib/index.ts'),
        `export { default as Foo } from './RealButton.svelte';\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/Bar.svelte'),
        `<script lang="ts">\n  import { Foo } from './lib';\n</script>\n\n<Foo />\n`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const fooNode = cg
        .getNodesByKind('component')
        .find((n) => n.name === 'RealButton' && n.filePath === 'src/lib/RealButton.svelte');
      expect(fooNode).toBeDefined();
      const callers = cg.getCallers(fooNode!.id);
      expect(callers.some((c) => c.node.filePath === 'src/Bar.svelte')).toBe(true);
    });

    it('links an .astro page to the component and TS util it uses (#768)', async () => {
      // The canonical Astro shape: a page imports a layout/component in
      // frontmatter and uses it as a template tag; the component's template
      // calls an imported .ts util. Both hops must produce graph edges or
      // an Astro project is invisible to callers/impact.
      fs.mkdirSync(path.join(tempDir, 'src/components'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'src/utils'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'src/pages'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/utils/format.ts'),
        `export function formatDate(d: Date): string { return d.toISOString(); }\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/components/PostCard.astro'),
        `---\nimport { formatDate } from '../utils/format';\nconst { date } = Astro.props;\n---\n<time>{formatDate(date)}</time>\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/pages/index.astro'),
        `---\nimport PostCard from '../components/PostCard.astro';\n---\n<PostCard date={new Date()} />\n`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      // Hop 1: page → component (template tag through the frontmatter import)
      const cardNode = cg
        .getNodesByKind('component')
        .find((n) => n.name === 'PostCard' && n.filePath === 'src/components/PostCard.astro');
      expect(cardNode).toBeDefined();
      const cardCallers = cg.getCallers(cardNode!.id);
      expect(cardCallers.some((c) => c.node.filePath === 'src/pages/index.astro')).toBe(true);

      // Hop 2: component template call → .ts util
      const fmtNode = cg
        .getNodesByKind('function')
        .find((n) => n.name === 'formatDate' && n.filePath === 'src/utils/format.ts');
      expect(fmtNode).toBeDefined();
      const fmtCallers = cg.getCallers(fmtNode!.id);
      expect(fmtCallers.some((c) => c.node.filePath === 'src/components/PostCard.astro')).toBe(true);
    });

    it('resolves a bare directory import (import { x } from "." / "./") to index.ts (#629)', async () => {
      // `import { helper } from '.'` (or './') must map to the
      // directory's index.ts before the re-export chase can run. The
      // barrel renames `realHelper` → `helper` so the name-matcher can't
      // mask a path-resolution failure: only the bare-dir resolution +
      // rename chase can connect the edge.
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/util.ts'),
        `export function realHelper(): void {}\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/index.ts'),
        `export { realHelper as helper } from './util';\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/main.ts'),
        `import { helper } from '.';\nexport function go(): void { helper(); }\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/main2.ts'),
        `import { helper } from './';\nexport function go2(): void { helper(); }\n`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const helperNode = cg
        .getNodesByKind('function')
        .find((n) => n.name === 'realHelper' && n.filePath === 'src/util.ts');
      expect(helperNode).toBeDefined();
      const callers = cg.getCallers(helperNode!.id);
      expect(callers.some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
      expect(callers.some((c) => c.node.filePath === 'src/main2.ts')).toBe(true);
    });

    it('resolves a workspace package-subpath barrel (@scope/pkg/sub) to its index (#629)', async () => {
      // bun/npm/pnpm workspace: `@scope/ui/widgets` → the `ui` package's
      // `widgets/` subdir index, which re-exports a .svelte component.
      // Alias `Thing` ≠ component `Widget` defeats the name-matcher, so
      // only workspace-package resolution can connect the edge.
      fs.mkdirSync(path.join(tempDir, 'packages/ui/widgets'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }, null, 2)
      );
      fs.writeFileSync(
        path.join(tempDir, 'packages/ui/package.json'),
        JSON.stringify({ name: '@scope/ui', version: '1.0.0' }, null, 2)
      );
      fs.writeFileSync(
        path.join(tempDir, 'packages/ui/widgets/Widget.svelte'),
        `<script lang="ts">\n  export let label: string = '';\n</script>\n\n<button>{label}</button>\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'packages/ui/widgets/index.ts'),
        `export { default as Thing } from './Widget.svelte';\n`
      );
      fs.mkdirSync(path.join(tempDir, 'app'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'app/App.svelte'),
        `<script lang="ts">\n  import { Thing } from '@scope/ui/widgets';\n</script>\n\n<Thing />\n`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const buttonNode = cg
        .getNodesByKind('component')
        .find((n) => n.name === 'Widget' && n.filePath === 'packages/ui/widgets/Widget.svelte');
      expect(buttonNode).toBeDefined();
      const callers = cg.getCallers(buttonNode!.id);
      expect(callers.some((c) => c.node.filePath === 'app/App.svelte')).toBe(true);
    });

    it('resolves a barrel import from a Vue SFC <script> block (#629)', async () => {
      // The same import-resolution gaps (no SFC import mappings, no SFC
      // extension list, barrel parsed in the consumer's language) broke
      // Vue SFCs too. Guards the resolver-side generalization to `.vue`.
      // The barrel renames `realRun` → `run` so only the import-chase (not
      // the name-matcher) can connect the call.
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/util.ts'),
        `export function realRun(): void {}\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/index.ts'),
        `export { realRun as run } from './util';\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/App.vue'),
        `<script lang="ts">\nimport { run } from './';\nexport default { mounted() { run(); } };\n</script>\n<template><div/></template>\n`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const runNode = cg
        .getNodesByKind('function')
        .find((n) => n.name === 'realRun' && n.filePath === 'src/util.ts');
      expect(runNode).toBeDefined();
      const callers = cg.getCallers(runNode!.id);
      expect(callers.some((c) => c.node.filePath === 'src/App.vue')).toBe(true);
    });

    it('follows a Vue component used in a <template> through a default re-export barrel (#629)', async () => {
      // End-to-end Vue analogue of the Svelte case: the leaf is a `.vue`
      // component re-exported under an alias (`Thing`) that differs from its
      // real name (`Widget`), and the consumer uses it ONLY in markup
      // (`<Thing />`). Requires both the new template-tag extraction AND the
      // barrel default-export chase to connect the edge.
      fs.mkdirSync(path.join(tempDir, 'src/lib'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/lib/Widget.vue'),
        `<script setup lang="ts">\ndefineProps<{ label?: string }>();\n</script>\n<template><button>x</button></template>\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/lib/index.ts'),
        `export { default as Thing } from './Widget.vue';\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/App.vue'),
        `<script setup lang="ts">\nimport { Thing } from './lib';\n</script>\n<template>\n  <Thing />\n</template>\n`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const widgetNode = cg
        .getNodesByKind('component')
        .find((n) => n.name === 'Widget' && n.filePath === 'src/lib/Widget.vue');
      expect(widgetNode).toBeDefined();
      const callers = cg.getCallers(widgetNode!.id);
      expect(callers.some((c) => c.node.filePath === 'src/App.vue')).toBe(true);
    });
  });

  describe('C/C++ Import Resolution', () => {
    afterEach(() => {
      clearCppIncludeDirCache();
    });

    it('should resolve C include to header in same directory', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'utils.h',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['utils.h', 'main.c'],
      };

      const result = resolveImportPath(
        'utils.h',
        'main.c',
        'c',
        context
      );

      expect(result).toBe('utils.h');
    });

    it('should resolve C++ include with .hpp extension', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'include/myclass.hpp',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['include/myclass.hpp', 'src/main.cpp'],
        getCppIncludeDirs: () => ['include'],
      };

      const result = resolveImportPath(
        'myclass.hpp',
        'src/main.cpp',
        'cpp',
        context
      );

      expect(result).toBe('include/myclass.hpp');
    });

    it('should resolve include with subdirectory path', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'utils/helpers.h',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['utils/helpers.h', 'main.c'],
      };

      const result = resolveImportPath(
        'utils/helpers.h',
        'main.c',
        'c',
        context
      );

      expect(result).toBe('utils/helpers.h');
    });

    it('should resolve include via include directories', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'include/myheader.h',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['include/myheader.h', 'src/main.cpp'],
        getCppIncludeDirs: () => ['include'],
      };

      const result = resolveImportPath(
        'myheader.h',
        'src/main.cpp',
        'cpp',
        context
      );

      expect(result).toBe('include/myheader.h');
    });

    it('should resolve include trying multiple extensions', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        // myclass.h does not exist, but myclass.hpp does
        fileExists: (p) => p === 'include/myclass.hpp',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['include/myclass.hpp', 'src/main.cpp'],
        getCppIncludeDirs: () => ['include'],
      };

      const result = resolveImportPath(
        'myclass',
        'src/main.cpp',
        'cpp',
        context
      );

      expect(result).toBe('include/myclass.hpp');
    });

    it('should return null for system headers', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => [],
      };

      // C standard library header
      expect(resolveImportPath('stdio.h', 'main.c', 'c', context)).toBeNull();
      // C++ standard library header
      expect(resolveImportPath('vector', 'main.cpp', 'cpp', context)).toBeNull();
      // C++ C-wrapper header
      expect(resolveImportPath('cstdio', 'main.cpp', 'cpp', context)).toBeNull();
    });

    it('should return null for single-component third-party paths that cannot be resolved', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => [],
        getCppIncludeDirs: () => [],
      };

      // Third-party bare header without path — not resolvable, returns null
      const result = resolveImportPath(
        'openssl/ssl.h',
        'main.cpp',
        'cpp',
        context
      );

      expect(result).toBeNull();
    });

    it('should not filter project headers with path separators', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'mylib/utils.h',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['mylib/utils.h'],
      };

      // Path with separator should NOT be filtered as external
      const result = resolveImportPath(
        'mylib/utils.h',
        'main.c',
        'c',
        context
      );

      expect(result).toBe('mylib/utils.h');
    });

    it('should extract C/C++ import mappings from #include directives', () => {
      const code = `#include <iostream>
#include "myheader.h"
#include "utils/helpers.hpp"`;

      const mappings = extractImportMappings('main.cpp', code, 'cpp');

      expect(mappings.length).toBe(3);
      expect(mappings[0]).toEqual({
        localName: 'iostream',
        exportedName: '*',
        source: 'iostream',
        isDefault: false,
        isNamespace: true,
      });
      expect(mappings[1]).toEqual({
        localName: 'myheader',
        exportedName: '*',
        source: 'myheader.h',
        isDefault: false,
        isNamespace: true,
      });
      expect(mappings[2]).toEqual({
        localName: 'helpers',
        exportedName: '*',
        source: 'utils/helpers.hpp',
        isDefault: false,
        isNamespace: true,
      });
    });

    it('should discover include directories from compile_commands.json', () => {
      // Create a temp project with compile_commands.json
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-test-'));
      try {
        const compileDb = [
          {
            directory: tempProject,
            command: 'g++ -Iinclude -Isrc/lib -isystem /usr/include -c src/main.cpp',
            file: 'src/main.cpp',
          },
        ];
        fs.writeFileSync(
          path.join(tempProject, 'compile_commands.json'),
          JSON.stringify(compileDb)
        );
        // Create the include dirs so they exist
        fs.mkdirSync(path.join(tempProject, 'include'), { recursive: true });
        fs.mkdirSync(path.join(tempProject, 'src', 'lib'), { recursive: true });

        clearCppIncludeDirCache();
        const dirs = loadCppIncludeDirs(tempProject);

        // Should find include and src/lib (relative to project root)
        // /usr/include is absolute and outside project, should be excluded
        expect(dirs).toContain('include');
        expect(dirs).toContain('src/lib');
        expect(dirs.some(d => d.includes('usr'))).toBe(false);
      } finally {
        fs.rmSync(tempProject, { recursive: true });
      }
    });

    it('should fall back to heuristic include dirs when no compile_commands.json', () => {
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-test-'));
      try {
        // Create include/ and src/ directories with headers
        fs.mkdirSync(path.join(tempProject, 'include'), { recursive: true });
        fs.writeFileSync(path.join(tempProject, 'include', 'types.h'), '');
        fs.mkdirSync(path.join(tempProject, 'src'), { recursive: true });
        fs.writeFileSync(path.join(tempProject, 'src', 'main.cpp'), '');
        // Create a directory without headers — should not be included
        fs.mkdirSync(path.join(tempProject, 'docs'), { recursive: true });

        clearCppIncludeDirCache();
        const dirs = loadCppIncludeDirs(tempProject);

        expect(dirs).toContain('include');
        expect(dirs).toContain('src');
        expect(dirs).not.toContain('docs');
      } finally {
        fs.rmSync(tempProject, { recursive: true });
      }
    });

    // Documents the cross-language `.h` behavior. Objective-C and C++ share
    // the `.h` extension, so in a mixed iOS-style project an Obj-C header
    // dir gets claimed as a C/C++ include dir too. That's intentional — a
    // C++ file legitimately can `#include "Foo.h"` against an Obj-C header
    // (Obj-C++ / .mm callers), and false-positive inclusion is far cheaper
    // than missing real resolutions. The test pins this so a later
    // "exclude objc dirs" refactor breaks loudly and reviewers see the
    // trade-off explicitly.
    it('heuristic claims any top-level dir containing .h files, including Obj-C', () => {
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-test-'));
      try {
        // C++ side: an `cppmod` dir with a .hpp (C++-only extension)
        fs.mkdirSync(path.join(tempProject, 'cppmod'), { recursive: true });
        fs.writeFileSync(path.join(tempProject, 'cppmod', 'shared.hpp'), '');
        // Obj-C side: an `iosmod` dir with .h + .m (no .cpp/.hpp).
        fs.mkdirSync(path.join(tempProject, 'iosmod'), { recursive: true });
        fs.writeFileSync(path.join(tempProject, 'iosmod', 'View.h'), '');
        fs.writeFileSync(path.join(tempProject, 'iosmod', 'View.m'), '');

        clearCppIncludeDirCache();
        const dirs = loadCppIncludeDirs(tempProject);

        // Both included — Obj-C dirs are intentionally allowed.
        expect(dirs).toContain('cppmod');
        expect(dirs).toContain('iosmod');
      } finally {
        fs.rmSync(tempProject, { recursive: true });
      }
    });

    // End-to-end: ensure `#include "X.h"` produces a file→file `imports` edge
    // in the actual indexing pipeline (not just a phantom file→import-node
    // edge). This pins the include-dir resolution path so the headline PR
    // feature can't silently regress to a no-op in the indexing flow.
    it('connects #include to the real header file via include-dir scan (end-to-end)', async () => {
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-e2e-'));
      try {
        fs.mkdirSync(path.join(tempProject, 'include'), { recursive: true });
        fs.mkdirSync(path.join(tempProject, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(tempProject, 'include', 'utils.h'),
          `#ifndef UTILS_H\n#define UTILS_H\nint add(int, int);\n#endif\n`
        );
        fs.writeFileSync(
          path.join(tempProject, 'src', 'main.cpp'),
          `#include "utils.h"\n#include <vector>\nint main(){ return add(1,2); }\n`
        );

        clearCppIncludeDirCache();
        cg = await CodeGraph.init(tempProject, { index: true });

        // Sanity: file nodes exist for the header and the cpp.
        const allFiles = cg.getStats();
        expect(allFiles.fileCount).toBe(2);

        // The `#include "utils.h"` edge should target the real
        // `include/utils.h` file node — not a floating `import` node
        // living inside main.cpp.
        const db = DatabaseConnection.open(path.join(tempProject, '.codegraph', 'codegraph.db'));
        const rows = db.getDb().prepare(`
          select dst.kind as dstKind, dst.file_path as dstPath
          from edges e
          join nodes src on e.source = src.id
          join nodes dst on e.target = dst.id
          where e.kind = 'imports'
            and src.kind = 'file'
            and src.file_path = 'src/main.cpp'
        `).all() as Array<{ dstKind: string; dstPath: string }>;
        const resolvedToHeader = rows.find(
          (r) => r.dstKind === 'file' && r.dstPath === 'include/utils.h'
        );
        expect(resolvedToHeader, 'main.cpp → include/utils.h imports edge missing').toBeDefined();
        // `<vector>` should NOT produce a file edge — it's a stdlib header.
        const stdlibFile = rows.find(
          (r) => r.dstKind === 'file' && r.dstPath && r.dstPath.endsWith('vector')
        );
        expect(stdlibFile).toBeUndefined();
      } finally {
        fs.rmSync(tempProject, { recursive: true, force: true });
      }
    });
  });

  describe('C++ templated base-class inheritance (#1043)', () => {
    // A class deriving from a TEMPLATE — `class D : public Base<int>` (or a CRTP
    // `class W : public CRTPBase<W>`, or a qualified `class Q : public ns::Tpl<int>`)
    // recorded its base as the full instantiation text (`Base<int>`), which never
    // name-matched the template, indexed as the bare node `Base`. The `<…>` args
    // are now stripped so the `extends` edge resolves end-to-end.
    it('resolves an extends edge to a templated base (plain, CRTP, struct, multi-base)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'lib.hpp'),
        `#pragma once
template<typename T> class Base { public: void foo(); };
template<typename Derived> class CRTPBase {};
class Plain {};

class Widget : public Base<int> {};            // plain template base
class App : public CRTPBase<App> {};           // CRTP (curiously-recurring)
struct Node : public Base<double> {};          // struct inheriting a template
class Both : public Base<char>, public Plain {}; // templated + plain in one clause
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      const db = DatabaseConnection.open(path.join(tempDir, '.codegraph', 'codegraph.db'));
      const edges = db
        .getDb()
        .prepare(
          `select src.name as fromName, dst.name as toName
             from edges e
             join nodes src on e.source = src.id
             join nodes dst on e.target = dst.id
            where e.kind = 'extends'`
        )
        .all() as Array<{ fromName: string; toName: string }>;
      const has = (from: string, to: string) =>
        edges.some((r) => r.fromName === from && r.toName === to);

      // Every templated base now resolves to the bare template node.
      expect(has('Widget', 'Base'), 'Widget : Base<int>').toBe(true);
      expect(has('App', 'CRTPBase'), 'App : CRTPBase<App> (CRTP)').toBe(true);
      expect(has('Node', 'Base'), 'struct Node : Base<double>').toBe(true);
      // A mixed clause resolves BOTH the templated and the plain base.
      expect(has('Both', 'Base'), 'Both : Base<char>').toBe(true);
      expect(has('Both', 'Plain'), 'Both : Plain (non-templated, regression guard)').toBe(true);
    });
  });

  describe('PHP Include Resolution', () => {
    it('isPhpIncludePathRef distinguishes include paths from namespace use (#660)', () => {
      const mk = (name: string, over: Partial<UnresolvedRef> = {}): UnresolvedRef => ({
        fromNodeId: 'f', referenceName: name, referenceKind: 'imports',
        line: 1, column: 0, filePath: 'x.php', language: 'php', ...over,
      });
      // include paths: contain a slash or a file extension
      expect(isPhpIncludePathRef(mk('lib.php'))).toBe(true);
      expect(isPhpIncludePathRef(mk('inc/db.php'))).toBe(true);
      expect(isPhpIncludePathRef(mk('../config.php'))).toBe(true);
      // namespace use symbols: a bare class (Closure) or FQN — never a path,
      // so they must NOT be treated as includes (would mis-connect to a
      // same-named Closure.php / Bar.php file).
      expect(isPhpIncludePathRef(mk('Closure'))).toBe(false);
      expect(isPhpIncludePathRef(mk('PDO'))).toBe(false);
      expect(isPhpIncludePathRef(mk('App\\Foo\\Bar'))).toBe(false);
      // scoped to PHP imports only
      expect(isPhpIncludePathRef(mk('lib.php', { language: 'c' }))).toBe(false);
      expect(isPhpIncludePathRef(mk('lib.php', { referenceKind: 'calls' }))).toBe(false);
    });

    it('resolves require_once to a file→file imports edge (#660)', async () => {
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-php-e2e-'));
      try {
        fs.mkdirSync(path.join(tempProject, 'src'), { recursive: true });
        fs.writeFileSync(
          path.join(tempProject, 'src', 'lib.php'),
          `<?php\nfunction greet() { return "hi"; }\n`
        );
        fs.writeFileSync(
          path.join(tempProject, 'src', 'page.php'),
          `<?php\nrequire_once("lib.php");\necho greet();\n`
        );

        cg = await CodeGraph.init(tempProject, { index: true });

        // reporter's repro: page.php's `require_once("lib.php")` must resolve
        // to the real src/lib.php file node — a file→file `imports` edge, so
        // callers(lib.php) now includes page.php.
        const db = DatabaseConnection.open(path.join(tempProject, '.codegraph', 'codegraph.db'));
        const rows = db.getDb().prepare(`
          select dst.kind as dstKind, dst.file_path as dstPath
          from edges e
          join nodes src on e.source = src.id
          join nodes dst on e.target = dst.id
          where e.kind = 'imports'
            and src.kind = 'file'
            and src.file_path = 'src/page.php'
        `).all() as Array<{ dstKind: string; dstPath: string }>;
        const resolved = rows.find(
          (r) => r.dstKind === 'file' && r.dstPath === 'src/lib.php'
        );
        expect(resolved, 'page.php → src/lib.php imports edge missing').toBeDefined();
      } finally {
        fs.rmSync(tempProject, { recursive: true, force: true });
      }
    });

    it('resolves a subdirectory include path to the correct file (#660)', async () => {
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-php-subdir-'));
      try {
        fs.mkdirSync(path.join(tempProject, 'inc'), { recursive: true });
        fs.writeFileSync(
          path.join(tempProject, 'inc', 'db.php'),
          `<?php\nfunction query() { return 1; }\n`
        );
        fs.writeFileSync(
          path.join(tempProject, 'index.php'),
          `<?php\nrequire "inc/db.php";\nquery();\n`
        );

        cg = await CodeGraph.init(tempProject, { index: true });

        const db = DatabaseConnection.open(path.join(tempProject, '.codegraph', 'codegraph.db'));
        const rows = db.getDb().prepare(`
          select dst.kind as dstKind, dst.file_path as dstPath
          from edges e
          join nodes src on e.source = src.id
          join nodes dst on e.target = dst.id
          where e.kind = 'imports'
            and src.kind = 'file'
            and src.file_path = 'index.php'
        `).all() as Array<{ dstKind: string; dstPath: string }>;
        expect(
          rows.find((r) => r.dstKind === 'file' && r.dstPath === 'inc/db.php'),
          'index.php → inc/db.php imports edge missing'
        ).toBeDefined();
      } finally {
        fs.rmSync(tempProject, { recursive: true, force: true });
      }
    });

    it('does not mis-connect an unresolvable include to a same-named file elsewhere (#660)', async () => {
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-php-misresolve-'));
      try {
        // app/page.php's `require "inc/db.php"` resolves relative to app/, where
        // inc/db.php does NOT exist. A same-named lib/inc/db.php exists elsewhere
        // but is unrelated — no edge should be created (a wrong edge is worse
        // than a missing one).
        fs.mkdirSync(path.join(tempProject, 'app'), { recursive: true });
        fs.mkdirSync(path.join(tempProject, 'lib', 'inc'), { recursive: true });
        fs.writeFileSync(
          path.join(tempProject, 'lib', 'inc', 'db.php'),
          `<?php\nfunction unrelated() {}\n`
        );
        fs.writeFileSync(
          path.join(tempProject, 'app', 'page.php'),
          `<?php\nrequire "inc/db.php";\n`
        );

        cg = await CodeGraph.init(tempProject, { index: true });

        const db = DatabaseConnection.open(path.join(tempProject, '.codegraph', 'codegraph.db'));
        const rows = db.getDb().prepare(`
          select dst.kind as dstKind, dst.file_path as dstPath
          from edges e
          join nodes src on e.source = src.id
          join nodes dst on e.target = dst.id
          where e.kind = 'imports'
            and src.kind = 'file'
            and src.file_path = 'app/page.php'
        `).all() as Array<{ dstKind: string; dstPath: string }>;
        expect(
          rows.find((r) => r.dstKind === 'file' && r.dstPath === 'lib/inc/db.php'),
          'app/page.php must NOT mis-connect to unrelated lib/inc/db.php'
        ).toBeUndefined();
      } finally {
        fs.rmSync(tempProject, { recursive: true, force: true });
      }
    });
  });

  describe('C++ chained-call receiver resolution (#645)', () => {
    async function indexCpp(files: Record<string, string>): Promise<void> {
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(tempDir, name), content);
      }
      cg = await CodeGraph.init(tempDir, { index: true });
    }

    function callerNamesOf(qualifiedName: string): string[] {
      const target = cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves singleton chains and auto locals to the right class, never the first-sorted one', async () => {
      // Two classes share writeLog; Logger sorts first so it wins any name-only
      // tie. All three call forms target Metrics.
      await indexCpp({
        'logger.hpp': `#pragma once
#include <string>
class Logger  { public: static Logger&  instance(); void writeLog(const std::string&); };
class Metrics { public: static Metrics& instance(); void writeLog(const std::string&); };
`,
        'impl.cpp': `#include "logger.hpp"
Logger&  Logger::instance()  { static Logger l;  return l; }
Metrics& Metrics::instance() { static Metrics m; return m; }
void Logger::writeLog(const std::string&)  {}
void Metrics::writeLog(const std::string&) {}
`,
        'app.cpp': `#include "logger.hpp"
void a() { Metrics::instance().writeLog("x"); }              // chained singleton
void b() { auto& m = Metrics::instance(); m.writeLog("x"); } // stored in auto
void c() { Metrics& m = Metrics::instance(); m.writeLog("x"); } // explicit type
`,
      });

      expect(callerNamesOf('Metrics::writeLog')).toEqual(['a', 'b', 'c']);
      expect(callerNamesOf('Logger::writeLog')).toEqual([]);
    });

    it('resolves factories, free-function factories, and member chains via the inner call return type', async () => {
      await indexCpp({
        'types.hpp': `#pragma once
#include <memory>
struct Widget { void draw(); };
struct Session { void run(); };
struct View { void render(); };
class WidgetFactory { public: static Widget create(); };
class Manager { public: View view(); };
Session* openSession();
// Decoy that sorts first and has all three methods — must never win.
struct Aaa { void draw(); void run(); void render(); };
`,
        'impl.cpp': `#include "types.hpp"
void Widget::draw() {}
void Session::run() {}
void View::render() {}
void Aaa::draw() {}
void Aaa::run() {}
void Aaa::render() {}
Widget WidgetFactory::create() { return Widget(); }
View Manager::view() { return View(); }
Session* openSession() { return nullptr; }
`,
        'app.cpp': `#include "types.hpp"
void factory()     { WidgetFactory::create().draw(); }   // -> Widget::draw
void freefunc()    { openSession()->run(); }             // -> Session::run
void member()      { Manager mgr; mgr.view().render(); }  // -> View::render
void makeUnique()  { auto w = std::make_unique<Widget>(); w->draw(); } // -> Widget::draw
`,
      });

      expect(callerNamesOf('Widget::draw')).toEqual(['factory', 'makeUnique']);
      expect(callerNamesOf('Session::run')).toEqual(['freefunc']);
      expect(callerNamesOf('View::render')).toEqual(['member']);
      // The first-sorted decoy never captures any of them.
      expect(callerNamesOf('Aaa::draw')).toEqual([]);
      expect(callerNamesOf('Aaa::run')).toEqual([]);
      expect(callerNamesOf('Aaa::render')).toEqual([]);
    });

    it('creates NO edge when the inferred type lacks the method (silent miss, not a wrong edge)', async () => {
      await indexCpp({
        'types.hpp': `#pragma once
struct Widget { void draw(); };
struct Other  { void onlyOther(); };
class WidgetFactory { public: static Widget create(); };
`,
        'impl.cpp': `#include "types.hpp"
void Widget::draw() {}
void Other::onlyOther() {}
Widget WidgetFactory::create() { return Widget(); }
`,
        'app.cpp': `#include "types.hpp"
// Widget has no onlyOther() — must produce NO edge, never a wrong one to Other.
void wrong() { WidgetFactory::create().onlyOther(); }
`,
      });

      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });
  });

  describe('PHP chained static-factory call resolution (#608)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves Cls::for($x)->method() via the factory\'s `: self` return (#608)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'ApiClient.php'),
        `<?php\nclass ApiClient {\n    public static function for(string $c): self { return new self; }\n    public function createOrder(array $p): array { return []; }\n}\n`
      );
      fs.writeFileSync(
        path.join(tempDir, 'DispatchOrder.php'),
        `<?php\nclass DispatchOrder {\n    public function handle(): void {\n        ApiClient::for('cred')->createOrder([]);\n    }\n}\n`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // The chained call's edge attaches to the factory result's method.
      expect(callerNamesOf('ApiClient::createOrder')).toContain('handle');
    });

    it('creates NO edge when the factory result lacks the method (#608)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'lib.php'),
        `<?php\nclass ApiClient { public static function for(string $c): self { return new self; } }\nclass Other { public function onlyOther(): void {} }\nclass Caller { public function go(): void { ApiClient::for('x')->onlyOther(); } }\n`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // ApiClient has no onlyOther — must not mis-attach to the same-named Other::onlyOther.
      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });
  });

  describe('Java chained static-factory call resolution (#645/#608 mechanism)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves Foo.getInstance().bar() via the factory return type, never a same-named decoy', async () => {
      // Aaa sorts first and has a same-named bar() — it must never win the chain.
      fs.writeFileSync(
        path.join(tempDir, 'Main.java'),
        `class Aaa { void bar() {} }
class Foo {
    static Foo getInstance() { return new Foo(); }
    void bar() {}
}
class Caller {
    void run() { Foo.getInstance().bar(); }
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Foo::bar')).toEqual(['run']);
      expect(callerNamesOf('Aaa::bar')).toEqual([]);
    });

    it('resolves a factory chain that passes arguments — Foo.create(cfg).build()', async () => {
      // The factory call carries an argument; the extractor must normalize the
      // receiver to empty parens (`Foo.create().build`) so the chain still splits.
      fs.writeFileSync(
        path.join(tempDir, 'Main.java'),
        `class Config {}
class Foo {
    static Foo create(Config c) { return new Foo(); }
    void build() {}
}
class Caller {
    void run() { Foo.create(new Config()).build(); }
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Foo::build')).toEqual(['run']);
    });

    it('creates NO edge when the factory return type lacks the method (silent miss, not a wrong edge)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'Main.java'),
        `class Foo {
    static Foo getInstance() { return new Foo(); }
}
class Other { void onlyOther() {} }
class Caller {
    void run() { Foo.getInstance().onlyOther(); }
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // Foo has no onlyOther() — must not mis-attach to the same-named Other::onlyOther.
      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });
  });

  describe('Kotlin chained companion-factory call resolution (#645/#608 mechanism)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves Foo.getInstance().bar() via the companion return type, never a same-named decoy', async () => {
      // Aaa sorts first and has a same-named bar() — without the chain fix Kotlin
      // dropped the receiver to a bare `bar` and attached to Aaa (a wrong edge).
      fs.writeFileSync(
        path.join(tempDir, 'Main.kt'),
        `class Aaa { fun bar() {} }
class Foo {
    companion object {
        fun getInstance(): Foo = Foo()
    }
    fun bar() {}
}
class Caller {
    fun run() { Foo.getInstance().bar() }
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Foo::bar')).toEqual(['run']);
      expect(callerNamesOf('Aaa::bar')).toEqual([]);
    });

    it('resolves a companion factory chain that passes arguments — Foo.create(cfg).build()', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'Main.kt'),
        `class Config
class Foo {
    companion object {
        fun create(c: Config): Foo = Foo()
    }
    fun build() {}
}
class Caller {
    fun run() { Foo.create(Config()).build() }
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Foo::build')).toEqual(['run']);
    });

    it('creates NO edge when the companion return type lacks the method (silent miss, not a wrong edge)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'Main.kt'),
        `class Foo {
    companion object {
        fun getInstance(): Foo = Foo()
    }
}
class Other { fun onlyOther() {} }
class Caller {
    fun run() { Foo.getInstance().onlyOther() }
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // Foo has no onlyOther() — must not mis-attach to the same-named Other::onlyOther.
      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });
  });

  describe('C# chained static-factory call resolution (#645/#608 mechanism)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves Foo.Create().Bar() via the factory return type, never a same-named decoy', async () => {
      // Aaa sorts first and has a same-named Bar() — it must never win the chain.
      fs.writeFileSync(
        path.join(tempDir, 'Main.cs'),
        `class Aaa { void Bar() {} }
class Foo {
    static Foo Create() { return new Foo(); }
    void Bar() {}
}
class Caller {
    void Run() { Foo.Create().Bar(); }
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Foo::Bar')).toEqual(['Run']);
      expect(callerNamesOf('Aaa::Bar')).toEqual([]);
    });

    it('resolves a factory chain that passes arguments — Foo.Make(cfg).Build()', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'Main.cs'),
        `class Config {}
class Foo {
    static Foo Make(Config c) { return new Foo(); }
    void Build() {}
}
class Caller {
    void Run() { Foo.Make(new Config()).Build(); }
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Foo::Build')).toEqual(['Run']);
    });

    it('creates NO edge when the factory return type lacks the method (silent miss, not a wrong edge)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'Main.cs'),
        `class Foo {
    static Foo Create() { return new Foo(); }
}
class Other { void OnlyOther() {} }
class Caller {
    void Run() { Foo.Create().OnlyOther(); }
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // Foo has no OnlyOther() — must not mis-attach to the same-named Other::OnlyOther.
      expect(callerNamesOf('Other::OnlyOther')).toEqual([]);
    });
  });

  describe('Swift chained static-factory call resolution (#645/#608 mechanism)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves Foo.make().draw() via the factory return type, never a same-named decoy', async () => {
      // Aaa sorts first and has a same-named draw() — without the fix Swift dropped
      // the receiver to a bare `draw` and attached to Aaa (a wrong edge).
      fs.writeFileSync(
        path.join(tempDir, 'Main.swift'),
        `class Aaa { func draw() {} }
class Foo {
    static func make() -> Foo { return Foo() }
    func draw() {}
}
func runCaller() { Foo.make().draw() }
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Foo::draw')).toEqual(['runCaller']);
      expect(callerNamesOf('Aaa::draw')).toEqual([]);
    });

    it('resolves a constructor chain Foo().draw() and an args factory chain Foo.build(c).render()', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'Main.swift'),
        `class Config {}
class Foo {
    static func build(_ c: Config) -> Foo { return Foo() }
    func draw() {}
    func render() {}
}
func runCaller() {
    Foo().draw()
    Foo.build(Config()).render()
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Foo::draw')).toEqual(['runCaller']);
      expect(callerNamesOf('Foo::render')).toEqual(['runCaller']);
    });

    it('creates NO edge when the factory return type lacks the method (silent miss, not a wrong edge)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'Main.swift'),
        `class Foo {
    static func make() -> Foo { return Foo() }
}
class Other { func onlyOther() {} }
func runCaller() { Foo.make().onlyOther() }
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // Foo has no onlyOther() — must not mis-attach to the same-named Other::onlyOther.
      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });
  });

  describe('Chained call resolves a method on a supertype (conformance, #750)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves a chained method defined only on a SUPERCLASS the return type extends', async () => {
      // draw() lives on Base; Widget (the factory's return type) has no draw() of
      // its own. Decoy.draw must never win. Needs the conformance second pass.
      fs.writeFileSync(
        path.join(tempDir, 'Main.java'),
        `class Base { void draw() {} }
class Widget extends Base {}
class Decoy { void draw() {} }
class Factory { static Widget create() { return new Widget(); } }
class Caller {
    void run() { Factory.create().draw(); }
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Base::draw')).toEqual(['run']);
      expect(callerNamesOf('Decoy::draw')).toEqual([]);
    });

    it('resolves a chained method defined on an INTERFACE the return type implements (default method)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'Main.java'),
        `interface Drawable { default void draw() {} }
class Widget implements Drawable {}
class Decoy { void draw() {} }
class Factory { static Widget create() { return new Widget(); } }
class Caller {
    void run() { Factory.create().draw(); }
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Drawable::draw')).toEqual(['run']);
      expect(callerNamesOf('Decoy::draw')).toEqual([]);
    });

    it('still creates NO edge when no supertype has the method (safety preserved)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'Main.java'),
        `class Base {}
class Widget extends Base {}
class Other { void onlyOther() {} }
class Factory { static Widget create() { return new Widget(); } }
class Caller {
    void run() { Factory.create().onlyOther(); }
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // Neither Widget nor Base has onlyOther() — must not attach to Other::onlyOther.
      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });
  });

  describe('Rust chained associated-function call resolution (#645/#608 mechanism)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves Foo::new().bar() (and a Self return) via the associated fn, never a same-named decoy', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.rs'),
        `struct Aaa { _x: i32 }
impl Aaa { fn bar(&self) {} }
struct Foo { _x: i32 }
impl Foo {
    fn new() -> Foo { Foo { _x: 0 } }
    fn make() -> Self { Foo { _x: 0 } }
    fn bar(&self) {}
}
fn caller() {
    Foo::new().bar();
    Foo::make().bar();
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Foo::bar')).toEqual(['caller']);
      expect(callerNamesOf('Aaa::bar')).toEqual([]);
    });

    it('resolves a chain that passes arguments — Foo::with(c).build()', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.rs'),
        `struct Config;
struct Foo { _x: i32 }
impl Foo {
    fn with(c: Config) -> Foo { Foo { _x: 0 } }
    fn build(&self) {}
}
fn caller() { Foo::with(Config).build(); }
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Foo::build')).toEqual(['caller']);
    });

    it('resolves a chained method from a trait the type implements (default method, via conformance)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.rs'),
        `struct Foo { _x: i32 }
impl Foo { fn new() -> Foo { Foo { _x: 0 } } }
struct Decoy { _x: i32 }
impl Decoy { fn draw(&self) {} }
trait Drawable { fn draw(&self) {} }
impl Drawable for Foo {}
fn caller() { Foo::new().draw(); }
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Drawable::draw')).toEqual(['caller']);
      expect(callerNamesOf('Decoy::draw')).toEqual([]);
    });

    it('creates NO edge when neither the type nor a supertype has the method (silent miss)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.rs'),
        `struct Foo { _x: i32 }
impl Foo { fn new() -> Foo { Foo { _x: 0 } } }
struct Other { _x: i32 }
impl Other { fn only_other(&self) {} }
fn caller() { Foo::new().only_other(); }
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // Foo has no only_other() — must not mis-attach to the same-named Other::only_other.
      expect(callerNamesOf('Other::only_other')).toEqual([]);
    });
  });

  describe('Go chained factory-function call resolution (#645/#608 mechanism)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves New().Bar() via the factory return type (pointer), never a same-named decoy', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.go'),
        `package main
type Aaa struct{}
func (a *Aaa) Bar() {}
type Foo struct{}
func New() *Foo { return &Foo{} }
func (f *Foo) Bar() {}
func caller() { New().Bar() }
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Foo::Bar')).toEqual(['caller']);
      expect(callerNamesOf('Aaa::Bar')).toEqual([]);
    });

    it('resolves an args chain and a multi-return factory — With(c).Build(), (*Foo, error)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.go'),
        `package main
type Config struct{}
type Foo struct{}
func With(c Config) (*Foo, error) { return &Foo{}, nil }
func (f *Foo) Build() {}
func caller() { With(Config{}).Build() }
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Foo::Build')).toEqual(['caller']);
    });

    it('resolves a method provided by an embedded struct (via conformance)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.go'),
        `package main
type Base struct{}
func (b *Base) Embedded() {}
type Decoy struct{}
func (d *Decoy) Embedded() {}
type Widget struct{ Base }
func NewWidget() *Widget { return &Widget{} }
func caller() { NewWidget().Embedded() }
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Base::Embedded')).toEqual(['caller']);
      expect(callerNamesOf('Decoy::Embedded')).toEqual([]);
    });

    it('creates NO edge when neither the type nor an embedded type has the method (silent miss)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.go'),
        `package main
type Foo struct{}
func New() *Foo { return &Foo{} }
type Other struct{}
func (o *Other) OnlyOther() {}
func caller() { New().OnlyOther() }
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // Foo has no OnlyOther() — must not mis-attach to the same-named Other::OnlyOther.
      expect(callerNamesOf('Other::OnlyOther')).toEqual([]);
    });

    it('falls back to bare-name resolution for a VARIABLE-inner chain without exploding the graph', async () => {
      // `engine` is a package-level VARIABLE holding a func value, not a factory
      // FUNCTION — so its return type can't be recovered and the chain falls back
      // to bare-name resolution of the method (restoring the pre-re-encoding edge).
      // Regression for the runaway this fallback originally caused: it resolved
      // with a mutated `original.referenceName` (the bare `ServeHTTP`, not the
      // stored `engine().ServeHTTP`), so the batched resolver's keyed delete
      // no-oped, the offset-0 batch never drained, and edges inserted forever
      // (5M edges / 1.4 GB on a 99-file repo). The fallback now ties the match to
      // the original ref, and a non-progress guard backstops the loop.
      fs.writeFileSync(
        path.join(tempDir, 'main.go'),
        `package main
type Server struct{}
func (s *Server) ServeHTTP() {}
var engine = func() *Server { return &Server{} }
func caller() { engine().ServeHTTP() }
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // Recall: the variable-inner chain still finds the method by bare name.
      expect(callerNamesOf('Server::ServeHTTP')).toEqual(['caller']);
      // No runaway: a single call site yields a single edge, not millions.
      const target = cg
        .getNodesByKind('method')
        .find((n) => n.qualifiedName === 'Server::ServeHTTP')!;
      const rawCalls = cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls');
      expect(rawCalls.length).toBeLessThan(5);
    });
  });

  describe('Scala chained static-factory call resolution (#645/#608 mechanism)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves a companion-factory chain Foo.create().doIt() to the return type, never a same-named decoy', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'Main.scala'),
        `object Foo {
  def create(): Bar = new Bar()
}
class Bar {
  def doIt(): Unit = {}
}
class Decoy {
  def doIt(): Unit = {}
}
object Main {
  def run(): Unit = { Foo.create().doIt() }
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Bar::doIt')).toEqual(['run']);
      expect(callerNamesOf('Decoy::doIt')).toEqual([]);
    });

    it('resolves a case-class apply construction Point(x).dist() on the constructed class', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'Main.scala'),
        `class Point(x: Int) {
  def dist(): Int = x
}
class Other {
  def dist(): Int = 0
}
object Main {
  def run(): Unit = { Point(3).dist() }
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Point::dist')).toEqual(['run']);
      expect(callerNamesOf('Other::dist')).toEqual([]);
    });

    it('resolves a chained method provided by a trait the return type extends (via conformance)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'Main.scala'),
        `trait Base {
  def shared(): Unit = {}
}
class Widget extends Base
class Decoy {
  def shared(): Unit = {}
}
object Factory {
  def make(): Widget = new Widget()
}
object Main {
  def run(): Unit = { Factory.make().shared() }
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Base::shared')).toEqual(['run']);
      expect(callerNamesOf('Decoy::shared')).toEqual([]);
    });

    it('creates NO edge when neither the factory return type nor a supertype has the method (silent miss)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'Main.scala'),
        `object Foo {
  def create(): Bar = new Bar()
}
class Bar {
}
class Other {
  def onlyOther(): Unit = {}
}
object Main {
  def run(): Unit = { Foo.create().onlyOther() }
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // Bar has no onlyOther() — must not mis-attach to the same-named Other::onlyOther.
      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });
  });

  describe('Dart chained static-factory / factory-constructor call resolution (#645/#608 mechanism)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves a static-factory chain Foo.makeBar().doIt() to the return type, never a same-named decoy', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.dart'),
        `class Foo {
  static Bar makeBar() => Bar();
}
class Bar {
  void doIt() {}
}
class Decoy {
  void doIt() {}
}
void run() {
  Foo.makeBar().doIt();
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Bar::doIt')).toEqual(['run']);
      expect(callerNamesOf('Decoy::doIt')).toEqual([]);
    });

    it('resolves a named factory-constructor chain Foo.create().ship() on the constructed class', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.dart'),
        `class Foo {
  Foo._();
  factory Foo.create() => Foo._();
  void ship() {}
}
class Decoy {
  void ship() {}
}
void run() {
  Foo.create().ship();
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // The factory constructor `Foo.create` is now a node whose return type is Foo,
      // so `ship` resolves on Foo, not the same-named Decoy.
      expect(callerNamesOf('Foo::ship')).toEqual(['run']);
      expect(callerNamesOf('Decoy::ship')).toEqual([]);
    });

    it('resolves a constructor-receiver chain Bar().doIt() on the constructed class', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.dart'),
        `class Bar {
  void doIt() {}
}
class Decoy {
  void doIt() {}
}
void run() {
  Bar().doIt();
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Bar::doIt')).toEqual(['run']);
      expect(callerNamesOf('Decoy::doIt')).toEqual([]);
    });

    it('resolves a chained method inherited from a superclass the return type extends (via conformance)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.dart'),
        `class Base {
  void render() {}
}
class Widget extends Base {
  static Widget make() => Widget();
}
class Decoy {
  void render() {}
}
void run() {
  Widget.make().render();
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Base::render')).toEqual(['run']);
      expect(callerNamesOf('Decoy::render')).toEqual([]);
    });

    it('creates NO edge when neither the factory return type nor a supertype has the method (silent miss)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.dart'),
        `class Foo {
  static Bar makeBar() => Bar();
}
class Bar {
}
class Other {
  void onlyOther() {}
}
void run() {
  Foo.makeBar().onlyOther();
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // Bar has no onlyOther() — must not mis-attach to the same-named Other::onlyOther.
      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });

    it('still extracts a method tree-sitter misparses as a constructor (@override + record return)', async () => {
      // tree-sitter-dart misparses `@override (A, B) reduce()` — the annotation
      // swallows the record return type, so `reduce()` looks like a single-
      // identifier constructor_signature. It must NOT be skipped as an unnamed
      // ctor (its name doesn't match the class); its body call must attribute to
      // `reduce`, not the class.
      fs.writeFileSync(
        path.join(tempDir, 'main.dart'),
        `class Base {}
class Action extends Base {
  Action({required int x});
  @override
  (int, String) reduce() {
    return (compute(), "y");
  }
  int compute() => 1;
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // reduce must be a node and its body call must resolve to Action::compute.
      expect(callerNamesOf('Action::compute')).toEqual(['reduce']);
    });

    it('keeps plain construction Foo() as instantiation, not a Foo::Foo method call', async () => {
      // The unnamed constructor is intentionally NOT extracted as a `Foo::Foo`
      // method, so `Foo(...)` resolves to the class (an `instantiates` edge),
      // never hijacked into a call to a phantom constructor method.
      fs.writeFileSync(
        path.join(tempDir, 'main.dart'),
        `class Widget {
  final int x;
  Widget(this.x);
}
void run() {
  Widget(3);
}
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // No Foo::Foo phantom method node.
      expect(cg.getNodesByKind('method').some((n) => n.qualifiedName === 'Widget::Widget')).toBe(false);
      // The construction resolves to the class as an `instantiates` edge.
      const widget = cg.getNodesByKind('class').find((n) => n.name === 'Widget')!;
      const incoming = cg.getIncomingEdges(widget.id);
      expect(incoming.some((e) => e.kind === 'instantiates')).toBe(true);
    });
  });

  describe('Objective-C chained message-send call resolution (#645/#608 mechanism)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }

    it('resolves a chained message send [[Foo create] doIt] via the return type, never a same-named decoy', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.m'),
        `@interface Bar : NSObject
- (void)doIt;
@end
@implementation Bar
- (void)doIt {}
@end
@interface Decoy : NSObject
- (void)doIt;
@end
@implementation Decoy
- (void)doIt {}
@end
@interface Foo : NSObject
+ (Bar *)create;
@end
@implementation Foo
+ (Bar *)create { return nil; }
- (void)run { [[Foo create] doIt]; }
@end
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Bar::doIt')).toEqual(['run']);
      expect(callerNamesOf('Decoy::doIt')).toEqual([]);
    });

    it('resolves a chained message whose method is inherited from a superclass (via conformance)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.m'),
        `@interface Base : NSObject
- (void)render;
@end
@implementation Base
- (void)render {}
@end
@interface Widget : Base
@end
@implementation Widget
@end
@interface Decoy : NSObject
- (void)render;
@end
@implementation Decoy
- (void)render {}
@end
@interface Factory : NSObject
+ (Widget *)make;
@end
@implementation Factory
+ (Widget *)make { return nil; }
- (void)run { [[Factory make] render]; }
@end
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Base::render')).toEqual(['run']);
      expect(callerNamesOf('Decoy::render')).toEqual([]);
    });

    it('creates NO edge when the factory return type lacks the method (silent miss)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.m'),
        `@interface Bar : NSObject
@end
@implementation Bar
@end
@interface Other : NSObject
- (void)onlyOther;
@end
@implementation Other
- (void)onlyOther {}
@end
@interface Foo : NSObject
+ (Bar *)create;
@end
@implementation Foo
+ (Bar *)create { return nil; }
- (void)run { [[Foo create] onlyOther]; }
@end
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // Bar has no onlyOther — must not mis-attach to the same-named Other::onlyOther.
      expect(callerNamesOf('Other::onlyOther')).toEqual([]);
    });

    it('resolves a singleton chain [[Cache shared] clearAll] whose factory returns nonnull instancetype', async () => {
      // The factory returns `nonnull instancetype` — the nullability qualifier must
      // be skipped (not captured AS the type), and an instancetype class-message
      // factory returns the receiver class, so clearAll resolves on Cache, never a
      // same-named decoy. (Regression for both: the captured-`nonnull` bug and the
      // ubiquitous `[[X alloc] init]` / singleton pattern.)
      fs.writeFileSync(
        path.join(tempDir, 'main.m'),
        `@interface Cache : NSObject
+ (nonnull instancetype)shared;
- (void)clearAll;
@end
@implementation Cache
+ (nonnull instancetype)shared { return nil; }
- (void)clearAll {}
@end
@interface Decoy : NSObject
- (void)clearAll;
@end
@implementation Decoy
- (void)clearAll {}
@end
@interface Caller : NSObject
- (void)run;
@end
@implementation Caller
- (void)run { [[Cache shared] clearAll]; }
@end
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(callerNamesOf('Cache::clearAll')).toEqual(['run']);
      expect(callerNamesOf('Decoy::clearAll')).toEqual([]);
    });
  });

  describe('Pascal/Delphi chained static-factory call resolution (#645/#608 mechanism)', () => {
    function callerNamesOf(qualifiedName: string): string[] {
      const target = cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
      if (!target) return [];
      const names = cg
        .getIncomingEdges(target.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg.getNode(e.source)?.name)
        .filter((n): n is string => !!n);
      return [...new Set(names)].sort();
    }
    function isCalled(qn: string): boolean {
      const t = cg.getNodesByKind('method').find((n) => n.qualifiedName === qn);
      return !!t && cg.getIncomingEdges(t.id).some((e) => e.kind === 'calls');
    }

    it('resolves a chained factory call TFoo.GetInstance().DoIt() via the return type, never a same-named decoy', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.pas'),
        `unit Main;
interface
type
  TBar = class
    procedure DoIt;
  end;
  TDecoy = class
    procedure DoIt;
  end;
  TFoo = class
    class function GetInstance: TBar;
  end;
implementation
procedure TBar.DoIt; begin end;
procedure TDecoy.DoIt; begin end;
class function TFoo.GetInstance: TBar; begin Result := nil; end;
procedure Run;
begin
  TFoo.GetInstance().DoIt();
end;
end.
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(isCalled('TBar::DoIt')).toBe(true);
      expect(isCalled('TDecoy::DoIt')).toBe(false);
    });

    it('resolves a constructor chain TFoo.Create().Configure() on the constructed class', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.pas'),
        `unit Main;
interface
type
  TFoo = class
    constructor Create;
    procedure Configure;
  end;
  TDecoy = class
    procedure Configure;
  end;
implementation
constructor TFoo.Create; begin end;
procedure TFoo.Configure; begin end;
procedure TDecoy.Configure; begin end;
procedure Run;
begin
  TFoo.Create().Configure();
end;
end.
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // A constructor returns its own class (no `: TBar` annotation), so Configure
      // resolves on TFoo, not the same-named decoy.
      expect(isCalled('TFoo::Configure')).toBe(true);
      expect(isCalled('TDecoy::Configure')).toBe(false);
    });

    it('resolves a typecast chain TFoo(x).DoIt() on the cast type', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.pas'),
        `unit Main;
interface
type
  TFoo = class
    procedure DoIt;
  end;
  TDecoy = class
    procedure DoIt;
  end;
implementation
procedure TFoo.DoIt; begin end;
procedure TDecoy.DoIt; begin end;
procedure Run(obj: TObject);
begin
  TFoo(obj).DoIt();
end;
end.
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(isCalled('TFoo::DoIt')).toBe(true);
      expect(isCalled('TDecoy::DoIt')).toBe(false);
    });

    it('creates NO edge when the factory return type lacks the method (silent miss)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.pas'),
        `unit Main;
interface
type
  TBar = class
  end;
  TOther = class
    procedure OnlyOther;
  end;
  TFoo = class
    class function GetInstance: TBar;
  end;
implementation
procedure TOther.OnlyOther; begin end;
class function TFoo.GetInstance: TBar; begin Result := nil; end;
procedure Run;
begin
  TFoo.GetInstance().OnlyOther();
end;
end.
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // TBar has no OnlyOther — must not mis-attach to the same-named TOther::OnlyOther.
      expect(isCalled('TOther::OnlyOther')).toBe(false);
    });

    it('extracts paren-less method calls (Pascal lets a no-arg method drop its parens)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.pas'),
        `unit Main;
interface
type
  TFoo = class
    procedure DoThing;
    procedure Reset;
  end;
implementation
procedure TFoo.DoThing; begin end;
procedure TFoo.Reset; begin end;
procedure Run(f: TFoo);
begin
  f.DoThing;
  f.Reset;
end;
end.
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(isCalled('TFoo::DoThing')).toBe(true);
      expect(isCalled('TFoo::Reset')).toBe(true);
    });

    it('resolves a PAREN-LESS chained factory call TFoo.GetInstance.DoIt via the return type', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.pas'),
        `unit Main;
interface
type
  TBar = class
    procedure DoIt;
  end;
  TDecoy = class
    procedure DoIt;
  end;
  TFoo = class
    class function GetInstance: TBar;
  end;
implementation
procedure TBar.DoIt; begin end;
procedure TDecoy.DoIt; begin end;
class function TFoo.GetInstance: TBar; begin Result := nil; end;
procedure Run;
begin
  TFoo.GetInstance.DoIt;
end;
end.
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      expect(isCalled('TBar::DoIt')).toBe(true);
      expect(isCalled('TDecoy::DoIt')).toBe(false);
    });

    it('does NOT turn a property write/read into a call edge (only statement-level dots are calls)', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.pas'),
        `unit Main;
interface
type
  TFoo = class
    function GetValue: Integer;
    procedure SetValue(v: Integer);
    property Value: Integer read GetValue write SetValue;
  end;
implementation
function TFoo.GetValue: Integer; begin Result := 0; end;
procedure TFoo.SetValue(v: Integer); begin end;
procedure Run(f: TFoo);
var x: Integer;
begin
  f.Value := 5;
  x := f.Value;
end;
end.
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // A property read/write is a bare dot in assignment position, not a statement,
      // so it must not be mis-extracted as a call to the property's getter/setter.
      expect(isCalled('TFoo::GetValue')).toBe(false);
      expect(isCalled('TFoo::SetValue')).toBe(false);
    });

    it('attributes an implementation-only free procedure\'s calls to the procedure, not the file', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'main.pas'),
        `unit Main;
interface
type
  TTgt = class
    procedure Hit;
  end;
  TFoo = class
    procedure DoStuff;
  end;
implementation
procedure TTgt.Hit; begin end;
procedure TFoo.DoStuff; var t: TTgt; begin t.Hit; end;
procedure Helper; var t: TTgt; begin t.Hit; end;
`
      );
      cg = await CodeGraph.init(tempDir, { index: true });
      // `Helper` is implementation-only (no interface decl, not a method), but its
      // body's call must attribute to `Helper`, not the file/module — alongside the
      // method `DoStuff`.
      expect(callerNamesOf('TTgt::Hit')).toEqual(['DoStuff', 'Helper']);
    });
  });

  describe('Nix path import resolution', () => {
    function fileNode(filePath: string) {
      return cg.getNodesByKind('file').find((n) => n.filePath === filePath);
    }

    function importedFilePaths(fromFile: string): string[] {
      const source = fileNode(fromFile);
      expect(source, `${fromFile} file node`).toBeDefined();
      return cg
        .getOutgoingEdges(source!.id)
        .filter((edge) => edge.kind === 'imports')
        .map((edge) => cg.getNodesByKind('file').find((n) => n.id === edge.target)?.filePath)
        .filter((filePath): filePath is string => Boolean(filePath))
        .sort();
    }

    it('resolves relative Nix imports to indexed file nodes', async () => {
      fs.mkdirSync(path.join(tempDir, 'core'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'core', 'ports.nix'), '{ http = 80; https = 443; }');
      fs.writeFileSync(
        path.join(tempDir, 'data', 'postgresql.nix'),
        `let
  ports = import ../core/ports.nix;
in
{
  port = ports.https;
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      expect(importedFilePaths('data/postgresql.nix')).toEqual(['core/ports.nix']);
    });

    it('resolves Nix directory imports through default.nix and deduplicates called imports', async () => {
      fs.mkdirSync(path.join(tempDir, 'dir'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'dir', 'default.nix'), '{ value = 1; }');
      fs.writeFileSync(path.join(tempDir, 'x.nix'), '{ value = 2; }');
      fs.writeFileSync(
        path.join(tempDir, 'main.nix'),
        `let
  dir = import ./dir;
  x = import ./x.nix {};
in
{
  inherit dir x;
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      expect(importedFilePaths('main.nix')).toEqual(['dir/default.nix', 'x.nix']);
    });

    it('resolves NixOS module imports lists and callPackage paths to file nodes', async () => {
      fs.mkdirSync(path.join(tempDir, 'modules'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'common'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'pkgs', 'hello'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'modules', 'users.nix'), '{ users.users.demo.isNormalUser = true; }');
      fs.writeFileSync(path.join(tempDir, 'common', 'default.nix'), '{ time.timeZone = "UTC"; }');
      fs.writeFileSync(
        path.join(tempDir, 'pkgs', 'hello', 'default.nix'),
        '{ stdenv }: stdenv.mkDerivation { pname = "hello"; }'
      );
      fs.writeFileSync(
        path.join(tempDir, 'configuration.nix'),
        `{ config, pkgs, ... }:
{
  imports = [ ./modules/users.nix ./common ];
  environment.systemPackages = [ (pkgs.callPackage ./pkgs/hello { }) ];
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      expect(importedFilePaths('configuration.nix')).toEqual([
        'common/default.nix',
        'modules/users.nix',
        'pkgs/hello/default.nix',
      ]);
    });

    it('never resolves another language\'s calls into nix bindings', async () => {
      // Nix bindings are not linkable symbols from any other language —
      // interop is eval/CLI. Without the target-side gate, a Python script's
      // bare `resolve(...)` exact-matches a module's `resolve = ...` binding.
      fs.writeFileSync(
        path.join(tempDir, 'helpers.nix'),
        `let
  resolve = x: x;
in
{
  inherit resolve;
}
`
      );
      fs.writeFileSync(path.join(tempDir, 'tool.py'), 'def main():\n    return resolve("target")\n');

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const nixNodeIds = new Set(
        cg.getNodesByKind('variable').filter((n) => n.language === 'nix').map((n) => n.id)
      );
      const pyFns = cg.getNodesByKind('function').filter((n) => n.language === 'python');
      expect(pyFns.length).toBeGreaterThan(0);
      const crossEdges = pyFns.flatMap((f) => cg.getOutgoingEdges(f.id)).filter((e) => nixNodeIds.has(e.target));
      expect(crossEdges).toEqual([]);
    });

    it('never cross-links Nix calls by bare name across files (lexical scope only)', async () => {
      // Both modules `inherit (lib) mkOption` — the nixpkgs idiom. A call to
      // mkOption in one file must NOT resolve to the other file's inherit
      // binding: Nix has no ambient cross-file namespace, so any such edge is
      // wrong by construction. Same-file bindings still resolve.
      fs.writeFileSync(
        path.join(tempDir, 'alpha.nix'),
        `{ lib, ... }:
let
  inherit (lib) mkOption;
  mkPort = default: mkOption { inherit default; };
in
{
  options.alpha.port = mkPort 8080;
}
`
      );
      fs.writeFileSync(
        path.join(tempDir, 'beta.nix'),
        `{ lib, ... }:
let
  inherit (lib) mkOption;
in
{
  options.beta.enable = mkOption { default = false; };
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      const crossFileCalls = cg
        .getNodesByKind('file')
        .flatMap((f) => cg.getOutgoingEdges(f.id))
        .concat(
          cg.getNodesByKind('function').flatMap((f) => cg.getOutgoingEdges(f.id)),
          cg.getNodesByKind('variable').flatMap((v) => cg.getOutgoingEdges(v.id))
        )
        .filter((e) => e.kind === 'calls')
        .map((e) => {
          const src = cg.getNode(e.source);
          const tgt = cg.getNode(e.target);
          return { from: src?.filePath, to: tgt?.filePath, name: tgt?.name };
        });

      // No calls edge may cross files by bare-name matching.
      expect(crossFileCalls.filter((e) => e.from !== e.to)).toEqual([]);
      // The same-file chain still resolves: mkPort's mkOption call hits
      // alpha.nix's own inherit binding.
      const sameFile = crossFileCalls.filter((e) => e.from === e.to && e.name === 'mkOption');
      expect(sameFile.length).toBeGreaterThan(0);
      expect(sameFile.every((e) => e.from === 'alpha.nix' || e.from === 'beta.nix')).toBe(true);
    });

    it('does not resolve Nix angle-bracket, attribute, or variable imports as project file edges', async () => {
      fs.writeFileSync(path.join(tempDir, 'nixpkgs.nix'), '{ bogus = true; }');
      fs.writeFileSync(path.join(tempDir, 'selectedPath.nix'), '{ bogus = true; }');
      fs.writeFileSync(
        path.join(tempDir, 'main.nix'),
        `let
  pkgs = import <nixpkgs> {};
  fromSources = import sources.nixpkgs {};
  dynamic = import selectedPath;
in
{
  inherit pkgs fromSources dynamic;
}
`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      expect(importedFilePaths('main.nix')).toEqual([]);
    });
  });
});
