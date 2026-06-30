# Qt Widgets Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real Qt Widgets support to the unified `qt` framework resolver while preserving existing QML / Qt Quick behavior.

**Architecture:** Use a dedicated Qt Widgets synthesized-edge pass instead of unresolved-reference metadata. `cpp-meta.ts` provides a qualified, overload-aware Qt C++ fact registry; `ui-xml.ts` provides `.ui` facts; `qt-widgets-synthesizer.ts` joins those facts with existing graph nodes and inserts conservative `calls` edges.

**Tech Stack:** TypeScript, Vitest, SQLite-backed CodeGraph integration tests, existing tree-sitter C/C++ extraction, direct synthesized edges via `QueryBuilder.insertEdges`.

---

## Execution Prerequisites

This repo may have unrelated local changes. Before executing this plan:

- Work on a clean feature branch or worktree.
- Record the base with `BASE_REF=$(git merge-base HEAD origin/develop)` or the branch base chosen by the maintainer.
- Stage only files named in the current task.
- Do not use hardcoded ranges such as `HEAD~7`; use `$BASE_REF..HEAD` for final review.

## Scope

This plan implements:

1. C/C++ routing and Qt Widgets detection.
2. An overload-aware, qualified Qt C++ registry.
3. A typed-connect synthesizer.
4. Macro and overload connect forms.
5. `.ui` XML, code-behind, and auto-connect synthesis.
6. Sync regressions and final verification.

The plan does not add `UnresolvedRef.metadata` or a DB schema migration. Widgets facts are derived in a synthesizer after normal extraction/resolution.

## File Structure

- Modify: `src/resolution/frameworks/qt/index.ts`
  - Add `cpp` and `c` to `qtResolver.languages`.

- Modify: `src/resolution/frameworks/qt/widgets.ts`
  - Implement Widgets project detection helpers.
  - Keep framework resolver extraction/resolution conservative; real Widgets edges live in the synthesizer.

- Modify: `src/resolution/frameworks/qt/cpp-meta.ts`
  - Add qualified class indexes.
  - Represent overloaded methods with arrays/signature keys.
  - Attach method facts to existing C++ method nodes.

- Modify: `src/resolution/frameworks/qt/ui-xml.ts`
  - Parse `.ui` form, object, action, and connection facts.
  - Expose a cached registry for the synthesizer.

- Create: `src/resolution/qt-widgets-synthesizer.ts`
  - Scan indexed C/C++ sources and `.ui` facts.
  - Synthesize connect-site -> slot, signal -> slot, and emit-site -> signal edges.

- Modify: `src/resolution/callback-synthesizer.ts`
  - Import and call the Qt Widgets synthesizer from `synthesizeCallbackEdges`, following existing framework synthesizer patterns.

- Create: `__tests__/qt-widgets-integration.test.ts`
  - End-to-end tests for detection, typed connect, macro/overload connect, `.ui`, auto-connect, negative cases, and sync.

- Modify: `__tests__/frameworks.test.ts`
  - Add C/C++ language routing coverage for `qtResolver`.

- Modify: `CHANGELOG.md`
  - Add a user-facing Widgets support note.

## Task 1: Add Failing Routing and Detection Tests

**Files:**
- Modify: `__tests__/frameworks.test.ts`
- Create: `__tests__/qt-widgets-integration.test.ts`

- [ ] **Step 1: Add framework routing assertions**

In `__tests__/frameworks.test.ts`, extend the Qt public identity describe block:

```ts
  it('routes Qt framework extraction to C and C++ files for Widgets support', () => {
    expect(qtResolver.languages).toContain('cpp');
    expect(qtResolver.languages).toContain('c');
    expect(getApplicableFrameworks([qtResolver], 'cpp')).toEqual([qtResolver]);
    expect(getApplicableFrameworks([qtResolver], 'c')).toEqual([qtResolver]);
  });
```

- [ ] **Step 2: Create the Widgets integration test scaffold**

Create `__tests__/qt-widgets-integration.test.ts`:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';

