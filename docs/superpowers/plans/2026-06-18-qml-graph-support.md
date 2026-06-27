# QML Graph Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class QML graph generation for `.qml` files using the existing tree-sitter language pipeline, covering QML-internal structure, symbols, static calls, and static references.

**Architecture:** QML is added as a normal `Language` value and parsed through `TreeSitterExtractor` with a `src/extraction/languages/qml.ts` `LanguageExtractor`. The first version stays inside the existing graph schema, emits standard `nodes`, `edges`, and `unresolvedReferences`, and deliberately avoids C++/QML bridge resolution.

**Tech Stack:** TypeScript, `web-tree-sitter`, `@lumis-sh/wasm-qmljs`, Vitest, SQLite-backed CodeGraph integration tests.

---

## File Structure

- Create `docs/design/qml-ast-node-map.md`
  Records the actual QMLJS AST node names used by the implementation and the known inline-component recovery behavior.

- Modify `package.json`
  Adds `@lumis-sh/wasm-qmljs` as a runtime dependency.

- Modify `package-lock.json`
  Lockfile update from `npm install @lumis-sh/wasm-qmljs@0.26.0 --save`.

- Modify `src/types.ts`
  Adds `qml` to the `LANGUAGES` runtime/type union.

- Modify `src/extraction/grammars.ts`
  Adds `.qml` detection, QML WASM loading, display name, support checks, and `getSupportedLanguages()` inclusion.

- Create `src/extraction/languages/qml.ts`
  Implements QML-specific AST traversal with `LanguageExtractor.visitNode`.

- Modify `src/extraction/languages/index.ts`
  Registers `qmlExtractor`.

- Modify `src/extraction/extraction-version.ts`
  Bumps `EXTRACTION_VERSION` because existing indexes need a re-index to include QML files and symbols.

- Modify `__tests__/extraction.test.ts`
  Adds language detection and QML extraction tests.

- Create `__tests__/qml-integration.test.ts`
  Adds a small end-to-end Qt Quick fixture for `CodeGraph.indexAll()`, callers, callees, and impact.

- Modify `README.md`
  Adds QML to the supported-language/user-facing surface if the supported-language section is present in the current README.

---

### Task 1: Record QML Grammar AST Facts

**Files:**
- Create: `docs/design/qml-ast-node-map.md`

- [ ] **Step 1: Create a representative temporary QML sample**

Run this from the repository root:

```powershell
$sample = Join-Path $env:TEMP "codegraph-qml-ast-sample.qml"
@'
pragma Singleton
import QtQuick
import QtQuick.Controls 2.15
import "utils.js" as Utils

component PrimaryButton : Button {
    id: primaryButton
    property alias label: buttonText.text
    signal accepted(string name)
    enum Mode { Light, Dark }
    onClicked: accepted(Utils.format(label))
    Text { id: buttonText; text: "OK" }
}

Item {
    id: root
    required property var viewModel
    property int count: 1
    Component.onCompleted: initialize()
    function initialize() {
        viewModel.load(count)
    }
    Connections {
        target: viewModel
        function onLoaded(value) { root.count = value }
    }
    Loader { sourceComponent: delegateComponent }
    Component { id: delegateComponent; Rectangle {} }
    states: [ State { name: "busy" } ]
}
'@ | Set-Content -Path $sample -Encoding UTF8
```

Expected: command exits successfully and writes a QML sample to `%TEMP%`.

- [ ] **Step 2: Download the QML WASM package outside the repo**

Run:

```powershell
$pkgDir = Join-Path $env:TEMP ("codegraph-qml-wasm-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $pkgDir | Out-Null
npm pack @lumis-sh/wasm-qmljs@0.26.0 --pack-destination $pkgDir
tar -xf (Join-Path $pkgDir "lumis-sh-wasm-qmljs-0.26.0.tgz") -C $pkgDir
```

Expected: output includes `lumis-sh-wasm-qmljs-0.26.0.tgz`, and `$pkgDir\package\tree-sitter-qmljs.wasm` exists.

- [ ] **Step 3: Verify the grammar loads and parses repeatedly**

Run:

```powershell
node scripts/add-lang/check-grammar.mjs (Join-Path $pkgDir "package/tree-sitter-qmljs.wasm") $sample 20
```

Expected: `RESULT: PASS` with `20 clean / 0 with errors`. If the inline-component sample reports parse errors but the non-inline sample parses cleanly, keep the package and document inline-component recovery in Step 5.

- [ ] **Step 4: Dump the AST**

Run:

```powershell
node scripts/add-lang/dump-ast.mjs (Join-Path $pkgDir "package/tree-sitter-qmljs.wasm") $sample --depth=5
```

Expected: output includes these named nodes:

```text
program
ui_pragma
ui_import
ui_object_definition
ui_object_initializer
ui_binding
ui_property
ui_signal
function_declaration
enum_declaration
ui_object_array
call_expression
member_expression
nested_identifier
```

