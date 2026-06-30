# Qt Framework Resolver Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the current QML/Qt resolver into a unified public `qt` framework resolver while preserving existing QML graph behavior and keeping compatibility shims for `qml-qt`.

**Architecture:** Create `src/resolution/frameworks/qt/` with `index.ts`, `qml.ts`, `cpp-meta.ts`, `widgets.ts`, and `ui-xml.ts`. Phase 1 moves existing QML behavior behind `qtResolver`, keeps `qmlQtResolver` as a compatibility alias, and adds tests for the public-name migration, QML invariants, and shared C++ bridge cache behavior. Widgets support remains a stub with documented post-pass prerequisites; do not implement Qt Widgets connect edges in this phase.

**Tech Stack:** TypeScript, Vitest, Node.js 20-24, tree-sitter extraction, SQLite-backed CodeGraph integration tests.

---

## Scope

This plan implements Phase 1 only:

- Public framework identity becomes `qt`.
- `qml-qt` remains available as a compatibility alias for imports and `getFrameworkResolver('qml-qt')`.
- Existing QML and QML-to-C++ bridge behavior remains unchanged except for the accepted detected framework name migration.
- `qt/widgets.ts` and `qt/ui-xml.ts` are created as no-op internal surfaces to lock the architecture without adding incomplete Widgets behavior.

Out of scope for this plan:

- Signal-to-slot Widgets edges.
- `.ui` XML extraction.
- C++ declaration-backed method-node synthesis.
- Real-repo performance probes beyond commands documented for the next plan.

## File Structure

- Create: `src/resolution/frameworks/qt/index.ts`
  - Exports `qtResolver`.
  - Composes QML, Widgets, and `.ui` internal surfaces.
  - Owns `name: 'qt'`, `languages`, `detect`, `claimsReference`, `resolve`, and `extract`.
- Create: `src/resolution/frameworks/qt/qml.ts`
  - Contains the current QML/Qt resolver implementation moved from `src/resolution/frameworks/qml-qt.ts`.
  - Exports internal helpers used by `qtResolver`: `detectQmlQt`, `claimsQmlQtReference`, `resolveQmlQt`, and `extractQmlQt`.
- Create: `src/resolution/frameworks/qt/cpp-meta.ts`
  - Contains shared C++ Qt meta-object parsing moved from the current QML resolver.
  - Exports the registry types and `getQtCppMetaRegistry(context)`.
- Create: `src/resolution/frameworks/qt/widgets.ts`
  - Exports conservative no-op Widgets hooks.
  - Documents that Widgets must not process QML refs.
- Create: `src/resolution/frameworks/qt/ui-xml.ts`
  - Exports conservative no-op `.ui` hooks.
- Modify: `src/resolution/frameworks/qml-qt.ts`
  - Replace with a compatibility shim exporting `qtResolver` as `qmlQtResolver`.
- Modify: `src/resolution/frameworks/index.ts`
  - Register `qtResolver`.
  - Export `qtResolver` and `qmlQtResolver`.
  - Map `getFrameworkResolver('qml-qt')` to `qtResolver`.
- Modify: `src/resolution/index.ts`
  - No name-based framework gate should be added.
  - Update the QML-to-C++ framework gate comment so it describes the actual invariant.
- Modify: `__tests__/qml-integration.test.ts`
  - Update detected framework expectation from `qml-qt` to `qt`.
  - Add compatibility and QML invariant regressions.
- Modify: `__tests__/frameworks.test.ts` or `__tests__/resolution.test.ts`
  - Add resolver registry alias coverage.
- Modify: `CHANGELOG.md`
  - Add a user-facing Unreleased note for the `qt` framework identity and `qml-qt` compatibility alias.

## Compatibility Decision

Use this policy in implementation:

- `graph.getDetectedFrameworks()` returns `qt`.
- `getFrameworkResolver('qt')` returns `qtResolver`.
- `getFrameworkResolver('qml-qt')` returns `qtResolver` during the compatibility window.
- `qmlQtResolver` remains importable from `src/resolution/frameworks` and `src/resolution/frameworks/qml-qt`.
- The compatibility shim must not register a second framework resolver, or QML refs will be resolved twice.

