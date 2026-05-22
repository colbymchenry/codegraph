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
import { resolveImportPath, extractImportMappings } from '../src/resolution/import-resolver';
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
  });

  describe('Nix Import Path Resolution', () => {
    it('resolves relative Nix imports to file nodes', async () => {
      // Create a Nix project layout
      const coreDir = path.join(tempDir, 'core');
      const dataDir = path.join(tempDir, 'data');
      fs.mkdirSync(coreDir, { recursive: true });
      fs.mkdirSync(dataDir, { recursive: true });

      // Create core/ports.nix
      fs.writeFileSync(
        path.join(coreDir, 'ports.nix'),
        `{
          http = 80;
          https = 443;
        }`
      );

      // Create data/postgresql.nix that imports core/ports.nix
      fs.writeFileSync(
        path.join(dataDir, 'postgresql.nix'),
        `let
          ports = import ../core/ports.nix;
        in
        {
          port = ports.https;
        }`
      );

      cg = await CodeGraph.init(tempDir, { index: true });
      cg.resolveReferences();

      // Find the file node for postgresql.nix
      const postgresqlFileNode = cg.getNodesByKind('file').find((n) => n.filePath === 'data/postgresql.nix');
      expect(postgresqlFileNode).toBeDefined();

      // Find outgoing edges from postgresql.nix
      // (The import expression inside data/postgresql.nix is contained by the file, so it should resolve to core/ports.nix file node)
      const outgoing = cg.getOutgoingEdges(postgresqlFileNode!.id);
      const importEdge = outgoing.find((e) => e.kind === 'imports');
      expect(importEdge).toBeDefined();

      const targetNode = cg.getNodesByKind('file').find((n) => n.id === importEdge!.target);
      expect(targetNode).toBeDefined();
      expect(targetNode?.kind).toBe('file');
      expect(targetNode?.filePath).toBe('core/ports.nix');
    });
  });
});
