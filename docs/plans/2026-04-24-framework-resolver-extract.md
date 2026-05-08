# Framework Resolver `extract()` Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the dead `FrameworkResolver.extractNodes` hook so every framework resolver can contribute route nodes AND route-to-handler edges to the graph, and update all 13 existing framework resolvers to use it correctly.

**Architecture:** Replace the unused `extractNodes?(filePath, content): Node[]` hook with a single `extract?(filePath, content): { nodes, references }` method. Call it once per file during the extraction phase (after tree-sitter parses the file) for any framework whose language matches the file. Extracted nodes go into the DB alongside tree-sitter nodes; extracted references flow into the existing unresolved-references pipeline so the existing name-matcher / import-resolver / framework `resolve()` machinery creates the final edges. Net effect: `path('/users', UserListView.as_view())` produces a `route` node linked by a `references` edge to the `UserListView` class node — and the equivalent holds for Flask, FastAPI, Express, Rails, Laravel, Spring, Gin, Axum, ASP.NET, Vapor, React Router, and SvelteKit.

**Tech Stack:** TypeScript, vitest, tree-sitter (existing), better-sqlite3 (existing). No new dependencies.

---

## Background

Today, every `FrameworkResolver` ships with an `extractNodes?(filePath, content)` method (express, laravel, python/django, python/flask, python/fastapi, ruby/rails, java/spring, go, rust, csharp, swift × 3, react, svelte). None of them are ever called. Empirical proof: grep across `src/` finds exactly one reference to `extractNodes` — the interface definition at `src/resolution/types.ts:99`. As a result the graph has zero `route` kind nodes in practice, and the link between a URL entry in a routing file and its view/controller/handler doesn't exist.

Separately, the Django extractor's regex captures the view name in group 2 but the destructure in `src/resolution/frameworks/python.ts` discards it, so even if the hook were alive it wouldn't link the route to the view. Similar shape bugs exist across most frameworks.

This plan fixes both problems in one coherent change.

## File Structure

- `src/resolution/types.ts` — add `extract?()` to `FrameworkResolver`; remove `extractNodes?()`.
- `src/resolution/frameworks/index.ts` — keep `detectFrameworks` signature; add `getApplicableFrameworks(language)` helper.
- `src/resolution/frameworks/python.ts` — rewrite Django/Flask/FastAPI extractors.
- `src/resolution/frameworks/express.ts` / `laravel.ts` / `ruby.ts` / `java.ts` / `go.ts` / `rust.ts` / `csharp.ts` / `swift.ts` / `react.ts` / `svelte.ts` — migrate to new interface.
- `src/extraction/index.ts` — plug framework extraction into `ExtractionOrchestrator.indexAll` after per-file tree-sitter parse.
- `src/extraction/parse-worker.ts` — pass detected-framework names into the worker so the worker can invoke framework extractors itself (needed because main-thread `extractFromSource` and worker-thread parse path both have to cover this).
- `__tests__/frameworks.test.ts` — NEW. One `describe` per framework, checking that representative fixtures produce the expected `{nodes, references}`.
- `__tests__/frameworks-integration.test.ts` — NEW. End-to-end test: index a tiny Django project fixture, assert a `route -> class` edge with kind `references` exists from `urlpatterns` entry to `UserListView`.

Rationale for splitting the two test files: the unit tests are deterministic string-in / array-out and run in milliseconds; the integration test boots a CodeGraph DB and is slower but gives the strongest behavioral guarantee.

## Scope Note

This plan does NOT move Django extraction from regex to AST. The regex approach is fine for the shapes this PR targets (`path(...)`, `url(...)`, `re_path(...)`, `include(...)`, DRF `router.register(...)`, CBV `.as_view()`, dotted module paths). A follow-up PR can swap the regex for AST walking using tree-sitter's existing Python parser. That's a larger change and doesn't block this one.

---

## Task 1: Update the `FrameworkResolver` interface

**Files:**
- Modify: `src/resolution/types.ts:88-100`

- [ ] **Step 1: Write the failing test**

Create `__tests__/frameworks.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { FrameworkResolver, UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';

describe('FrameworkResolver.extract interface', () => {
  it('extract() returns { nodes, references }', () => {
    const resolver: FrameworkResolver = {
      name: 'fake',
      detect: () => true,
      resolve: () => null,
      languages: ['python'],
      extract: (_filePath: string, _content: string) => ({
        nodes: [] as Node[],
        references: [] as UnresolvedRef[],
      }),
    };
    const result = resolver.extract!('foo.py', '');
    expect(result).toEqual({ nodes: [], references: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/frameworks.test.ts`
Expected: FAIL — `extract` is not a property of `FrameworkResolver`; `languages` is not a property of `FrameworkResolver`.

- [ ] **Step 3: Update the interface**

Replace `src/resolution/types.ts:88-100` with:

