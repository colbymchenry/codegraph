# QML Follow-up Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the documented QML follow-up scope while keeping every new relationship on CodeGraph's normal extraction, unresolved-reference, resolver, persisted-edge, and MCP/query path.

**Architecture:** Add Qt/QML-specific cross-file behavior as a normal framework resolver under `src/resolution/frameworks/qml-qt.ts`, plus small QML extractor additions only where new unresolved references must be emitted. The resolver consumes indexed files and existing graph symbols, returns normal `ResolvedRef` objects, and is registered through the existing framework registry.

**Tech Stack:** TypeScript, Vitest, existing `LanguageExtractor`, existing `FrameworkResolver`, existing `references` / `calls` / `imports` edge kinds, QML tree-sitter extraction, C++ tree-sitter extraction.

---

## File Structure

- Create: `src/resolution/frameworks/qml-qt.ts`
  - Owns QML module registry parsing, literal dynamic QML target resolution, and C++/QML bridge registry/resolution.
  - Exports `qmlQtResolver: FrameworkResolver`.
  - Uses only `ResolutionContext`, `Node`, `UnresolvedRef`, and `ResolvedRef`.
- Modify: `src/resolution/frameworks/index.ts`
  - Imports and registers `qmlQtResolver`.
  - Re-exports it with the other framework resolvers.
- Modify: `src/extraction/languages/qml.ts`
  - Emits unresolved `references` for alias-qualified component types already visible in QML syntax.
  - Emits unresolved `references` for literal local dynamic QML URLs only where extraction can prove the syntax is a QML component load.
- Modify: `__tests__/qml-integration.test.ts`
  - Adds end-to-end fixtures for `qmldir`, dynamic loading, and C++/QML bridge behavior.
- Modify: `docs/superpowers/specs/2026-06-09-qt-quick-design.md`
  - Aligns first-version status with the already-landed QML-side closure and the remaining follow-up phases.
- Modify: `docs/superpowers/plans/2026-06-19-qml-follow-up-tasks.md`
  - Records which QML-side gaps are closed and which follow-up phases remain.
- Modify: `CHANGELOG.md`
  - Adds a final `[Unreleased]` entry after implementation and validation.

Do not modify files under `test-qml-project/`.

## Task 1: Documentation Baseline

**Files:**
- Modify: `docs/superpowers/specs/2026-06-09-qt-quick-design.md`
- Modify: `docs/superpowers/plans/2026-06-19-qml-follow-up-tasks.md`

- [ ] **Step 1: Update the QML design status paragraph**

Replace the current implementation status in `docs/superpowers/specs/2026-06-09-qt-quick-design.md` with:

```markdown
**Implementation status:** QML-internal graph generation and QML-side closure are implemented. The extractor covers component trees, ids, properties, signals, functions, handlers, imports, embedded JavaScript static references, nested handler bodies, object-literal callbacks, function-valued callbacks, directory-local component references, and false-positive suppression for broad cross-file property/name matches. `qmldir` module registry resolution, statically safe dynamic QML loading, C++/QML bridge resolution, and release notes remain follow-up work.
```

- [ ] **Step 2: Update the follow-up task context**

In `docs/superpowers/plans/2026-06-19-qml-follow-up-tasks.md`, replace the opening context paragraph with:

```markdown
The first QML graph generation version and the QML-side closure pass are implemented. The current remaining follow-up scope is documentation hygiene, read-only real-project validation, `qmldir` module/import scope, statically safe dynamic QML loading, C++/QML bridge resolution, and release notes.
```

- [ ] **Step 3: Run a documentation diff check**

Run:

```bash
git diff -- docs/superpowers/specs/2026-06-09-qt-quick-design.md docs/superpowers/plans/2026-06-19-qml-follow-up-tasks.md
```

Expected: diff mentions completed QML-side closure and still-open `qmldir`, dynamic loading, bridge, validation, and release-note phases. It must not claim complete Qt runtime or C++ meta-object closure.

- [ ] **Step 4: Commit the documentation baseline**

Run:

```bash
git add docs/superpowers/specs/2026-06-09-qt-quick-design.md docs/superpowers/plans/2026-06-19-qml-follow-up-tasks.md
git commit -m "docs(qml): clarify follow-up closure scope"
```

Expected: commit succeeds and includes only the two documentation files.

## Task 2: Read-only Validation Baseline

**Files:**
- Modify: `docs/superpowers/plans/2026-06-19-qml-follow-up-tasks.md`

- [ ] **Step 1: Build the local CLI**

Run:

```bash
npm run build
```

Expected: build passes and `dist/bin/codegraph.js` exists.

- [ ] **Step 2: Create a temporary validation copy outside `test-qml-project/`**

Run in PowerShell:

```powershell
$src = "test-qml-project/unifiedpromax/src/components/general/video_download_component"
$dst = Join-Path $env:TEMP "codegraph-qml-video-download-validation"
Remove-Item -Recurse -Force $dst -ErrorAction SilentlyContinue
Copy-Item -Recurse $src $dst
```

Expected: `$dst` exists and `git status --short test-qml-project` shows no tracked modifications.

- [ ] **Step 3: Index the temporary validation copy**

Run:

```powershell
Push-Location $env:TEMP\codegraph-qml-video-download-validation
node E:\AICode\codegraph\dist\bin\codegraph.js init
node E:\AICode\codegraph\dist\bin\codegraph.js index -f
node E:\AICode\codegraph\dist\bin\codegraph.js status --json
Pop-Location
```

Expected: indexing completes. Record indexed file counts, QML file counts, and any status errors in the follow-up document.

- [ ] **Step 4: Add a validation-baseline note**

Append this section to `docs/superpowers/plans/2026-06-19-qml-follow-up-tasks.md`. Use the concrete values printed by `status --json` in Step 3; do not commit sample labels or blank values.