describe('Qt Widgets graph support', () => {
  let tmpDir: string;
  let graph: CodeGraph | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qt-widgets-'));
    graph = CodeGraph.initSync(tmpDir);
  });

  afterEach(() => {
    graph?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects Qt Widgets projects from QApplication and QWidget usage', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main.cpp'),
      `#include <QApplication>
#include <QWidget>

int main(int argc, char **argv) {
  QApplication app(argc, argv);
  QWidget window;
  window.show();
  return app.exec();
}
`
    );

    await graph!.indexAll();

    expect(graph!.getDetectedFrameworks()).toContain('qt');
  });
});
```

- [ ] **Step 3: Verify RED**

Run:

```bash
npx vitest run __tests__/frameworks.test.ts -t "routes Qt framework extraction"
npx vitest run __tests__/qt-widgets-integration.test.ts -t "detects Qt Widgets"
```

Expected:

- routing test fails because `qtResolver.languages` lacks `cpp`/`c`
- detection test fails because `detectQtWidgets()` returns `false`

- [ ] **Step 4: Commit failing tests**

```bash
git add __tests__/frameworks.test.ts __tests__/qt-widgets-integration.test.ts
git commit -m "test: define qt widgets routing"
```

## Task 2: Implement C/C++ Routing and Widgets Detection

**Files:**
- Modify: `src/resolution/frameworks/qt/index.ts`
- Modify: `src/resolution/frameworks/qt/widgets.ts`

- [ ] **Step 1: Add C/C++ languages to `qtResolver`**

In `src/resolution/frameworks/qt/index.ts`, change:

```ts
  languages: ['qml', 'yaml', 'xml'],
```

to:

```ts
  languages: ['qml', 'yaml', 'xml', 'cpp', 'c'],