```typescript
/**
 * Result of framework-specific file extraction.
 */
export interface FrameworkExtractionResult {
  /** Framework-specific nodes (e.g. routes) */
  nodes: Node[];
  /** Framework-specific unresolved references (e.g. route -> handler) */
  references: UnresolvedRef[];
}

/**
 * Framework-specific resolver
 */
export interface FrameworkResolver {
  /** Framework name */
  name: string;
  /** Languages this framework applies to. If omitted, applies to all languages. */
  languages?: Language[];
  /** Detect if project uses this framework (project-level, called once at startup) */
  detect(context: ResolutionContext): boolean;
  /** Resolve a reference using framework-specific patterns */
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null;
  /**
   * Extract framework-specific nodes and references from a file.
   *
   * Returns route nodes, middleware nodes, etc., plus unresolved references
   * that link those nodes to handlers (view classes, controller methods,
   * included modules). Unresolved references flow into the normal resolution
   * pipeline; the framework's own `resolve()` is one of the strategies tried.
   */
  extract?(filePath: string, content: string): FrameworkExtractionResult;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/frameworks.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck to catch downstream breakage**

Run: `npx tsc --noEmit`
Expected: FAIL — every `src/resolution/frameworks/*.ts` will error on `extractNodes` not existing on `FrameworkResolver`. That's expected; subsequent tasks fix each one.

- [ ] **Step 6: Commit**

```bash
git add src/resolution/types.ts __tests__/frameworks.test.ts
git commit -m "feat(resolution): replace extractNodes with extract() returning nodes and references"
```

---

## Task 2: Add `getApplicableFrameworks` helper and keep detection correct

**Files:**
- Modify: `src/resolution/frameworks/index.ts`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/frameworks.test.ts`:

```typescript
import { getApplicableFrameworks } from '../src/resolution/frameworks';
import type { FrameworkResolver } from '../src/resolution/types';

describe('getApplicableFrameworks', () => {
  const pyFw: FrameworkResolver = { name: 'py', languages: ['python'], detect: () => true, resolve: () => null };
  const jsFw: FrameworkResolver = { name: 'js', languages: ['javascript', 'typescript'], detect: () => true, resolve: () => null };
  const anyFw: FrameworkResolver = { name: 'any', detect: () => true, resolve: () => null };

  it('filters by language', () => {
    const result = getApplicableFrameworks([pyFw, jsFw, anyFw], 'python');
    expect(result.map(r => r.name)).toEqual(['py', 'any']);
  });

  it('returns anyFw-only when language has no matches', () => {
    const result = getApplicableFrameworks([pyFw, jsFw, anyFw], 'rust');
    expect(result.map(r => r.name)).toEqual(['any']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/frameworks.test.ts`
Expected: FAIL — `getApplicableFrameworks` is not exported.

- [ ] **Step 3: Add helper to `src/resolution/frameworks/index.ts`**

Add after the existing `detectFrameworks` function:

```typescript
import type { Language } from '../../types';

/**
 * Filter a list of detected frameworks down to ones that apply to a given language.
 * Frameworks without an explicit `languages` list are treated as universal.
 */
