# Adding a Language

This is a cookbook for adding a new language to CodeGraph. It assumes you have a
working dev setup (`npm install` and `npm test` pass).

There are two patterns. **Pick the one that matches the language you're adding.**

| Language shape | Pattern | Examples |
|---|---|---|
| Procedural / OO with named functions, classes, methods | **`LanguageExtractor` config** | `python.ts`, `ruby.ts`, `r.ts` |
| Declarative / template / configuration / no named functions | **Custom extractor class** | `hcl-extractor.ts`, `liquid-extractor.ts`, `sql-extractor.ts` |

The two patterns share the same setup steps (1–4) and only diverge at the extractor
itself (step 5).

---

## 1. Source a tree-sitter wasm grammar

CodeGraph parses everything via [`web-tree-sitter`](https://www.npmjs.com/package/web-tree-sitter),
so the grammar has to be available as a `.wasm` file. Three options, in order of
preference:

### 1a. Already in `tree-sitter-wasms`

The [`tree-sitter-wasms`](https://www.npmjs.com/package/tree-sitter-wasms) npm package
ships pre-built wasms for 30+ common languages. Check `node_modules/tree-sitter-wasms/out/`
after a fresh install:

```bash
ls node_modules/tree-sitter-wasms/out/ | grep <lang>
```

If your grammar is there, you're done with this step — just reference the filename.

### 1b. A pre-built `.wasm` released somewhere else

Many grammars publish wasms in their GitHub releases (e.g. r-lib/tree-sitter-r) or
in a separate npm package (e.g. `@tree-sitter-grammars/tree-sitter-hcl` ships
`tree-sitter-hcl.wasm` directly in the tarball).

```bash
# GitHub release
curl -sL -o src/extraction/wasm/tree-sitter-foo.wasm \
  https://github.com/.../releases/download/vX.Y.Z/tree-sitter-foo.wasm

# Inside an npm tarball
mkdir -p /tmp/foo && cd /tmp/foo
curl -sL https://registry.npmjs.org/tree-sitter-foo/-/tree-sitter-foo-X.Y.Z.tgz | tar xz
cp package/tree-sitter-foo.wasm <repo>/src/extraction/wasm/
```

Verify the sha256 against the upstream release manifest before committing.

### 1c. Build from source

If only the C source is published (e.g. DerekStride/tree-sitter-sql), build the wasm
locally with `tree-sitter-cli`. Recent versions ship their own wasi-sdk and don't need
Docker or local emcc:

```bash
mkdir /tmp/foo && cd /tmp/foo
curl -sL https://github.com/.../releases/download/vX.Y.Z/tree-sitter-foo.tar.gz | tar xz
npx --yes tree-sitter-cli@latest build --wasm
cp tree-sitter-foo.wasm <repo>/src/extraction/wasm/
```

### Where the wasm lives

- Grammars from the `tree-sitter-wasms` package are loaded directly from there at runtime.
- Other grammars must be **vendored** under `src/extraction/wasm/` so they ship in the
  npm package. The build's `copy-assets` script copies every `.wasm` from that
  directory into `dist/extraction/wasm/`.

**License check.** Tree-sitter grammars are usually MIT or Apache-2.0 — confirm before
committing the wasm and note the source/version in the file's header comment so the
provenance is recoverable later.

---

## 2. Probe the AST

Don't guess at node types. Parse a representative sample and dump the tree:

```js
// scratch/probe.mjs
import { Parser, Language } from 'web-tree-sitter';
await Parser.init();
const lang = await Language.load('./src/extraction/wasm/tree-sitter-foo.wasm');
const parser = new Parser();
parser.setLanguage(lang);

const sample = `
// realistic code here — cover every construct you plan to extract
`;

const tree = parser.parse(sample);
function dump(n, d = 0, max = 4) {
  if (d > max) return;
  const text = n.text.length > 60 ? n.text.slice(0, 60).replace(/\n/g, '\\n') + '...' : n.text.replace(/\n/g, '\\n');
  console.log(`${'  '.repeat(d)}${n.type}  "${text}"`);
  for (let i = 0; i < n.namedChildCount; i++) dump(n.namedChild(i), d + 1, max);
}
dump(tree.rootNode);
```

```bash
node scratch/probe.mjs
```

Cover every construct you plan to extract: function definitions, classes, methods,
imports, assignments, calls, references. Watch for surprises:

- Some grammars wrap names in extra layers (`identifier > simple_identifier`)
- Field names (`childForFieldName`) often differ from what the docs imply
- Operator nodes can be named, unnamed, or both — call `child(i)` vs `namedChild(i)`
  and inspect

Save the probe output before you start coding — you'll refer to it constantly.

---

## 3. Register the language

Three files, all small.

**`src/types.ts`** — add to the `Language` union and to `DEFAULT_CONFIG.include`:

```ts
export type Language =
  | 'typescript'
  | ...
  | 'foo'                  // ← add here
  | 'unknown';

export const DEFAULT_CONFIG: CodeGraphConfig = {
  ...
  include: [
    ...
    '**/*.foo',            // ← and here
  ],
};
```

**`src/extraction/grammars.ts`** — wire up the wasm path, extension map, and display name:

```ts
const WASM_GRAMMAR_FILES: Record<GrammarLanguage, string> = {
  ...
  foo: 'tree-sitter-foo.wasm',
};

// If vendored under src/extraction/wasm/ instead of tree-sitter-wasms:
const VENDORED_WASM_LANGUAGES: ReadonlySet<GrammarLanguage> = new Set([
  'pascal',
  'foo',                   // ← add here
]);

export const EXTENSION_MAP: Record<string, Language> = {
  ...
  '.foo': 'foo',
};

// And in getLanguageDisplayName():
foo: 'Foo',
```

**`CLAUDE.md`** — append the language to the "Supported Languages" line so the
LLM-readable architecture doc stays in sync.

---

## 4. Type-check before writing the extractor

Run `npx tsc --noEmit` now. If it's not clean, the wiring is wrong — fix that
before adding extraction logic, otherwise type errors will pile up.

---

## 5a. Path A — Plug into `LanguageExtractor`

Use this when the language has named function/class/method declarations (Python, Ruby,
Java, R, etc.). Create `src/extraction/languages/<lang>.ts`:

```ts
import type { LanguageExtractor } from '../tree-sitter-types';

export const fooExtractor: LanguageExtractor = {
  // Map AST node types → graph kinds. Empty array = "this kind doesn't
  // exist in this language."
  functionTypes: ['function_definition'],
  classTypes: ['class_definition'],
  methodTypes: ['function_definition'],   // often the same node, dispatched by context
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_statement'],
  callTypes: ['call'],
  variableTypes: ['assignment'],

  // Field names tree-sitter exposes for extractors to read.
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',

  // Optional hooks — implement what you need:
  getSignature: (node, source) => { ... },
  isExported: (node, source) => { ... },
  isAsync: (node) => { ... },

  // Escape hatch: take over a specific node type entirely. Return true to
  // tell the core "I handled this, skip default dispatch."
  visitNode: (node, ctx) => {
    // R uses this to handle `name <- function() {}` because tree-sitter's
    // function_definition has no name field — the name is on the LHS of
    // the enclosing assignment.
    return false;
  },
};
```

Then register it in `src/extraction/languages/index.ts`:

```ts
import { fooExtractor } from './foo';

export const EXTRACTORS: Partial<Record<Language, LanguageExtractor>> = {
  ...
  foo: fooExtractor,
};
```

The core (`TreeSitterExtractor` in `src/extraction/tree-sitter.ts`) does the rest:
walks the AST, dispatches based on your `*Types` arrays, calls your hooks, manages
the scope stack, and emits nodes/edges.

**Worked example: R** (`src/extraction/languages/r.ts`). R's `function_definition`
has no name (it's anonymous), so `functionTypes` is empty and the `visitNode` hook
intercepts `binary_operator` assignments and emits the function manually via
`ctx.createNode('function', name, ...)`.

## 5b. Path B — Custom extractor class

Use this when the language is declarative (HCL, SQL, dbt) or has a fundamentally
different shape than functions/classes/methods (Liquid templates, Pascal `.dfm` form
files). Create `src/extraction/<lang>-extractor.ts`:

```ts
import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId, getNodeText } from './tree-sitter-helpers';
import { getParser } from './grammars';

export class FooExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    const parser = getParser('foo');
    if (!parser) {
      this.errors.push({ message: 'foo grammar not loaded', severity: 'error', code: 'grammar_unavailable' });
      return this.result(startTime);
    }
    const tree = parser.parse(this.source);
    if (!tree) { ... return this.result(startTime); }

    try {
      const fileNodeId = this.createFileNode();
      // Walk the AST, emit nodes via this.nodes.push and this.edges.push
      // Emit references via this.unresolvedReferences.push so the resolver
      // pass can match them across files.
      ...
      return this.result(startTime);
    } finally {
      tree.delete();   // ← important: tree-sitter trees back onto WASM memory
    }
  }

  private result(startTime: number): ExtractionResult {
    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }
}
```

Wire the dispatch in `src/extraction/tree-sitter.ts`:

```ts
import { FooExtractor } from './foo-extractor';

export function extractFromSource(filePath, source, language?) {
  ...
  if (detectedLanguage === 'foo') {
    return new FooExtractor(filePath, source).extract();
  }
  ...
}
```

**Worked examples:**

- `src/extraction/hcl-extractor.ts` — Terraform / HCL. Block-based DDL. Each
  top-level block becomes a node whose qualified name matches the Terraform
  reference form (`var.X`, `local.X`, `module.X`, `aws_s3_bucket.foo`) so the
  resolver can match references across files automatically.
- `src/extraction/sql-extractor.ts` — SQL DDL. CREATE TABLE / VIEW / FUNCTION /
  TRIGGER / TYPE / SCHEMA → graph nodes; foreign keys, view source tables,
  trigger target tables and executed functions → edges.
- `src/extraction/liquid-extractor.ts` — Shopify Liquid templates. Regex-based
  (no tree-sitter) since the template grammar isn't useful for code intelligence.

---

## 6. Pick `NodeKind` and `EdgeKind` values

`NodeKind` and `EdgeKind` are fixed unions in `src/types.ts`. Map your language's
constructs onto the closest existing kind rather than introducing new ones —
adding a new kind is a cross-cutting change that touches search, resolution, and
context-building code.

Common mappings used by recent extractors:

| Language construct | NodeKind |
|---|---|
| Function / procedure / standalone routine | `function` |
| Method on a class | `method` |
| Class / type / table / declarative resource | `class` |
| Trait / mixin | `trait` |
| Interface / protocol | `interface` |
| Module / package / file-level scope / Terraform module | `module` |
| Namespace / schema / SQL schema / Terraform provider | `namespace` |
| Variable / Terraform variable | `variable` |
| Constant / Terraform local / R top-level binding | `constant` |
| Type alias / SQL composite type | `type_alias` |
| Enum (any) | `enum` |
| Import / library / source / require | `import` |
| Output / re-export / Terraform output | `export` |

Edges are usually one of:

| Edge | When |
|---|---|
| `contains` | Parent contains child (file → block, class → method) |
| `calls` | Function/method invokes another |
| `imports` | File pulls in another module/file |
| `references` | Generic mention of another symbol (FK, lookup, attribute access) |
| `extends` / `implements` | Inheritance relationships |

Emit references through `unresolvedReferences` (with `referenceName` set to a
qualified name that matches what you put on the target node's `qualifiedName`) —
the resolver pass matches them across files using the `name-matcher` and
`import-resolver` modules.

---

## 7. Tests

Tests live in `__tests__/extraction.test.ts`, grouped by language with a
`describe('<Language> Extraction', ...)` block. Use `extractFromSource` directly
for unit-style tests:

```ts
import { extractFromSource } from '../src/extraction';

describe('Foo Extraction', () => {
  describe('Language detection', () => {
    it('should detect Foo files', () => {
      expect(detectLanguage('main.foo')).toBe('foo');
    });
  });

  describe('Function extraction', () => {
    it('should extract a top-level function', () => {
      const code = `function add(a, b) a + b`;
      const result = extractFromSource('main.foo', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'add');
      expect(fn).toBeDefined();
    });
  });
});
```

Cover the AST shapes you saw in the probe, especially the surprising ones. Pay
particular attention to:

- The smallest possible valid program (`expect(...).toBeDefined()` for the file node)
- Each node-kind mapping (one test per emitted kind)
- Reference forms (call edges, FK / cross-file references, imports)
- Anything you intentionally skipped (anonymous lambdas, dynamic imports, etc.)
  with a negative assertion so the omission is documented

Run the suite serialized to avoid the file-watcher tests' parallel flakiness:

```bash
npx vitest run --no-file-parallelism
```

End-to-end smoke test from a fresh fixture before opening the PR:

```bash
SMOKE=$(mktemp -d) && cat > "$SMOKE/main.foo" <<'EOF'
... realistic input ...
EOF
cd "$SMOKE" && git init -q
node <repo>/dist/bin/codegraph.js init "$SMOKE"
node <repo>/dist/bin/codegraph.js index "$SMOKE"
node <repo>/dist/bin/codegraph.js status "$SMOKE"
cd "$SMOKE" && node <repo>/dist/bin/codegraph.js query "<symbol>"
```

The `status` call should report your file under "Files by Language", and `query`
should turn up the symbols you expect at the right line numbers.

---

## 8. Open the PR

Include in the PR description:

- The grammar source + version + license + sha256 (if vendored)
- A small worked example showing what gets extracted
- The full test plan (`npm test`, `tsc`, `npm run build`, CLI smoke)
- Any known limitations (constructs not supported, AST quirks, things the grammar
  itself can't parse)

Don't claim support for constructs the grammar can't actually parse — this happens
more often than you'd expect (e.g. `tree-sitter-sql` errors out on `CREATE
PROCEDURE` because procedure-body syntax varies sharply across dialects). Say what
works, say what doesn't, and let reviewers decide.

---

## Reference: existing extractors as templates

Read these in source order if your language is similar to one of them:

- **Procedural / OO:** `src/extraction/languages/python.ts` (small, easy to read),
  `ruby.ts` (with bare-call detection), `kotlin.ts` (extension functions),
  `r.ts` (no `def` keyword — uses `visitNode` hook for assignments)
- **Declarative / config:** `src/extraction/hcl-extractor.ts` (Terraform reference
  graph), `sql-extractor.ts` (DDL with FK / view source extraction)
- **Embedded / template:** `src/extraction/svelte-extractor.ts` (delegates to JS
  for `<script>` blocks), `liquid-extractor.ts` (regex-based, no tree-sitter)
- **Form / non-tree-sitter:** `src/extraction/dfm-extractor.ts` (Delphi `.dfm`
  files; line-based regex parser cross-linked with Pascal symbols)

When in doubt, copy the extractor closest in shape to yours and modify from there.
