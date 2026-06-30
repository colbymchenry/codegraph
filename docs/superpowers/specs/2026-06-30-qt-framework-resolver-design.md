# Qt Framework Resolver Design

## Goal

Expose Qt support as one framework resolver named `qt`, while keeping the internal implementation split by Qt surface area. The first migration should preserve existing QML behavior exactly except for any explicitly accepted framework-name migration. Widget-specific support should be added only after the graph shape and declaration-node prerequisites are defined.

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

`index.ts` exports `qtResolver: FrameworkResolver`. It owns the public framework contract: `name`, `languages`, `detect`, `claimsReference`, `resolve`, `extract`, and any future post-extract hooks. The initial `languages` list must preserve current QML and `qmldir` extraction behavior. If `.ui` support requires a file type that is not already routed through framework extraction, that language-detection change is a prerequisite for the `.ui` phase rather than an implicit part of the resolver move.

`cpp-meta.ts` owns shared Qt C++ fact extraction. It should scan C/C++ files once per resolver context and cache immutable registry results keyed by C/C++ source/version inputs. QML bridge facts and future `.ui` facts must keep separate cache keys so unrelated file changes do not invalidate or stale the wrong surface.

`qml.ts` owns the existing QML and QML-to-C++ bridge behavior.

`widgets.ts` owns Qt Widgets behavior such as signal/slot connection analysis. It should not run for QML references.

`ui-xml.ts` owns Designer `.ui` parsing.

## Shared Qt C++ Registry

The shared registry should include:

- Qt classes and structs with `Q_OBJECT` or `Q_GADGET`
- class node ids when matching indexed C++ symbols are available
- methods marked with `Q_INVOKABLE`
- methods declared under `signals:` or `Q_SIGNALS:`
- methods declared under `public slots:`, `private slots:`, `protected slots:`, or `Q_SLOTS`
- method-level `Q_SIGNAL` and `Q_SLOT` annotations
- normalized signature text or at least arity and canonical parameter text for signal/slot declarations
- declaration locations and declaration-backed method ids when such nodes exist or are synthesized
- `Q_PROPERTY` names and accessor/notify methods
- Qt exposure evidence used to avoid aggressive false-positive resolution

The QML-specific facts should remain separate:

- `qmlRegisterType`
- `qmlRegisterSingletonType`
- `qmlRegisterUncreatableType`
- `setContextProperty`

This split keeps C++ meta-object parsing reusable while preserving QML bridge semantics.

Collecting broader Qt facts must not make those facts QML-visible. The QML resolver keeps its current narrower visibility model:

- QML calls resolve to C++ only through context properties or imported registered singletons.
- QML calls target only `Q_INVOKABLE` methods or public slots currently considered QML-visible.
- QML property reads resolve only through `Q_PROPERTY` `READ` accessors.
- QML component references resolve only to imported creatable registered types.
- QML explicit property type references resolve only to imported creatable or uncreatable registered types.
- QML `Connections` handling remains scoped to the nearest `Connections { target: ... }`, and same-scope QML shadowing suppresses C++ context-property resolution.

## Public Detection

`qtResolver.detect()` should enable the framework when a project contains strong Qt evidence. Detection should separate strong and weak signals so non-Qt C++ projects with generic `connect` helpers do not pay Qt resolver costs.

- `.qml` files
- `.ui` files
- C++ source containing `Q_OBJECT`, `Q_GADGET`, `QObject::connect`, `qmlRegisterType`, `qmlRegisterSingletonType`, or `setContextProperty`
- C++ source containing Qt includes/imports plus Qt-specific connect syntax such as `&Type::member`, `SIGNAL(...)`, or `SLOT(...)`
- Widget base names such as `QWidget`, `QMainWindow`, or `QDialog` only when paired with Qt headers or meta-object evidence

The public framework name should be `qt`. This is a user-visible migration because `getDetectedFrameworks()` currently exposes resolver names. The implementation must choose one compatibility policy before code changes:

- breaking rename: `getDetectedFrameworks()` returns `qt`, tests and docs are updated, and the changelog calls out the rename from `qml-qt`; or
- compatibility window: `qtResolver` is registered as the real resolver, while `getFrameworkResolver('qml-qt')`, `qmlQtResolver` symbol imports, and any retained module-path shim continue to map to the unified resolver until a documented removal.

## Resolution Flow

`qtResolver.resolve()` should dispatch in this order:

1. QML-specific resolvers for `.qml` references and QML-to-C++ bridge calls.
2. Widgets-specific resolvers for C++ Qt signal/slot and Designer-related references, only for C/C++ references with strong Qt evidence.
3. No framework result when evidence is weak or ambiguous.

QML behavior must remain unchanged in the first migration. Existing language gating is not keyed by resolver name; it permits explicit QML-to-C++ framework edges by source language, target language, and `resolvedBy: 'framework'`. Preserve that invariant. Do not add a broad `qt` name-based gate. If Widgets support needs C++-only synthesized edges, keep their provenance separate from QML bridge results.

`claimsReference()` must remain conservative and surface-specific:

- QML claim logic stays equivalent to the current resolver in Phase 1.
- Widgets claim logic may only opt in explicit Qt connection or Designer-shaped references.
- Generic C++ names and generic `connect` calls are not enough to claim a reference.

## Extraction Flow

`qtResolver.extract()` should dispatch by file type:

- `.qml` and `qmldir` use the current QML extraction behavior.
- `.ui` uses Designer XML extraction once implemented.
- Other files return no framework-extracted nodes unless a later phase introduces Qt-specific synthetic nodes.

`qmldir` is a named Phase 1 preservation target. The migration must preserve module/import node extraction, alias imports, internal-component exclusions, version compatibility, dependency imports, metadata-only retargeting, and invalidation behavior where unrelated importers are not reindexed.

## Widgets Phase Scope

The first Widgets implementation phase must start by defining a graph shape that the current infrastructure can represent. `FrameworkResolver.resolve()` can return only one target for a single unresolved reference from the calling node; it cannot directly create a signal-method to slot-method edge. Function-pointer arguments may also be consumed by generic function-reference resolution before framework resolution.

There are two acceptable implementation shapes:

- registration-site model: the function or method containing `connect(...)` gets a `calls` or `references` edge to the receiver slot, with metadata noting the sender signal when known; or
- Qt post-pass model: a Qt-specific extraction or post-extract pass synthesizes dedicated signal and slot references or edges after both endpoints are known.

The post-pass model is preferred for eventual signal-to-slot fidelity. Before implementing it, C++ signal/slot declarations must be indexed or synthesized as declaration-backed method nodes; otherwise many real Qt targets will be absent.

The first Widgets connection parser should support only explicitly safe patterns:

```cpp
QObject::connect(button, &QPushButton::clicked, this, &MainWindow::save);
connect(button, &QPushButton::clicked, this, &MainWindow::save);
connect(button, SIGNAL(clicked()), this, SLOT(save()));
connect(button, &QPushButton::clicked, this, &MainWindow::save, Qt::QueuedConnection);
connect(button, SIGNAL(clicked()), this, SLOT(save()), Qt::QueuedConnection);
```

Resolution should connect only when the registry has sufficient Qt evidence. It should prefer exact class-qualified and signature-compatible matches. Ambiguous or weak matches remain unresolved.

The signature parser should account for:

- `&Type::signal`
- `qOverload<T...>(&Type::signal)`
- `QOverload<T...>::of(&Type::signal)`
- `static_cast<...>(&Type::signal)`
- `SIGNAL(name(args))` and `SLOT(name(args))`

Lambda, functor, `std::bind`, and receiver-context overloads should be explicit non-goals for the first Widgets connection pass unless the implementation adds a tested representation for them.