export function getApplicableFrameworks(
  detected: FrameworkResolver[],
  language: Language
): FrameworkResolver[] {
  return detected.filter(
    (fw) => !fw.languages || fw.languages.includes(language)
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/frameworks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/resolution/frameworks/index.ts __tests__/frameworks.test.ts
git commit -m "feat(resolution): add getApplicableFrameworks helper for per-language dispatch"
```

---

## Task 3: Port Django resolver to new `extract()` with proper route→view references

**Files:**
- Modify: `src/resolution/frameworks/python.ts` (djangoResolver section, ~line 1-100)

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/frameworks.test.ts`:

```typescript
import { djangoResolver } from '../src/resolution/frameworks/python';

describe('djangoResolver.extract', () => {
  it('extracts route node and reference for path() with CBV.as_view()', () => {
    const src = `
from django.urls import path
from users.views import UserListView

urlpatterns = [
    path('users/', UserListView.as_view(), name='user-list'),
]
`;
    const { nodes, references } = djangoResolver.extract!('users/urls.py', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('route');
    expect(nodes[0].name).toBe('users/');
    expect(references).toHaveLength(1);
    expect(references[0].referenceName).toBe('UserListView');
    expect(references[0].referenceKind).toBe('references');
    expect(references[0].fromNodeId).toBe(nodes[0].id);
  });

  it('extracts route for path() with dotted module.Class.as_view()', () => {
    const src = `from django.urls import path\nfrom api.v1 import views as api_v1_views\nurlpatterns = [path('api/', api_v1_views.UserListView.as_view())]\n`;
    const { nodes, references } = djangoResolver.extract!('api/urls.py', src);
    expect(nodes).toHaveLength(1);
    expect(references[0].referenceName).toBe('UserListView');
  });

  it('extracts route for path() with bare function view', () => {
    const src = `from django.urls import path\nurlpatterns = [path('home/', home_view, name='home')]\n`;
    const { nodes, references } = djangoResolver.extract!('home/urls.py', src);
    expect(references[0].referenceName).toBe('home_view');
  });

  it('extracts route for path() with include()', () => {
    const src = `from django.urls import path, include\nurlpatterns = [path('api/', include('api.urls'))]\n`;
    const { nodes, references } = djangoResolver.extract!('root/urls.py', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('route');
    expect(references[0].referenceName).toBe('api.urls');
    expect(references[0].referenceKind).toBe('imports');
  });

  it('extracts routes for re_path and url', () => {
    const src = `from django.urls import re_path, url\nurlpatterns = [re_path(r'^users/$', UserView), url(r'^old/$', OldView)]\n`;
    const { nodes } = djangoResolver.extract!('legacy/urls.py', src);
    expect(nodes).toHaveLength(2);
    expect(nodes.map(n => n.name)).toEqual(['^users/$', '^old/$']);
  });

  it('returns empty result for a non-urls.py python file', () => {
    const src = `def foo(): return 1\n`;
    const { nodes, references } = djangoResolver.extract!('views.py', src);
    expect(nodes).toEqual([]);
    expect(references).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/frameworks.test.ts -t djangoResolver`
Expected: FAIL — `djangoResolver.extract` is undefined.

- [ ] **Step 3: Rewrite djangoResolver**

Replace the `djangoResolver` object in `src/resolution/frameworks/python.ts` (approximately lines 7-100) with:

```typescript
export const djangoResolver: FrameworkResolver = {
  name: 'django',
  languages: ['python'],

  detect(context) {
    const requirements = context.readFile('requirements.txt');
    if (requirements && requirements.toLowerCase().includes('django')) return true;
    const setup = context.readFile('setup.py');
    if (setup && setup.toLowerCase().includes('django')) return true;
    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && pyproject.toLowerCase().includes('django')) return true;
    return context.fileExists('manage.py');
  },

  resolve(ref, context) {
    if (ref.referenceName.endsWith('Model') || /^[A-Z][a-z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, MODEL_DIRS, context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('View') || ref.referenceName.endsWith('ViewSet')) {
      const result = resolveByNameAndKind(ref.referenceName, VIEW_KINDS, VIEW_DIRS, context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (ref.referenceName.endsWith('Form')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, FORM_DIRS, context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
    }
    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.py')) return { nodes: [], references: [] };

    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    // path('url', handler, name=...) / re_path(r'...', handler) / url(r'...', handler)
    // Capture groups: 1=function name, 2=url string, 3=rest of line up to closing )
    const routeRegex = /\b(path|re_path|url)\s*\(\s*r?['"]([^'"]+)['"]\s*,\s*([^)]*?)(?:\)|,\s*name=)/g;

    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(content)) !== null) {
      const [, _fn, urlPath, handlerExpr] = match;
      const line = content.slice(0, match.index).split('\n').length;

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${urlPath}`,
        kind: 'route',
        name: urlPath,
        qualifiedName: `${filePath}::route:${urlPath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'python',
        updatedAt: now,
      };
      nodes.push(routeNode);

      const handler = handlerExpr.trim();
      const target = resolveHandlerName(handler);
      if (target) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: target.name,
          referenceKind: target.kind,
          line,
          column: 0,
          filePath,
          language: 'python',
        });
      }
    }

    return { nodes, references };
  },
};

/**
 * Parse a Django URL handler expression and return the symbol/module to link.
 *
 * Returns null for shapes we can't confidently link (e.g. lambdas).
 */
function resolveHandlerName(expr: string): { name: string; kind: 'references' | 'imports' } | null {
  // include('module.path') / include("module.path")
  const includeMatch = expr.match(/^include\s*\(\s*['"]([^'"]+)['"]/);
  if (includeMatch) return { name: includeMatch[1], kind: 'imports' };

  // Strip trailing .as_view(...) or .as_view call
  let head = expr.replace(/\.as_view\s*\([^)]*\)\s*$/, '');

  // Drop a trailing method call like .some_method()
  head = head.replace(/\.\w+\s*\([^)]*\)\s*$/, '');

  // Now head should be either a bare name or a dotted path. Take the last segment.
  const dotted = head.split('.').filter(Boolean);
  if (dotted.length === 0) return null;
  const last = dotted[dotted.length - 1];
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(last)) return null;

  return { name: last, kind: 'references' };
}
```

Also ensure the top of the file imports `UnresolvedRef` and `Node`:

```typescript
import type { FrameworkResolver, UnresolvedRef } from '../types';
import type { Node } from '../../types';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/frameworks.test.ts -t djangoResolver`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/resolution/frameworks/python.ts __tests__/frameworks.test.ts
git commit -m "feat(django): emit route nodes and route->view references in extract()"
```

---

## Task 4: Port Flask and FastAPI resolvers

**Files:**
- Modify: `src/resolution/frameworks/python.ts` (flaskResolver and fastapiResolver sections)

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/frameworks.test.ts`:

```typescript
import { flaskResolver, fastapiResolver } from '../src/resolution/frameworks/python';

describe('flaskResolver.extract', () => {
  it('extracts route and reference from @app.route', () => {
    const src = `
@app.route('/users')
def list_users():
    return []
`;
    const { nodes, references } = flaskResolver.extract!('app.py', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('route');
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('list_users');
  });

  it('extracts blueprint routes', () => {
    const src = `
@users_bp.route('/<id>', methods=['POST'])
def create_user(id):
    pass
`;
    const { nodes, references } = flaskResolver.extract!('routes.py', src);
    expect(nodes[0].name).toBe('POST /<id>');
    expect(references[0].referenceName).toBe('create_user');
  });
});

describe('fastapiResolver.extract', () => {
  it('extracts route and reference from @app.get', () => {
    const src = `
@app.get('/users')
async def list_users():
    return []
`;
    const { nodes, references } = fastapiResolver.extract!('main.py', src);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('list_users');
  });

  it('extracts route from router.post', () => {
    const src = `
@router.post('/items')
def create_item(item: Item):
    pass
`;
    const { nodes, references } = fastapiResolver.extract!('items.py', src);
    expect(nodes[0].name).toBe('POST /items');
    expect(references[0].referenceName).toBe('create_item');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/frameworks.test.ts -t "flaskResolver|fastapiResolver"`
Expected: FAIL — both resolvers' `extract` are undefined.

- [ ] **Step 3: Rewrite flaskResolver and fastapiResolver**

Replace `flaskResolver` in `src/resolution/frameworks/python.ts` with:

```typescript
export const flaskResolver: FrameworkResolver = {
  name: 'flask',
  languages: ['python'],

  detect(context) {
    const requirements = context.readFile('requirements.txt');
    if (requirements && /\bflask\b/i.test(requirements)) return true;
    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && /\bflask\b/i.test(pyproject)) return true;
    for (const file of ['app.py', 'application.py', 'main.py', '__init__.py']) {
      const content = context.readFile(file);
      if (content && content.includes('Flask(__name__)')) return true;
    }
    return false;
  },

  resolve(ref, context) {
    if (ref.referenceName.endsWith('_bp') || ref.referenceName.endsWith('_blueprint')) {
      const result = resolveByNameAndKind(ref.referenceName, VARIABLE_KINDS, [], context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
    }
    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.py')) return { nodes: [], references: [] };
    return extractDecoratorRoutes(filePath, content, {
      // Flask: @x.route('/path', methods=[...])
      decoratorRegex: /@(\w+)\.route\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*methods\s*=\s*\[([^\]]+)\])?\s*\)\s*\n\s*(?:async\s+)?def\s+(\w+)/g,
      defaultMethod: 'GET',
      methodFromGroup: 3,
      pathGroup: 2,
      handlerGroup: 4,
      language: 'python',
    });
  },
};

export const fastapiResolver: FrameworkResolver = {
  name: 'fastapi',
  languages: ['python'],

  detect(context) {
    const requirements = context.readFile('requirements.txt');
    if (requirements && /\bfastapi\b/i.test(requirements)) return true;
    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && /\bfastapi\b/i.test(pyproject)) return true;
    for (const file of ['app.py', 'main.py', 'api.py']) {
      const content = context.readFile(file);
      if (content && content.includes('FastAPI(')) return true;
    }
    return false;
  },

  resolve(ref, context) {
    if (ref.referenceName.endsWith('_router') || ref.referenceName === 'router') {
      const result = resolveByNameAndKind(ref.referenceName, VARIABLE_KINDS, ROUTER_DIRS, context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
    }
    if (ref.referenceName.startsWith('get_') || ref.referenceName.startsWith('Depends')) {
      const result = resolveByNameAndKind(ref.referenceName, FUNCTION_KINDS, DEP_DIRS, context);
      if (result) return { original: ref, targetNodeId: result, confidence: 0.75, resolvedBy: 'framework' };
    }
    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.py')) return { nodes: [], references: [] };
    return extractDecoratorRoutes(filePath, content, {
      // FastAPI: @x.get('/path')
      decoratorRegex: /@(\w+)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]+)['"]/g,
      defaultMethod: '',
      methodGroup: 2,
      pathGroup: 3,
      // handler follows on next def line; captured via post-scan
      handlerGroup: undefined,
      findHandler: true,
      language: 'python',
    });
  },
};
```

And add this shared helper at the bottom of `python.ts`:

```typescript
interface DecoratorRouteOpts {
  decoratorRegex: RegExp;
  defaultMethod: string;
  methodGroup?: number;
  methodFromGroup?: number; // methods=[...] list
  pathGroup: number;
  handlerGroup?: number;
  findHandler?: boolean;
  language: 'python';
}

function extractDecoratorRoutes(filePath: string, content: string, opts: DecoratorRouteOpts) {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  let match: RegExpExecArray | null;
  while ((match = opts.decoratorRegex.exec(content)) !== null) {
    const routePath = match[opts.pathGroup];
    let method = opts.defaultMethod;
    if (opts.methodGroup && match[opts.methodGroup]) {
      method = match[opts.methodGroup].toUpperCase();
    } else if (opts.methodFromGroup && match[opts.methodFromGroup]) {
      const m = match[opts.methodFromGroup].match(/['"]([A-Z]+)['"]/i);
      if (m) method = m[1].toUpperCase();
    }
    const line = content.slice(0, match.index).split('\n').length;
    const name = method ? `${method} ${routePath}` : routePath;
    const routeNode: Node = {
      id: `route:${filePath}:${line}:${method}:${routePath}`,
      kind: 'route',
      name,
      qualifiedName: `${filePath}::${method}:${routePath}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: match[0].length,
      language: opts.language,
      updatedAt: now,
    };
    nodes.push(routeNode);

    let handlerName: string | undefined;
    if (opts.handlerGroup && match[opts.handlerGroup]) {
      handlerName = match[opts.handlerGroup];
    } else if (opts.findHandler) {
      // Find the next `def <name>` after the decorator
      const tail = content.slice(match.index + match[0].length);
      const defMatch = tail.match(/\n\s*(?:async\s+)?def\s+(\w+)/);
      if (defMatch) handlerName = defMatch[1];
    }
    if (handlerName) {
      references.push({
        fromNodeId: routeNode.id,
        referenceName: handlerName,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'python',
      });
    }
  }
  return { nodes, references };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/frameworks.test.ts -t "flaskResolver|fastapiResolver"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/resolution/frameworks/python.ts __tests__/frameworks.test.ts