## Task 1: Add Failing Compatibility Tests

**Files:**
- Modify: `__tests__/qml-integration.test.ts`
- Modify: `__tests__/frameworks.test.ts`

- [ ] **Step 1: Update detected framework expectation to the new public name**

In `__tests__/qml-integration.test.ts`, find the test named `uses the QML Qt framework resolver for QML-specific cross-file references`. Change the framework assertion to:

```ts
expect(graph.getDetectedFrameworks()).toContain('qt');
expect(graph.getDetectedFrameworks()).not.toContain('qml-qt');
```

- [ ] **Step 2: Add registry alias tests**

In `__tests__/frameworks.test.ts`, add these imports near the other framework imports:

```ts
import { getFrameworkResolver, qtResolver, qmlQtResolver } from '../src/resolution/frameworks';
```

If `getFrameworkResolver` is already imported in that file, extend the existing import instead of adding a duplicate import.

Add this test near the existing framework registry tests:

```ts
describe('Qt framework resolver compatibility aliases', () => {
  it('registers qt as the public resolver and keeps qml-qt as a lookup alias', () => {
    expect(qtResolver.name).toBe('qt');
    expect(qmlQtResolver).toBe(qtResolver);
    expect(getFrameworkResolver('qt')).toBe(qtResolver);
    expect(getFrameworkResolver('qml-qt')).toBe(qtResolver);
  });
});
```

- [ ] **Step 3: Run the targeted tests and verify they fail**

Run:

```bash
npx vitest run __tests__/frameworks.test.ts -t "Qt framework resolver compatibility aliases"
npx vitest run __tests__/qml-integration.test.ts -t "uses the QML Qt framework resolver"
```

Expected:

- The framework registry test fails because `qtResolver` is not exported yet.
- The QML integration test fails because detected frameworks still contain `qml-qt`.

- [ ] **Step 4: Commit the failing tests**

```bash
git add __tests__/frameworks.test.ts __tests__/qml-integration.test.ts
git commit -m "test: define qt resolver compatibility"
```

## Task 2: Create the Qt Resolver Shell

**Files:**
- Create: `src/resolution/frameworks/qt/widgets.ts`
- Create: `src/resolution/frameworks/qt/ui-xml.ts`
- Create: `src/resolution/frameworks/qt/index.ts`
- Modify: `src/resolution/frameworks/qml-qt.ts`
- Modify: `src/resolution/frameworks/index.ts`

- [ ] **Step 1: Create no-op Widgets hooks**

Create `src/resolution/frameworks/qt/widgets.ts`:

```ts
import type { FrameworkExtractionResult, ResolutionContext, ResolvedRef, UnresolvedRef } from '../../types';

export function detectQtWidgets(context: ResolutionContext): boolean {
  void context;
  return false;
}

export function claimsQtWidgetsReference(_name: string, ref?: UnresolvedRef): boolean {
  if (!ref || ref.language === 'qml') return false;
  return false;
}

export function resolveQtWidgets(_ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
  return null;
}

export function extractQtWidgets(_filePath: string, _content: string): FrameworkExtractionResult {
  return { nodes: [], references: [] };
}
```

- [ ] **Step 2: Create no-op `.ui` hooks**

Create `src/resolution/frameworks/qt/ui-xml.ts`:

```ts
import type { FrameworkExtractionResult, ResolutionContext } from '../../types';

export function detectQtUiFiles(context: ResolutionContext): boolean {
  return context.getAllFiles().some((filePath) => /\.ui$/i.test(filePath));
}

export function extractQtUiXml(_filePath: string, _content: string): FrameworkExtractionResult {
  return { nodes: [], references: [] };
}
```

- [ ] **Step 3: Create a temporary Qt resolver shell**

Create `src/resolution/frameworks/qt/index.ts` with a temporary import from the existing resolver:

```ts
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../../types';
import { qmlQtResolver as legacyQmlQtResolver } from '../qml-qt';
import { detectQtUiFiles, extractQtUiXml } from './ui-xml';
import { claimsQtWidgetsReference, detectQtWidgets, extractQtWidgets, resolveQtWidgets } from './widgets';

function detectQt(context: ResolutionContext): boolean {
  return legacyQmlQtResolver.detect(context) || detectQtUiFiles(context) || detectQtWidgets(context);
}

export const qtResolver: FrameworkResolver = {
  name: 'qt',
  languages: ['qml', 'yaml'],
  detect: detectQt,
  claimsReference(name: string, ref?: UnresolvedRef): boolean {
    return Boolean(
      legacyQmlQtResolver.claimsReference?.(name, ref) ||
        claimsQtWidgetsReference(name, ref)
    );
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language === 'qml') return legacyQmlQtResolver.resolve(ref, context);
    return resolveQtWidgets(ref, context);
  },
  extract(filePath: string, content: string) {
    if (/\.ui$/i.test(filePath)) return extractQtUiXml(filePath, content);
    const qmlResult = legacyQmlQtResolver.extract?.(filePath, content);
    if (qmlResult && (qmlResult.nodes.length > 0 || qmlResult.references.length > 0)) {
      return qmlResult;
    }
    return extractQtWidgets(filePath, content);
  },
};
```

This temporary shell will create a circular import once `qml-qt.ts` becomes a shim, so do not commit this state until Task 3 replaces the legacy import with `./qml`.

- [ ] **Step 4: Update the framework registry**

In `src/resolution/frameworks/index.ts`, replace the current import:

```ts
import { qmlQtResolver } from './qml-qt';
```

with:

```ts
import { qtResolver } from './qt';
import { qmlQtResolver } from './qml-qt';
```

Replace the resolver array entry:

```ts
qmlQtResolver,
```

with:

```ts
qtResolver,
```

Update `getFrameworkResolver`:

```ts
export function getFrameworkResolver(name: string): FrameworkResolver | undefined {
  if (name === 'qml-qt') return qtResolver;
  return FRAMEWORK_RESOLVERS.find((r) => r.name === name);
}
```

Add exports at the bottom:

```ts
export { qtResolver } from './qt';
export { qmlQtResolver } from './qml-qt';
```

Remove any duplicate existing `export { qmlQtResolver } from './qml-qt';`.

- [ ] **Step 5: Run the registry test**

Run:

```bash
npx vitest run __tests__/frameworks.test.ts -t "Qt framework resolver compatibility aliases"
```

Expected: fail because `qml-qt.ts` is still the real resolver and Task 3 has not moved QML internals into `qt/qml.ts`. This run is a checkpoint only; Task 3 completes the import graph.

## Task 3: Move the QML Resolver Into `qt/qml.ts`

**Files:**
- Create: `src/resolution/frameworks/qt/qml.ts`
- Modify: `src/resolution/frameworks/qt/index.ts`
- Modify: `src/resolution/frameworks/qml-qt.ts`

- [ ] **Step 1: Copy the current QML resolver implementation**

Copy the full contents of `src/resolution/frameworks/qml-qt.ts` into `src/resolution/frameworks/qt/qml.ts`.

In the copied file, update relative imports:

```ts
import type { Node } from '../../../types';
import { isQmlDirFile, isQmlFile } from '../../../extraction/grammars';
import type { FrameworkExtractionResult, ResolutionContext, ResolvedRef, UnresolvedRef } from '../../types';
```

If the copied file only imports `FrameworkResolver` for the exported object, remove that type from the import list.

- [ ] **Step 2: Replace the exported resolver object with internal functions**

At the bottom of `src/resolution/frameworks/qt/qml.ts`, remove the exported `qmlQtResolver` object and replace it with these exported functions. The function bodies below are the current resolver behavior expressed without the public resolver object:

```ts
export function detectQmlQt(context: ResolutionContext): boolean {
  return hasQmlFiles(context);
}

export function claimsQmlQtReference(name: string, ref?: UnresolvedRef): boolean {
  if (ref && ref.language !== 'qml') return false;
  return (
    /\.qml$/i.test(name) ||
    /^[A-Za-z_][A-Za-z0-9_]*\.[A-Z][A-Za-z0-9_]*$/.test(name) ||
    /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(name) ||
    (ref?.referenceKind === 'references' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
    /^[A-Z][A-Za-z0-9_]*$/.test(name)
  );
}

export function resolveQmlQt(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  return (
    resolveLiteralQmlUrl(ref, context) ??
    resolveQmlCppBridgeCall(ref, context) ??
    resolveQmlCppSignalHandler(ref, context) ??
    resolveQmlCppPropertyRead(ref, context) ??
    resolveQmlCppContextPropertyRef(ref, context) ??
    resolveQmlCppRegisteredTypeReference(ref, context) ??
    resolveQmlCppRegisteredComponent(ref, context) ??
    resolveQmlModuleComponent(ref, context)
  );
}

export function extractQmlQt(filePath: string, content: string): FrameworkExtractionResult {
  if (!isQmlDirFile(filePath)) return { nodes: [], references: [] };

  const parsed = parseQmlDir(filePath, content);
  if (!parsed) return { nodes: [], references: [] };

  const node: Node = {
    id: `module:qml:${filePath}:${parsed.uri}`,
    kind: 'module',
    name: parsed.uri,
    qualifiedName: parsed.uri,
    filePath,
    language: 'yaml',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    signature: `module ${parsed.uri}`,
    updatedAt: Date.now(),
  };
  const importNodes = parsed.imports.map((dependency, index): Node => ({
    id: `import:qml:${filePath}:${parsed.uri}:${dependency.uri}:${index}`,
    kind: 'import',
    name: dependency.uri,
    qualifiedName: `${parsed.uri}.import:${dependency.uri}`,
    filePath,
    language: 'yaml',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    signature: `import ${dependency.uri}${dependency.version ? ` ${dependency.version}` : ''}`,
    updatedAt: Date.now(),
  }));
  return { nodes: [node, ...importNodes], references: [] };
}
```

If the existing method bodies differ because local QML work has changed, preserve the existing behavior exactly and only change the export shape.

- [ ] **Step 3: Update `qt/index.ts` to use internal QML functions**

Replace the temporary legacy import:

```ts
import { qmlQtResolver as legacyQmlQtResolver } from '../qml-qt';
```

with:

```ts
import { claimsQmlQtReference, detectQmlQt, extractQmlQt, resolveQmlQt } from './qml';
```

Update the resolver implementation:

```ts
function detectQt(context: ResolutionContext): boolean {
  return detectQmlQt(context) || detectQtUiFiles(context) || detectQtWidgets(context);
}

export const qtResolver: FrameworkResolver = {
  name: 'qt',
  languages: ['qml', 'yaml'],
  detect: detectQt,
  claimsReference(name: string, ref?: UnresolvedRef): boolean {
    return claimsQmlQtReference(name, ref) || claimsQtWidgetsReference(name, ref);
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language === 'qml') return resolveQmlQt(ref, context);
    return resolveQtWidgets(ref, context);
  },
  extract(filePath: string, content: string) {
    if (/\.ui$/i.test(filePath)) return extractQtUiXml(filePath, content);
    const qmlResult = extractQmlQt(filePath, content);
    if (qmlResult.nodes.length > 0 || qmlResult.references.length > 0) return qmlResult;
    return extractQtWidgets(filePath, content);
  },
};
```

- [ ] **Step 4: Replace `qml-qt.ts` with a compatibility shim**

Replace `src/resolution/frameworks/qml-qt.ts` with:

```ts
export { qtResolver as qmlQtResolver } from './qt';
```

- [ ] **Step 5: Run targeted compatibility tests**

Run:

```bash
npx vitest run __tests__/frameworks.test.ts -t "Qt framework resolver compatibility aliases"
npx vitest run __tests__/qml-integration.test.ts -t "uses the QML Qt framework resolver"
```