````markdown
## Validation Baseline: Follow-up Closure

Validation was rerun against a temporary copy of:

```text
test-qml-project/unifiedpromax/src/components/general/video_download_component
```

The source directory was not modified or staged.

- Indexed files: write the concrete indexed file count from `status --json`
- QML files: write the concrete QML file count from `status --json` or the validation query output
- Status errors: write `none` when the status output has no errors; otherwise paste the concrete error names/messages
- Current expected remaining gaps:
  - `qmldir` module imports are not yet resolved to concrete component definitions.
  - Literal dynamic QML loading is not yet connected.
  - C++/QML bridge facts are not yet modeled from Qt registration, context properties, `Q_PROPERTY`, `Q_INVOKABLE`, slots, or signals.
```
````

- [ ] **Step 5: Commit the validation baseline**

Run:

```bash
git add docs/superpowers/plans/2026-06-19-qml-follow-up-tasks.md
git commit -m "docs(qml): record follow-up validation baseline"
```

Expected: commit includes only the follow-up task document. No files under `test-qml-project/` are staged.

## Task 3: QML Qt Framework Resolver Skeleton

**Files:**
- Create: `src/resolution/frameworks/qml-qt.ts`
- Modify: `src/resolution/frameworks/index.ts`
- Test: `__tests__/qml-integration.test.ts`

- [ ] **Step 1: Write a failing smoke test for framework resolver registration**

Add this test near the end of `describe('QML end-to-end graph support', ...)` in `__tests__/qml-integration.test.ts`:

```typescript
  it('uses the QML Qt framework resolver for QML-specific cross-file references', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick

Item {
  id: root
}
`
    );

    const graph = cg!;
    await graph.indexAll();

    expect(graph.getDetectedFrameworks()).toContain('qml-qt');
  });
```

- [ ] **Step 2: Run the red test**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts -t "QML Qt framework resolver"
```

Expected: FAIL because no `qml-qt` framework resolver is registered.

- [ ] **Step 3: Create the resolver skeleton**

Create `src/resolution/frameworks/qml-qt.ts`:

```typescript
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';

function hasQmlFiles(context: ResolutionContext): boolean {
  return context.getAllFiles().some((filePath) => filePath.endsWith('.qml'));
}

export const qmlQtResolver: FrameworkResolver = {
  name: 'qml-qt',
  languages: ['qml'],
  detect(context: ResolutionContext): boolean {
    return hasQmlFiles(context);
  },
  claimsReference(_name: string): boolean {
    return false;
  },
  resolve(_ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
    return null;
  },
};
```

- [ ] **Step 4: Register and export the resolver**

In `src/resolution/frameworks/index.ts`, add:

```typescript
import { qmlQtResolver } from './qml-qt';
```

Add `qmlQtResolver` to `FRAMEWORK_RESOLVERS` after `fabricViewResolver`:

```typescript
  qmlQtResolver,
```

Add the re-export:

```typescript
export { qmlQtResolver } from './qml-qt';
```

- [ ] **Step 5: Run the green smoke test**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts -t "QML Qt framework resolver"
```

Expected: PASS.

- [ ] **Step 6: Commit the resolver skeleton**

Run:

```bash
git add __tests__/qml-integration.test.ts src/resolution/frameworks/qml-qt.ts src/resolution/frameworks/index.ts
git commit -m "feat(qml): add Qt framework resolver skeleton"
```

Expected: commit contains the skeleton and registration only.

## Task 4: QML Module and `qmldir` Import Scope

**Files:**
- Modify: `__tests__/qml-integration.test.ts`
- Modify: `src/extraction/languages/qml.ts`
- Modify: `src/resolution/frameworks/qml-qt.ts`

- [ ] **Step 1: Write the failing `qmldir` regression test**

Add this test to `__tests__/qml-integration.test.ts`:

```typescript
  it('resolves qmldir module imports without broad built-in or internal matches', async () => {
    fs.mkdirSync(path.join(tmpDir, 'Controls'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import My.Controls 1.0
import My.Controls 1.0 as Controls

Item {
  FancyButton { id: plainFancy }
  Controls.FancyButton { id: aliasFancy }
  HiddenButton { id: hiddenButton }
  Text { id: builtInText }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module My.Controls
FancyButton 1.0 FancyButton.qml
Text 1.0 Text.qml
internal HiddenButton HiddenButton.qml
`
    );
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'FancyButton.qml'), 'import QtQuick\nRectangle { id: fancyRoot }\n');
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'HiddenButton.qml'), 'import QtQuick\nItem { id: hiddenRoot }\n');
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'Text.qml'), 'import QtQuick\nItem { id: customText }\n');

    const graph = cg!;
    await graph.indexAll();

    const fancyDefinition = graph.getNodesByName('FancyButton').find((n) => n.kind === 'component' && n.filePath === 'Controls/FancyButton.qml');
    const plainFancy = graph.getNodesByName('plainFancy').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const aliasFancy = graph.getNodesByName('aliasFancy').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const hiddenDefinition = graph.getNodesByName('HiddenButton').find((n) => n.kind === 'component' && n.filePath === 'Controls/HiddenButton.qml');
    const hiddenButton = graph.getNodesByName('hiddenButton').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const customText = graph.getNodesByName('Text').find((n) => n.kind === 'component' && n.filePath === 'Controls/Text.qml');
    const builtInText = graph.getNodesByName('builtInText').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');

    expect(fancyDefinition).toBeDefined();
    expect(plainFancy).toBeDefined();
    expect(aliasFancy).toBeDefined();
    expect(hiddenDefinition).toBeDefined();
    expect(hiddenButton).toBeDefined();
    expect(customText).toBeDefined();
    expect(builtInText).toBeDefined();

    expect(graph.getOutgoingEdges(plainFancy!.id).some((edge) => edge.kind === 'references' && edge.target === fancyDefinition!.id)).toBe(true);
    expect(graph.getOutgoingEdges(aliasFancy!.id).some((edge) => edge.kind === 'references' && edge.target === fancyDefinition!.id)).toBe(true);
    expect(graph.getOutgoingEdges(hiddenButton!.id).some((edge) => edge.kind === 'references' && edge.target === hiddenDefinition!.id)).toBe(false);
    expect(graph.getOutgoingEdges(builtInText!.id).some((edge) => edge.kind === 'references' && edge.target === customText!.id)).toBe(false);
  });