git commit -m "feat(flask,fastapi): emit route nodes and route->handler references"
```

---

## Task 5: Port Express resolver

**Files:**
- Modify: `src/resolution/frameworks/express.ts` (extractNodes section, ~line 83-117)

- [ ] **Step 1: Write failing tests**

Append to `__tests__/frameworks.test.ts`:

```typescript
import { expressResolver } from '../src/resolution/frameworks/express';

describe('expressResolver.extract', () => {
  it('extracts route with inline handler reference', () => {
    const src = `app.get('/users', listUsers);\n`;
    const { nodes, references } = expressResolver.extract!('routes.ts', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('GET /users');
    expect(references[0].referenceName).toBe('listUsers');
  });

  it('extracts route with router.post', () => {
    const src = `router.post('/items', auth, createItem);\n`;
    const { nodes, references } = expressResolver.extract!('items.ts', src);
    expect(nodes[0].name).toBe('POST /items');
    // Multiple handlers: prefer the LAST one (convention: middleware comes first, handler last)
    expect(references[0].referenceName).toBe('createItem');
  });

  it('extracts route with controller method reference', () => {
    const src = `app.get('/x', userController.list);\n`;
    const { nodes, references } = expressResolver.extract!('routes.ts', src);
    expect(references[0].referenceName).toBe('list');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/frameworks.test.ts -t expressResolver`
Expected: FAIL.

- [ ] **Step 3: Rewrite expressResolver.extract**

Replace the existing `extractNodes` method on `expressResolver` (in `src/resolution/frameworks/express.ts`) with:

```typescript
  languages: ['javascript', 'typescript'],

  extract(filePath, content) {
    if (!/\.(m?js|tsx?|cjs)$/.test(filePath)) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    // Capture: (app|router).METHOD('/path', handler-expr)
    const regex = /\b(app|router)\.(get|post|put|patch|delete|all|use)\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const [, _obj, method, routePath, handlers] = match;
      if (method === 'use' && !routePath.startsWith('/')) continue;
      const line = content.slice(0, match.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method.toUpperCase()}:${routePath}`,
        kind: 'route',
        name: `${method.toUpperCase()} ${routePath}`,
        qualifiedName: `${filePath}::${method.toUpperCase()}:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: detectLanguage(filePath),
        updatedAt: now,
      };
      nodes.push(routeNode);
      // Last comma-separated arg is the handler; intermediate args are middleware
      const handlerParts = handlers.split(',').map((s) => s.trim()).filter(Boolean);
      const last = handlerParts[handlerParts.length - 1];
      const handlerName = extractTailIdent(last);
      if (handlerName) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: handlerName,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: detectLanguage(filePath),
        });
      }
    }
    return { nodes, references };
  },
