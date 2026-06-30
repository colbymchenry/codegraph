# Qt Widgets Support Design

## Goal

Add real Qt Widgets code intelligence under the unified public `qt` framework resolver. QML / Qt Quick continues to use `src/resolution/frameworks/qt/qml.ts`; Widgets support is added through Qt-specific C++ facts and a synthesized-edge pass.

The feature should let CodeGraph answer practical Widgets questions:

- which slot handles a button or action signal
- which connect sites register a slot
- which emit sites can reach connected slots
- which `.ui` object backs a `ui->objectName` reference
- which auto-connect handler corresponds to a `.ui` object and signal

## Current State

CodeGraph already has general C/C++ graph extraction. It indexes files, classes, structs, methods, functions, inheritance, includes, and ordinary call references.

The Qt-specific layer is separate:

- `src/resolution/frameworks/qt/index.ts` is the only public `qt` framework resolver.
- `src/resolution/frameworks/qt/qml.ts` implements QML / Qt Quick framework behavior.
- `src/resolution/frameworks/qt/cpp-meta.ts` parses Qt meta-object facts such as `Q_OBJECT`, `Q_PROPERTY`, `Q_INVOKABLE`, `signals:`, and slots.
- `src/resolution/frameworks/qt/widgets.ts` is currently a no-op scaffold.
- `src/resolution/frameworks/qt/ui-xml.ts` is currently a no-op `.ui` scaffold.

`cpp-meta.ts` does not replace the C++ graph. It answers "what do these C++ symbols mean to Qt?" and attaches those facts back to existing C++ nodes.

## Architectural Decision: Synthesizer, Not Unresolved Metadata

Qt Widgets facts should not be transported through `UnresolvedRef.metadata`. The current unresolved-reference contract and DB schema do not persist arbitrary metadata, and unresolved refs without real source node ids are filtered out during extraction.

Widgets support should therefore use a post-resolution synthesized-edge pass, following the existing dynamic-dispatch pattern used by callback, function-pointer, framework, and event synthesizers:

1. Existing extraction indexes C++ and XML files normally.
2. The Qt C++ registry reads indexed files and existing nodes to build Qt facts.
3. A new `qt-widgets-synthesizer.ts` scans source files and `.ui` registries for connect facts.
4. The synthesizer emits `Edge[]` directly with `provenance: 'heuristic'` and metadata such as `synthesizedBy: 'qt-widget-connect'`.
5. The resolver pipeline persists those synthesized edges after ordinary resolution, and sync re-runs the synthesizer so stale edges are removed/rebuilt with the rest of the graph.

This design supports multiple edges per connect relationship:

- connect-site function/method -> receiver slot
- signal method -> receiver slot
- emit-site function/method -> signal method where the signal method node exists

## Public Resolver Shape

The public framework identity remains `qt`. There is no `qml-qt` compatibility alias.

`qtResolver` still delegates:

- QML and `qmldir`: `qt/qml.ts`
- `.ui` XML extraction facts: `qt/ui-xml.ts`
- C++ Widgets detection and no-op framework extraction: `qt/widgets.ts`

`qtResolver.languages` must include the C/C++ languages needed for Widgets detection and any framework extraction hooks, but core Widgets edges come from the synthesizer rather than `resolveQtWidgets()`.

## Qt C++ Meta Registry

`cpp-meta.ts` should become a shared Qt C++ fact registry for QML and Widgets.

Required facts:

- QObject-like class evidence: `Q_OBJECT`, `Q_GADGET`, `QObject` / `QWidget` / `QMainWindow` / `QDialog` inheritance, and `Ui::` usage.
- class indexes by both qualified name and simple name.
- method facts grouped by method name, because overloaded signals and slots need multiple facts per name.
- normalized signatures: name, arity, parameter type list, visibility, signal/slot/invokable flags, and attached method node id.
- base class names for conservative inherited signal/slot lookup.

The registry should avoid global simple-name guesses. Simple-name lookup is allowed only when it produces a unique class in the project or in the relevant file/class context.

## Widgets Connection Model

Widgets connection parsing belongs in the synthesizer and should be conservative.

Supported forms, phased:

```cpp
connect(button, &QPushButton::clicked, this, &MainWindow::onButtonClicked);
QObject::connect(sender, &Worker::finished, receiver, &Controller::handleFinished);
connect(button, SIGNAL(clicked()), this, SLOT(onButtonClicked()));
connect(combo, qOverload<int>(&QComboBox::currentIndexChanged), this, &MainWindow::onIndexChanged);
connect(combo, QOverload<int>::of(&QComboBox::currentIndexChanged), this, &MainWindow::onIndexChanged);
connect(spin, static_cast<void (QSpinBox::*)(int)>(&QSpinBox::valueChanged), this, &MainWindow::onValueChanged);
```

No edge should be created when:

- the enclosing connect-site node cannot be identified
- receiver class cannot be inferred
- the slot method is missing
- overload resolution is ambiguous
- a class name collision cannot be narrowed by qualified name, namespace, file, or owner context

## `.ui` XML and Code-Behind Model

`.ui` parsing should produce a registry, not arbitrary unresolved refs:

- form class
- widget/action object names
- widget/action class names
- `<connection>` sender/signal/receiver/slot facts

Widgets synthesis then uses this registry to:

- resolve `.ui` `<connections>` to C++ slots
- infer sender type for `ui->pushButton`
- link `ui->objectName` member reads to `.ui` object nodes when those nodes exist
- synthesize auto-connect edges for methods matching `on_<objectName>_<signalName>()`

`ui->setupUi(this)` should be used to infer the owner C++ class for a form. If multiple `.ui` forms match the same owner ambiguously, skip the synthesized edge.

## Sync Requirements

Widgets support introduces cross-file derived state, so sync coverage is mandatory. Tests must cover:

- changing a slot name/signature removes the old edge and adds the new edge
- changing a `.ui` object name updates `ui->objectName` and auto-connect edges
- changing a `.ui` connection updates the connected slot
- changing `ui->setupUi(this)` owner context removes stale owner-based edges

## Safety Rules

- Do not execute moc, qmake, cmake, or user build scripts.
- Do not require Qt headers to be installed.
- Prefer missing edges over wrong edges.
- Treat overloads as unresolved unless the expression disambiguates them.
- Lambda/functor connects are dynamic boundaries unless an existing graph node can be identified confidently.

## Phased Delivery

### Phase A: Routing, Detection, and Typed Connect Synthesizer

Enable `qt` on C/C++ languages, detect Widgets projects, extend the Qt C++ registry for overloaded methods and qualified class lookup, and synthesize high-confidence typed connect edges.

### Phase B: Macro and Overload Connects

Add `SIGNAL` / `SLOT`, `qOverload`, `QOverload`, and `static_cast` support with ambiguity tests.

### Phase C: `.ui` XML and Auto-Connect

Parse `.ui` registries, resolve `.ui` `<connections>`, support `ui->objectName` sender type inference, and synthesize auto-connect edges.

### Phase D: Hardening and Real-Repo Validation

Run focused tests, full QML regressions, sync regressions, full build/test where feasible, and real Qt Widgets repository probes.

## Out of Scope

The first implementation should not attempt:

- executing Qt build tooling
- perfect C++ type inference
- arbitrary template metaprogramming
- guaranteed lambda/functor target identification
- broad edges for ambiguous overloads or duplicate class names
