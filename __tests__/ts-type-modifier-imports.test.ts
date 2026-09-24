/**
 * TypeScript `type` modifiers on imports and re-exports.
 *
 * `import { type Cfg }` recorded the local name `"type Cfg"`, so the name
 * never matched and a reference to `Cfg` fell through to name-matching —
 * which picked whichever `Cfg` came first, often the wrong file.
 * `import type { Cfg }` recorded a bogus default import named `type`;
 * `import type X from` / `import type * as ns from` were not recognised at
 * all; and `export { type Foo } from` / `export type { Foo } from` dropped the
 * re-export, breaking barrel resolution for types.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractImportMappings, extractReExports } from '../src/resolution/import-resolver';

function mappings(content: string) {
  return extractImportMappings('src/a.ts', content, 'typescript').map((m) => ({
    local: m.localName,
    exported: m.exportedName,
    source: m.source,
    isDefault: m.isDefault,
    isNamespace: m.isNamespace,
  }));
}

describe('import mappings with a `type` modifier', () => {
  it('inline `type` on a named import', () => {
    expect(mappings(`import { type Cfg, run } from './cfg';`)).toEqual([
      { local: 'Cfg', exported: 'Cfg', source: './cfg', isDefault: false, isNamespace: false },
      { local: 'run', exported: 'run', source: './cfg', isDefault: false, isNamespace: false },
    ]);
  });

  it('inline `type` with an alias', () => {
    expect(mappings(`import { type Cfg as Config } from './cfg';`)).toEqual([
      { local: 'Config', exported: 'Cfg', source: './cfg', isDefault: false, isNamespace: false },
    ]);
  });

  it('`import type { … }` records no default import named `type`', () => {
    expect(mappings(`import type { Cfg, Opts as O } from './cfg';`)).toEqual([
      { local: 'Cfg', exported: 'Cfg', source: './cfg', isDefault: false, isNamespace: false },
      { local: 'O', exported: 'Opts', source: './cfg', isDefault: false, isNamespace: false },
    ]);
  });

  it('`import type X from` and `import type * as ns from`', () => {
    expect(mappings(`import type Cfg from './cfg';\nimport type * as types from './types';`)).toEqual([
      { local: 'Cfg', exported: 'default', source: './cfg', isDefault: true, isNamespace: false },
      { local: 'types', exported: '*', source: './types', isDefault: false, isNamespace: true },
    ]);
  });

  it('ignores comments beside a specifier', () => {
    const content = `import {\n  // the config\n  type Cfg as Config, /* runner */ run,\n  load, // eslint-disable-line\n} from './cfg';`;
    expect(mappings(content).map((m) => `${m.exported}->${m.local}`)).toEqual(['Cfg->Config', 'run->run', 'load->load']);
  });

  it('keeps `$` and non-ASCII identifiers', () => {
    const content = `import $ from 'jquery';\nimport { component$, $ as dollar, type Café } from './q';\nimport * as $$ from './all';`;
    expect(mappings(content).map((m) => `${m.exported}->${m.local}`)).toEqual([
      'default->$',
      'component$->component$',
      '$->dollar',
      'Café->Café',
      '*->$$',
    ]);
  });

  it('a comma inside a comment does not split the list; a block comment still separates words', () => {
    const content = `import {\n  A, // used by foo, bar\n  B, /* one, two */\n  type/* inline */C,\n  D/**/as E,\n} from './x';`;
    expect(mappings(content).map((m) => `${m.exported}->${m.local}`)).toEqual(['A->A', 'B->B', 'C->C', 'D->E']);
  });

  it('leaves the rest of a Vue/Svelte file alone (markup is not JavaScript)', () => {
    const sfc = `<template><p>Don't panic</p></template>\n<script setup lang="ts">\nimport X from 'https://esm.sh/x';\nimport { type B } from './b';\nimport C from './c';\n</script>`;
    expect(extractImportMappings('a.vue', sfc, 'vue').map((m) => `${m.localName}@${m.source}`)).toEqual([
      'X@https://esm.sh/x',
      'B@./b',
      'C@./c',
    ]);
  });

  it('a multi-line JSDoc `@import`', () => {
    const js = `/**\n * @import {\n *   Foo,\n *   Bar as B\n * } from './types'\n */\nexport function g() {}`;
    expect(extractImportMappings('a.js', js, 'javascript').map((m) => `${m.exportedName}->${m.localName}`)).toEqual([
      'Foo->Foo',
      'Bar->B',
    ]);
  });

  it('phase imports: `defer` is a modifier; a `source` import binds no export', () => {
    expect(mappings(`import defer * as ns from 'x';\nimport source wasm from './m.wasm';\nimport defer from 'y';`).map((m) => `${m.exported}->${m.local}`)).toEqual([
      '*->ns',
      'default->defer',
    ]);
  });

  it('an import example inside an ordinary doc comment is not a JSDoc `@import`', () => {
    const js = `/**\n * Example:\n * import {\n *   createStore,\n * } from 'redux'\n */\nexport function createStore() {}`;
    expect(extractImportMappings('a.js', js, 'javascript')).toEqual([]);
  });

  it('imports written with no spaces', () => {
    expect(mappings(`import{a as b}from"x";import*as ns from"y";`).map((m) => `${m.exported}->${m.local}@${m.source}`)).toEqual([
      'a->b@x',
      '*->ns@y',
    ]);
  });

  it('keeps JSDoc `@import` tags', () => {
    const js = `/** @import { Foo } from './types' */\n/** @param {Foo} f */\nexport function g(f) {}`;
    expect(extractImportMappings('a.js', js, 'javascript').map((m) => `${m.localName}@${m.source}`)).toEqual(['Foo@./types']);
  });

  it('`type` modifier with no space, and `type` named default with extra space', () => {
    expect(mappings(`import type{ A } from './a';\nimport type*as ns from './n';`).map((m) => `${m.exported}->${m.local}`)).toEqual([
      'A->A',
      '*->ns',
    ]);
    expect(mappings(`import type  from './t';\nimport type\n  from './u';`).map((m) => `${m.exported}->${m.local}@${m.source}`)).toEqual([
      'default->type@./t',
      'default->type@./u',
    ]);
  });

  it('string-named specifiers (ES2022)', () => {
    expect(mappings(`import { "my-fn" as myFn, 'a b' as ab } from './m';`).map((m) => `${m.exported}->${m.local}`)).toEqual([
      'my-fn->myFn',
      'a b->ab',
    ]);
    const re = extractReExports(`export { "my-fn" as myFn } from './m';`, 'typescript');
    expect(re.map((r) => r.kind === 'named' && `${r.originalName}->${r.exportedName}`)).toEqual(['my-fn->myFn']);
  });

  it('a block comment in a list ends at its own `*/`', () => {
    const content = `import { a /* one */ } from './a';\nimport { b /* two */ } from './b';`;
    expect(mappings(content).map((m) => `${m.local}@${m.source}`)).toEqual(['a@./a', 'b@./b']);
  });

  it('string names with commas, braces or escaped quotes; Flow `typeof`', () => {
    const content = `import { "a,b" as c, 'it\\'s' as e, typeof Foo as Bar } from './a';`;
    expect(mappings(content).map((m) => `${m.exported}->${m.local}`)).toEqual(['a,b->c', "it's->e", 'Foo->Bar']);
    const re = extractReExports(`export { "a-b" } from './a';\nexport * as "ns-x" from './b';`, 'typescript');
    expect(re.map((r) => (r.kind === 'named' ? `${r.originalName}->${r.exportedName}` : `*@${r.source}`))).toEqual([
      '*@./b',
      'a-b->a-b',
    ]);
  });

  it('Flow statement-level `typeof`; escapes in string names are decoded', () => {
    expect(mappings(`import typeof { a } from 'x';\nimport typeof Foo from 'y';`).map((m) => `${m.exported}->${m.local}@${m.source}`)).toEqual([
      'a->a@x',
      'default->Foo@y',
    ]);
    expect(mappings(`import { "\\u0041" as d, "a\\nb" as e, "\\x41\\u0042" as f } from 'x';`).map((m) => `${JSON.stringify(m.exported)}->${m.local}`)).toEqual([
      '"A"->d',
      '"a\\nb"->e',
      '"AB"->f',
    ]);
  });

  it('parses a large barrel list (no length cap)', () => {
    const names = Array.from({ length: 1000 }, (_, i) => `Icon${i}`);
    expect(mappings(`import { ${names.join(', ')} } from 'icons';`)).toHaveLength(1000);
    expect(extractReExports(`export { ${names.join(', ')} } from './icons';`, 'typescript')).toHaveLength(1000);
  });

  it('stays fast on long whitespace after `import`', () => {
    // Main took ~5 s on this input (~40 s on 800 spaces); linear now.
    // Kept small on purpose: a synchronous regex can't be interrupted, so a
    // reintroduced blow-up must fail in seconds, not hang the suite.
    const content = `import type${' '.repeat(400)}\n// we import them${'\n'.repeat(400)}`;
    const t = Date.now();
    mappings(content);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('still treats `type` as a name where it is one', () => {
    // A default import named `type`, a named import `type`, and one aliased.
    expect(mappings(`import type from './t';\nimport { type } from './u';\nimport { type as kind } from './v';`)).toEqual([
      { local: 'type', exported: 'default', source: './t', isDefault: true, isNamespace: false },
      { local: 'type', exported: 'type', source: './u', isDefault: false, isNamespace: false },
      { local: 'kind', exported: 'type', source: './v', isDefault: false, isNamespace: false },
    ]);
  });
});