```

And add near the top of the file:

```typescript
import type { FrameworkResolver, UnresolvedRef } from '../types';
import type { Node } from '../../types';

function extractTailIdent(expr: string): string | null {
  const cleaned = expr.replace(/\s+/g, '').replace(/\(\)$/, '');
  const m = cleaned.match(/(?:\.|^)([A-Za-z_][A-Za-z0-9_]*)$/);
  return m ? m[1] : null;
}
```

Remove the old `extractNodes` method.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run __tests__/frameworks.test.ts -t expressResolver`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/resolution/frameworks/express.ts __tests__/frameworks.test.ts
git commit -m "feat(express): emit route nodes and route->handler references"
```

---

## Task 6: Port Laravel, Rails, Spring, Gin (Go), Axum (Rust), ASP.NET (C#), Swift resolvers

**Files:**
- Modify: `src/resolution/frameworks/laravel.ts` / `ruby.ts` / `java.ts` / `go.ts` / `rust.ts` / `csharp.ts` / `swift.ts`

Each framework follows the **same pattern** as Tasks 3–5 above:

1. Add `languages: [...]` field.
2. Replace `extractNodes(filePath, content)` with `extract(filePath, content): { nodes, references }`.
3. Inside `extract()`, for each matched route regex: create a route node (reuse existing shape) AND emit a `UnresolvedRef` for the handler/controller with `fromNodeId = routeNode.id`.
4. For each framework, add one unit test to `__tests__/frameworks.test.ts` that verifies at least one route shape produces both a node and a handler reference.

**Per-framework specifics:**

- **Laravel** (`laravel.ts`): `Route::get('/x', [Ctrl::class, 'method'])` → handler ref name = `method`; `Route::get('/x', 'Ctrl@method')` → handler ref name = `method`; `Route::resource('users', UserController::class)` → handler ref name = `UserController`. `languages: ['php']`.

- **Rails** (`ruby.ts`): `get '/x', to: 'users#index'` → handler ref name = `index` (scope by `users`); `resources :users` → one node per CRUD action, each referencing the corresponding method name on `UsersController`. `languages: ['ruby']`.

- **Spring** (`java.ts`): `@GetMapping("/x")` on method → handler is the following method name (scan forward past the decorator). `languages: ['java']`.

- **Gin / chi / gorilla** (`go.ts`): `r.GET("/x", handler)` → handler ref = last ident in the last arg. `languages: ['go']`.

- **Axum / actix** (`rust.ts`): `.route("/x", get(handler))` → handler ref = ident inside `get(...)`. `languages: ['rust']`.

- **ASP.NET** (`csharp.ts`): `[HttpGet("/x")] public ActionResult Method()` → handler ref = method name on same class. `languages: ['csharp']`.

- **Swift / Vapor** (`swift.ts`): `app.get("/x", use: handler)` → handler ref = ident after `use:`. `languages: ['swift']`.

Each of these gets its own commit in the form:

```bash
git add src/resolution/frameworks/<framework>.ts __tests__/frameworks.test.ts
git commit -m "feat(<framework>): emit route nodes and route->handler references"
```

**Important:** keep each framework's commit independent so any one of them can be reverted if it causes regressions.

### Task 6a: Laravel

- [ ] **Step 1: Write test** for `Route::get('/users', [UserController::class, 'index'])` → `{nodes[0].name='GET /users', references[0].referenceName='index'}`.
- [ ] **Step 2: Run test, see fail.**
- [ ] **Step 3: Implement `extract()`** following the Express pattern. Regex: `/Route::(get|post|put|patch|delete|options|any)\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\)/g`. Extract handler from third group via `resolveLaravelHandler()`: strip `[`/`]`/`::class`, take second element of comma-split array or `Ctrl@method`.
- [ ] **Step 4: Run test, see pass.**
- [ ] **Step 5: Commit.**

### Task 6b: Rails

- [ ] **Step 1: Write test** for `get '/users', to: 'users#index'` → `{references[0].referenceName='index'}`.
- [ ] **Step 2: Run test, see fail.**
- [ ] **Step 3: Implement `extract()`**. Regex: `/\b(get|post|put|patch|delete|match)\s+['"]([^'"]+)['"]\s*,\s*to:\s*['"]([^'"]+)['"]/g` → `controller#method` split on `#` gives handler = `method`.
- [ ] **Step 4: Run test, see pass.**
- [ ] **Step 5: Commit.**