```

- [ ] **Step 2: Implement Widgets detection**

In `src/resolution/frameworks/qt/widgets.ts`, replace `detectQtWidgets`:

```ts
const qtWidgetsProjectPattern =
  /\b(QApplication|QWidget|QMainWindow|QDialog|QObject::connect|connect\s*\(|QT\s*\+=\s*widgets|find_package\s*\(\s*Qt[56]?\b[\s\S]*\bWidgets\b)/;

export function detectQtWidgets(context: ResolutionContext): boolean {
  return context.getAllFiles().some((filePath) => {
    if (!/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|pro|pri|txt|cmake)$/i.test(filePath)) return false;
    const content = context.readFile(filePath);
    return Boolean(content && qtWidgetsProjectPattern.test(content));
  });
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run __tests__/frameworks.test.ts -t "routes Qt framework extraction"
npx vitest run __tests__/qt-widgets-integration.test.ts -t "detects Qt Widgets"
npx vitest run __tests__/qml-integration.test.ts
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/resolution/frameworks/qt/index.ts src/resolution/frameworks/qt/widgets.ts
git commit -m "feat: detect qt widgets projects"
```

## Task 3: Make `cpp-meta.ts` Overload-Aware and Qualified

**Files:**
- Modify: `src/resolution/frameworks/qt/cpp-meta.ts`
- Modify: `__tests__/qt-widgets-integration.test.ts`

- [ ] **Step 1: Add a failing duplicate class safety test**

Append to `__tests__/qt-widgets-integration.test.ts`:

```ts
  it('does not connect slots across duplicate class names in different namespaces', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QMainWindow>
#include <QPushButton>

namespace App {
class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  MainWindow();
private slots:
  void onButtonClicked();
};
}

namespace Other {
class MainWindow : public QMainWindow {
  Q_OBJECT
private slots:
  void onButtonClicked();
};
void MainWindow::onButtonClicked() {}
}

App::MainWindow::MainWindow() {
  auto *button = new QPushButton(this);
  connect(button, &QPushButton::clicked, this, &App::MainWindow::onButtonClicked);
}

void App::MainWindow::onButtonClicked() {}
`
    );

    await graph!.indexAll();

    const constructor = graph!.getNodesByName('MainWindow').find((node) => node.kind === 'method' && node.qualifiedName.endsWith('App::MainWindow::MainWindow'));
    const appSlot = graph!.getNodesByName('onButtonClicked').find((node) => node.kind === 'method' && node.qualifiedName.endsWith('App::MainWindow::onButtonClicked'));
    const otherSlot = graph!.getNodesByName('onButtonClicked').find((node) => node.kind === 'method' && node.qualifiedName.endsWith('Other::MainWindow::onButtonClicked'));

    expect(constructor).toBeDefined();
    expect(appSlot).toBeDefined();
    expect(otherSlot).toBeDefined();
    const edges = graph!.getOutgoingEdges(constructor!.id);
    expect(edges.some((edge) => edge.kind === 'calls' && edge.target === appSlot!.id)).toBe(true);
    expect(edges.some((edge) => edge.kind === 'calls' && edge.target === otherSlot!.id)).toBe(false);
  });
```

This test will remain red until the typed synthesizer exists, but it defines the required qualified-name behavior.

- [ ] **Step 2: Replace single method facts with overload-capable facts**

In `cpp-meta.ts`, change class method storage from a single fact per name to arrays:

```ts
export interface QtCppMethodFact {
  name: string;
  qualifiedName?: string;
  invokable: boolean;
  publicSlot: boolean;
  privateOrProtectedSlot?: boolean;
  signal?: boolean;
  visibility?: 'public' | 'protected' | 'private';
  signature?: string;
  arity?: number;
  parameterTypes: string[];
  nodeId?: string;
}

export interface QtCppClassFacts {
  name: string;
  qualifiedName?: string;
  classNodeId?: string;
  baseClassNames: string[];
  methodsByName: Map<string, QtCppMethodFact[]>;
  properties: Map<string, QtCppPropertyFact>;
  signals: Set<string>;
  hasQmlExposureEvidence: boolean;
  hasWidgetsEvidence: boolean;
}

export interface QtCppMetaRegistry {
  classes: Map<string, QtCppClassFacts>;
  classesByQualifiedName: Map<string, QtCppClassFacts>;
  classesBySimpleName: Map<string, QtCppClassFacts[]>;
}
```

- [ ] **Step 3: Add signature helpers**

Add and export:

```ts
export function normalizeCppType(typeName: string): string {
  return typeName
    .replace(/\bconst\b/g, '')
    .replace(/[&*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseQtParameterTypes(params: string): string[] {
  const trimmed = params.trim();
  if (!trimmed || trimmed === 'void') return [];
  return trimmed
    .split(',')
    .map((part) => normalizeCppType(part.replace(/\s+[A-Za-z_][A-Za-z0-9_]*\s*$/, '')))
    .filter(Boolean);
}

export function normalizeQtSignature(signature: string): { name: string; parameterTypes: string[] } | null {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*$/.exec(signature);
  if (!match) return null;
  return { name: match[1]!, parameterTypes: parseQtParameterTypes(match[2] ?? '') };
}
```

- [ ] **Step 4: Attach method node ids by qualified name**

Update node attachment so `App::MainWindow::onButtonClicked` attaches only to `App::MainWindow`, not another `MainWindow`. If a method cannot be attached uniquely, leave `nodeId` undefined.

- [ ] **Step 5: Preserve QML bridge APIs**

Update `qt/qml.ts` usages from `methods.get(name)` to a helper that returns the unique method fact for a name when overloads are not relevant. QML bridge tests must keep passing.

- [ ] **Step 6: Run registry and QML tests**

```bash
npx vitest run __tests__/qml-integration.test.ts -t "C\\+\\+/QML bridge|private or protected slots|aliased and versioned"
npx vitest run __tests__/qt-widgets-integration.test.ts -t "duplicate class"
```

Expected:

- QML tests pass.
- duplicate class test still fails until Task 4 creates synthesized edges.

- [ ] **Step 7: Commit**

```bash
git add src/resolution/frameworks/qt/cpp-meta.ts src/resolution/frameworks/qt/qml.ts __tests__/qt-widgets-integration.test.ts
git commit -m "refactor: make qt cpp meta overload aware"
```

## Task 4: Add Typed Connect Synthesizer

**Files:**
- Create: `src/resolution/qt-widgets-synthesizer.ts`
- Modify: `src/resolution/callback-synthesizer.ts`
- Modify: `__tests__/qt-widgets-integration.test.ts`

- [ ] **Step 1: Add typed connect tests**

Append to `__tests__/qt-widgets-integration.test.ts`:

```ts
  it('synthesizes typed signal-slot connects to the receiver slot', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QMainWindow>
#include <QPushButton>

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  MainWindow();
private slots:
  void onButtonClicked();
};

MainWindow::MainWindow() {
  auto *button = new QPushButton(this);
  connect(button, &QPushButton::clicked, this, &MainWindow::onButtonClicked);
}

void MainWindow::onButtonClicked() {}
`
    );

    await graph!.indexAll();

    const constructor = graph!.getNodesByName('MainWindow').find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::MainWindow'));
    const slot = graph!.getNodesByName('onButtonClicked').find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::onButtonClicked'));
    expect(constructor).toBeDefined();
    expect(slot).toBeDefined();
    expect(graph!.getOutgoingEdges(constructor!.id).some((edge) => edge.kind === 'calls' && edge.target === slot!.id)).toBe(true);
  });

  it('does not synthesize typed connects when the receiver slot is missing', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'mainwindow.cpp'),
      `#include <QMainWindow>
#include <QPushButton>

class MainWindow : public QMainWindow {
  Q_OBJECT
public:
  MainWindow();
};

MainWindow::MainWindow() {
  auto *button = new QPushButton(this);
  connect(button, &QPushButton::clicked, this, &MainWindow::missingSlot);
}
`
    );

    await graph!.indexAll();

    const constructor = graph!.getNodesByName('MainWindow').find((node) => node.kind === 'method' && node.qualifiedName.endsWith('MainWindow::MainWindow'));
    expect(constructor).toBeDefined();
    expect(graph!.getOutgoingEdges(constructor!.id).some((edge) => edge.kind === 'calls')).toBe(false);
  });
