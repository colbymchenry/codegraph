# QML Graph Support Follow-up Tasks

## Context

The first QML graph generation version is implemented for QML-internal graph
coverage. It uses the normal tree-sitter `LanguageExtractor` pipeline and keeps
C++/QML bridge resolution, `qmldir` module resolution, and dynamic component URL
resolution deferred.

`test-qml-project/` may be used for validation, but files under that directory
must not be staged or committed.

## Current Scope Decision

QML to C++ bridge work is explicitly deferred until after the QML-side graph is
complete. Current implementation work must stay within QML extraction and
QML-to-QML resolution:

- QML component, property, id, function, signal, handler, and import extraction
- QML directory-local component type references
- QML nested handler bodies, including block handlers and function-valued
  handlers
- QML object-literal callback bodies
- QML function-valued non-handler bindings, such as formatter callbacks
- QML function callbacks passed as call arguments, such as
  `items.filter(function (item) { ... })`
- conservative suppression of broad cross-file QML property/name matches

Deferred bridge scope:

- `Q_PROPERTY`, `Q_INVOKABLE`, C++ signal exposure, `setContextProperty`,
  `qmlRegisterType`, and `qmlRegisterSingletonType`
- resolving `root.viewModel.someMethod(...)` to the C++ ViewModel by Qt bridge
  metadata
- treating existing heuristic QML-to-C++ name matches as final bridge behavior

## Validation Update: QML-side Closure

Validation was rerun against temporary copies of:

```text
test-qml-project/unifiedpromax/src/components/general/bookmark_tree_component
test-qml-project/unifiedpromax/src/components/general/video_download_component
```

The source directories were not modified or staged.

### `bookmark_tree_component` after QML-side fixes

- Indexed files: 27
- Languages: 26 C/C++ files, 1 QML file
- Total graph facts: 709 nodes, 1,647 edges
- QML nodes: 292
- QML node breakdown:
  - 63 `component`
  - 139 `property`
  - 27 `variable` / id
  - 26 `function`
  - 29 `method`
  - 7 `import`
- QML edge breakdown from QML-owned nodes:
  - 291 `contains`
  - 7 `imports`
  - 53 `calls`
  - 531 `references`
- Newly confirmed QML-only chains:
  - `labelFormatter -> displayBookmarkGroupLabel`
  - `groupLabelFormatter -> displayBookmarkGroupLabel`
  - `groups.filter(function (...) { ... })` callback extraction
  - `onActivated -> applyCurrentFilters`
  - `onSearchTriggered -> applyCurrentFilters`
- No suspicious cross-file `text` property references were observed.

The remaining absent links in this module are QML-to-C++ ViewModel links, for
example:

- `onPageRequested -> root.viewModel.goToPage(...)`
- delegate `onClicked -> root.viewModel.onNodeClicked(...)`
- delegate `onDoubleClicked -> root.viewModel.onNodeDoubleClicked(...)`

These are intentionally left for the later C++/QML bridge phase. They should not
be counted as QML-side extraction gaps after this update.

### `video_download_component` after QML-side fixes

- Indexed files: 39
- Languages: 26 C/C++ files, 13 QML files
- Total graph facts: 829 nodes, 2,023 edges
- QML nodes: 455
- QML node breakdown:
  - 154 `component`
  - 123 `property`
  - 43 `variable` / id
  - 16 `function`
  - 47 `method`
  - 59 `import`
- QML edge breakdown from QML-owned nodes:
  - 442 `contains`
  - 59 `imports`
  - 54 `calls`
  - 740 `references`
- Confirmed local QML component closure:
  - `VideoDownloadOverviewBar`
  - `VideoDownloadSegmentSection`
  - `VideoDownloadTaskSection`
  - `VideoDownloadSegmentItem`
  - `VideoDownloadTaskItem`
- Confirmed callback chains:
  - object-literal `accepted -> removeAll`
  - object-literal `accepted -> cancelAll`
  - object-literal `accepted -> applySegmentEdit`
- No suspicious cross-file `text` property references were observed.

Historical validation notes below are kept as evidence of the gaps that led to
these follow-up fixes. Where they say nested handlers, local component
resolution, object-literal callbacks, or formatter callbacks were missing, those
items are superseded by this validation update.

## Priority 1: Workspace and Documentation Hygiene

- Review the remaining dirty or untracked workspace files and decide which
  should be kept, split, or discarded in separate commits.