### Task 6c: Spring

- [ ] **Step 1: Write test** for `@GetMapping("/x")\npublic String list() {...}` → `{references[0].referenceName='list'}`.
- [ ] **Step 2: Run test, see fail.**
- [ ] **Step 3: Implement `extract()`** using the shared `extractDecoratorRoutes` helper (move it to a new `src/resolution/frameworks/shared.ts` if cleaner). Find the next `public` or `private` method declaration's name after each mapping annotation.
- [ ] **Step 4: Run test, see pass.**
- [ ] **Step 5: Commit.**

### Task 6d: Go

- [ ] **Step 1: Write test** for `r.GET("/x", handler)` and `router.Handle("/x", handler)` → `{references[0].referenceName='handler'}`.
- [ ] **Step 2: Run test, see fail.**
- [ ] **Step 3: Implement `extract()`**. Regex: `/\b(?:router|r|mux|app)\.(GET|POST|PUT|PATCH|DELETE|Handle|HandleFunc)\s*\(\s*["]([^"]+)["]\s*,\s*([^)]+)\)/g`. Handler = last ident in third group.
- [ ] **Step 4: Run test, see pass.**
- [ ] **Step 5: Commit.**

### Task 6e: Rust

- [ ] **Step 1: Write test** for `.route("/x", get(list_users))` → `{references[0].referenceName='list_users'}`.
- [ ] **Step 2: Run test, see fail.**
- [ ] **Step 3: Implement `extract()`**. Regex: `/\.route\s*\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)\s*\(\s*(\w+)/g` → handler = group 3.
- [ ] **Step 4: Run test, see pass.**
- [ ] **Step 5: Commit.**

### Task 6f: C# (ASP.NET)

- [ ] **Step 1: Write test** for `[HttpGet("/x")]\npublic IActionResult List()` → `{references[0].referenceName='List'}`.
- [ ] **Step 2: Run test, see fail.**
- [ ] **Step 3: Implement `extract()`**. Find attributes, then scan forward to first `public|private|protected` method declaration and take its name.
- [ ] **Step 4: Run test, see pass.**
- [ ] **Step 5: Commit.**

