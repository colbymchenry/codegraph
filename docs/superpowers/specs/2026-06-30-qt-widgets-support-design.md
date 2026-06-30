# Qt Widgets Support Design

## Goal

Add real Qt Widgets code intelligence under the unified public `qt` framework resolver. QML / Qt Quick remains supported through the existing `qt/qml.ts` path, while Widgets support lives under `qt/widgets.ts` and shares Qt C++ meta-object facts from `qt/cpp-meta.ts`.

The finished feature should let CodeGraph answer practical questions in Qt Widgets projects:

- which slot handles a button or action signal
- which emit sites can reach a slot through a signal-slot connection
- which `.ui` object backs a `ui->objectName` reference
- which auto-connect handler corresponds to a `.ui` object and signal

## Current State

The repository already has general C/C++ graph extraction. It can index classes, methods, functions, inheritance, calls, and includes. That layer answers "what C++ symbols exist?"

The Qt-specific layer is separate:

- `src/resolution/frameworks/qt/index.ts` is the single public `qt` framework resolver.
- `src/resolution/frameworks/qt/qml.ts` implements QML / Qt Quick framework behavior.
- `src/resolution/frameworks/qt/cpp-meta.ts` parses Qt meta-object facts such as `Q_OBJECT`, `Q_PROPERTY`, `Q_INVOKABLE`, `signals:`, and slots.
- `src/resolution/frameworks/qt/widgets.ts` is currently a no-op scaffold.
- `src/resolution/frameworks/qt/ui-xml.ts` is currently a no-op `.ui` scaffold.

`cpp-meta.ts` does not replace the C++ graph. It annotates existing C++ graph nodes with Qt meaning: signal, slot, invokable, property, and QObject-style exposure. Widgets support should extend this role instead of building a parallel C++ parser.

## Recommended Architecture

### 1. Keep One Public Qt Resolver

The public framework identity remains `qt`. There is no `qml-qt` compatibility alias. Internally, `qtResolver` delegates by language and file kind:

- QML and `qmldir` behavior: `qt/qml.ts`
- Qt Widgets C++ behavior: `qt/widgets.ts`
- `.ui` XML behavior: `qt/ui-xml.ts`
- shared C++ meta-object facts: `qt/cpp-meta.ts`

`qtResolver.languages` must include the C/C++ languages needed for Widgets, otherwise the framework extractor will never run on C++ source files.

### 2. Extend the Qt C++ Meta Registry

`cpp-meta.ts` should become the shared Qt C++ fact registry for both QML and Widgets. It should continue parsing source text conservatively, then attach facts to existing indexed C++ nodes.

Add facts for:

- QObject-like class evidence: `Q_OBJECT`, `Q_GADGET`, `QObject` / `QWidget` inheritance, `QMainWindow`, `QDialog`, generated `Ui::` usage
- method visibility sections: public / protected / private, public slots, protected slots, private slots
- signals and signal signatures
- slot methods and slot signatures
- method arity and normalized parameter type strings where available
- class inheritance names useful for resolving `this` and base class signals/slots

The registry should expose helpers used by Widgets:

- find class facts by simple or qualified name
- find signal by class and method name
- find slot or ordinary callable by class and method name
- resolve a member pointer expression such as `&MainWindow::onClicked`
- normalize macro signatures such as `clicked()` and `valueChanged(int)`

### 3. Add a Widgets Connection Model

`widgets.ts` should parse Qt connection facts from C++ source files and resolve them to graph edges.

Start with high-confidence typed connects:

```cpp
connect(button, &QPushButton::clicked, this, &MainWindow::onButtonClicked);
QObject::connect(sender, &Worker::finished, receiver, &Controller::handleFinished);
```

Then add the legacy and overload forms:

```cpp
connect(button, SIGNAL(clicked()), this, SLOT(onButtonClicked()));
connect(combo, qOverload<int>(&QComboBox::currentIndexChanged), this, &MainWindow::onIndexChanged);
connect(combo, QOverload<int>::of(&QComboBox::currentIndexChanged), this, &MainWindow::onIndexChanged);
connect(spin, static_cast<void (QSpinBox::*)(int)>(&QSpinBox::valueChanged), this, &MainWindow::onValueChanged);
```

The connection model should be explicit and conservative:

- connect site function/method -> slot method as a `calls` edge
- emit site -> signal method as a `calls` edge when the signal method node exists
- signal method -> connected slot method as a synthesized `calls` edge
- optional metadata on synthesized edges should identify the connect site and pattern

If the sender or receiver type is unknown, the signal/slot is ambiguous, or overload resolution cannot pick a single target, no edge should be created. A dynamic-dispatch boundary can be reported later, but fabricated edges are worse than missing edges.

### 4. Add `.ui` XML and Code-Behind Support

`.ui` parsing should extract enough structure to support Widgets workflows:

- widget/action object names
- widget class names
- `<connections>` sender/signal/receiver/slot relationships
- top-level form class where available

Code-behind support should connect C++ to `.ui` facts:

- `ui->setupUi(this)` marks a class as the form owner
- `ui->pushButton` references the `.ui` object named `pushButton`
- `connect(ui->pushButton, &QPushButton::clicked, this, &MainWindow::onClicked)` can resolve sender type from `.ui`
- auto-connect methods such as `on_pushButton_clicked()` resolve from `.ui` object `pushButton` signal `clicked`

### 5. Error Handling and Safety

Qt Widgets support must remain conservative:

- Do not execute moc, qmake, cmake, or user build scripts.
- Do not require Qt headers to be installed.
- Prefer missing edges over wrong edges.
- Treat overloaded signals/slots as unresolved unless the connect expression disambiguates them.
- Lambda/functor connects should only connect to a lambda/enclosing callable when the existing graph can identify it confidently; otherwise leave them as dynamic boundaries.

## Phased Delivery

### Phase A: Typed Connect Core

Build the C++ language gate, Widgets detection, Qt C++ registry extensions, and typed connect edges. This phase makes modern Qt5/Qt6 Widgets projects useful without handling every legacy form.

### Phase B: Overload and Macro Connects

Add `SIGNAL` / `SLOT`, `qOverload`, `QOverload`, and `static_cast` handling with negative tests for ambiguous overloads.

### Phase C: `.ui` XML and Auto-Connect

Parse `.ui` XML structure, connect `ui->objectName` references, resolve `.ui` `<connections>`, and synthesize auto-connect edges.

### Phase D: Hardening and Evaluation

Run targeted unit and integration tests, then probe real small/medium/large Qt Widgets repositories. Update MCP/server guidance if needed so agents understand that `qt` covers QML and Widgets.

## Test Strategy

Each phase needs tests at three levels:

- deterministic unit tests for parsers and registry helpers
- integration tests with small Qt Widgets projects indexed by CodeGraph
- negative tests proving unresolved or ambiguous cases do not create false edges

Existing QML / Qt Quick tests must stay green. Any Widgets changes to `cpp-meta.ts` must preserve QML bridge behavior.

## Out of Scope

The first implementation plan should not attempt:

- executing moc or build systems
- full C++ type inference beyond local declarations and existing graph facts
- complete template metaprogramming support
- perfect overload resolution for all C++ forms
- semantic understanding of arbitrary lambdas or functor objects

Those can be added after the core connection model is reliable.