describe('re-exports with a `type` modifier', () => {
  const named = (content: string) =>
    extractReExports(content, 'typescript')
      .filter((r) => r.kind === 'named')
      .map((r) => r.kind === 'named' && `${r.originalName}->${r.exportedName}@${r.source}`);

  it('inline `type` in a re-export list', () => {
    expect(named(`export { type Cfg, run, type Opts as O } from './cfg';`)).toEqual([
      'Cfg->Cfg@./cfg',
      'run->run@./cfg',
      'Opts->O@./cfg',
    ]);
  });

  it('`export type * from`', () => {
    const wild = extractReExports(`export type * from './a';`, 'typescript')
      .filter((r) => r.kind === 'wildcard')
      .map((r) => r.source);
    expect(wild).toEqual(['./a']);
  });

  it('comments in a re-export list are stripped even when the file-wide scan loses its place', () => {
    const tsx = `const A = () => <p>Don't</p>;\nexport {\n  a, // old, b\n  c,\n} from './a';`;
    expect(named(tsx)).toEqual(['a->a@./a', 'c->c@./a']);
  });

  it('`export` must be a whole word', () => {
    expect(extractReExports(`reexport { a } from './a';\nmyexport * from './b';\nexporttype { c } from './c';`, 'typescript')).toEqual([]);
  });

  it('`export type { … } from`', () => {
    expect(named(`export type { Cfg, Opts as O } from './cfg';`)).toEqual(['Cfg->Cfg@./cfg', 'Opts->O@./cfg']);
  });
});