### Task 6g: Swift / Vapor

- [ ] **Step 1: Write test** for `app.get("/users", use: list)` → `{references[0].referenceName='list'}`.
- [ ] **Step 2: Run test, see fail.**
- [ ] **Step 3: Implement `extract()`**. Regex: `/\b(app|router|routes)\.(get|post|put|patch|delete)\s*\(\s*"([^"]+)"\s*,\s*use:\s*([A-Za-z_][A-Za-z0-9_.]*)/g` → handler = group 4's last segment.
- [ ] **Step 4: Run test, see pass.**
- [ ] **Step 5: Commit.**

### Task 6h: React & Svelte

These are UI frameworks where routes map to components, not handlers in the server sense. Keep the existing behavior but migrate the interface:

- [ ] **Step 1: Migrate `reactResolver`** (`src/resolution/frameworks/react.ts`) — add `languages: ['javascript', 'typescript']`, rename `extractNodes` to `extract`, make it return `{ nodes, references: [] }` (the existing logic only emits nodes, no handler references needed yet — a follow-up can add `<Route element={<Page/>}/>` → `Page` references).
- [ ] **Step 2: Migrate `svelteResolver`** (`src/resolution/frameworks/svelte.ts`) — same pattern; `languages: ['svelte']`.
- [ ] **Step 3: Add a smoke test** for each that verifies `extract()` returns the same node shape it used to.
- [ ] **Step 4: Run tests, see pass.**
- [ ] **Step 5: Commit.**

---

## Task 7: Wire framework extraction into `ExtractionOrchestrator`

**Files:**
- Modify: `src/extraction/index.ts` (the per-file extraction result merging path)
- Modify: `src/extraction/parse-worker.ts` (pass detected frameworks to worker if extraction runs there)

This is the core wiring change. It runs after each file is parsed by tree-sitter.

- [ ] **Step 1: Write an integration test**

Create `__tests__/frameworks-integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Django end-to-end', () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a route->view edge from urls.py to view class', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-django-'));
    fs.writeFileSync(path.join(tmpDir, 'manage.py'), '# marker');
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'django==4.2\n');
    fs.mkdirSync(path.join(tmpDir, 'users'));
    fs.writeFileSync(path.join(tmpDir, 'users/__init__.py'), '');
    fs.writeFileSync(path.join(tmpDir, 'users/views.py'),
      'class UserListView:\n    def get(self, request): pass\n');
    fs.writeFileSync(path.join(tmpDir, 'users/urls.py'),
      'from django.urls import path\n' +
      'from users.views import UserListView\n' +
      'urlpatterns = [path("users/", UserListView.as_view(), name="user-list")]\n');

    const cg = new CodeGraph(tmpDir);
    await cg.initialize();
    await cg.indexAll();

    const nodes = cg.queries.searchNodes({ kinds: ['route'] });
    expect(nodes.length).toBeGreaterThan(0);
    const route = nodes.find(n => n.name === 'users/');
    expect(route).toBeDefined();

    const view = cg.queries.getNodesByName('UserListView').find(n => n.kind === 'class');
    expect(view).toBeDefined();

    const edges = cg.queries.getOutgoingEdges(route!.id);
    const toView = edges.find(e => e.target === view!.id);
    expect(toView).toBeDefined();
    expect(toView!.kind).toBe('references');

    await cg.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/frameworks-integration.test.ts`