```

- [ ] **Step 2: Run the red test**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts -t "resolves qmldir"
```

Expected: FAIL because `plainFancy` and `aliasFancy` do not reference `Controls/FancyButton.qml`.

- [ ] **Step 3: Emit alias-qualified component references from QML extraction**

In `src/extraction/languages/qml.ts`, update `shouldReferenceComponentType()` so alias-qualified component names are emitted:

```typescript
function shouldReferenceComponentType(typeName: string): boolean {
  if (inlineComponentNames.has(typeName)) return true;
  const leafName = typeName.split('.').pop() ?? typeName;
  if (inlineComponentNames.has(leafName)) return true;
  return (
    /^[A-Za-z_][A-Za-z0-9_]*\.[A-Z][A-Za-z0-9_]*$/.test(typeName) ||
    (/^[A-Z][A-Za-z0-9_]*$/.test(typeName) &&
      !QML_BUILTIN_COMPONENT_TYPES.has(typeName))
  );
}
```

- [ ] **Step 4: Add module parsing helpers to `qml-qt.ts`**

Add these types and helpers above `qmlQtResolver`:

```typescript
import * as path from 'path';
import type { Node } from '../../types';

interface QmlDirComponent {
  name: string;
  version?: string;
  filePath: string;
  internal: boolean;
}

interface QmlDirModule {
  uri: string;
  dir: string;
  components: QmlDirComponent[];
}

interface QmlModuleImport {
  uri: string;
  version?: string;
  alias?: string;
}

const moduleCache = new WeakMap<ResolutionContext, QmlDirModule[]>();
const importCache = new WeakMap<ResolutionContext, Map<string, QmlModuleImport[]>>();

function dirname(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(0, slash) : '';
}

function parseQmlImports(context: ResolutionContext, filePath: string): QmlModuleImport[] {
  let perContext = importCache.get(context);
  if (!perContext) {
    perContext = new Map();
    importCache.set(context, perContext);
  }
  const cached = perContext.get(filePath);
  if (cached) return cached;

  const source = context.readFile(filePath);
  if (!source) {
    perContext.set(filePath, []);
    return [];
  }

  const imports: QmlModuleImport[] = [];
  const re = /^\s*import\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*(\d+(?:\.\d+)?)?\s*(?:as\s+([A-Za-z_][A-Za-z0-9_]*))?/gm;
  for (const match of source.matchAll(re)) {
    const uri = match[1];
    if (!uri) continue;
    imports.push({ uri, version: match[2], alias: match[3] });
  }

  perContext.set(filePath, imports);
  return imports;
}

function parseQmlDir(filePath: string, source: string): QmlDirModule | null {
  const dir = dirname(filePath);
  let uri: string | null = null;
  const components: QmlDirComponent[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    if (tokens[0] === 'module' && tokens[1]) {
      uri = tokens[1];
      continue;
    }

    const internal = tokens[0] === 'internal';
    const singleton = tokens[0] === 'singleton';
    const nameIndex = internal || singleton ? 1 : 0;
    const name = tokens[nameIndex];
    const version = tokens[nameIndex + 1] && /^\d+(?:\.\d+)?$/.test(tokens[nameIndex + 1]!) ? tokens[nameIndex + 1] : undefined;
    const qmlFileIndex = tokens.findIndex((token) => /\.qml$/i.test(token));
    if (!name || qmlFileIndex < 0 || !/^[A-Z][A-Za-z0-9_]*$/.test(name)) continue;
    const target = path.posix.normalize(dir ? `${dir}/${tokens[qmlFileIndex]}` : tokens[qmlFileIndex]!);
    components.push({ name, version, filePath: target, internal });
  }

  return uri && components.length > 0 ? { uri, dir, components } : null;
}

function getQmlDirModules(context: ResolutionContext): QmlDirModule[] {
  const cached = moduleCache.get(context);
  if (cached) return cached;

  const dirs = new Set<string>();
  for (const filePath of context.getAllFiles()) {
    if (filePath.endsWith('.qml')) dirs.add(dirname(filePath));
  }

  const modules: QmlDirModule[] = [];
  for (const dir of dirs) {
    const qmlDirPath = dir ? `${dir}/qmldir` : 'qmldir';
    const source = context.readFile(qmlDirPath);
    if (!source) continue;
    const parsed = parseQmlDir(qmlDirPath, source);
    if (parsed) modules.push(parsed);
  }

  moduleCache.set(context, modules);
  return modules;
}

function componentTypeName(referenceName: string): string | null {
  const typeName = referenceName.split('.').pop() ?? referenceName;
  return /^[A-Z][A-Za-z0-9_]*$/.test(typeName) ? typeName : null;
}

function pickVersionedComponent(
  components: QmlDirComponent[],
  importVersion: string | undefined
): QmlDirComponent | null {
  const publicComponents = components.filter((component) => !component.internal);
  if (publicComponents.length === 0) return null;
  if (publicComponents.length === 1) return publicComponents[0]!;
  if (!importVersion) return null;
  return publicComponents.find((component) => component.version === importVersion) ?? null;
}

function findQmlComponentNode(context: ResolutionContext, targetPath: string, name: string): Node | null {
  return (
    context
      .getNodesByName(name)
      .find(
        (node) =>
          node.language === 'qml' &&
          node.kind === 'component' &&
          node.filePath.replace(/\\/g, '/') === targetPath &&
          node.qualifiedName === node.name
      ) ?? null
  );
}

function resolveQmlModuleComponent(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.language !== 'qml' || ref.referenceKind !== 'references') return null;
  const componentName = componentTypeName(ref.referenceName);
  if (!componentName) return null;

  const parts = ref.referenceName.split('.');
  const alias = parts.length > 1 ? parts[0] : undefined;
  const imports = parseQmlImports(context, ref.filePath);

  for (const imported of imports) {
    if (alias && imported.alias !== alias) continue;
    if (!alias && imported.alias) continue;
    const module = getQmlDirModules(context).find((candidate) => candidate.uri === imported.uri);
    if (!module) continue;
    const component = pickVersionedComponent(
      module.components.filter((candidate) => candidate.name === componentName),
      imported.version
    );
    if (!component) continue;
    const target = findQmlComponentNode(context, component.filePath, componentName);
    if (!target) continue;
    return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'import' };
  }

  return null;
}
```