Expected: both pass.

- [ ] **Step 6: Commit the resolver shell migration**

```bash
git add src/resolution/frameworks/qt src/resolution/frameworks/qml-qt.ts src/resolution/frameworks/index.ts __tests__/frameworks.test.ts __tests__/qml-integration.test.ts
git commit -m "refactor: expose unified qt resolver"
```

## Task 4: Extract Shared C++ Qt Metadata

**Files:**
- Modify: `src/resolution/frameworks/qt/cpp-meta.ts`
- Modify: `src/resolution/frameworks/qt/qml.ts`

- [ ] **Step 1: Create `cpp-meta.ts` by moving shared types and helpers**

Move these definitions from `src/resolution/frameworks/qt/qml.ts` into `src/resolution/frameworks/qt/cpp-meta.ts`:

```ts
export interface QtCppMethodFact {
  name: string;
  invokable: boolean;
  publicSlot: boolean;
  privateOrProtectedSlot?: boolean;
  signature?: string;
  arity?: number;
}

export interface QtCppPropertyFact {
  name: string;
  read?: string;
  notify?: string;
}

export interface QtCppClassFacts {
  name: string;
  classNodeId?: string;
  methods: Map<string, QtCppMethodFact>;
  properties: Map<string, QtCppPropertyFact>;
  signals: Set<string>;
  hasQmlExposureEvidence: boolean;
}

export interface QtCppMetaRegistry {
  classes: Map<string, QtCppClassFacts>;
}
```

Also move the functions that only parse Qt C++ class metadata:

```text
simpleCppTypeName
getOrCreateClassFacts
addMethodFact
methodNamesFromCppDeclarations
parseQmlCppProperties
parseQmlCppSignals
parseQmlCppMethods
parseQmlCppClasses
attachQmlCppNodes
```

Rename QML-prefixed functions while moving:

```text
parseQmlCppProperties -> parseQtCppProperties
parseQmlCppSignals -> parseQtCppSignals
parseQmlCppMethods -> parseQtCppMethods
parseQmlCppClasses -> parseQtCppClasses
attachQmlCppNodes -> attachQtCppNodes
```

- [ ] **Step 2: Add the shared registry cache**

In `cpp-meta.ts`, add:

```ts
import type { Node } from '../../../types';
import type { ResolutionContext } from '../../types';

interface QtCppMetaRegistryCacheEntry {
  key: string;
  registry: QtCppMetaRegistry;
}

const qtCppMetaRegistryCache = new WeakMap<ResolutionContext, QtCppMetaRegistryCacheEntry>();
```

Then expose:

```ts
export function getQtCppMetaRegistry(context: ResolutionContext): QtCppMetaRegistry {
  const { key, sources } = getQtCppBridgeSources(context);
  const cached = qtCppMetaRegistryCache.get(context);
  if (cached?.key === key) return cached.registry;

  const registry: QtCppMetaRegistry = {
    classes: new Map(),
  };
  for (const [, source] of sources) {
    if (!source) continue;
    parseQtCppClasses(registry, source);
  }
  attachQtCppNodes(context, registry);
  qtCppMetaRegistryCache.set(context, { key, registry });
  return registry;
}
```

Move `isCppBridgeFile`, `cppBridgeFiles`, `cppBridgeVersionKey`, and `getQmlCppBridgeSources` into this file too. Rename `getQmlCppBridgeSources` to `getQtCppSources`, and make `getQtCppMetaRegistry` call `getQtCppSources(context)`.

- [ ] **Step 3: Keep QML bridge-specific registration facts in `qml.ts`**

In `qml.ts`, keep these QML-specific interfaces and parsers:

```text
QmlCppRegistration
QmlCppContextProperty
QmlCppBridgeRegistry
parseQmlCppRegistrations
parseQmlCppContextProperties
getQmlCppBridgeNameIndex
getQmlCppBridgeRegistry
```

Update `getQmlCppBridgeRegistry(context)` so it starts from the shared registry:

```ts
const meta = getQtCppMetaRegistry(context);
const registry: QmlCppBridgeRegistry = {
  classes: new Map(meta.classes),
  registrations: [],
  contextProperties: new Map(),
};
```

Continue parsing QML registration and context-property facts in `qml.ts`, not `cpp-meta.ts`.

- [ ] **Step 4: Run QML bridge tests**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts -t "C++/QML bridge"
```

Expected: all matching C++/QML bridge tests pass.

- [ ] **Step 5: Commit the shared metadata extraction**

```bash
git add src/resolution/frameworks/qt/cpp-meta.ts src/resolution/frameworks/qt/qml.ts
git commit -m "refactor: share qt cpp metadata parsing"
```

## Task 5: Add QML Invariant Regression Tests

**Files:**
- Modify: `__tests__/qml-integration.test.ts`

- [ ] **Step 1: Add alias and version disambiguation coverage**

Add this test near the existing C++/QML bridge tests:

```ts
it('resolves aliased and versioned C++ QML registrations conservatively', async () => {
  fs.writeFileSync(
    path.join(tmpDir, 'main.cpp'),
    `#include <QObject>
#include <QtQml>

class ThemeApiV1 : public QObject {
  Q_OBJECT
public:
  Q_INVOKABLE QString color();
};

class ThemeApiV2 : public QObject {
  Q_OBJECT
public:
  Q_INVOKABLE QString color();
};

class HiddenApi : public QObject {
  Q_OBJECT
public:
  Q_INVOKABLE void refresh();
};

QString ThemeApiV1::color() { return "#111111"; }
QString ThemeApiV2::color() { return "#222222"; }
void HiddenApi::refresh() {}

int main() {
  qmlRegisterSingletonType<ThemeApiV1>("App.Controls", 1, 0, "ThemeApi", [](QQmlEngine*, QJSEngine*) -> QObject* {
    return new ThemeApiV1();
  });
  qmlRegisterSingletonType<ThemeApiV2>("App.Controls", 2, 0, "ThemeApi", [](QQmlEngine*, QJSEngine*) -> QObject* {
    return new ThemeApiV2();
  });
  qmlRegisterUncreatableType<HiddenApi>("App.Controls", 1, 0, "HiddenApi", "Only for typed properties");
  return 0;
}
`
  );
  fs.writeFileSync(
    path.join(tmpDir, 'Main.qml'),
    `import QtQuick
import App.Controls 2.0 as Controls

Item {
  property Controls.HiddenApi hidden
  Component.onCompleted: {
    Controls.ThemeApi.color()
  }
}
`
  );

  const graph = cg!;
  await graph.indexAll();

  const onCompleted = graph.getNodesByName('Component.onCompleted').find((n) => n.kind === 'method' && n.filePath === 'Main.qml');
  const v1Color = graph.getNodesByName('color').find((n) => n.kind === 'method' && n.qualifiedName.endsWith('ThemeApiV1::color'));
  const v2Color = graph.getNodesByName('color').find((n) => n.kind === 'method' && n.qualifiedName.endsWith('ThemeApiV2::color'));
  const hiddenApi = graph.getNodesByName('HiddenApi').find((n) => n.kind === 'class');

  expect(onCompleted).toBeDefined();
  expect(v1Color).toBeDefined();
  expect(v2Color).toBeDefined();
  expect(hiddenApi).toBeDefined();

  const edges = graph.getOutgoingEdges(onCompleted!.id);
  expect(edges.some((edge) => edge.kind === 'calls' && edge.target === v2Color!.id)).toBe(true);
  expect(edges.some((edge) => edge.kind === 'calls' && edge.target === v1Color!.id)).toBe(false);

  const hiddenProperty = graph.getNodesByName('hidden').find((n) => n.kind === 'property' && n.filePath === 'Main.qml');
  expect(hiddenProperty).toBeDefined();
  expect(graph.getOutgoingEdges(hiddenProperty!.id).some((edge) => edge.kind === 'references' && edge.target === hiddenApi!.id)).toBe(true);
});
```

- [ ] **Step 2: Add a negative test for private/protected slots not becoming QML-visible**

Add:

```ts
it('does not expose private or protected slots to QML through the shared Qt registry', async () => {
  fs.writeFileSync(
    path.join(tmpDir, 'main.cpp'),
    `#include <QObject>
#include <QQmlApplicationEngine>
#include <QQmlContext>

class ViewModel : public QObject {
  Q_OBJECT
public slots:
  void visible();
private slots:
  void hidden();
protected slots:
  void alsoHidden();
};

void ViewModel::visible() {}
void ViewModel::hidden() {}
void ViewModel::alsoHidden() {}

int main() {
  QQmlApplicationEngine engine;
  ViewModel vm;
  engine.rootContext()->setContextProperty("viewModel", &vm);
  return 0;
}
`
  );
  fs.writeFileSync(
    path.join(tmpDir, 'Main.qml'),
    `import QtQuick

Item {
  Component.onCompleted: {
    viewModel.visible()
    viewModel.hidden()
    viewModel.alsoHidden()
  }
}
`
  );

  const graph = cg!;
  await graph.indexAll();

  const onCompleted = graph.getNodesByName('Component.onCompleted').find((n) => n.kind === 'method' && n.filePath === 'Main.qml');
  const visible = graph.getNodesByName('visible').find((n) => n.kind === 'method' && n.qualifiedName.endsWith('ViewModel::visible'));
  const hidden = graph.getNodesByName('hidden').find((n) => n.kind === 'method' && n.qualifiedName.endsWith('ViewModel::hidden'));
  const alsoHidden = graph.getNodesByName('alsoHidden').find((n) => n.kind === 'method' && n.qualifiedName.endsWith('ViewModel::alsoHidden'));

  expect(onCompleted).toBeDefined();
  expect(visible).toBeDefined();
  expect(hidden).toBeDefined();
  expect(alsoHidden).toBeDefined();

  const edges = graph.getOutgoingEdges(onCompleted!.id);
  expect(edges.some((edge) => edge.kind === 'calls' && edge.target === visible!.id)).toBe(true);
  expect(edges.some((edge) => edge.kind === 'calls' && edge.target === hidden!.id)).toBe(false);
  expect(edges.some((edge) => edge.kind === 'calls' && edge.target === alsoHidden!.id)).toBe(false);
});
```

- [ ] **Step 3: Run the new tests**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts -t "aliased and versioned|private or protected slots"
```