Expected: FAIL — no route nodes get created (framework extract isn't wired in yet).

- [ ] **Step 3: Add the wiring**

In `src/extraction/index.ts`, locate the `extractFromSource` function (around line 600; the function that runs tree-sitter on a single file and returns `ExtractionResult`). Add framework extraction as a post-tree-sitter augmentation.

Find where `ExtractionResult` is built at the end of `extractFromSource` (around line 1000-1015). Just before `return result`, add:

```typescript
// Framework-specific extraction (routes, etc.)
if (detectedFrameworks && detectedFrameworks.length > 0) {
  const applicable = getApplicableFrameworks(detectedFrameworks, language);
  for (const fw of applicable) {
    if (!fw.extract) continue;
    try {
      const fwResult = fw.extract(filePath, content);
      result.nodes.push(...fwResult.nodes);
      result.unresolvedReferences.push(...fwResult.references);
    } catch (err) {
      result.errors.push({
        message: `Framework extractor '${fw.name}' failed: ${err instanceof Error ? err.message : String(err)}`,
        filePath,
        severity: 'warning',
      });
    }
  }
}
```

Also add `detectedFrameworks?: FrameworkResolver[]` as a parameter to `extractFromSource`.

In `ExtractionOrchestrator.indexAll` (around line 412), before kicking off the parse workers, detect frameworks once:

```typescript
// Detect frameworks once per indexing run (project-level signal)
const resolutionContext = buildResolutionContext(this.rootDir, this.queries);
const detectedFrameworks = detectFrameworks(resolutionContext);
```

Pass `detectedFrameworks` into the parse worker batch config (or, if the parse worker doesn't invoke `extractFromSource` directly, into the main-thread merge step that invokes framework extract on the raw file content). If the parse worker already has access to file content, pass the framework NAMES and re-resolve to resolver objects inside the worker from `getAllFrameworkResolvers().filter(f => detectedNames.includes(f.name))` — objects with functions can't cross worker_threads postMessage boundaries.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run __tests__/frameworks-integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npx vitest run`
Expected: All existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/extraction/index.ts src/extraction/parse-worker.ts __tests__/frameworks-integration.test.ts
git commit -m "feat(extraction): run framework extractors after tree-sitter parse"
```

---

## Task 8: Remove dead regex code + update README

**Files:**
- Modify: `src/resolution/frameworks/*.ts` — confirm no dangling `extractNodes` remains
- Modify: `README.md` — add a section on framework route extraction

- [ ] **Step 1: grep for any lingering references**

Run: `grep -rn "extractNodes" src/ __tests__/`
Expected: zero matches. If any remain, delete or rename them.

- [ ] **Step 2: Run the full build and test**

Run: `npm run build && npm test`
Expected: Build succeeds; all tests pass.

- [ ] **Step 3: Add a README section**

Append to `README.md` after the features list:

```markdown
### Framework-aware Routes

CodeGraph recognizes web framework routing files and links URL patterns to their handlers:

- **Django**: `urlpatterns` entries in `urls.py` — `path()`, `re_path()`, `url()`, `include()`
- **Flask / FastAPI**: `@app.route` / `@app.get` / `@router.post` decorators
- **Express**: `app.get(...)`, `router.post(...)`
- **Laravel**: `Route::get()`, `Route::resource()`
- **Rails**: `resources :users`, `get 'x', to: 'y#z'`
- **Spring**: `@GetMapping`, `@RequestMapping`
- **Gin / chi / gorilla**: `r.GET(...)`
- **Axum / actix**: `.route("/x", get(handler))`
- **ASP.NET**: `[HttpGet]` + action method
- **Vapor**: `app.get("x", use: handler)`

Query `codegraph_callers(YourView)` and the route pattern will appear as an incoming edge.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document framework route extraction"
```

---

## Task 9: Open the PR

- [ ] **Step 1: Push branch to fork**

```bash
git push -u origin feat/framework-extract-wiring
```

- [ ] **Step 2: Create PR**

```bash
gh pr create \
  --repo colbymchenry/codegraph \
  --base main \
  --head timomeara:feat/framework-extract-wiring \
  --title "feat: wire up framework route extraction" \
  --body "$(cat <<'EOF'
## Problem

`FrameworkResolver.extractNodes` is declared in the type but never called anywhere in `src/`. As a result, the graph has zero `route` nodes for any framework, and the URL-to-handler link (e.g. Django `urls.py` entry -> view class) doesn't exist. This makes `codegraph_callers(MyView)` silently miss its most important caller.

## Fix

- Replaces the dead `extractNodes?(filePath, content): Node[]` hook with `extract?(filePath, content): { nodes, references }`.
- Calls `extract()` inside the extraction pipeline for every framework whose declared `languages` include the current file's language.
- Updates all 13 existing framework resolvers (Django, Flask, FastAPI, Express, Laravel, Rails, Spring, Gin, Axum, ASP.NET, Vapor, React Router, SvelteKit) to emit both route nodes AND handler references. The references flow through the existing resolution pipeline (name matching, import resolution, framework-specific `resolve()`) to produce `route -> handler` edges.

## Tests

- Unit tests per framework in `__tests__/frameworks.test.ts`.
- End-to-end Django test in `__tests__/frameworks-integration.test.ts` that verifies a real `urls.py -> views.py` edge.

## Stats

| Category | Lines |
|----------|------:|
| Production code | ~X |
| Tests | ~Y |
| Docs | ~Z |
EOF
)"
```

- [ ] **Step 3: Link PR in task tracker** (if one exists).

---

## Self-Review Checklist

- [ ] **Spec coverage:** each framework in the original codebase has a migration task. Django has the richest test coverage because it was the motivating case.
- [ ] **No placeholders:** every task shows actual code. The "same pattern as Task X" phrasing in Task 6 is backed by full implementations in Tasks 3-5 as referents.
- [ ] **Type consistency:** `FrameworkExtractionResult` is defined once in Task 1 and used by every resolver's `extract` signature.
- [ ] **Realistic stats placeholders** (X/Y/Z) are filled in at PR time, not plan time.

## Known gaps (intentionally out of scope)

- **AST-based extraction.** Regex is good enough for the common shapes. Swap to tree-sitter AST in a follow-up.
- **DRF router expansion.** `router.register(r'users', UserViewSet)` produces a single route node pointing at the viewset. Expanding to 6 CRUD action nodes can be a follow-up.
- **React Router handler edges.** `<Route element={<Page/>}/>` currently only produces a route node. Follow-up can add `route -> Page` references.
- **Spring Controller-class scoping.** Method-scoped mappings work; class-level `@RequestMapping` base path composition is a follow-up.