- [ ] **Step 5: Wire module resolution into `qmlQtResolver`**

Update `claimsReference()` and `resolve()` in `qml-qt.ts`:

```typescript
  claimsReference(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*\.[A-Z][A-Za-z0-9_]*$/.test(name);
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    return resolveQmlModuleComponent(ref, context);
  },
```

- [ ] **Step 6: Run the green `qmldir` test**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts -t "resolves qmldir"
```

Expected: PASS.

- [ ] **Step 7: Commit module/import scope**

Run:

```bash
git add __tests__/qml-integration.test.ts src/extraction/languages/qml.ts src/resolution/frameworks/qml-qt.ts
git commit -m "feat(qml): resolve qmldir module imports"
```

Expected: commit contains only module/import scope behavior and tests.

## Task 5: Literal Dynamic QML Loading

**Files:**
- Modify: `__tests__/qml-integration.test.ts`
- Modify: `src/extraction/languages/qml.ts`
- Modify: `src/resolution/frameworks/qml-qt.ts`

- [ ] **Step 1: Write the failing dynamic-loading test**

Add this test to `__tests__/qml-integration.test.ts`:

```typescript
  it('resolves dynamic QML loading only for literal local component URLs', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick

Item {
  id: root
  property string panelName: "Panel"

  Loader {
    id: literalLoader
    source: "LazyPanel.qml"
  }

  Loader {
    id: dynamicLoader
    source: "Lazy" + root.panelName + ".qml"
  }

  Image {
    id: imageSource
    source: "LazyPanel.qml"
  }

  Component.onCompleted: {
    Qt.createComponent("LazyPanel.qml")
  }
}
`
    );
    fs.writeFileSync(path.join(tmpDir, 'LazyPanel.qml'), 'import QtQuick\nRectangle { id: lazyRoot }\n');

    const graph = cg!;
    await graph.indexAll();

    const lazyPanel = graph.getNodesByName('LazyPanel').find((n) => n.kind === 'component' && n.filePath === 'LazyPanel.qml');
    const literalLoader = graph.getNodesByName('literalLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const dynamicLoader = graph.getNodesByName('dynamicLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const imageSource = graph.getNodesByName('imageSource').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const onCompleted = graph.getNodesByName('Component.onCompleted').find((n) => n.kind === 'method' && n.filePath === 'Main.qml');

    expect(lazyPanel).toBeDefined();
    expect(literalLoader).toBeDefined();
    expect(dynamicLoader).toBeDefined();
    expect(imageSource).toBeDefined();
    expect(onCompleted).toBeDefined();

    expect(graph.getOutgoingEdges(literalLoader!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(true);
    expect(graph.getOutgoingEdges(onCompleted!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(true);
    expect(graph.getOutgoingEdges(dynamicLoader!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(false);
    expect(graph.getOutgoingEdges(imageSource!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(false);
  });
```

- [ ] **Step 2: Run the red dynamic-loading test**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts -t "dynamic QML loading"
```

Expected: FAIL because literal loader and `Qt.createComponent` targets do not resolve.

- [ ] **Step 3: Add literal URL extraction helpers**

In `src/extraction/languages/qml.ts`, add:

```typescript
function literalQmlUrl(node: SyntaxNode | null, source: string): string | null {
  const unwrapped = unwrapExpressionStatement(node);
  if (!unwrapped) return null;
  const text = getNodeText(unwrapped, source).trim();
  const match = /^['"]([^'"]+\.qml)['"]$/.exec(text);
  return match?.[1] ?? null;
}

function currentQmlComponentType(ctx: ExtractorContext): string | null {
  const currentNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!currentNodeId) return null;
  const currentNode = ctx.nodes.find((node) => node.id === currentNodeId);
  if (!currentNode || currentNode.kind !== 'component') return null;
  const typeName = currentNode.signature?.trim().split(/\s+/)[0] ?? null;
  return typeName?.split('.').pop() ?? null;
}
```

- [ ] **Step 4: Emit literal URL references from `Qt.createComponent`**

Inside `scanStaticReferences()` in `src/extraction/languages/qml.ts`, before `addStaticReference(calleeName, 'calls', ...)`, add:

```typescript
    if (calleeName === 'Qt.createComponent') {
      const argsNode = getChildByField(node, 'arguments');
      const firstArg = argsNode?.namedChildren[0] ?? null;
      const qmlUrl = literalQmlUrl(firstArg, ctx.source);
      const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
      if (qmlUrl && fromNodeId) {
        addReferenceFromNode(ctx, fromNodeId, qmlUrl, firstArg ?? node);
      }
    }