```

- [ ] **Step 2: Verify RED**

```bash
npx vitest run __tests__/qt-widgets-integration.test.ts -t "typed signal-slot|receiver slot is missing|duplicate class"
```

Expected: typed positive and duplicate class tests fail; negative missing-slot test passes or fails only if an incorrect edge exists.

- [ ] **Step 3: Implement `qt-widgets-synthesizer.ts`**

Create `src/resolution/qt-widgets-synthesizer.ts` and export a `qtWidgetsEdges(queries: QueryBuilder): Edge[]` entry point. The implementation must:

- read only files already indexed by CodeGraph
- find enclosing method/function nodes by file and line range
- skip connects with no enclosing node
- parse multiline typed connect calls by collecting balanced parentheses after `connect(`
- resolve receiver class using qualified class lookup first, unique simple-name lookup second
- require a unique slot method node id
- emit `Edge` objects:

```ts
{
  source: connectSiteNode.id,
  target: slot.nodeId,
  kind: 'calls',
  provenance: 'heuristic',
  metadata: {
    synthesizedBy: 'qt-widget-connect',
    pattern: 'typed',
    via: `${signalClass}::${signalName}`,
    registeredAt: `${filePath}:${line}`,
  },
}
```

- [ ] **Step 4: Wire synthesizer into `synthesizeCallbackEdges`**

In `src/resolution/callback-synthesizer.ts`, import `qtWidgetsEdges` and merge its returned edges with the other synthesized edges before insertion.

- [ ] **Step 5: Run typed connect tests**

```bash
npx vitest run __tests__/qt-widgets-integration.test.ts -t "typed signal-slot|receiver slot is missing|duplicate class"
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/resolution/qt-widgets-synthesizer.ts src/resolution/callback-synthesizer.ts __tests__/qt-widgets-integration.test.ts
git commit -m "feat: synthesize qt widgets typed connects"
```

## Task 5: Add Macro and Overload Connect Support

**Files:**
- Modify: `src/resolution/qt-widgets-synthesizer.ts`
- Modify: `src/resolution/frameworks/qt/cpp-meta.ts`
- Modify: `__tests__/qt-widgets-integration.test.ts`

- [ ] **Step 1: Add RED tests**

Add tests for:

```cpp
connect(button, SIGNAL(clicked()), this, SLOT(onButtonClicked()));
connect(combo, qOverload<int>(&QComboBox::currentIndexChanged), this, &MainWindow::onIndexChanged);
connect(combo, QOverload<int>::of(&QComboBox::currentIndexChanged), this, &MainWindow::onIndexChanged);
connect(spin, static_cast<void (QSpinBox::*)(int)>(&QSpinBox::valueChanged), this, &MainWindow::onValueChanged);
```

Each test asserts the connect-site node has a `calls` edge to the receiver slot. Add a negative overloaded signal test where the expression does not disambiguate parameter types and assert no edge is created.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run __tests__/qt-widgets-integration.test.ts -t "SIGNAL|qOverload|QOverload|static_cast|ambiguous overload"
```

Expected: positive tests fail until support is implemented.

- [ ] **Step 3: Implement macro parsing**

Parse `SIGNAL(name(types))` and `SLOT(name(types))`. For `this` receiver, infer receiver class from the enclosing connect-site node qualified name. Skip when the enclosing class cannot be inferred.

- [ ] **Step 4: Implement overload parsing**

Parse:

- `qOverload<types...>(&Class::signal)`
- `QOverload<types...>::of(&Class::signal)`
- `static_cast<void (Class::*)(types...)>(&Class::signal)`

Use normalized parameter types against method fact arrays. If zero or more than one target remains, skip.

- [ ] **Step 5: Run tests**

```bash
npx vitest run __tests__/qt-widgets-integration.test.ts -t "SIGNAL|qOverload|QOverload|static_cast|ambiguous overload"
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/resolution/qt-widgets-synthesizer.ts src/resolution/frameworks/qt/cpp-meta.ts __tests__/qt-widgets-integration.test.ts
git commit -m "feat: synthesize qt widgets overload connects"
```

## Task 6: Add `.ui` Registry and Connection Synthesis

**Files:**
- Modify: `src/resolution/frameworks/qt/ui-xml.ts`
- Modify: `src/resolution/qt-widgets-synthesizer.ts`
- Modify: `__tests__/qt-widgets-integration.test.ts`

- [ ] **Step 1: Add RED `.ui` connection test**

Add a test with `mainwindow.ui`:

```xml
<ui version="4.0">
 <class>MainWindow</class>
 <widget class="QMainWindow" name="MainWindow">
  <widget class="QPushButton" name="pushButton"/>
 </widget>
 <connections>
  <connection>
   <sender>pushButton</sender>
   <signal>clicked()</signal>
   <receiver>MainWindow</receiver>
   <slot>onButtonClicked()</slot>
  </connection>
 </connections>
</ui>
```

and a C++ `MainWindow::onButtonClicked` slot. Assert a synthesized calls edge reaches the slot.

- [ ] **Step 2: Implement `.ui` registry types**

In `ui-xml.ts`, export:

```ts
export interface QtUiObjectFact {
  name: string;
  className: string;
  filePath: string;
}

export interface QtUiConnectionFact {
  sender: string;
  signal: string;
  receiver: string;
  slot: string;
  filePath: string;
}

export interface QtUiFileFacts {
  filePath: string;
  formClass?: string;
  objects: QtUiObjectFact[];
  connections: QtUiConnectionFact[];
}
```

Add `parseQtUiXml(filePath, content)` and `getQtUiRegistryFromFiles(files)` helpers. Do not use unresolved refs for `.ui` connections.

- [ ] **Step 3: Synthesize `.ui` connection edges**

In `qt-widgets-synthesizer.ts`, read indexed `.ui` files, parse registries, resolve receiver slots through the Qt C++ registry, and emit `calls` edges with metadata:

```ts
{
  synthesizedBy: 'qt-ui-connection',
  via: `${sender}.${signal}`,
  registeredAt: `${uiFilePath}:1`,
}
```

- [ ] **Step 4: Run `.ui` tests**

```bash
npx vitest run __tests__/qt-widgets-integration.test.ts -t "\\.ui connection"
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/resolution/frameworks/qt/ui-xml.ts src/resolution/qt-widgets-synthesizer.ts __tests__/qt-widgets-integration.test.ts
git commit -m "feat: synthesize qt ui connections"
```

## Task 7: Add `ui->objectName`, Auto-Connect, and Sync Regressions

**Files:**
- Modify: `src/resolution/qt-widgets-synthesizer.ts`
- Modify: `src/resolution/frameworks/qt/ui-xml.ts`
- Modify: `__tests__/qt-widgets-integration.test.ts`

- [ ] **Step 1: Add RED `ui->objectName` connect test**

Use:

```cpp
MainWindow::MainWindow() {
  ui->setupUi(this);
  connect(ui->pushButton, &QPushButton::clicked, this, &MainWindow::onButtonClicked);
}
```

and a `.ui` object named `pushButton`. Assert the connect-site node calls `onButtonClicked`.

- [ ] **Step 2: Add RED auto-connect test**

Use `.ui` object `pushButton` and C++ slot:

```cpp
void MainWindow::on_pushButton_clicked() {}
```

Assert a synthesized edge reaches the auto-connect slot with metadata `synthesizedBy: 'qt-ui-autoconnect'`.

- [ ] **Step 3: Add sync regression tests**

Add tests that:

- change `.ui` object `pushButton` to `saveButton`, call `graph.sync()`, and assert the old auto-connect edge disappears and the new one appears
- change `onButtonClicked()` to `onRenamedClicked()`, call `graph.sync()`, and assert old connect edges disappear
- change `ui->setupUi(this)` owner context so form ownership no longer matches, call `graph.sync()`, and assert owner-based edges disappear

- [ ] **Step 4: Implement form owner inference**

Detect `ui->setupUi(this)` inside class methods/constructors and map the owner class to matching `.ui` form facts. If multiple forms match ambiguously, skip.

- [ ] **Step 5: Implement `ui->objectName` sender type inference**

When a connect sender expression is `ui->name`, get the sender class from the `.ui` registry for the inferred owner.

- [ ] **Step 6: Implement auto-connect synthesis**

For each `.ui` object and each C++ method matching `on_<objectName>_<signalName>`, emit a conservative `calls` edge when the owner class and method node are unique.

- [ ] **Step 7: Run tests**

```bash
npx vitest run __tests__/qt-widgets-integration.test.ts -t "ui->|auto-connect|sync"
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/resolution/qt-widgets-synthesizer.ts src/resolution/frameworks/qt/ui-xml.ts __tests__/qt-widgets-integration.test.ts
git commit -m "feat: synthesize qt ui codebehind links"
```

## Task 8: Documentation and Final Verification

**Files:**
- Modify: `CHANGELOG.md`
- Optional Modify: `src/mcp/server-instructions.ts`

- [ ] **Step 1: Update changelog**

Under `## [Unreleased] > ### New Features`, append:

```md
Qt Widgets projects now resolve high-confidence signal-slot relationships from typed connects, legacy macro connects, overload-disambiguated connects, `.ui` connections, and auto-connect handlers.
```

- [ ] **Step 2: Check MCP guidance**

Open `src/mcp/server-instructions.ts`. If it names QML/Qt only, update it to say `qt` covers QML / Qt Quick and Qt Widgets. Do not claim unsupported lambda/functor inference.

- [ ] **Step 3: Run targeted verification**

```bash
npx vitest run __tests__/qt-widgets-integration.test.ts
npx vitest run __tests__/qml-integration.test.ts
npx vitest run __tests__/frameworks.test.ts __tests__/resolution.test.ts
npm run build
```

Expected: all pass.

- [ ] **Step 4: Run full suite**

```bash
npm test
```

Expected: pass, or document existing unrelated Windows/MCP/multi-repo failures if they reproduce.

- [ ] **Step 5: Inspect final diff**

```bash
git diff --stat "$BASE_REF"..HEAD
git status --short
```

Expected:

- committed files match the plan
- unrelated local changes remain unstaged

- [ ] **Step 6: Commit docs**

```bash
git add CHANGELOG.md src/mcp/server-instructions.ts
git commit -m "docs: note qt widgets support"
```

## Real-Repo Probe Checklist

After deterministic tests pass, probe:

- a tiny hand-written Qt Widgets sample
- a CMake project using `find_package(Qt6 COMPONENTS Widgets)`
- a qmake project using `QT += widgets`
- a project with `.ui` files and auto-connect slots

Verify:

- `getDetectedFrameworks()` contains `qt`
- `codegraph_explore` on a slot surfaces connect sites and `.ui` context
- missing/ambiguous slots do not produce broad false-positive edges
