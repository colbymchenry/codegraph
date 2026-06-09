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
import { matchReference } from '../src/resolution/name-matcher';
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
        language: 'typescript' as const,
      };

      const result = reactResolver!.resolve(ref, context);
      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('component:src/Button.tsx:Button:5');
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
});