```

- [ ] **Step 5: Emit literal URL references from `Loader.source`**

Inside `visitQmlBinding()` in `src/extraction/languages/qml.ts`, before handler handling, add:

```typescript
  if (name === 'source' && currentQmlComponentType(ctx) === 'Loader') {
    const qmlUrl = literalQmlUrl(valueNode, ctx.source);
    const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
    if (qmlUrl && fromNodeId && valueNode) {
      addReferenceFromNode(ctx, fromNodeId, qmlUrl, valueNode);
    }
    if (valueNode) {
      addStaticReferences(valueNode, ctx);
    }
    return false;
  }
```

- [ ] **Step 6: Add literal URL resolution to `qml-qt.ts`**

Add this helper to `src/resolution/frameworks/qml-qt.ts`:

```typescript
function resolveLiteralQmlUrl(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.language !== 'qml' || ref.referenceKind !== 'references' || !/\.qml$/i.test(ref.referenceName)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref.referenceName) || path.isAbsolute(ref.referenceName)) return null;

  const fromDir = dirname(ref.filePath);
  const targetPath = path.posix.normalize(fromDir ? `${fromDir}/${ref.referenceName}` : ref.referenceName);
  const componentName = targetPath.split('/').pop()!.replace(/\.qml$/i, '');
  const target = findQmlComponentNode(context, targetPath, componentName);
  if (!target) return null;
  return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'file-path' };
}
```

Update `resolve()`:

```typescript
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    return resolveLiteralQmlUrl(ref, context) ?? resolveQmlModuleComponent(ref, context);
  },
```

- [ ] **Step 7: Run the green dynamic-loading test**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts -t "dynamic QML loading"
```

Expected: PASS.

- [ ] **Step 8: Commit dynamic loading**

Run:

```bash
git add __tests__/qml-integration.test.ts src/extraction/languages/qml.ts src/resolution/frameworks/qml-qt.ts
git commit -m "feat(qml): resolve literal dynamic component loads"
```

Expected: commit contains dynamic loading behavior and tests only.

## Task 6: C++/QML Bridge Registry

**Files:**
- Modify: `src/resolution/frameworks/qml-qt.ts`
- Test: `__tests__/qml-integration.test.ts`

- [ ] **Step 1: Write the failing bridge test**

Add this test to `__tests__/qml-integration.test.ts`:

```typescript
  it('resolves C++/QML bridge methods, properties, signals, and registered types conservatively', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main.cpp'),
      `#include <QQmlApplicationEngine>
#include <QQmlContext>

class ViewModel : public QObject {
  Q_OBJECT
  Q_PROPERTY(QString title READ title NOTIFY titleChanged)
public:
  Q_INVOKABLE void refresh();
  QString title() const;
public slots:
  void save();
signals:
  void titleChanged();
};

class OtherModel : public QObject {
  Q_OBJECT
public:
  Q_INVOKABLE void refresh();
};

class MyButton : public QObject { Q_OBJECT };

class ThemeApi : public QObject {
  Q_OBJECT
  Q_PROPERTY(QString accent READ accent NOTIFY accentChanged)
public:
  Q_INVOKABLE void color();
  QString accent() const;
signals:
  void accentChanged();
};

void ViewModel::refresh() {}
void ViewModel::save() {}
QString ViewModel::title() const { return QString(); }
void OtherModel::refresh() {}
void ThemeApi::color() {}
QString ThemeApi::accent() const { return QString(); }