- [ ] **Step 5: Write the AST node map document**

Create `docs/design/qml-ast-node-map.md` with this content:

```markdown
# QML AST Node Map

This document records the QMLJS tree-sitter node names used by CodeGraph's QML
extractor. The grammar source is `@lumis-sh/wasm-qmljs@0.26.0`.

## Verified Grammar

- Package: `@lumis-sh/wasm-qmljs@0.26.0`
- WASM export: `@lumis-sh/wasm-qmljs/tree-sitter-qmljs.wasm`
- Runtime: `web-tree-sitter`

## Core Nodes

| QML syntax | Tree-sitter node |
|---|---|
| File root | `program` |
| `pragma Singleton` | `ui_pragma` |
| `import QtQuick` | `ui_import` |
| Object declaration `Item {}` | `ui_object_definition` |
| Object body | `ui_object_initializer` |
| Binding `name: value` | `ui_binding` |
| Property `property int count` | `ui_property` |
| Signal `signal accepted(...)` | `ui_signal` |
| Function `function initialize() {}` | `function_declaration` |
| Enum `enum Mode { Light, Dark }` | `enum_declaration` / `enum_body` |
| Array object binding `states: [ State {} ]` | `ui_object_array` |
| JavaScript call `foo()` | `call_expression` |
| JavaScript member read `root.count` | `member_expression` |
| Attached handler `Component.onCompleted` | `nested_identifier` |

## Field Names

| Parent node | Field | Meaning |
|---|---|---|
| `ui_import` | `source` | Module name or JS helper string |
| `ui_import` | `version` | Optional module version |
| `ui_import` | `alias` | Optional JS import alias |
| `ui_object_definition` | `type_name` | QML type name |
| `ui_object_definition` | `initializer` | QML object body |
| `ui_property` | `type` | Property type token |
| `ui_property` | `name` | Property name |
| `ui_property` | `value` | Optional initializer expression |
| `ui_signal` | `name` | Signal name |
| `ui_signal` | `parameters` | Signal parameters |
| `ui_binding` | `name` | Binding name, including handler names |
| `ui_binding` | `value` | Binding expression or object array |
| `function_declaration` | `name` | Function or handler function name |
| `function_declaration` | `parameters` | Function parameters |
| `function_declaration` | `body` | Function body block |

## Inline Component Recovery

The grammar recovers `component PrimaryButton : Button { ... }` with an `ERROR`
node and an inner `ui_object_definition` for the base type. The QML extractor
therefore handles inline components in a constrained way:

1. Detect an `ERROR` node whose source starts with `component <Name> :`.
2. Create a `component` node named `<Name>` at the `ERROR` node location.
3. Visit the inner `ui_object_definition` children under that inline component
   scope.
4. Do not use this recovery for arbitrary `ERROR` nodes.

This keeps inline component support inside the normal QML language extractor
instead of adding a separate scanner.
```

- [ ] **Step 6: Commit the AST facts**

Run:

```bash
git add docs/design/qml-ast-node-map.md
git commit -m "docs: record qml ast node map"
```

Expected: commit succeeds with only `docs/design/qml-ast-node-map.md`.

---

### Task 2: Add QML Language Wiring

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/types.ts`
- Modify: `src/extraction/grammars.ts`
- Modify: `src/extraction/extraction-version.ts`
- Modify: `__tests__/extraction.test.ts`

- [ ] **Step 1: Write failing language wiring tests**

Modify `__tests__/extraction.test.ts`.

In `describe('Language Detection', ...)`, add:

```ts
  it('should detect QML files', () => {
    expect(detectLanguage('Main.qml')).toBe('qml');
    expect(detectLanguage('src/app/qml/LoginPage.qml')).toBe('qml');
    expect(isSourceFile('Main.qml')).toBe(true);
  });
```

In `describe('Language Support', ...)`, add these expectations to the existing tests:

```ts
    expect(isLanguageSupported('qml')).toBe(true);
```

```ts
    expect(languages).toContain('qml');
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npx vitest run __tests__/extraction.test.ts -t "QML|Language Support"
```

Expected: fails because TypeScript does not yet know `qml` as a `Language`, or because `detectLanguage('Main.qml')` returns `unknown`.

- [ ] **Step 3: Install the QML WASM package**

Run:

```bash
npm install @lumis-sh/wasm-qmljs@0.26.0 --save
```

Expected: `package.json` contains `"@lumis-sh/wasm-qmljs": "^0.26.0"` and `package-lock.json` is updated.

- [ ] **Step 4: Add `qml` to the language union**

Modify `src/types.ts` by adding `qml` near the other source languages:

```ts
  'lua',
  'luau',
  'qml',
  'objc',