describe('a type imported with a `type` modifier resolves to its declaration', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-type-mod-'));
    const w = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    // A same-named decoy that name-matching alone would pick first.
    w('app/cfg-local.ts', 'export interface Cfg { local: number }\n');
    w('lib/cfg.ts', 'export interface Cfg { real: number }\n');
    w('lib/index.ts', "export type { Cfg } from './cfg';\n");
    w('app/inline.ts', "import { type Cfg } from '../lib/cfg';\nexport function inline(c: Cfg) { return c; }\n");
    w('app/barrel.ts', "import type { Cfg } from '../lib';\nexport function barrel(c: Cfg) { return c; }\n");
    // `$` / non-ASCII names, same-named in two files: the import decides.
    const dollar = 'export function $fetch() {}\nexport function user$() {}\nexport function café() {}\n';
    w('fx/a.ts', dollar);
    w('fx/b.ts', dollar);
    w('fx/main.ts', "import { $fetch, user$, café } from './b';\nexport function main() { $fetch(); user$(); café(); }\n");
    cg = await CodeGraph.init(dir, { index: true });
  });

  afterAll(() => {
    cg?.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const typeRefs = (fn: string) => {
    const node = cg.getNodesByName(fn).find((n) => n.kind === 'function');
    expect(node).toBeDefined();
    return cg
      .getCallees(node!.id)
      .filter(({ node: t }) => t.name === 'Cfg')
      .map(({ node: t }) => t.filePath);
  };

  it('`$` and non-ASCII named imports bind to the file they are imported from', () => {
    const main = cg.getNodesByName('main').find((n) => n.kind === 'function' && n.filePath === 'fx/main.ts');
    expect(main).toBeDefined();
    const targets = cg.getCallees(main!.id).map(({ node }) => `${node.name}@${node.filePath}`).sort();
    expect(targets).toEqual(['$fetch@fx/b.ts', 'café@fx/b.ts', 'user$@fx/b.ts']);
  });

  it('`import { type Cfg }` → lib/cfg.ts', () => {
    expect(typeRefs('inline')).toEqual(['lib/cfg.ts']);
  });

  it('`import type { Cfg }` through a type-only barrel → lib/cfg.ts', () => {
    expect(typeRefs('barrel')).toEqual(['lib/cfg.ts']);
  });
});
