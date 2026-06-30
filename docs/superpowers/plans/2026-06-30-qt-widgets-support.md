# Qt Widgets Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real Qt Widgets support to the unified `qt` framework resolver while preserving existing QML / Qt Quick behavior.

**Architecture:** Extend the existing Qt package under `src/resolution/frameworks/qt/`. `cpp-meta.ts` remains the shared Qt C++ meta-object registry, `widgets.ts` owns Widgets connect and auto-connect behavior, and `ui-xml.ts` owns `.ui` XML facts. The public resolver name remains `qt`; there is no `qml-qt` compatibility path.

**Tech Stack:** TypeScript, Vitest, SQLite-backed CodeGraph integration tests, existing tree-sitter C/C++ extraction, conservative regex parsing for Qt meta-object and connect facts.

---

## Scope

This plan implements Qt Widgets in four incremental phases:

1. C++ language routing, Widgets detection, and typed connect support.
2. Legacy macro and overload connect forms.
3. `.ui` XML, `ui->objectName`, and auto-connect handlers.
4. Documentation, final verification, and real-repo probe commands.

The implementation must not execute Qt build tooling, moc, qmake, cmake, or project scripts. It must prefer missing edges over fabricated edges.

## File Structure

- Modify: `src/resolution/frameworks/qt/index.ts`
  - Add C/C++ languages to `qtResolver.languages`.
  - Keep routing QML refs to `resolveQmlQt` and route non-QML refs to `resolveQtWidgets`.

- Modify: `src/resolution/frameworks/qt/cpp-meta.ts`
  - Extend `QtCppClassFacts`, `QtCppMethodFact`, and registry helpers for Widgets.
  - Parse signal/slot signatures, method arity, visibility, inheritance names, and QObject/QWidget evidence.
  - Export helper functions for Widgets resolution.

- Modify: `src/resolution/frameworks/qt/widgets.ts`
  - Implement Widgets detection.
  - Extract connect facts from C++ files.
  - Resolve typed, macro, overload, `.ui`, and auto-connect references conservatively.

- Modify: `src/resolution/frameworks/qt/ui-xml.ts`
  - Parse `.ui` XML object names, widget classes, actions, and `<connections>`.
  - Expose a cache/registry consumed by `widgets.ts`.

- Modify: `__tests__/frameworks.test.ts`
  - Add resolver language routing coverage for `cpp` and `c`.

- Create: `__tests__/qt-widgets-integration.test.ts`
  - End-to-end Widgets tests for detection, typed connects, macro/overload connects, `.ui`, auto-connect, and negative cases.

- Modify: `CHANGELOG.md`
  - Add a user-facing note that `qt` now covers Qt Widgets signal-slot and `.ui` relationships.

## Task 1: Add Failing Widgets Routing and Detection Tests

**Files:**
- Modify: `__tests__/frameworks.test.ts`
- Create: `__tests__/qt-widgets-integration.test.ts`

- [ ] **Step 1: Add resolver language routing assertions**

In `__tests__/frameworks.test.ts`, extend the Qt public identity describe block with:

```ts
  it('routes Qt framework extraction to C and C++ files for Widgets support', () => {
    expect(qtResolver.languages).toContain('cpp');
    expect(qtResolver.languages).toContain('c');
    expect(getApplicableFrameworks([qtResolver], 'cpp')).toEqual([qtResolver]);
    expect(getApplicableFrameworks([qtResolver], 'c')).toEqual([qtResolver]);
  });
```