Designer `.ui` support should be a later phase:

- parse widget names and classes from `.ui` XML
- parse `.ui` connection signal/slot records
- treat `.ui` XML as canonical; generated `ui_*.h` files are optional corroboration
- cover common form ownership shapes: `Ui::X *ui`, `Ui::X ui`, `Ui_X`, and classes inheriting `private Ui::X`
- connect `.ui` widgets to `ui->widgetName` references only after source or extraction support preserves that receiver chain
- connect `setupUi(this)` usage to the corresponding form context
- add a separate auto-connect phase for `QMetaObject::connectSlotsByName` and `on_<objectName>_<signal>` slots

## Testing Strategy

Phase 1, refactor-only:

- existing QML integration behavior must pass unchanged, except for the explicitly chosen framework-name migration
- framework detection tests should cover the chosen `qt` versus `qml-qt` compatibility policy
- compatibility exports, module-path shims, and `getFrameworkResolver('qml-qt')` behavior should be covered if retained
- QML bridge invariants should be named in tests: hidden methods remain hidden, uncreatable component instances do not instantiate, context-property shadowing wins, `Connections` target scoping is preserved, alias and version disambiguation work for `qmlRegisterType`, `qmlRegisterSingletonType`, and `qmlRegisterUncreatableType`
- non-bridge QML invariants should remain covered: literal `Loader` URL resolution, project-defined or `qmldir`-exported `Loader` shadowing, uppercase `.QML`, built-in type non-stealing, exported-name-versus-basename handling, and versionless `qmldir` import selection
- sync tests should cover adding, changing, and removing C++ bridge facts such as `Q_OBJECT`, `Q_PROPERTY`, `Q_INVOKABLE`, `setContextProperty`, and `qmlRegister*`

Phase 2, Widgets connect:

- function-pointer `QObject::connect`
- unqualified `connect`
- macro `SIGNAL`/`SLOT`
- parameterized signatures and overload disambiguation
- inherited receiver slots
- duplicate receiver method names across classes in the same file
- lambda/functor connects that remain unresolved if out of scope
- same method name in unrelated classes does not steal the edge
- no aggressive edge when Qt exposure evidence is missing

Phase 3, Designer `.ui`:

- `.ui` widget extraction
- `.ui` connection extraction
- `setupUi(this)` association
- `ui->widgetName` references
- `connectSlotsByName` and `on_<objectName>_<signal>` auto-connect behavior
- promoted/custom widgets
- sync invalidation for `.ui` changes

Each phase should end with explicit verification:

- targeted Qt/QML or Widgets integration tests
- `npm run build`
- `npm test` when the change touches shared resolver, extraction, or sync behavior
- for substantial Widgets or `.ui` work, at least one non-Qt large C++ negative probe and one mixed Qt real-project probe with timing notes

## Migration Plan

1. Create `src/resolution/frameworks/qt/`.
2. Move shared Qt C++ meta-object parsing into `cpp-meta.ts`.
3. Move current QML framework behavior into `qml.ts`.
4. Add `qtResolver` in `index.ts` and register it in the framework list.
5. Preserve QML behavior and tests before adding Widgets behavior.
6. Decide and document the `qml-qt` compatibility policy, then update tests, docs, and changelog if the public name changes.
7. Define Widgets graph shape and declaration-node prerequisites.
8. Add Widgets connect support in a separate change.
9. Add Designer `.ui` support after connect behavior is stable.

## Non-Goals

- Do not model every Qt module in the first pass.
- Do not infer signal/slot edges from method names alone.
- Do not fabricate `.ui` relationships without an indexed `.ui` source or explicit `setupUi` evidence.
- Do not broaden cross-language resolution outside explicit Qt framework facts.
- Do not broaden QML-visible C++ facts just because Widgets needs a richer Qt registry.
- Do not resolve lambda, functor, or `std::bind` connects in the first Widgets pass unless a specific graph representation and tests are added.