int main() {
  QQmlApplicationEngine engine;
  ViewModel viewModel;
  engine.rootContext()->setContextProperty("viewModel", &viewModel);
  qmlRegisterType<MyButton>("My.App", 1, 0, "MyButton");
  qmlRegisterSingletonType<ThemeApi>("My.App", 1, 0, "ThemeApi", nullptr);
  qmlRegisterUncreatableType<OtherModel>("My.App", 1, 0, "OtherModel", "factory only");
  return 0;
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import My.App 1.0

Item {
  id: root
  property string label: viewModel.title
  property string accent: ThemeApi.accent
  Component.onCompleted: {
    viewModel.refresh()
    viewModel.save()
    ThemeApi.color()
  }
  Connections {
    target: viewModel
    function onTitleChanged() {
      viewModel.refresh()
    }
  }
  MyButton { id: registeredButton }
  OtherModel { id: invalidOtherModelInstance }
}
`
    );

    const graph = cg!;
    await graph.indexAll();

    const onCompleted = graph.getNodesByName('Component.onCompleted').find((n) => n.kind === 'method' && n.filePath === 'Main.qml');
    const onTitleChanged = graph.getNodesByName('onTitleChanged').find((n) => n.kind === 'method' && n.filePath === 'Main.qml');
    const registeredButton = graph.getNodesByName('registeredButton').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const invalidOtherModelInstance = graph.getNodesByName('invalidOtherModelInstance').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const viewModelRefresh = graph.getNodesByName('refresh').find((n) => n.qualifiedName === 'ViewModel::refresh');
    const otherRefresh = graph.getNodesByName('refresh').find((n) => n.qualifiedName === 'OtherModel::refresh');
    const viewModelSave = graph.getNodesByName('save').find((n) => n.qualifiedName === 'ViewModel::save');
    const themeColor = graph.getNodesByName('color').find((n) => n.qualifiedName === 'ThemeApi::color');
    const myButton = graph.getNodesByName('MyButton').find((n) => n.kind === 'class' && n.filePath === 'main.cpp');
    const otherModel = graph.getNodesByName('OtherModel').find((n) => n.kind === 'class' && n.filePath === 'main.cpp');

    expect(onCompleted).toBeDefined();
    expect(onTitleChanged).toBeDefined();
    expect(registeredButton).toBeDefined();
    expect(invalidOtherModelInstance).toBeDefined();
    expect(viewModelRefresh).toBeDefined();
    expect(otherRefresh).toBeDefined();
    expect(viewModelSave).toBeDefined();
    expect(themeColor).toBeDefined();
    expect(myButton).toBeDefined();
    expect(otherModel).toBeDefined();

    const completedEdges = graph.getOutgoingEdges(onCompleted!.id);
    expect(completedEdges.some((edge) => edge.kind === 'calls' && edge.target === viewModelRefresh!.id)).toBe(true);
    expect(completedEdges.some((edge) => edge.kind === 'calls' && edge.target === otherRefresh!.id)).toBe(false);
    expect(completedEdges.some((edge) => edge.kind === 'calls' && edge.target === viewModelSave!.id)).toBe(true);
    expect(completedEdges.some((edge) => edge.kind === 'calls' && edge.target === themeColor!.id)).toBe(true);
    expect(graph.getOutgoingEdges(onTitleChanged!.id).some((edge) => edge.kind === 'calls' && edge.target === viewModelRefresh!.id)).toBe(true);
    expect(graph.getOutgoingEdges(registeredButton!.id).some((edge) => edge.kind === 'references' && edge.target === myButton!.id)).toBe(true);
    expect(graph.getOutgoingEdges(invalidOtherModelInstance!.id).some((edge) => edge.kind === 'references' && edge.target === otherModel!.id)).toBe(false);
  });
```

- [ ] **Step 2: Run the red bridge test**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts -t "C\\+\\+/QML bridge"
```

Expected: FAIL because bridge metadata is not modeled.

- [ ] **Step 3: Add bridge registry types**

In `src/resolution/frameworks/qml-qt.ts`, add:

```typescript
interface QtClassExposure {
  className: string;
  hasMetaObjectEvidence: boolean;
  invokableMethods: Set<string>;
  publicSlots: Set<string>;
  properties: Map<string, { notifySignal?: string }>;
  signals: Set<string>;
}

interface QtContextProperty {
  qmlName: string;
  className: string;
}

interface QtRegisteredType {
  uri: string;
  version?: string;
  qmlName: string;
  className: string;
  singleton: boolean;
  uncreatable: boolean;
}

interface QtBridgeRegistry {
  classes: Map<string, QtClassExposure>;
  contextProperties: QtContextProperty[];
  registeredTypes: QtRegisteredType[];
}

const bridgeCache = new WeakMap<ResolutionContext, QtBridgeRegistry>();
```

- [ ] **Step 4: Add C++ bridge scanners**

Add these helpers to `qml-qt.ts`:

```typescript
function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function getOrCreateClassExposure(classes: Map<string, QtClassExposure>, className: string): QtClassExposure {
  let exposure = classes.get(className);
  if (!exposure) {
    exposure = {
      className,
      hasMetaObjectEvidence: false,
      invokableMethods: new Set(),
      publicSlots: new Set(),
      properties: new Map(),
      signals: new Set(),
    };
    classes.set(className, exposure);
  }
  return exposure;
}

function classBodies(source: string): Array<{ className: string; body: string }> {
  const results: Array<{ className: string; body: string }> = [];
  const classRe = /class\s+([A-Za-z_][A-Za-z0-9_:]*)[^{;]*\{/g;
  let match: RegExpExecArray | null;
  while ((match = classRe.exec(source)) !== null) {
    const className = match[1];
    if (!className) continue;
    let depth = 1;
    let i = classRe.lastIndex;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (depth === 0) break;
    }
    results.push({ className, body: source.slice(classRe.lastIndex, i) });
  }
  return results;
}

function parseClassExposure(source: string, classes: Map<string, QtClassExposure>): void {
  for (const cls of classBodies(source)) {
    const exposure = getOrCreateClassExposure(classes, cls.className);
    if (/\bQ_OBJECT\b/.test(cls.body) || /\bQ_GADGET\b/.test(cls.body)) exposure.hasMetaObjectEvidence = true;

    const propertyRe = /Q_PROPERTY\s*\(\s*[^)]+?\s+([A-Za-z_][A-Za-z0-9_]*)\b([^)]*)\)/g;
    let propertyMatch: RegExpExecArray | null;
    while ((propertyMatch = propertyRe.exec(cls.body)) !== null) {
      const propertyName = propertyMatch[1];
      const tail = propertyMatch[2] ?? '';
      if (!propertyName) continue;
      const notifySignal = tail.match(/\bNOTIFY\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
      exposure.properties.set(propertyName, { notifySignal });
      exposure.hasMetaObjectEvidence = true;
    }

    const invokableRe = /Q_INVOKABLE\s+[^;{()]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    let invokableMatch: RegExpExecArray | null;
    while ((invokableMatch = invokableRe.exec(cls.body)) !== null) {
      if (invokableMatch[1]) exposure.invokableMethods.add(invokableMatch[1]);
      exposure.hasMetaObjectEvidence = true;
    }

    const publicSlots = cls.body.match(/public\s+slots\s*:\s*([\s\S]*?)(?:private\s+slots\s*:|protected\s+slots\s*:|signals\s*:|public\s*:|protected\s*:|private\s*:|$)/)?.[1] ?? '';
    for (const slotMatch of publicSlots.matchAll(/\b[A-Za-z_][A-Za-z0-9_:<>,\s*&]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      if (slotMatch[1]) exposure.publicSlots.add(slotMatch[1]);
    }
    if (publicSlots.trim()) exposure.hasMetaObjectEvidence = true;

    const signals = cls.body.match(/signals\s*:\s*([\s\S]*?)(?:public\s+slots\s*:|private\s+slots\s*:|protected\s+slots\s*:|public\s*:|protected\s*:|private\s*:|$)/)?.[1] ?? '';
    for (const signalMatch of signals.matchAll(/\b[A-Za-z_][A-Za-z0-9_:<>,\s*&]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      if (signalMatch[1]) exposure.signals.add(signalMatch[1]);
    }
    if (signals.trim()) exposure.hasMetaObjectEvidence = true;
  }
}
```

- [ ] **Step 5: Add registration and context-property scanners**

Add:

```typescript
function parseVariableTypes(source: string): Map<string, string> {
  const variableTypes = new Map<string, string>();
  for (const match of source.matchAll(/\b([A-Z][A-Za-z0-9_:]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:[;=({])/g)) {
    if (match[1] && match[2]) variableTypes.set(match[2], match[1]);
  }
  return variableTypes;
}

function parseBridgeRegistrations(
  source: string,
  variableTypes: Map<string, string>,
  contextProperties: QtContextProperty[],
  registeredTypes: QtRegisteredType[],
  classes: Map<string, QtClassExposure>
): void {
  for (const match of source.matchAll(/setContextProperty\s*\(\s*["']([^"']+)["']\s*,\s*&?([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const qmlName = match[1];
    const variableName = match[2];
    const className = variableName ? variableTypes.get(variableName) : undefined;
    if (!qmlName || !className) continue;
    contextProperties.push({ qmlName, className });
    getOrCreateClassExposure(classes, className).hasMetaObjectEvidence = true;
  }

  const registerRe = /qmlRegister(Type|SingletonType|UncreatableType)\s*<\s*([A-Za-z_][A-Za-z0-9_:]*)\s*>\s*\(\s*["']([^"']+)["']\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(registerRe)) {
    const kind = match[1];
    const className = match[2];
    const uri = match[3];
    const major = match[4];
    const minor = match[5];
    const qmlName = match[6];
    if (!kind || !className || !uri || !major || !minor || !qmlName) continue;
    registeredTypes.push({
      uri,
      version: `${major}.${minor}`,
      qmlName,
      className,
      singleton: kind === 'SingletonType',
      uncreatable: kind === 'UncreatableType',
    });
    getOrCreateClassExposure(classes, className).hasMetaObjectEvidence = true;
  }
}

function getBridgeRegistry(context: ResolutionContext): QtBridgeRegistry {
  const cached = bridgeCache.get(context);
  if (cached) return cached;

  const registry: QtBridgeRegistry = {
    classes: new Map(),
    contextProperties: [],
    registeredTypes: [],
  };

  for (const filePath of context.getAllFiles()) {
    if (!/\.(?:c|cc|cpp|cxx|h|hpp|hxx|hh)$/i.test(filePath)) continue;
    const source = context.readFile(filePath);
    if (!source) continue;
    parseClassExposure(source, registry.classes);
    parseBridgeRegistrations(
      source,
      parseVariableTypes(source),
      registry.contextProperties,
      registry.registeredTypes,
      registry.classes
    );
  }

  bridgeCache.set(context, registry);
  return registry;
}
```

- [ ] **Step 6: Add C++ target lookup helpers**

Add:

```typescript
function cppLeafName(className: string): string {
  return className.split('::').pop() ?? className;
}

function findCppClass(context: ResolutionContext, className: string): Node | null {
  const leaf = cppLeafName(className);
  return (
    context
      .getNodesByName(leaf)
      .find(
        (node) =>
          node.language === 'cpp' &&
          node.kind === 'class' &&
          (node.name === className || node.name === leaf || node.qualifiedName === className)
      ) ?? null
  );
}

function findCppMethod(context: ResolutionContext, className: string, methodName: string): Node | null {
  return (
    context
      .getNodesByName(methodName)
      .find((node) => {
        if (node.language !== 'cpp' || node.kind !== 'method') return false;
        const qualifiedName = node.qualifiedName ?? '';
        return qualifiedName === `${className}::${methodName}` || qualifiedName.endsWith(`::${className}::${methodName}`);
      }) ?? null
  );
}
```

- [ ] **Step 7: Add bridge resolution helpers**

Add:

```typescript
function visibleMethod(exposure: QtClassExposure | undefined, methodName: string): boolean {
  if (!exposure?.hasMetaObjectEvidence) return false;
  return exposure.invokableMethods.has(methodName) || exposure.publicSlots.has(methodName);
}

function findRegisteredType(
  ref: UnresolvedRef,
  context: ResolutionContext,
  singleton: boolean
): QtRegisteredType | null {
  const parts = ref.referenceName.split('.');
  const imports = parseQmlImports(context, ref.filePath);
  const registry = getBridgeRegistry(context);
  for (const imported of imports) {
    const qmlName = imported.alias ? parts[1] : parts[0];
    if (!qmlName) continue;
    if (imported.alias && parts[0] !== imported.alias) continue;
    const candidates = registry.registeredTypes.filter(
      (entry) => entry.uri === imported.uri && entry.qmlName === qmlName && entry.singleton === singleton
    );
    if (candidates.length === 1) return candidates[0]!;
    if (imported.version) {
      const versioned = candidates.find((entry) => entry.version === imported.version);
      if (versioned) return versioned;
    }
  }
  return null;
}

function resolveBridgeCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.language !== 'qml' || ref.referenceKind !== 'calls' || !ref.referenceName.includes('.')) return null;
  const parts = ref.referenceName.split('.');
  const rootName = parts[0];
  const methodName = parts[parts.length - 1];
  if (!rootName || !methodName) return null;
  const registry = getBridgeRegistry(context);

  const contextProperty = registry.contextProperties.find((entry) => entry.qmlName === rootName);
  if (contextProperty) {
    const exposure = registry.classes.get(contextProperty.className);
    if (visibleMethod(exposure, methodName)) {
      const target = findCppMethod(context, contextProperty.className, methodName);
      if (target) return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
    }
  }

  const singleton = findRegisteredType(ref, context, true);
  if (singleton) {
    const exposure = registry.classes.get(singleton.className);
    if (visibleMethod(exposure, methodName)) {
      const target = findCppMethod(context, singleton.className, methodName);
      if (target) return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
    }
  }

  return null;
}

function resolveRegisteredComponent(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.language !== 'qml' || ref.referenceKind !== 'references') return null;
  const registered = findRegisteredType(ref, context, false);
  if (!registered || registered.uncreatable) return null;
  const target = findCppClass(context, registered.className);
  if (!target) return null;
  return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
}
```

- [ ] **Step 8: Wire bridge resolution into `qmlQtResolver`**

Update `claimsReference()`:

```typescript
  claimsReference(name: string): boolean {
    return (
      /^[A-Za-z_][A-Za-z0-9_]*\.[A-Z][A-Za-z0-9_]*$/.test(name) ||
      /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    );
  },
```

Update `resolve()`:

```typescript
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    return (
      resolveLiteralQmlUrl(ref, context) ??
      resolveBridgeCall(ref, context) ??
      resolveRegisteredComponent(ref, context) ??
      resolveQmlModuleComponent(ref, context)
    );
  },
```

- [ ] **Step 9: Run the green bridge test**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts -t "C\\+\\+/QML bridge"
```

Expected: PASS for bridge calls, registered component references, uncreatable negative case, and same-name negative case.

- [ ] **Step 10: Commit bridge registry**

Run:

```bash
git add __tests__/qml-integration.test.ts src/resolution/frameworks/qml-qt.ts
git commit -m "feat(qml): resolve explicit Qt bridge facts"
```

Expected: commit contains bridge registry and bridge tests only.

## Task 7: Validation Rerun and Release Notes

**Files:**
- Modify: `docs/superpowers/plans/2026-06-19-qml-follow-up-tasks.md`
- Modify: `docs/superpowers/specs/2026-06-09-qt-quick-design.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run focused QML tests**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts __tests__/extraction.test.ts -t "QML|qml"
```

Expected: all selected QML tests pass.

- [ ] **Step 2: Run the build**

Run:

```bash
npm run build
```

Expected: build passes.

- [ ] **Step 3: Confirm validation project stayed untouched**

Run:

```bash
git diff --name-only -- test-qml-project
git status --short test-qml-project
```

Expected: first command prints nothing. Second command may show `?? test-qml-project/` if the directory is untracked, but no modified tracked files under it.

- [ ] **Step 4: Update follow-up task status**

In `docs/superpowers/plans/2026-06-19-qml-follow-up-tasks.md`, add a closure update:

```markdown
## Follow-up Closure Update

The follow-up closure implementation adds:

- `qmldir` and module import scope for explicit QML component resolution
- literal local dynamic QML loading for `Loader.source` and `Qt.createComponent`
- explicit Qt bridge fact resolution for registered types, registered singletons, uncreatable type references, context properties, `Q_INVOKABLE`, public slots with Qt exposure evidence, `Q_PROPERTY`, and signals

Still unsupported:

- runtime-built QML URLs
- runtime-computed Qt registration metadata
- full C++ overload resolution
- moc-generated code execution
- QML JavaScript helper alias function resolution
```

- [ ] **Step 5: Update original QML design status**

In `docs/superpowers/specs/2026-06-09-qt-quick-design.md`, replace the implementation status with:

```markdown
**Implementation status:** QML-internal graph generation, QML-side closure, `qmldir` module import scope, literal local dynamic loading, and explicit Qt bridge fact resolution are implemented. Runtime-built URLs, runtime-computed Qt registration metadata, full C++ overload resolution, moc-generated code execution, and QML JavaScript helper alias function resolution remain unsupported.
```

- [ ] **Step 6: Add release note**

Under `[Unreleased]` / `### New Features` in `CHANGELOG.md`, add:

```markdown
- QML / Qt Quick indexing now connects explicit module, dynamic-loading, and Qt bridge relationships through the normal graph pipeline. `qmldir` module imports resolve visible QML components without broad built-in name matching; literal local `Loader.source` and `Qt.createComponent("...qml")` targets resolve to their QML component files; and explicit Qt bridge facts connect registered QML types, singletons, context properties, `Q_INVOKABLE` methods, Qt-exposed public slots, `Q_PROPERTY` reads, and signals to indexed C++ symbols. Runtime-built URLs, runtime-computed registration metadata, full C++ overload resolution, moc execution, and QML JavaScript helper alias function resolution remain intentionally unsupported. (QML, Qt Quick, C++)
```

- [ ] **Step 7: Commit validation and release notes**

Run:

```bash
git add docs/superpowers/plans/2026-06-19-qml-follow-up-tasks.md docs/superpowers/specs/2026-06-09-qt-quick-design.md CHANGELOG.md
git commit -m "docs(qml): document follow-up closure"
```

Expected: commit contains only docs and changelog.

## Task 8: Final Verification

**Files:**
- No source edits.

- [ ] **Step 1: Run QML focused tests**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts __tests__/extraction.test.ts -t "QML|qml"
```

Expected: PASS.

- [ ] **Step 2: Run full build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Inspect final git status**

Run:

```bash
git status --short
```

Expected: only intentional committed changes are absent from working tree. Pre-existing unrelated local files may still appear if they were not part of the implementation branch.

## Self-Review

Spec coverage:

- Workspace and documentation baseline: Task 1.
- Read-only validation baseline: Task 2.
- QML module/import scope: Task 4.
- Dynamic QML loading: Task 5.
- C++/QML bridge registry and resolution: Task 6.
- Validation rerun and release notes: Task 7.
- Main CodeGraph pipeline constraint: Task 3 creates a normal framework resolver, Tasks 4-6 return `ResolvedRef` objects, and no task introduces a QML-specific query or MCP path.

Placeholder scan:

- The plan contains no `TBD`, no `TODO`, and no unconstrained "add tests" steps.
- Every code-changing task includes concrete code snippets and exact commands.

Type consistency:

- The framework resolver uses existing `FrameworkResolver`, `ResolutionContext`, `UnresolvedRef`, and `ResolvedRef` types.
- New edges are produced by normal resolver output and persisted by existing `ReferenceResolver.createEdges()`.
