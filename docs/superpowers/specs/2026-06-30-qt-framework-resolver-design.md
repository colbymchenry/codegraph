# Qt Framework Resolver Design

## Goal

Expose Qt support as one framework resolver named `qt`, while keeping the internal implementation split by Qt surface area. The first migration should preserve existing QML behavior. Widget-specific support can then be added without growing the current QML resolver into a mixed-purpose file.

## Context

The current QML work already parses Qt C++ bridge facts such as `Q_OBJECT`, `Q_PROPERTY`, `Q_INVOKABLE`, signals, public slots, `qmlRegister*`, and `setContextProperty`. Qt Widgets needs many of the same C++ facts, but it resolves different framework edges: signal/slot connections, Designer `.ui` objects, generated `setupUi` usage, and `ui->widget` references.

Treating Widgets as a separate language would duplicate C++ parsing and split one Qt project across multiple framework identities. The intended external model is a single Qt framework with separate internal resolvers for QML and Widgets.

## Proposed Structure

```text
src/resolution/frameworks/qt/
  index.ts
  cpp-meta.ts
  qml.ts
  widgets.ts
  ui-xml.ts
```

`index.ts` exports `qtResolver: FrameworkResolver`. It owns the public framework contract: `name`, `languages`, `detect`, `claimsReference`, `resolve`, `extract`, and any future post-extract hooks.

`cpp-meta.ts` owns shared Qt C++ fact extraction. It should scan C/C++ files once per resolver context and cache immutable registry results keyed by the source/version inputs already used by the current QML bridge code.

`qml.ts` owns the existing QML and QML-to-C++ bridge behavior.

`widgets.ts` owns Qt Widgets behavior such as signal/slot connection resolution.

`ui-xml.ts` owns Designer `.ui` parsing.

## Shared Qt C++ Registry

The shared registry should include:

- Qt classes and structs with `Q_OBJECT` or `Q_GADGET`
- class node ids when matching indexed C++ symbols are available
- methods marked with `Q_INVOKABLE`
- methods declared under `signals:` or `Q_SIGNALS:`
- methods declared under `public slots:`, `private slots:`, `protected slots:`, or `Q_SLOTS`
- `Q_PROPERTY` names and accessor/notify methods
- Qt exposure evidence used to avoid aggressive false-positive resolution

The QML-specific facts should remain separate:

- `qmlRegisterType`
- `qmlRegisterSingletonType`
- `qmlRegisterUncreatableType`
- `setContextProperty`

This split keeps C++ meta-object parsing reusable while preserving QML bridge semantics.

## Public Detection

`qtResolver.detect()` should enable the framework when a project contains any strong Qt signal:

- `.qml` files
- `.ui` files
- C++ source containing `Q_OBJECT`, `Q_GADGET`, `QObject::connect`, `connect(` with Qt signal/slot evidence, `qmlRegisterType`, `qmlRegisterSingletonType`, `setContextProperty`, `QWidget`, `QMainWindow`, or `QDialog`

The public framework name should be `qt`. A temporary `qml-qt` export alias may remain for import compatibility, but framework detection should register the unified `qt` resolver.

## Resolution Flow

`qtResolver.resolve()` should dispatch in this order:

1. QML-specific resolvers for `.qml` references and QML-to-C++ bridge calls.
2. Widgets-specific resolvers for C++ Qt signal/slot and Designer-related references.
3. No framework result when evidence is weak or ambiguous.

QML behavior must remain unchanged in the first migration. Existing language gating that permits explicit QML-to-C++ framework edges should be updated to recognize the new resolver identity without opening general cross-language references.

## Extraction Flow

`qtResolver.extract()` should dispatch by file type:

- `.qml` and `qmldir` use the current QML extraction behavior.
- `.ui` uses Designer XML extraction once implemented.
- Other files return no framework-extracted nodes unless a later phase introduces Qt-specific synthetic nodes.

## Widgets Phase Scope

The first Widgets phase should support C++ signal/slot connection patterns:

```cpp
QObject::connect(button, &QPushButton::clicked, this, &MainWindow::save);
connect(button, &QPushButton::clicked, this, &MainWindow::save);
connect(button, SIGNAL(clicked()), this, SLOT(save()));
```

Resolution should connect the sender signal to the receiver slot or method only when the registry has sufficient Qt evidence. It should prefer exact class-qualified matches. Ambiguous or weak matches should remain unresolved.

Designer `.ui` support should be a later phase:

- parse widget names and classes from `.ui` XML
- parse `.ui` connection signal/slot records
- connect `.ui` widgets to generated `ui->widgetName` references where practical
- connect `setupUi(this)` usage to the corresponding form context

## Testing Strategy

Phase 1, refactor-only:

- existing QML integration tests must pass unchanged
- framework detection tests should expect `qt` for QML projects
- compatibility exports should be covered if retained

Phase 2, Widgets connect:

- function-pointer `QObject::connect`
- unqualified `connect`
- macro `SIGNAL`/`SLOT`
- same method name in unrelated classes does not steal the edge
- no aggressive edge when Qt exposure evidence is missing

Phase 3, Designer `.ui`:

- `.ui` widget extraction
- `.ui` connection extraction
- `setupUi(this)` association
- `ui->widgetName` references

## Migration Plan

1. Create `src/resolution/frameworks/qt/`.
2. Move shared Qt C++ meta-object parsing into `cpp-meta.ts`.
3. Move current QML framework behavior into `qml.ts`.
4. Add `qtResolver` in `index.ts` and register it in the framework list.
5. Preserve QML behavior and tests before adding Widgets behavior.
6. Add Widgets connect support in a separate change.
7. Add Designer `.ui` support after connect behavior is stable.

## Non-Goals

- Do not model every Qt module in the first pass.
- Do not infer signal/slot edges from method names alone.
- Do not fabricate `.ui` relationships without an indexed `.ui` source or explicit `setupUi` evidence.
- Do not broaden cross-language resolution outside explicit Qt framework facts.
