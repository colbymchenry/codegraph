/**
 * codegraph_explore for a query that names ONE symbol (#3407).
 *
 * "What is X?", "who calls X?", "what breaks if X changes?" arrive as a
 * one-name query. Explore used to answer them with its ranked, budget-filling
 * answer: ~25,000 characters of files that matched the name's WORDS, often
 * without the one line that uses it, and the agent then grepped and read
 * anyway. A one-symbol query now gets that symbol's definition and every line
 * that depends on it, each with its function and its text.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler, getExploreOutputBudget } from '../src/mcp/tools';
import { oneSymbolQueryName } from '../src/mcp/explore-one-symbol';

interface Project { dir: string; cg: CodeGraph }

async function project(prefix: string, files: Record<string, string>): Promise<Project> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  return { dir, cg };
}

function destroy(p: Project | undefined): void {
  if (!p) return;
  p.cg.destroy();
  fs.rmSync(p.dir, { recursive: true, force: true });
}

async function explore(p: Project, query: string): Promise<string> {
  const result = await new ToolHandler(p.cg).execute('codegraph_explore', { query });
  expect(result.isError ?? false).toBe(false);
  return result.content?.[0]?.text ?? '';
}

describe('which queries name one symbol', () => {
  it.each([
    ['MODELS_MODULE_NAME', 'MODELS_MODULE_NAME'],
    ['toValidURL callers', 'toValidURL'],
    ['Engine.ServeHTTP callers', 'Engine.ServeHTTP'],
    ['`noWritten`', 'noWritten'],
    ['where is noWritten defined?', 'noWritten'],
    ['who calls toValidURL()', 'toValidURL'],
    ['what would break if BaseStorage changed', 'BaseStorage'],
  ])('%s → %s', (query, name) => {
    expect(oneSymbolQueryName(query)).toBe(name);
  });

  it.each([
    ['a flow: two names', 'mutateElement renderScene'],
    ['a question with other content words', 'how does the router dispatch requests'],
    ['no name at all', 'callers'],
    ['too short to be a name', 'ab'],
    ['a path', 'src/url.ts'],
  ])('%s → none', (_why, query) => {
    expect(oneSymbolQueryName(query)).toBeNull();
  });
});

describe('the answer for one TypeScript symbol', () => {
  let ts: Project | undefined;
  beforeAll(async () => {
    ts = await project('codegraph-one-symbol-ts-', {
      'src/normalize.ts': [
        'export function normalize(value: string): string {',
        '  return value.trim();',
        '}',
        '',
      ].join('\n'),
      'src/url.ts': [
        "import { normalize } from './normalize';",
        '',
        'export const toValidURL = (link: string): string => {',
        '  const cleaned = normalize(link);',
        "  return cleaned.startsWith('/') ? `https://example.test${cleaned}` : cleaned;",
        '};',
        '',
      ].join('\n'),
      'src/render.ts': [
        "import { toValidURL } from './url';",
        '',
        'export function renderEmbed(link: string): string {',
        '  const src = toValidURL(link);',
        '  return `<iframe src="${src}"></iframe>`;',
        '}',
        '',
      ].join('\n'),
      'src/library.ts': [
        "import { toValidURL } from './url';",
        '',
        'export class Library {',
        '  load(url: string): Promise<Response> {',
        '    return fetch(toValidURL(url));',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/url.test.ts': [
        "import { toValidURL } from './url';",
        '',
        "describe('toValidURL', () => {",
        "  it('keeps absolute links', () => {",
        "    expect(toValidURL('https://a.test')).toBe('https://a.test');",
        '  });',
        '});',
        '',
      ].join('\n'),
      'src/constants.ts': [
        'export const SNAP_THRESHOLD = 30;',
        'export const OTHER_LIMIT = 5;',
        '',
      ].join('\n'),
      'src/snap.ts': [
        "import { SNAP_THRESHOLD } from './constants';",
        '',
        'export function snapToCenter(distance: number): boolean {',
        '  // Within SNAP_THRESHOLD pixels the text snaps to the center.',
        '  return distance < SNAP_THRESHOLD;',
        '}',
        '',
      ].join('\n'),
      'src/deep.ts': [
        'export function deepHelper(n: number): number {',
        '  return n * 2;',
        '}',
        '',
      ].join('\n'),
      'src/mid.ts': [
        "import { deepHelper } from './deep';",
        '',
        'export function mid(n: number): number {',
        '  return deepHelper(n) + 1;',
        '}',
        '',
      ].join('\n'),
      'src/mid.test.ts': [
        "import { mid } from './mid';",
        '',
        "it('adds one', () => {",
        '  expect(mid(1)).toBe(3);',
        '});',
        '',
      ].join('\n'),
      'src/widgets.ts': ['Alpha', 'Beta', 'Gamma', 'Delta'].map((name) => [
        `export class ${name}Widget {`,
        '  render(): string {',
        `    return '${name}';`,
        '  }',
        '}',
        '',
      ].join('\n')).join('\n'),
    });
  }, 120_000);
  afterAll(() => destroy(ts));

  it('shows the definition, then every caller with its function, line and text', async () => {
    const text = await explore(ts!, 'toValidURL callers');
    expect(text).toContain('**`toValidURL`** (function) — defined at `src/url.ts:3`');
    expect(text).toContain('3\texport const toValidURL = (link: string): string => {');
    expect(text).toContain('**Called by**');
    expect(text).toContain('- `renderEmbed` — `src/render.ts:4`: `const src = toValidURL(link);`');
    expect(text).toContain('- `Library.load` — `src/library.ts:5`: `return fetch(toValidURL(url));`');
    expect(text).toContain('**Calls** `normalize` (`src/normalize.ts:1`)');
  });

  it('is sized to the symbol, not to the budget', async () => {
    const text = await explore(ts!, 'toValidURL');
    const budget = getExploreOutputBudget(ts!.cg.getStats().fileCount);
    expect(text.length).toBeLessThan(budget.maxOutputChars / 4);
    // Nothing from files that only share a word with the name.
    expect(text).not.toContain('src/widgets.ts');
  });

  it('lists the sites in tests apart, by file and line, without their imports', async () => {
    const text = await explore(ts!, 'toValidURL');
    // Line 5 calls it; line 1 imports it and line 3 names it in a `describe` title.
    expect(text).toContain('plus 1 site in tests');
    expect(text).toMatch(/\*\*In tests\*\* \(1 site, 1 file\)\n- `src\/url\.test\.ts`: 5\n/);
    expect(text).not.toMatch(/Called by[^\n]*\n(?:- [^\n]*\n)*- [^\n]*url\.test\.ts/);
  });

  it('finds a constant\'s use inside a function the import alone links to the file', async () => {
    const text = await explore(ts!, 'SNAP_THRESHOLD');
    expect(text).toContain('**`SNAP_THRESHOLD`** (constant) — defined at `src/constants.ts:1`');
    expect(text).toContain('- `snapToCenter` — `src/snap.ts:5`: `return distance < SNAP_THRESHOLD;`');
    // The comment that names it is prose about it, not a use.
    expect(text).not.toContain('src/snap.ts:4');
    expect(text).toContain('**Imported or re-exported in** `src/snap.ts:1`');
  });

  it('says when tests reach a symbol only through its callers', async () => {
    const text = await explore(ts!, 'deepHelper');
    expect(text).toContain('- `mid` — `src/mid.ts:4`: `return deepHelper(n) + 1;`');
    expect(text).toMatch(/\*\*Tests\*\* — none refer to it directly; tested via callers: `src\/mid\.test\.ts`/);
  });

  it('leaves a name with more definitions than it can show to the ranked answer', async () => {
    const text = await explore(ts!, 'render');
    expect(text).not.toContain('— defined at');
    expect(text).toContain('**Exploration');
  });

  it('turns off with CODEGRAPH_EXPLORE_ONE_SYMBOL=0', async () => {
    const before = process.env.CODEGRAPH_EXPLORE_ONE_SYMBOL;
    process.env.CODEGRAPH_EXPLORE_ONE_SYMBOL = '0';
    try {
      const text = await explore(ts!, 'toValidURL');
      expect(text).not.toContain('— defined at');
      expect(text).toContain('**Exploration');
    } finally {
      if (before === undefined) delete process.env.CODEGRAPH_EXPLORE_ONE_SYMBOL;
      else process.env.CODEGRAPH_EXPLORE_ONE_SYMBOL = before;
    }
  });

  it('keeps a query that names two symbols on the ranked answer', async () => {
    const text = await explore(ts!, 'toValidURL normalize');
    expect(text).not.toContain('— defined at');
  });
});

describe('the answer for one Python class', () => {
  let py: Project | undefined;
  beforeAll(async () => {
    py = await project('codegraph-one-symbol-py-', {
      'storage/__init__.py': '',
      'storage/base.py': [
        'class BaseStorage:',
        '    def __init__(self, request):',
        '        self.request = request',
        '',
        '    def _get(self):',
        '        raise NotImplementedError',
        '',
        '    def _store(self, messages):',
        '        raise NotImplementedError',
        '',
        '    def add(self, message):',
        '        self._store([message])',
        '',
      ].join('\n'),
      'storage/cookie.py': [
        'from storage.base import BaseStorage',
        '',
        '',
        'class CookieStorage(BaseStorage):',
        '    def _get(self):',
        '        return []',
        '',
        '    def _store(self, messages):',
        '        return messages',
        '',
      ].join('\n'),
      'storage/api.py': [
        'from storage.base import BaseStorage',
        '',
        'CHOSEN = None',
        '',
        'def make_storage(request):',
        '    """Build a BaseStorage for the request.',
        '',
        '    Any BaseStorage subclass works here.',
        '    """',
        '    # BaseStorage is abstract, so a subclass is picked.',
        '    if not issubclass(CHOSEN, BaseStorage):',
        '        raise TypeError("CHOSEN must be a BaseStorage")',
        '    return CHOSEN(request)',
        '',
      ].join('\n'),
    });
  }, 120_000);
  afterAll(() => destroy(py));

  it('counts a line that names it in code, not in a docstring, comment or string', async () => {
    const text = await explore(py!, 'BaseStorage');
    expect(text).toContain('- `make_storage` — `storage/api.py:11`: `if not issubclass(CHOSEN, BaseStorage):`');
    for (const prose of [6, 8, 10, 12]) expect(text).not.toContain(`storage/api.py:${prose}\``);
  });

  it('lists each subclass with the members it redefines', async () => {
    const text = await explore(py!, 'BaseStorage');
    expect(text).toContain('**`BaseStorage`** (class) — defined at `storage/base.py:1`');
    expect(text).toContain('**Extended by** (1 site, 1 file)');
    expect(text).toMatch(/- `CookieStorage` — `storage\/cookie\.py:4`: `class CookieStorage\(BaseStorage\):` — also defines `_get`, `_store`/);
    // The class's own body is the definition, not something that depends on it.
    expect(text).toContain('12\t        self._store([message])');
  });
});

describe('the answer for a Go value another package names', () => {
  let go: Project | undefined;
  beforeAll(async () => {
    go = await project('codegraph-one-symbol-go-', {
      'go.mod': 'module example.test/app\n\ngo 1.21\n',
      'binding/query.go': 'package binding\n\ntype queryBinding struct{}\n\nfunc (queryBinding) Name() string { return "query" }\n',
      // Two build-tag variants of one variable, as gin has: the resolver can't
      // pick between them, so `binding.Query` stays unresolved.
      'binding/binding.go': '//go:build !nomsgpack\n\npackage binding\n\nvar Query = queryBinding{}\n',
      'binding/binding_nomsgpack.go': '//go:build nomsgpack\n\npackage binding\n\nvar Query = queryBinding{}\n',
      'context.go': [
        'package app',
        '',
        'import "example.test/app/binding"',
        '',
        'func BindQuery(obj any) any {',
        '\treturn use(obj, binding.Query)',
        '}',
        '',
        'func use(obj any, b any) any { return b }',
        '',
      ].join('\n'),
    });
  }, 120_000);
  afterAll(() => destroy(go));

  it('follows a value that holds the type to the code that uses it', async () => {
    const text = await explore(go!, 'queryBinding');
    expect(text).toContain('**Instantiated by** (2 sites, 2 files)');
    expect(text).toMatch(/- `Query` — `binding\/binding\.go:5`: `var Query = queryBinding\{\}`\n  - `Query` is used by `BindQuery` \(`context\.go:6`\)/);
    // A method's receiver names the type it belongs to; that's not a use.
    expect(text).not.toContain('`queryBinding.Name` —');
  });

  it('counts `binding.Query` as a use of `Query` though the resolver left it unlinked', async () => {
    const text = await explore(go!, 'Query');
    expect(text).toContain('2 definitions named `Query`');
    expect(text).toContain('- `BindQuery` — `context.go:6`: `return use(obj, binding.Query)`');
  });
});

describe('the answer for one Rust function with unit tests', () => {
  let rs: Project | undefined;
  beforeAll(async () => {
    rs = await project('codegraph-one-symbol-rs-', {
      'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/lib.rs': 'pub mod store;\npub mod api;\n',
      'src/store.rs': [
        'pub fn create_note() -> u32 { 1 }',
        '',
        '#[cfg(test)]',
        'mod tests {',
        '    use super::*;',
        '    #[test]',
        '    fn checks_create_note() { let n = create_note(); assert_eq!(n, 1); }',
        '}',
        '',
      ].join('\n'),
      'src/api.rs': [
        'use crate::store::create_note;',
        'pub fn handler() -> u32 { create_note() }',
        '',
      ].join('\n'),
    });
  }, 120_000);
  afterAll(() => destroy(rs));

  it('counts a caller in a #[cfg(test)] module as a test, and production callers apart', async () => {
    const text = await explore(rs!, 'create_note');
    expect(text).toMatch(/\*\*Called by\*\* \(1 site, 1 file\)\n- `handler` — `src\/api\.rs:2`/);
    expect(text).toMatch(/\*\*In tests\*\* \(1 site, 1 file\)\n- `src\/store\.rs`: 7/);
  });
});