- Keep unrelated pre-existing changes out of QML implementation commits.
- Update QML design documentation so it matches current behavior:
  - top-level component names come from the `.qml` file basename
  - object `id` bindings are still indexed as `variable` nodes
  - `Connections.target` supports member-expression references
  - same-file inline component type references are supported
  - local JavaScript helper imports are file-level dependencies
  - directory-local QML component resolution is supported for same-directory
    files and explicit string imports
  - `qmldir` module resolution remains deferred

## Priority 2: Real-project Validation

- Run CodeGraph against `test-qml-project/` and capture validation notes outside
  that directory.
- Validate at least:
  - `.qml` file detection and indexing
  - component tree extraction
  - handler-to-function call chains
  - property and id references
  - same-file inline component references
  - local JavaScript helper imports
  - absence of obvious false edges from Qt built-in component names to same-named
    project files

### Validation Note: `eager_base_tree`

Validation was run against a temporary copy of:

```text
test-qml-project/unifiedpromax/src/components/general/eager_base_tree
```

The source directory was not modified or staged. The full `unifiedpromax` tree
and full `src/` subtree were too large for a quick validation pass in this
session, so validation was scoped to one representative `src/components/general`
submodule as agreed.

Observed result from the temporary copy:

- Indexed files: 52
- Languages: 36 C/C++ files, 16 QML files
- QML component nodes: 124
- QML property nodes: 250
- QML variable/id nodes: 39
- QML method nodes: 54
- QML function nodes: 29
- QML import nodes / import edges: 74
- QML call edges from QML-owned nodes: 26
- QML reference edges from QML-owned nodes: 894
- Sample top-level QML components found:
  - `TreeActionButton`
  - `TreeDialogScaffold`
  - `TreeNodeRow`
  - `TreeSearchBar`
  - `TreePanelHeader`

This validates that the current QML extractor can index a real Qt Quick
submodule and produce searchable component, property, id, method/function,
import, call, and reference graph facts without relying on C++/QML bridge
support.

### Validation Note: `bookmark_tree_component`

Validation was run against a temporary copy of:

```text
test-qml-project/unifiedpromax/src/components/general/bookmark_tree_component
```

The source directory was not modified or staged. This module is intentionally
useful as a mixed C++/QML validation case because it contains one large QML
view plus the corresponding C++ component, service, runtime adapter, and
`BookmarkTreeViewModel` implementation.

Observed result from the temporary copy:

- Indexed files: 27
- Languages: 26 C/C++ files, 1 QML file
- Total graph facts: 706 nodes, 1,599 edges
- QML parse/index result: `presentation/qml/BookmarkTreeComponent.qml`
  indexed with 289 QML nodes and no file errors
- QML node breakdown:
  - 63 `component` nodes
  - 139 `property` nodes
  - 27 `variable` / `id` nodes
  - 26 `function` nodes
  - 26 `method` / handler nodes
  - 7 `import` nodes
- QML edge breakdown from QML-owned nodes:
  - 288 `contains` edges
  - 519 `references` edges
  - 20 `calls` edges
  - 7 `imports` edges
- Sample QML imports found:
  - `QtQuick`
  - `QtQuick.Controls`
  - `QtQuick.Layouts`
  - `Components`
  - `Core.I18n`
  - `Shared.Controls`
  - `UnifiedProMax.Theme`
- Sample QML structure found:
  - top-level `BookmarkTreeComponent` component from the file basename
  - `root` id node
  - nested controls such as `panel`, `groupCombo`, `searchField`,
    `bookmarkList`, `beginPicker`, `endPicker`, and `addBookmarkDialog`
  - nested handlers such as `onActivated`, `onClicked`, `onDoubleClicked`,
    `onAccepted`, `onPageRequested`, `onDateTimeConfirmed`, and
    `onAddOperationInProgressChanged`
- Sample correct call edges:
  - `isAlertTag -> bookmarkTagText`
  - `bookmarkTagFillColor -> isAlertTag`
  - `formatDateTimeText -> padDateTimePart`
  - `Component.onCompleted -> tryEagerLoad`
  - `onViewModelChanged -> refreshFilterControls`
  - `submitInlineBookmarkEdit -> BookmarkTreeViewModel::submitEditBookmark`
  - `tryEagerLoad -> BookmarkTreeViewModel::loadSnapshot`
  - `submitAddBookmarkDialog -> BookmarkTreeViewModel::submitAddBookmark`
  - `handleSwitchPanelHeaderAction -> BookmarkTreeViewModel::refreshSnapshot`

Correctness assessment:

- Graph generation succeeds for this module.
- QML file discovery, import extraction, component nesting, id extraction,
  property extraction, root-level helper functions, top-level handlers, and
  simple same-file helper calls are working.
- A limited set of QML-to-C++ ViewModel calls can already resolve through the
  existing graph pipeline when the target C++ method name is available.
- The generated graph is not yet complete for this module. Nested control and
  delegate handlers are extracted as method nodes, but their body calls are not
  consistently emitted as `calls` edges. Missing examples include:
  - `groupCombo.onActivated -> root.applyCurrentFilters()`
  - `searchButton.onClicked -> root.applyCurrentFilters()`
  - `currentDeviceOnlyCheck.onClicked -> root.applyCurrentFilters()`
  - `bookmarkList` delegate `MouseArea.onClicked ->
    root.viewModel.onNodeClicked(...)`
  - `bookmarkList` delegate `MouseArea.onDoubleClicked ->
    root.viewModel.onNodeDoubleClicked(...)`
  - `ThemedPaginationBar.onPageRequested -> root.viewModel.goToPage(...)`
  - `DateTimePickerPopup.onDateTimeConfirmed ->
    root.formatDateTimeText(...) / root.applyCurrentFilters()`
  - `addBookmarkDialog.onAccepted -> root.submitAddBookmarkDialog(...)`
  - `Connections.onAddOperationInProgressChanged ->
    root.closeAddBookmarkDialog()`

Follow-up implication:

- Before claiming full QML interaction-chain coverage, extend the QML extractor
  or resolver so nested handler bodies participate in the same call/reference
  extraction path as root-level functions and handlers.
- Add a deterministic regression fixture based on the patterns above:
  nested object handler -> root helper -> `root.viewModel.*` C++ method.
- Treat the currently observed QML-to-C++ links as useful but heuristic. A
  proper bridge design is still needed for `Q_PROPERTY`, `Q_INVOKABLE`,
  `setContextProperty`, and registered QML types.

### Validation Note: `video_download_component`

Validation was run against a temporary copy of:

```text
test-qml-project/unifiedpromax/src/components/general/video_download_component
```

The source directory was not modified or staged. This module is a stronger
mixed QML/C++ validation case than `bookmark_tree_component` because it has
multiple local QML files that instantiate each other, plus a C++ component,
service layer, domain models, and `VideoDownloadViewModel`.

Observed result from the temporary copy:

- Indexed files: 39
- Languages: 26 C/C++ files, 13 QML files
- Total graph facts: 819 nodes, 1,946 edges
- QML parse/index result: all 13 QML files indexed with no file errors
- QML node breakdown:
  - 154 `component` nodes
  - 123 `property` nodes
  - 43 `variable` / `id` nodes
  - 16 `function` nodes
  - 37 `method` / handler nodes
  - 59 `import` nodes
- QML edge breakdown from QML-owned nodes:
  - 432 `contains` edges
  - 712 `references` edges
  - 15 `calls` edges
  - 59 `imports` edges
- Top-level QML components found:
  - `SegmentInlineEditor`
  - `VideoDownloadComponent`
  - `VideoDownloadIconActionButton`
  - `VideoDownloadInlineActionButton`
  - `VideoDownloadInlineConfirm`
  - `VideoDownloadInlineField`
  - `VideoDownloadOverviewBar`
  - `VideoDownloadPanelHeader`
  - `VideoDownloadSectionActionButton`
  - `VideoDownloadSegmentItem`
  - `VideoDownloadSegmentSection`
  - `VideoDownloadTaskItem`
  - `VideoDownloadTaskSection`
- Sample local QML component instances found as component nodes:
  - `VideoDownloadComponent::ColumnLayout@64::VideoDownloadOverviewBar@69`
    with signature `VideoDownloadOverviewBar`
  - `VideoDownloadComponent::ColumnLayout@64::VideoDownloadSegmentSection@76`
    with signature `VideoDownloadSegmentSection`
  - `VideoDownloadComponent::ColumnLayout@64::VideoDownloadTaskSection@95`
    with signature `VideoDownloadTaskSection`
  - `VideoDownloadSegmentItem::inlineEditor` with signature
    `SegmentInlineEditor`
  - `VideoDownloadSegmentSection::...::VideoDownloadSegmentItem@277`
    with signature `VideoDownloadSegmentItem`
  - `VideoDownloadTaskSection::...::VideoDownloadTaskItem@212`
    with signature `VideoDownloadTaskItem`