```

- [ ] **Step 5: Add QML grammar, extension, support, and display name**

Modify `src/extraction/grammars.ts`.

Update `WASM_GRAMMAR_FILES`:

```ts
  lua: 'tree-sitter-lua.wasm',
  luau: 'tree-sitter-luau.wasm',
  qml: 'tree-sitter-qmljs.wasm',
  objc: 'tree-sitter-objc.wasm',
```

Update `EXTENSION_MAP`:

```ts
  '.lua': 'lua',
  '.luau': 'luau',
  '.qml': 'qml',
  '.m': 'objc',
```

Update the WASM path branch in `loadGrammarsForLanguages()`:

```ts
      const wasmPath = lang === 'qml'
        ? require.resolve('@lumis-sh/wasm-qmljs/tree-sitter-qmljs.wasm')
        : (lang === 'pascal' || lang === 'scala' || lang === 'lua' || lang === 'luau' || lang === 'csharp')
          ? path.join(__dirname, 'wasm', wasmFile)
          : require.resolve(`tree-sitter-wasms/out/${wasmFile}`);
```

Update `getSupportedLanguages()`:

```ts
  return [...(Object.keys(WASM_GRAMMAR_FILES) as GrammarLanguage[]), 'svelte', 'vue', 'liquid'];
```

No literal change is needed here after adding `qml` to `WASM_GRAMMAR_FILES`; verify `qml` appears automatically.

Update `getLanguageDisplayName()`:

```ts
    lua: 'Lua',
    luau: 'Luau',
    qml: 'QML',
    objc: 'Objective-C',