Expected: both pass.

- [ ] **Step 4: Commit the invariant tests**

```bash
git add __tests__/qml-integration.test.ts
git commit -m "test: preserve qml qt bridge invariants"
```

## Task 6: Add C++ Bridge Sync Invalidation Tests

**Files:**
- Modify: `__tests__/qml-integration.test.ts`

- [ ] **Step 1: Add a sync test for context-property type changes**

Add:

```ts
it('updates QML C++ bridge edges when context property types change during sync', async () => {
  const cppPath = path.join(tmpDir, 'main.cpp');
  const qmlPath = path.join(tmpDir, 'Main.qml');

  fs.writeFileSync(
    cppPath,
    `#include <QObject>
#include <QQmlApplicationEngine>
#include <QQmlContext>

class FirstModel : public QObject {
  Q_OBJECT
public:
  Q_INVOKABLE void refresh();
};

class SecondModel : public QObject {
  Q_OBJECT
public:
  Q_INVOKABLE void refresh();
};

void FirstModel::refresh() {}
void SecondModel::refresh() {}

int main() {
  QQmlApplicationEngine engine;
  FirstModel model;
  engine.rootContext()->setContextProperty("viewModel", &model);
  return 0;
}
`
  );
  fs.writeFileSync(
    qmlPath,
    `import QtQuick