- [ ] **Step 2: Create the Qt Widgets integration test file**

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
    graph = new CodeGraph(tmpDir);
  });

  afterEach(async () => {
    if (graph) await graph.close();
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

- [ ] **Step 3: Run the failing tests**

Run:

```bash
npx vitest run __tests__/frameworks.test.ts -t "routes Qt framework extraction"
npx vitest run __tests__/qt-widgets-integration.test.ts -t "detects Qt Widgets"
```

Expected:

- The framework routing test fails because `qtResolver.languages` does not include `cpp`/`c`.
- The Widgets detection test fails because `detectQtWidgets()` returns `false`.

- [ ] **Step 4: Commit the failing tests**

```bash
git add __tests__/frameworks.test.ts __tests__/qt-widgets-integration.test.ts
git commit -m "test: define qt widgets routing"
```

## Task 2: Implement Widgets Detection and C++ Routing

**Files:**
- Modify: `src/resolution/frameworks/qt/index.ts`
- Modify: `src/resolution/frameworks/qt/widgets.ts`

- [ ] **Step 1: Route Qt framework extraction to C/C++**

In `src/resolution/frameworks/qt/index.ts`, change:

```ts
  languages: ['qml', 'yaml', 'xml'],
```

to:

```ts
  languages: ['qml', 'yaml', 'xml', 'cpp', 'c'],
```

- [ ] **Step 2: Add conservative Widgets detection**

In `src/resolution/frameworks/qt/widgets.ts`, replace `detectQtWidgets` with:

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

- [ ] **Step 3: Keep Widgets extraction no-op for now**

Do not implement `extractQtWidgets` yet. This task only proves routing and detection.

- [ ] **Step 4: Run routing and detection tests**

Run:

```bash
npx vitest run __tests__/frameworks.test.ts -t "routes Qt framework extraction"
npx vitest run __tests__/qt-widgets-integration.test.ts -t "detects Qt Widgets"
```

Expected: both pass.

- [ ] **Step 5: Run QML regression tests**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts
```

Expected: all QML tests pass.

- [ ] **Step 6: Commit routing and detection**

```bash
git add src/resolution/frameworks/qt/index.ts src/resolution/frameworks/qt/widgets.ts
git commit -m "feat: detect qt widgets projects"
```

## Task 3: Extend the Qt C++ Meta Registry for Widgets

**Files:**
- Modify: `src/resolution/frameworks/qt/cpp-meta.ts`
- Modify: `__tests__/qt-widgets-integration.test.ts`

- [ ] **Step 1: Add a failing typed connect test**

Append to `__tests__/qt-widgets-integration.test.ts`:

```ts
  it('resolves typed signal-slot connects to the receiver slot', async () => {
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
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
npx vitest run __tests__/qt-widgets-integration.test.ts -t "typed signal-slot"
```

Expected: fail because no Widgets connect edge exists.

- [ ] **Step 3: Extend Qt method facts**

In `src/resolution/frameworks/qt/cpp-meta.ts`, extend `QtCppMethodFact`:

```ts
export interface QtCppMethodFact {
  name: string;
  invokable: boolean;
  publicSlot: boolean;
  privateOrProtectedSlot?: boolean;
  signal?: boolean;
  visibility?: 'public' | 'protected' | 'private';
  signature?: string;
  arity?: number;
  parameterTypes?: string[];
  nodeId?: string;
}
```

Extend `QtCppClassFacts`:

```ts
export interface QtCppClassFacts {
  name: string;
  classNodeId?: string;
  baseClassNames: string[];
  methods: Map<string, QtCppMethodFact>;
  properties: Map<string, QtCppPropertyFact>;
  signals: Set<string>;
  hasQmlExposureEvidence: boolean;
  hasWidgetsEvidence: boolean;
}
```

- [ ] **Step 4: Add method signature helpers**

Add helper functions near `simpleCppTypeName`:

```ts
function normalizeCppType(typeName: string): string {
  return typeName
    .replace(/\bconst\b/g, '')
    .replace(/[&*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseParameterTypes(params: string): string[] {
  const trimmed = params.trim();
  if (!trimmed || trimmed === 'void') return [];
  return trimmed
    .split(',')
    .map((part) => normalizeCppType(part.replace(/\s+[A-Za-z_][A-Za-z0-9_]*\s*$/, '')))
    .filter(Boolean);
}
```

- [ ] **Step 5: Track method node ids**

Update `attachQtCppNodes` so method nodes attach to class method facts:

```ts
  for (const node of context.getNodesByKind('method')) {
    if (node.language !== 'cpp') continue;
    const owner = node.qualifiedName.includes('::') ? node.qualifiedName.split('::').slice(-2, -1)[0] : undefined;
    if (!owner) continue;
    const facts = registry.classes.get(owner);
    const method = facts?.methods.get(node.name);
    if (method) method.nodeId = node.id;
  }
```

- [ ] **Step 6: Preserve QML behavior**

Keep `hasQmlExposureEvidence` semantics unchanged for QML bridge tests. Widgets metadata must add fields without changing which QML methods are considered invokable or public slots.

- [ ] **Step 7: Run QML bridge and Widgets typed tests**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts -t "C\\+\\+/QML bridge|private or protected slots|aliased and versioned"
npx vitest run __tests__/qt-widgets-integration.test.ts -t "typed signal-slot"
```

Expected: QML tests pass; Widgets test still fails until Task 4 implements connect extraction.

- [ ] **Step 8: Commit registry extension**

```bash
git add src/resolution/frameworks/qt/cpp-meta.ts __tests__/qt-widgets-integration.test.ts
git commit -m "refactor: extend qt cpp meta for widgets"
```

## Task 4: Implement Typed Connect Extraction and Resolution

**Files:**
- Modify: `src/resolution/frameworks/qt/widgets.ts`
- Modify: `src/resolution/frameworks/qt/cpp-meta.ts`

- [ ] **Step 1: Add Widgets unresolved reference metadata type**

In `widgets.ts`, add:

```ts
interface QtWidgetConnectRef {
  pattern: 'typed';
  signalClass: string;
  signalName: string;
  receiverClass: string;
  slotName: string;
}
```

Encode this metadata in `UnresolvedRef.metadata` when extracting connect calls.

- [ ] **Step 2: Parse typed connect expressions**

Add a parser in `widgets.ts`:

```ts
const typedConnectPattern =
  /\b(?:QObject::)?connect\s*\(\s*[^,]+,\s*&([A-Za-z_][A-Za-z0-9_:]*)::([A-Za-z_][A-Za-z0-9_]*)\s*,\s*[^,]+,\s*&([A-Za-z_][A-Za-z0-9_:]*)::([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
```

For each match, emit an unresolved reference:

```ts
{
  fromNodeId: '',
  fromName: '<connect-site>',
  referenceName: `${receiverClass}::${slotName}`,
  referenceKind: 'calls',
  filePath,
  line,
  column,
  language: 'cpp',
  metadata: {
    framework: 'qt',
    qtWidgetConnect: {
      pattern: 'typed',
      signalClass,
      signalName,
      receiverClass,
      slotName,
    },
  },
}
```

Use the enclosing method/function node when possible. Follow existing framework extractors for unresolved reference shape.

- [ ] **Step 3: Implement `claimsQtWidgetsReference`**

Return true only for refs with `metadata.framework === 'qt'` and `metadata.qtWidgetConnect`.

- [ ] **Step 4: Implement `resolveQtWidgets`**

Use `getQtCppMetaRegistry(context)` to resolve:

1. Receiver class facts by `receiverClass`
2. Slot method fact by `slotName`
3. Unique `nodeId` on the slot method

If no unique node exists, return `null`.

Return:

```ts
{
  targetNodeId: slot.nodeId,
  confidence: 0.9,
  resolvedBy: 'framework',
  metadata: {
    framework: 'qt',
    pattern: 'qt-widget-connect',
    signalClass,
    signalName,
  },
}
```

- [ ] **Step 5: Run typed connect test**

Run:

```bash
npx vitest run __tests__/qt-widgets-integration.test.ts -t "typed signal-slot"
```

Expected: pass.

- [ ] **Step 6: Add negative typed connect test**

Add to `__tests__/qt-widgets-integration.test.ts`:

```ts
  it('does not resolve typed connects when the receiver slot is missing', async () => {
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

- [ ] **Step 7: Run Widgets suite**

Run:

```bash
npx vitest run __tests__/qt-widgets-integration.test.ts
```

Expected: all Widgets tests pass.

- [ ] **Step 8: Commit typed connect support**

```bash
git add src/resolution/frameworks/qt/widgets.ts src/resolution/frameworks/qt/cpp-meta.ts __tests__/qt-widgets-integration.test.ts
git commit -m "feat: resolve qt widgets typed connects"
```

## Task 5: Add Legacy Macro and Overload Connect Support

**Files:**
- Modify: `src/resolution/frameworks/qt/widgets.ts`
- Modify: `src/resolution/frameworks/qt/cpp-meta.ts`
- Modify: `__tests__/qt-widgets-integration.test.ts`

- [ ] **Step 1: Add failing tests for macro and overload forms**

Add tests covering:

```cpp
connect(button, SIGNAL(clicked()), this, SLOT(onButtonClicked()));
connect(combo, qOverload<int>(&QComboBox::currentIndexChanged), this, &MainWindow::onIndexChanged);
connect(combo, QOverload<int>::of(&QComboBox::currentIndexChanged), this, &MainWindow::onIndexChanged);
connect(spin, static_cast<void (QSpinBox::*)(int)>(&QSpinBox::valueChanged), this, &MainWindow::onValueChanged);
```

Each test should assert the connect site function/method has a `calls` edge to the receiver slot.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run __tests__/qt-widgets-integration.test.ts -t "macro|qOverload|QOverload|static_cast"
```

Expected: fail because only typed connect is supported.

- [ ] **Step 3: Implement signature normalization**

In `cpp-meta.ts`, export:

```ts
export function normalizeQtSignature(signature: string): { name: string; parameterTypes: string[] } | null {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*$/.exec(signature);
  if (!match) return null;
  return {
    name: match[1]!,
    parameterTypes: parseParameterTypes(match[2] ?? ''),
  };
}
```

- [ ] **Step 4: Implement macro connect parsing**

In `widgets.ts`, parse `SIGNAL(...)` and `SLOT(...)`. For macro receiver `this`, infer the enclosing class from the connect site node's qualified name.

Return `null` when receiver class cannot be inferred.

- [ ] **Step 5: Implement overload connect parsing**

Add parsers for:

- `qOverload<...>(&Class::signal)`
- `QOverload<...>::of(&Class::signal)`
- `static_cast<void (Class::*)(...)>(&Class::signal)`

Use normalized parameter types to disambiguate overloaded methods. If multiple candidates remain, do not resolve.

- [ ] **Step 6: Run overload tests**

Run:

```bash
npx vitest run __tests__/qt-widgets-integration.test.ts -t "macro|qOverload|QOverload|static_cast"
```

Expected: pass.

- [ ] **Step 7: Add ambiguous overload negative test**

Add a test where a signal name has multiple overloads and the connect expression does not specify types. Assert no edge is created.

- [ ] **Step 8: Commit macro and overload support**

```bash
git add src/resolution/frameworks/qt/widgets.ts src/resolution/frameworks/qt/cpp-meta.ts __tests__/qt-widgets-integration.test.ts
git commit -m "feat: resolve qt widgets overload connects"
```

## Task 6: Add `.ui` XML Object and Connection Parsing

**Files:**
- Modify: `src/resolution/frameworks/qt/ui-xml.ts`
- Modify: `src/resolution/frameworks/qt/widgets.ts`
- Modify: `__tests__/qt-widgets-integration.test.ts`

- [ ] **Step 1: Add failing `.ui` connection test**

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

and C++:

```cpp
class MainWindow : public QMainWindow {
  Q_OBJECT
public slots:
  void onButtonClicked();
};

void MainWindow::onButtonClicked() {}
```

Assert the `.ui` connection resolves to the C++ slot method.

- [ ] **Step 2: Implement `.ui` registry**

In `ui-xml.ts`, parse:

- `<class>...`
- `<widget class="..." name="...">`
- `<action name="...">`
- `<connection>` sender/signal/receiver/slot

Expose:

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
```

Add cached `getQtUiRegistry(context)`.

- [ ] **Step 3: Emit framework references from `.ui` extraction**

`extractQtUiXml()` should emit unresolved references for `<connections>` with metadata `{ framework: 'qt', qtUiConnection: ... }`.

- [ ] **Step 4: Resolve `.ui` connection refs in `resolveQtWidgets`**

Use `normalizeQtSignature()` and `getQtCppMetaRegistry(context)` to resolve receiver slot methods.

- [ ] **Step 5: Run `.ui` test**

Run:

```bash
npx vitest run __tests__/qt-widgets-integration.test.ts -t "\\.ui connection"
```

Expected: pass.

- [ ] **Step 6: Commit `.ui` connection support**

```bash
git add src/resolution/frameworks/qt/ui-xml.ts src/resolution/frameworks/qt/widgets.ts __tests__/qt-widgets-integration.test.ts
git commit -m "feat: resolve qt ui connections"
```

## Task 7: Add `ui->objectName` and Auto-Connect Support

**Files:**
- Modify: `src/resolution/frameworks/qt/widgets.ts`
- Modify: `src/resolution/frameworks/qt/ui-xml.ts`
- Modify: `__tests__/qt-widgets-integration.test.ts`

- [ ] **Step 1: Add failing `ui->objectName` test**

Create C++ with:

```cpp
MainWindow::MainWindow() {
  ui->setupUi(this);
  connect(ui->pushButton, &QPushButton::clicked, this, &MainWindow::onButtonClicked);
}
```

and a `.ui` object named `pushButton`. Assert the connect resolves to `onButtonClicked`.

- [ ] **Step 2: Add failing auto-connect test**

Use `.ui` object `pushButton` and C++ slot:

```cpp
void MainWindow::on_pushButton_clicked() {}
```

Assert a synthesized calls edge exists from the `.ui` object/signal or owner class setup path to the auto-connect slot.

- [ ] **Step 3: Implement form owner inference**

In `widgets.ts`, detect `ui->setupUi(this)` inside a class method/constructor and map the owning C++ class to matching `.ui` form facts.

- [ ] **Step 4: Implement `ui->objectName` sender type inference**

When parsing connect sender expressions, recognize `ui->name` and get the object class from `getQtUiRegistry(context)`.

- [ ] **Step 5: Implement auto-connect synthesis**

For each `.ui` object and each C++ method matching:

```text
on_<objectName>_<signalName>
```

create a conservative framework resolution edge to the method when:

- the owner class can be inferred
- the method exists uniquely
- the object exists in exactly one matching `.ui` form for that owner

- [ ] **Step 6: Run auto-connect tests**

Run:

```bash
npx vitest run __tests__/qt-widgets-integration.test.ts -t "ui->|auto-connect"
```

Expected: pass.

- [ ] **Step 7: Commit code-behind support**

```bash
git add src/resolution/frameworks/qt/widgets.ts src/resolution/frameworks/qt/ui-xml.ts __tests__/qt-widgets-integration.test.ts
git commit -m "feat: resolve qt ui codebehind links"
```

## Task 8: Documentation and Final Verification

**Files:**
- Modify: `CHANGELOG.md`
- Optional Modify: `src/mcp/server-instructions.ts`

- [ ] **Step 1: Update changelog**

Under `## [Unreleased] > ### New Features`, append a sentence to the Qt bullet:

```md
Qt Widgets projects now resolve high-confidence signal-slot relationships from typed connects, legacy macro connects, overload-disambiguated connects, `.ui` connections, and auto-connect handlers.
```

- [ ] **Step 2: Check MCP guidance**

Open `src/mcp/server-instructions.ts`. If it names QML/Qt only, update it to say the `qt` resolver covers QML / Qt Quick and Qt Widgets. Do not add claims about unsupported forms.

- [ ] **Step 3: Run targeted tests**

Run:

```bash
npx vitest run __tests__/qt-widgets-integration.test.ts
npx vitest run __tests__/qml-integration.test.ts
npx vitest run __tests__/frameworks.test.ts __tests__/resolution.test.ts
npm run build
```

Expected: all pass.

- [ ] **Step 4: Run full test suite**

Run:

```bash
npm test
```

Expected: pass, or document existing unrelated Windows/MCP/multi-repo failures if they reproduce.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git diff --stat HEAD~7..HEAD
git status --short
```

Expected:

- Qt Widgets changes are committed in focused commits.
- Existing unrelated local files remain unstaged unless they are part of this plan.

- [ ] **Step 6: Commit docs**

```bash
git add CHANGELOG.md src/mcp/server-instructions.ts
git commit -m "docs: note qt widgets support"
```

## Real-Repo Probe Checklist

After implementation passes deterministic tests, probe at least:

- a tiny hand-written Qt Widgets sample
- a CMake Qt Widgets project using `find_package(Qt6 COMPONENTS Widgets)`
- a qmake project using `QT += widgets`
- a project with `.ui` files and auto-connect slots

Use CodeGraph tools to verify:

- `getDetectedFrameworks()` contains `qt`
- `codegraph_explore` on a slot surfaces connect sites and `.ui` context
- no broad false-positive edges appear for missing or ambiguous slots