```

- [ ] **Step 6: Bump extraction version**

Modify `src/extraction/extraction-version.ts`:

```ts
export const EXTRACTION_VERSION = 2;
```

- [ ] **Step 7: Run language wiring tests**

Run:

```bash
npx vitest run __tests__/extraction.test.ts -t "QML|Language Support"
```

Expected: language detection/support tests pass. QML extraction tests do not exist yet.

- [ ] **Step 8: Commit language wiring**

Run:

```bash
git add package.json package-lock.json src/types.ts src/extraction/grammars.ts src/extraction/extraction-version.ts __tests__/extraction.test.ts
git commit -m "feat(qml): wire qml language support"
```

Expected: commit succeeds.

---

### Task 3: Add Minimal QML Extractor for Imports and Object Trees

**Files:**
- Create: `src/extraction/languages/qml.ts`
- Modify: `src/extraction/languages/index.ts`
- Modify: `__tests__/extraction.test.ts`

- [ ] **Step 1: Write failing extraction tests for imports and object tree**

Append this block to `__tests__/extraction.test.ts` before the final language-specific sections:

```ts
describe('QML Extraction', () => {
  it('should extract QML imports and a nested object tree', () => {
    const code = `
import QtQuick
import QtQuick.Controls 2.15

ApplicationWindow {
  id: root
  Rectangle {
    id: panel
    Text { text: "Hello" }
  }
}
`;
    const result = extractFromSource('Main.qml', code);
    expect(result.errors).toEqual([]);

    const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
    expect(imports).toContain('QtQuick');
    expect(imports).toContain('QtQuick.Controls');

    const components = result.nodes.filter((n) => n.kind === 'component').map((n) => n.name);
    expect(components).toContain('root');
    expect(components).toContain('panel');
    expect(components.some((name) => name.startsWith('Text@'))).toBe(true);

    const root = result.nodes.find((n) => n.kind === 'component' && n.name === 'root');
    const panel = result.nodes.find((n) => n.kind === 'component' && n.name === 'panel');
    expect(root).toBeDefined();
    expect(panel).toBeDefined();
    expect(result.edges.some((e) => e.kind === 'contains' && e.source === root!.id && e.target === panel!.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the failing QML extraction test**

Run:

```bash
npx vitest run __tests__/extraction.test.ts -t "QML Extraction"
```

Expected: fails because `qmlExtractor` is not registered and no component/import nodes are extracted.

- [ ] **Step 3: Create the initial QML extractor**

Create `src/extraction/languages/qml.ts` with this content:

```ts
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

function childText(node: SyntaxNode, field: string, source: string): string | null {
  const child = getChildByField(node, field);
  return child ? getNodeText(child, source).trim() : null;
}

function dottedText(node: SyntaxNode, source: string): string {
  return node.namedChildren
    .map((child) => getNodeText(child, source).trim())
    .filter(Boolean)
    .join('.');
}

function qmlName(node: SyntaxNode, source: string): string {
  if (node.type === 'nested_identifier') return dottedText(node, source);
  return getNodeText(node, source).trim().replace(/^["']|["']$/g, '');
}

function findBindingValueText(initializer: SyntaxNode | null, name: string, source: string): string | null {
  if (!initializer) return null;
  for (const child of initializer.namedChildren) {
    if (child.type !== 'ui_binding') continue;
    const nameNode = getChildByField(child, 'name');
    if (!nameNode || qmlName(nameNode, source) !== name) continue;
    const valueNode = getChildByField(child, 'value');
    return valueNode ? getNodeText(valueNode, source).trim() : null;
  }
  return null;
}

function objectDisplayName(node: SyntaxNode, source: string): string {
  const initializer = getChildByField(node, 'initializer');
  const idValue = findBindingValueText(initializer, 'id', source);
  if (idValue && /^[A-Za-z_][A-Za-z0-9_]*$/.test(idValue)) return idValue;

  const typeName = childText(node, 'type_name', source) ?? 'Component';
  return `${typeName}@${node.startPosition.row + 1}`;
}

function addRef(ctx: ExtractorContext, fromNodeId: string, name: string, node: SyntaxNode, kind: 'imports' | 'references' | 'calls' = 'references'): void {
  if (!name) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: name,
    referenceKind: kind,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
    filePath: ctx.filePath,
    language: 'qml',
  });
}

function visitObject(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = objectDisplayName(node, ctx.source);
  const component = ctx.createNode('component', name, node, {
    signature: childText(node, 'type_name', ctx.source) ?? undefined,
  });
  if (!component) return true;

  ctx.pushScope(component.id);
  const initializer = getChildByField(node, 'initializer');
  if (initializer) {
    for (const child of initializer.namedChildren) {
      ctx.visitNode(child);
    }
  }
  ctx.popScope();
  return true;
}

function visitImport(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const sourceNode = getChildByField(node, 'source');
  if (!sourceNode) return true;
  const moduleName = qmlName(sourceNode, ctx.source);
  const importNode = ctx.createNode('import', moduleName, node, {
    signature: getNodeText(node, ctx.source).trim(),
  });
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (importNode && parentId) addRef(ctx, parentId, moduleName, node, 'imports');
  return true;
}

export const qmlExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  enumMemberTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  visitNode: (node, ctx) => {
    if (node.type === 'ui_import') return visitImport(node, ctx);
    if (node.type === 'ui_object_definition') return visitObject(node, ctx);
    return false;
  },
};
```

- [ ] **Step 4: Register the QML extractor**

Modify `src/extraction/languages/index.ts`.

Add the import:

```ts
import { qmlExtractor } from './qml';
```

Add the map entry:

```ts
  qml: qmlExtractor,
```

- [ ] **Step 5: Run the QML extraction test**

Run:

```bash
npx vitest run __tests__/extraction.test.ts -t "QML Extraction"
```

Expected: the import/object-tree test passes.

- [ ] **Step 6: Commit minimal QML extraction**

Run:

```bash
git add src/extraction/languages/qml.ts src/extraction/languages/index.ts __tests__/extraction.test.ts
git commit -m "feat(qml): extract imports and object trees"
```

Expected: commit succeeds.

---

### Task 4: Extract QML Symbols: ids, properties, signals, functions, handlers, enums

**Files:**
- Modify: `src/extraction/languages/qml.ts`
- Modify: `__tests__/extraction.test.ts`

- [ ] **Step 1: Write failing symbol extraction tests**

Add these tests inside `describe('QML Extraction', ...)`:

```ts
  it('should extract QML ids, properties, signals, functions, handlers, and enums', () => {
    const code = `
import QtQuick

Item {
  id: root
  required property var viewModel
  readonly property string title: "Dashboard"
  property alias label: titleText.text
  signal accepted(string name)
  enum Mode { Light, Dark }

  Component.onCompleted: initialize()
  onAccepted: initialize()

  function initialize() {
    viewModel.load(title)
  }

  Text { id: titleText; text: root.title }
}
`;
    const result = extractFromSource('Dashboard.qml', code);
    expect(result.errors).toEqual([]);

    expect(result.nodes.some((n) => n.kind === 'variable' && n.name === 'root')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'property' && n.name === 'viewModel')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'property' && n.name === 'title')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'property' && n.name === 'label')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'method' && n.name === 'accepted')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'method' && n.name === 'Component.onCompleted')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'method' && n.name === 'onAccepted')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'function' && n.name === 'initialize')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'enum' && n.name === 'Mode')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'enum_member' && n.name === 'Light')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'enum_member' && n.name === 'Dark')).toBe(true);
  });

  it('should extract Connections handlers as method nodes', () => {
    const code = `
import QtQuick

Item {
  id: root
  property var viewModel
  Connections {
    target: viewModel
    function onLoaded(value) { root.count = value }
  }
}
`;
    const result = extractFromSource('ConnectionsHost.qml', code);
    expect(result.nodes.some((n) => n.kind === 'component' && n.name.startsWith('Connections'))).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'method' && n.name === 'onLoaded')).toBe(true);
    expect(result.unresolvedReferences.some((r) => r.referenceKind === 'references' && r.referenceName === 'viewModel')).toBe(true);
  });
```

- [ ] **Step 2: Run the failing symbol tests**

Run:

```bash
npx vitest run __tests__/extraction.test.ts -t "ids, properties|Connections handlers"
```

Expected: fails because `qml.ts` only extracts imports and objects.

- [ ] **Step 3: Add symbol visitor helpers**

Modify `src/extraction/languages/qml.ts` by adding these helpers above `export const qmlExtractor`:

```ts
function currentOwnerId(ctx: ExtractorContext): string | null {
  return ctx.nodeStack[ctx.nodeStack.length - 1] ?? null;
}

function visitBinding(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const owner = currentOwnerId(ctx);
  const nameNode = getChildByField(node, 'name');
  const valueNode = getChildByField(node, 'value');
  if (!nameNode || !owner) return false;

  const name = qmlName(nameNode, ctx.source);
  if (name === 'id' && valueNode) {
    const idName = getNodeText(valueNode, ctx.source).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(idName)) {
      ctx.createNode('variable', idName, valueNode);
    }
    return true;
  }

  if (name === 'target' && valueNode) {
    addStaticReferences(valueNode, ctx, owner);
    return true;
  }

  if (name.startsWith('on') || name.includes('.on')) {
    const method = ctx.createNode('method', name, nameNode);
    if (method && valueNode) {
      ctx.pushScope(method.id);
      addStaticReferences(valueNode, ctx, method.id);
      ctx.popScope();
    }
    return true;
  }

  if (valueNode) addStaticReferences(valueNode, ctx, owner);
  return false;
}

function visitProperty(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = childText(node, 'name', ctx.source);
  if (!name) return true;
  const prop = ctx.createNode('property', name, node, {
    signature: getNodeText(node, ctx.source).trim().slice(0, 160),
  });
  const value = getChildByField(node, 'value');
  if (prop && value) addStaticReferences(value, ctx, prop.id);
  return true;
}

function visitSignal(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = childText(node, 'name', ctx.source);
  if (!name) return true;
  ctx.createNode('method', name, node, {
    signature: getNodeText(node, ctx.source).trim().slice(0, 160),
  });
  return true;
}

function visitFunction(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const rawName = childText(node, 'name', ctx.source);
  if (!rawName) return true;
  const kind = rawName.startsWith('on') ? 'method' : 'function';
  const fn = ctx.createNode(kind, rawName, node, {
    signature: getNodeText(node, ctx.source).split('{')[0]!.trim(),
  });
  const body = getChildByField(node, 'body');
  if (fn && body) {
    ctx.pushScope(fn.id);
    addStaticReferences(body, ctx, fn.id);
    ctx.popScope();
  }
  return true;
}

function visitEnum(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = childText(node, 'name', ctx.source);
  if (!name) return true;
  const enumNode = ctx.createNode('enum', name, node);
  if (!enumNode) return true;
  ctx.pushScope(enumNode.id);
  const body = getChildByField(node, 'body');
  if (body) {
    for (const child of body.namedChildren) {
      if (child.type === 'identifier') ctx.createNode('enum_member', getNodeText(child, ctx.source).trim(), child);
    }
  }
  ctx.popScope();
  return true;
}
```

- [ ] **Step 4: Wire symbol visitors**

Modify the `visitNode` function in `qmlExtractor`:

```ts
  visitNode: (node, ctx) => {
    if (node.type === 'ui_import') return visitImport(node, ctx);
    if (node.type === 'ui_object_definition') return visitObject(node, ctx);
    if (node.type === 'ui_binding') return visitBinding(node, ctx);
    if (node.type === 'ui_property') return visitProperty(node, ctx);
    if (node.type === 'ui_signal') return visitSignal(node, ctx);
    if (node.type === 'function_declaration') return visitFunction(node, ctx);
    if (node.type === 'enum_declaration') return visitEnum(node, ctx);
    return false;
  },
```

- [ ] **Step 5: Run symbol tests**

Run:

```bash
npx vitest run __tests__/extraction.test.ts -t "ids, properties|Connections handlers"
```

Expected: tests pass for ids, properties, signals, functions, handlers, enums, and `Connections.target`.

- [ ] **Step 6: Commit symbol extraction**

Run:

```bash
git add src/extraction/languages/qml.ts __tests__/extraction.test.ts
git commit -m "feat(qml): extract qml symbols"
```

Expected: commit succeeds.

---

### Task 5: Extract Static QML Calls and References

**Files:**
- Modify: `src/extraction/languages/qml.ts`
- Modify: `__tests__/extraction.test.ts`

- [ ] **Step 1: Write failing static reference tests**

Add this test inside `describe('QML Extraction', ...)`:

```ts
  it('should extract static QML calls and references from bindings and handlers', () => {
    const code = `
import QtQuick
import "utils.js" as Utils

Item {
  id: root
  property int count: 1
  property string label: Utils.format(root.count)

  function submit() {
    updateState(root.count)
  }

  function updateState(value) {
    count = value
  }

  MouseArea {
    onClicked: submit()
  }
}
`;
    const result = extractFromSource('Interactions.qml', code);
    const callNames = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'calls')
      .map((r) => r.referenceName);
    const refNames = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'references')
      .map((r) => r.referenceName);

    expect(callNames).toContain('Utils.format');
    expect(callNames).toContain('updateState');
    expect(callNames).toContain('submit');
    expect(refNames).toContain('Utils');
    expect(refNames).toContain('root');
    expect(refNames).toContain('root.count');
  });
```

- [ ] **Step 2: Run the failing static reference test**

Run:

```bash
npx vitest run __tests__/extraction.test.ts -t "static QML calls"
```

Expected: fails because `addStaticReferences()` is not implemented.

- [ ] **Step 3: Add static reference extraction helpers**

Modify `src/extraction/languages/qml.ts` by adding these helpers before `visitBinding()`:

```ts
const QML_REFERENCE_SKIP = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'parent',
  'model',
  'modelData',
  'event',
  'mouse',
  'Qt',
  'Math',
]);

function isIdentifierLike(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text);
}

function memberName(node: SyntaxNode, source: string): string | null {
  if (node.type === 'identifier' || node.type === 'property_identifier') {
    const text = getNodeText(node, source).trim();
    return isIdentifierLike(text) ? text : null;
  }
  if (node.type === 'nested_identifier') return qmlName(node, source);
  if (node.type === 'member_expression') {
    const parts: string[] = [];
    const walk = (current: SyntaxNode): void => {
      if (current.type === 'member_expression') {
        for (const child of current.namedChildren) walk(child);
        return;
      }
      if (current.type === 'identifier' || current.type === 'property_identifier') {
        const text = getNodeText(current, source).trim();
        if (isIdentifierLike(text)) parts.push(text);
      }
    };
    walk(node);
    return parts.length > 0 ? parts.join('.') : null;
  }
  return null;
}

function callName(node: SyntaxNode, source: string): string | null {
  const callee = getChildByField(node, 'function') ?? node.namedChild(0);
  return callee ? memberName(callee, source) : null;
}

function addReferenceName(ctx: ExtractorContext, fromNodeId: string, name: string, node: SyntaxNode): void {
  const root = name.split('.')[0]!;
  if (QML_REFERENCE_SKIP.has(root)) return;
  addRef(ctx, fromNodeId, name, node, 'references');
  if (name.includes('.')) addRef(ctx, fromNodeId, root, node, 'references');
}

function addStaticReferences(node: SyntaxNode, ctx: ExtractorContext, fromNodeId: string): void {
  const queue: SyntaxNode[] = [node];
  const seen = new Set<number>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.id)) continue;
    seen.add(current.id);

    if (current.type === 'call_expression') {
      const name = callName(current, ctx.source);
      if (name) {
        const root = name.split('.')[0]!;
        addRef(ctx, fromNodeId, name, current, 'calls');
        if (!QML_REFERENCE_SKIP.has(root)) addRef(ctx, fromNodeId, root, current, 'references');
      }
    } else if (
      current.type === 'member_expression' ||
      current.type === 'nested_identifier'
    ) {
      const name = memberName(current, ctx.source);
      if (name) addReferenceName(ctx, fromNodeId, name, current);
    } else if (current.type === 'identifier') {
      const name = getNodeText(current, ctx.source).trim();
      if (isIdentifierLike(name) && !QML_REFERENCE_SKIP.has(name)) {
        addRef(ctx, fromNodeId, name, current, 'references');
      }
    }

    for (const child of current.namedChildren) queue.push(child);
  }
}
```

- [ ] **Step 4: Run static reference tests**

Run:

```bash
npx vitest run __tests__/extraction.test.ts -t "static QML calls"
```

Expected: tests pass and no references are emitted for `Qt`, `Math`, `parent`, `model`, `modelData`, `event`, or `mouse` roots.

- [ ] **Step 5: Run all QML extraction tests**

Run:

```bash
npx vitest run __tests__/extraction.test.ts -t "QML Extraction"
```

Expected: all QML extraction tests pass.

- [ ] **Step 6: Commit static reference extraction**

Run:

```bash
git add src/extraction/languages/qml.ts __tests__/extraction.test.ts
git commit -m "feat(qml): extract static qml calls and references"
```

Expected: commit succeeds.

---

### Task 6: Cover Additional QML Base Syntax

**Files:**
- Modify: `src/extraction/languages/qml.ts`
- Modify: `__tests__/extraction.test.ts`

- [ ] **Step 1: Write failing tests for additional base syntax**

Add this test inside `describe('QML Extraction', ...)`:

```ts
  it('should cover alias, attached properties, object arrays, JS imports, pragmas, and inline components', () => {
    const code = `
pragma Singleton
import QtQuick
import QtQuick.Layouts
import "utils.js" as Utils

component PrimaryButton : Rectangle {
  id: primaryButton
  property alias label: labelText.text
  Layout.fillWidth: true
  Text { id: labelText; text: Utils.format("OK") }
}

Item {
  id: root
  property list<Item> items
  states: [ State { name: "busy" } ]
  transitions: [ Transition {} ]
}
`;
    const result = extractFromSource('BaseSyntax.qml', code);

    expect(result.nodes.some((n) => n.kind === 'import' && n.name === 'QtQuick.Layouts')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'import' && n.name === 'utils.js')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'component' && n.name === 'PrimaryButton')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'property' && n.name === 'label')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'property' && n.name === 'items')).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'component' && n.name.startsWith('State@'))).toBe(true);
    expect(result.nodes.some((n) => n.kind === 'component' && n.name.startsWith('Transition@'))).toBe(true);
    expect(result.unresolvedReferences.some((r) => r.referenceName === 'labelText.text')).toBe(true);
    expect(result.unresolvedReferences.some((r) => r.referenceName === 'Utils.format')).toBe(true);
  });
```

- [ ] **Step 2: Run the failing base syntax test**

Run:

```bash
npx vitest run __tests__/extraction.test.ts -t "additional base syntax"
```

Expected: fails on inline component and one or more static references.

- [ ] **Step 3: Add inline component recovery**

Modify `src/extraction/languages/qml.ts` by adding:

```ts
function inlineComponentName(errorNode: SyntaxNode, source: string): string | null {
  const text = getNodeText(errorNode, source);
  const match = /^\s*component\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(text);
  return match?.[1] ?? null;
}

function visitInlineComponentError(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = inlineComponentName(node, ctx.source);
  if (!name) return false;
  const component = ctx.createNode('component', name, node, {
    signature: getNodeText(node, ctx.source).split('{')[0]!.trim(),
  });
  if (!component) return true;
  ctx.pushScope(component.id);
  for (const child of node.namedChildren) {
    if (child.type === 'ui_object_definition') {
      const initializer = getChildByField(child, 'initializer');
      if (initializer) {
        for (const grandchild of initializer.namedChildren) ctx.visitNode(grandchild);
      }
    } else {
      ctx.visitNode(child);
    }
  }
  ctx.popScope();
  return true;
}
```

Update `visitNode`:

```ts
    if (node.type === 'ERROR') return visitInlineComponentError(node, ctx);
```

- [ ] **Step 4: Ensure object arrays are traversed**

Modify `visitBinding()` so `valueNode` traversal reaches `ui_object_array` children:

```ts
  if (valueNode) {
    for (const child of valueNode.namedChildren) {
      if (child.type === 'ui_object_definition') ctx.visitNode(child);
    }
    addStaticReferences(valueNode, ctx, owner);
  }
```

- [ ] **Step 5: Run the additional base syntax test**

Run:

```bash
npx vitest run __tests__/extraction.test.ts -t "additional base syntax"
```

Expected: test passes.

- [ ] **Step 6: Commit additional syntax coverage**

Run:

```bash
git add src/extraction/languages/qml.ts __tests__/extraction.test.ts
git commit -m "feat(qml): cover qml base syntax"
```

Expected: commit succeeds.

---

### Task 7: Add End-to-End QML Graph Tests

**Files:**
- Create: `__tests__/qml-integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `__tests__/qml-integration.test.ts` with:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('QML end-to-end graph support', () => {
  let tmpDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qml-'));
    cg = new CodeGraph(tmpDir);
  });

  afterEach(async () => {
    await cg.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes QML files and traverses handler to local function relationships', async () => {
    fs.mkdirSync(path.join(tmpDir, 'Controls'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `
import QtQuick
import "utils.js" as Utils

Item {
  id: root
  property int count: 1
  function submit() {
    updateState(root.count)
  }
  function updateState(value) {
    count = value
  }
  MouseArea {
    onClicked: submit()
  }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'PrimaryButton.qml'),
      `
import QtQuick
Rectangle {
  id: primaryButton
  property alias label: labelText.text
  Text { id: labelText; text: "OK" }
}
`
    );
    fs.writeFileSync(path.join(tmpDir, 'utils.js'), `export function format(value) { return String(value); }\n`);

    await cg.initialize();
    await cg.indexAll();

    const files = cg.getFiles();
    expect(files.some((f) => f.path === 'Main.qml' && f.language === 'qml')).toBe(true);
    expect(files.some((f) => f.path === 'Controls/PrimaryButton.qml' && f.language === 'qml')).toBe(true);

    const components = cg.getNodesByKind('component');
    expect(components.some((n) => n.name === 'root' && n.filePath === 'Main.qml')).toBe(true);
    expect(components.some((n) => n.name === 'primaryButton' && n.filePath === 'Controls/PrimaryButton.qml')).toBe(true);

    const submit = cg.getNodesByName('submit').find((n) => n.filePath === 'Main.qml');
    expect(submit).toBeDefined();

    const callers = await cg.getCallers('submit');
    expect(callers.some((c) => c.node.name === 'onClicked' && c.node.filePath === 'Main.qml')).toBe(true);

    const callees = await cg.getCallees('onClicked');
    expect(callees.some((c) => c.node.name === 'submit' && c.node.filePath === 'Main.qml')).toBe(true);

    const impacted = await cg.getImpact('updateState', { maxDepth: 2 });
    expect(impacted.nodes.some((n) => n.name === 'submit' && n.filePath === 'Main.qml')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the failing or passing integration test**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts
```

Expected: if same-file QML references are not yet resolving, this fails on callers/callees. The failure should show missing `onClicked -> submit` or `submit -> updateState`.

- [ ] **Step 3: Tighten QML reference names for same-file resolution**

If the test fails because `onClicked -> submit` does not resolve, update `addStaticReferences()` so a `call_expression` emits the bare callee for simple identifiers:

```ts
    if (current.type === 'call_expression') {
      const name = callName(current, ctx.source);
      if (name) {
        const root = name.split('.')[0]!;
        addRef(ctx, fromNodeId, name, current, 'calls');
        if (name !== root && !QML_REFERENCE_SKIP.has(root)) {
          addRef(ctx, fromNodeId, root, current, 'references');
        }
      }
    }
```

This keeps `submit()` as a direct call to `submit`, while `Utils.format()` remains a call to `Utils.format`.

- [ ] **Step 4: Re-run the integration test**

Run:

```bash
npx vitest run __tests__/qml-integration.test.ts
```

Expected: test passes.

- [ ] **Step 5: Commit integration coverage**

Run:

```bash
git add src/extraction/languages/qml.ts __tests__/qml-integration.test.ts
git commit -m "test(qml): add end-to-end qml graph coverage"
```

Expected: commit succeeds.

---

### Task 8: Update User-Facing Documentation and Final Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-06-09-qt-quick-design.md`

- [ ] **Step 1: Update README supported-language wording**

Find the supported-language section in `README.md`:

```bash
rg -n "Supported|Languages|C\\+\\+|Vue|Svelte|QML" README.md
```

Add QML to the language list using the existing README style. If the README uses prose rather than a table, add this sentence near the supported-language list:

```markdown
QML / Qt Quick files are indexed as first-class source files for component trees,
properties, signals, handlers, and QML-internal static calls/references.
```

- [ ] **Step 2: Update the QML spec with implementation status**

Modify `docs/superpowers/specs/2026-06-09-qt-quick-design.md` by adding this line under `## Summary`:

```markdown
**Implementation status:** implemented for QML-internal graph generation; C++/QML bridging remains deferred.
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
npx vitest run __tests__/extraction.test.ts -t "QML|Language Support"
npx vitest run __tests__/qml-integration.test.ts
```

Expected: both commands pass.

- [ ] **Step 4: Run broader affected tests**

Run:

```bash
npx vitest run __tests__/extraction.test.ts __tests__/resolution.test.ts __tests__/frameworks-integration.test.ts
```

Expected: all selected suites pass.

- [ ] **Step 5: Run build**

Run:

```bash
npm run build
```

Expected: TypeScript compiles and assets copy without errors.

- [ ] **Step 6: Inspect git status**

Run:

```bash
git status --short
```

Expected: only intended QML implementation, tests, package files, and docs are modified.

- [ ] **Step 7: Commit docs and final verification updates**

Run:

```bash
git add README.md docs/superpowers/specs/2026-06-09-qt-quick-design.md
git commit -m "docs(qml): document qml graph support"
```

Expected: commit succeeds.

---

## Self-Review

**Spec coverage:** This plan covers standard language wiring, real tree-sitter grammar use, QML-internal graph generation, object trees, ids, properties, signals, functions, handlers, `Connections`, static calls, static references, additional base syntax, error containment through conservative visitor behavior, and end-to-end graph query validation.

**Deferred by design:** C++ `setContextProperty`, `qmlRegisterType`, `qmlRegisterSingletonType`, `Q_PROPERTY`, `Q_INVOKABLE`, C++ signals, `qmldir` module registry resolution, and dynamic URL/component loading are not implemented in this plan because the approved first version explicitly defers C++/QML bridging and module registry work.

**Completeness scan:** Every implementation task has concrete files, commands, expected results, and code snippets. Inline-component handling is specified through constrained recovery inside `qmlExtractor`.

**Type consistency:** The plan uses the existing `LanguageExtractor`, `ExtractorContext`, `NodeKind`, and `EdgeKind` APIs. All QML nodes use existing node kinds: `component`, `variable`, `property`, `method`, `function`, `enum`, `enum_member`, and `import`. All relationships use existing unresolved reference kinds: `imports`, `calls`, and `references`.