Item {
  Component.onCompleted: viewModel.refresh()
}
`
  );

  const graph = cg!;
  await graph.indexAll();

  const firstRefresh = graph.getNodesByName('refresh').find((n) => n.kind === 'method' && n.qualifiedName.endsWith('FirstModel::refresh'));
  expect(firstRefresh).toBeDefined();

  let onCompleted = graph.getNodesByName('Component.onCompleted').find((n) => n.kind === 'method' && n.filePath === 'Main.qml');
  expect(onCompleted).toBeDefined();
  expect(graph.getOutgoingEdges(onCompleted!.id).some((edge) => edge.kind === 'calls' && edge.target === firstRefresh!.id)).toBe(true);

  fs.writeFileSync(
    cppPath,
    fs.readFileSync(cppPath, 'utf-8').replace('FirstModel model;', 'SecondModel model;')
  );
  await graph.sync();

  const secondRefresh = graph.getNodesByName('refresh').find((n) => n.kind === 'method' && n.qualifiedName.endsWith('SecondModel::refresh'));
  onCompleted = graph.getNodesByName('Component.onCompleted').find((n) => n.kind === 'method' && n.filePath === 'Main.qml');
  expect(secondRefresh).toBeDefined();
  expect(onCompleted).toBeDefined();

  const edges = graph.getOutgoingEdges(onCompleted!.id);
  expect(edges.some((edge) => edge.kind === 'calls' && edge.target === secondRefresh!.id)).toBe(true);
  expect(edges.some((edge) => edge.kind === 'calls' && edge.target === firstRefresh!.id)).toBe(false);
});
```

- [ ] **Step 2: Run the sync test**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts -t "context property types change during sync"
```

Expected: pass.

- [ ] **Step 3: Commit the sync regression**

```bash
git add __tests__/qml-integration.test.ts
git commit -m "test: cover qt bridge sync invalidation"
```

## Task 7: Changelog and Comment Hygiene

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `src/resolution/index.ts`

- [ ] **Step 1: Update the QML/Qt changelog entry**

In `CHANGELOG.md`, under `## [Unreleased] > ### New Features`, update the existing QML / Qt Quick bullet by appending:

```md
The framework is now exposed internally as the broader `qt` resolver while retaining `qml-qt` as a compatibility alias for resolver imports and explicit lookup during the migration window.
```

- [ ] **Step 2: Clarify the framework language gate comment**

In `src/resolution/index.ts`, keep the existing gate logic unchanged. Update the comment above the QML/C++ framework exception to:

```ts
    // QML/Qt bridge facts are explicit discoveries from QML bridge surfaces
    // (qmlRegisterType/context properties/Q_PROPERTY). The allowance is based
    // on source/target language plus framework provenance, not the resolver's
    // public name. Widgets support must not use this path for QML refs.
```

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: TypeScript build succeeds and assets copy.

- [ ] **Step 4: Commit docs and comment updates**

```bash
git add CHANGELOG.md src/resolution/index.ts
git commit -m "docs: note qt resolver compatibility"
```

## Task 8: Full Phase 1 Verification

**Files:**
- No planned source edits.

- [ ] **Step 1: Run targeted QML integration suite**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts
```

Expected: all QML integration tests pass.

- [ ] **Step 2: Run framework and resolution tests touched by the migration**

Run:

```bash
npx vitest run __tests__/frameworks.test.ts __tests__/resolution.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Run the full test suite**

Run:

```bash
npm test
```

Expected: Vitest exits successfully.

- [ ] **Step 4: Inspect the final diff**

Run:

```bash
git diff --stat HEAD~4..HEAD
git status --short
```

Expected:

- Only Qt resolver migration, tests, changelog, and comment files are changed by these commits.
- Existing unrelated workspace files such as `test-qml-project/` are not staged.

## Phase 2 Planning Trigger

Create a separate plan for Widgets only after Phase 1 passes. That plan should start with:

- declaration-backed C++ method nodes or Qt-specific synthetic signal/slot nodes
- a Qt post-pass edge model for signal-to-slot fidelity
- overload matrix tests for `qOverload`, `QOverload`, `static_cast`, `SIGNAL`, and `SLOT`
- negative tests for lambda/functor connects if they remain out of scope
- `.ui` language routing decision before XML extraction work