- Sample QML-to-C++ ViewModel call edges found:
  - `VideoDownloadOverviewBar.onClicked ->
    VideoDownloadViewModel::downloadAll`
  - `VideoDownloadSegmentItem.applySegmentEdit ->
    VideoDownloadViewModel::updateSegment`
  - `VideoDownloadSegmentItem.onClicked ->
    VideoDownloadViewModel::removeSegment`
  - `VideoDownloadSegmentSection.onClicked ->
    VideoDownloadViewModel::requestAddSegment`
  - `VideoDownloadTaskItem.onClicked ->
    VideoDownloadViewModel::pauseTask`
  - `VideoDownloadTaskItem.onClicked ->
    VideoDownloadViewModel::resumeTask`
  - `VideoDownloadTaskItem.onClicked ->
    VideoDownloadViewModel::cancelTask`
  - `VideoDownloadTaskSection.onClicked ->
    VideoDownloadViewModel::resumeAll`
  - `VideoDownloadTaskSection.onClicked ->
    VideoDownloadViewModel::pauseAll`

Correctness assessment:

- Graph generation succeeds for this module.
- QML file discovery, import extraction, top-level component naming,
  component nesting, id extraction, properties, handlers, and several direct
  QML-to-C++ ViewModel calls are working.
- Local QML component instantiations are detected as component nodes and their
  type names are preserved in `signature`.
- The generated graph is not complete for this module because directory-local
  QML component type references are not resolved to the corresponding top-level
  QML component definitions. For example:
  - `VideoDownloadComponent.qml` instantiates `VideoDownloadOverviewBar`,
    `VideoDownloadSegmentSection`, `VideoDownloadTaskSection`, and
    `VideoDownloadInlineConfirm`, but there are no cross-file component
    reference edges to those `.qml` definitions.
  - `VideoDownloadSegmentSection.qml` instantiates
    `VideoDownloadSegmentItem`, but there is no edge to
    `VideoDownloadSegmentItem.qml`.
  - `VideoDownloadTaskSection.qml` instantiates `VideoDownloadTaskItem`, but
    there is no edge to `VideoDownloadTaskItem.qml`.
- Object-literal callback bodies are still not fully represented as call
  sources. Direct `root.viewModel.*` calls resolved for 9 observed ViewModel
  methods, but calls inside `inlineConfirmRequested({ accepted: function () {
  ... } })` did not produce edges for:
  - `VideoDownloadTaskSection.qml -> VideoDownloadViewModel::cancelAll`
  - `VideoDownloadSegmentSection.qml -> VideoDownloadViewModel::removeAll`
- Cross-file QML references currently contain suspicious property-level matches
  such as `SegmentInlineEditor.onTextChanged -> VideoDownloadInlineField::text`
  across files. This reinforces the need to make QML module/import scope
  explicit before enabling broad cross-file name matching.

Follow-up implication:

- Add QML directory-local component resolution before claiming multi-file QML
  graph closure.
- Resolve local component instance signatures to top-level QML component nodes
  conservatively and only within valid QML import scope.
- Add regression coverage for:
  - top-level component basename extraction across multiple `.qml` files
  - local component instance -> local component definition edges
  - object-literal callback bodies that call `root.viewModel.*`
  - suppression of accidental cross-file property matches such as generic
    `text` properties

## Priority 3: QML Module and Import Scope Design

- Design `qmldir` and QML import scope support before enabling cross-file QML
  component type resolution.
- Model directory-local components, module URI imports, aliases, and versioned
  imports conservatively.
- Add regression tests that prevent same-name built-in/project-file collisions.

## Priority 4: C++ / QML Bridge Design

- Design bridge extraction and resolution for:
  - `qmlRegisterType`
  - `qmlRegisterSingletonType`
  - `setContextProperty`
  - `Q_PROPERTY`
  - `Q_INVOKABLE`
  - C++ signals consumed from QML
- Keep this bridge outside the QML extractor itself; it should be resolver or
  framework-bridge work that consumes normal C++ and QML graph facts.

## Priority 5: Dynamic QML Loading

- Evaluate static coverage for `Loader.source`, `Loader.sourceComponent`, and
  `Qt.createComponent(...)`.
- Only resolve literal or statically safe targets. Leave string-built runtime
  URLs unresolved unless a conservative rule is available.

## Priority 6: Release Notes

- Add a `[Unreleased]` changelog entry describing QML / Qt Quick indexing.
- Mention the supported first-version scope and explicitly exclude C++/QML
  bridging, `qmldir`, and dynamic URL resolution until those phases land.
