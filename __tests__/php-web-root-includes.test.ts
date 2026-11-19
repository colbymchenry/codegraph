/**
 * A PHP include built from the web server's root, `require
 * $_SERVER['DOCUMENT_ROOT'] . '/inc/header.php'`, links to its file under the
 * folder the server serves (#3298). That folder is set in the server's
 * configuration, not in the project, so it comes from `webRoot` in
 * `codegraph.json`, or else from the project's own includes when they settle
 * it (php-web-root.ts). Otherwise nothing links: a guess at the project root
 * would link `public/index.php` to the root's `config.php`, not the
 * `public/config.php` PHP loads. A sync after either moves is in
 * sync-module-config-change.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { clearProjectConfigCache, loadWebRoot } from '../src/project-config';
import { inferPhpWebRoots, phpWebRootSnapshot, phpWebRootsMoved } from '../src/resolution/php-web-root';

type Files = Record<string, string>;

let root = '';
let cg: CodeGraph | undefined;

afterEach(() => {
  cg?.close();
  cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
  clearProjectConfigCache();
});

function write(dir: string, files: Files): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

async function index(files: Files): Promise<CodeGraph> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-php-web-root-'));
  write(root, files);
  cg = await CodeGraph.init(root, { index: true });
  return cg;
}

/** The files anything in `file` imports (the file, or its namespace), sorted. */
function importsOf(graph: CodeGraph, file: string): string[] {
  const out = new Set<string>();
  for (const node of graph.getNodesInFile(file)) {
    for (const e of graph.getOutgoingEdges(node.id)) {
      const t = graph.getNode(e.target);
      if (e.kind === 'imports' && t?.kind === 'file') out.add(t.filePath);
    }
  }
  return [...out].sort();
}

const fn = (name: string) => `<?php\nfunction ${name}() {}\n`;
const config = (webRoot: unknown) => JSON.stringify({ webRoot });

/** A site whose server serves public/, with files of the same names at the project root. */
const SITE: Files = {
  'public/index.php': [
    '<?php',
    "require_once $_SERVER['DOCUMENT_ROOT'] . '/config.php';",
    "include $_SERVER['DOCUMENT_ROOT'] . '/inc/header.php';",
    '',
  ].join('\n'),
  'public/config.php': fn('public_config'),
  'public/inc/header.php': fn('public_header'),
  'config.php': fn('private_config'),
  'inc/header.php': fn('root_header'),
};

describe("PHP includes built from $_SERVER['DOCUMENT_ROOT'] (#3298)", () => {
  it("link nothing when neither a webRoot nor the includes settle the folder, not even to the root's file of the same name", async () => {
    // Two paths, and public/ and the project root each hold both.
    const graph = await index(SITE);
    expect(importsOf(graph, 'public/index.php')).toEqual([]);
  });

  it('link to the file under the webRoot codegraph.json names', async () => {
    const graph = await index({ ...SITE, 'codegraph.json': config('public') });
    expect(importsOf(graph, 'public/index.php')).toEqual(['public/config.php', 'public/inc/header.php']);
  });

  it('take "." for the project root', async () => {
    const graph = await index({ ...SITE, 'codegraph.json': config('.') });
    expect(importsOf(graph, 'public/index.php')).toEqual(['config.php', 'inc/header.php']);
  });

  it('read both quotes, parentheses, DIRECTORY_SEPARATOR, a climb out of the web root and an include in a function', async () => {
    const graph = await index({
      'site/htdocs/index.php': [
        '<?php',
        'require_once($_SERVER["DOCUMENT_ROOT"] . "/inc/a.php");',
        "include $_SERVER[ 'DOCUMENT_ROOT' ] . DIRECTORY_SEPARATOR . 'inc' . DIRECTORY_SEPARATOR . 'b.php';",
        "require $_SERVER['DOCUMENT_ROOT'] . '/../lib/c.php';",
        'function page() {',
        "    require $_SERVER['DOCUMENT_ROOT'] . '/inc/d.php';",
        '}',
        '',
      ].join('\n'),
      'site/htdocs/inc/a.php': fn('a_fn'),
      'site/htdocs/inc/b.php': fn('b_fn'),
      'site/htdocs/inc/d.php': fn('d_fn'),
      'site/lib/c.php': fn('c_fn'),
      'codegraph.json': config('./site\\htdocs/'),
    });
    expect(importsOf(graph, 'site/htdocs/index.php')).toEqual([
      'site/htdocs/inc/a.php', 'site/htdocs/inc/b.php', 'site/htdocs/inc/d.php', 'site/lib/c.php',
    ]);
  });

  it('load the path exactly as written, and never one outside the project', async () => {
    const graph = await index({
      'public/index.php': [
        '<?php',
        // PHP adds no extension to the path it is given.
        "require $_SERVER['DOCUMENT_ROOT'] . '/inc/header';",
        "require $_SERVER['DOCUMENT_ROOT'] . '/inc/missing.php';",
        "require $_SERVER['DOCUMENT_ROOT'] . '/../../outside.php';",
        "require $_SERVER['DOCUMENT_ROOT'] . '/' . $page;",
        "require $_SERVER['DOCUMENT_ROOT'] . 'inc/header.php';",
        '',
      ].join('\n'),
      'public/inc/header.php': fn('header'),
      'outside.php': fn('outside'),
      'codegraph.json': config('public'),
    });
    expect(importsOf(graph, 'public/index.php')).toEqual([]);
  });

  it('read a literal path that merely spells the variable as a plain path', async () => {
    const graph = await index({
      'public/index.php': "<?php\nrequire '$_SERVER[DOCUMENT_ROOT]/inc/header.php';\n",
      'public/inc/header.php': fn('header'),
      'codegraph.json': config('public'),
    });
    expect(importsOf(graph, 'public/index.php')).toEqual([]);
  });
});

/** `count` files under `dir`'s lib/ (`lib/f1.php`, …), each defining a function. */
const libFiles = (dir: string, count: number): Files =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`${dir ? `${dir}/` : ''}lib/f${i + 1}.php`, fn(`f${i + 1}`)]));
/** A page's includes of `/lib/f1.php` … `/lib/f<count>.php` from the web root. */
const includesOf = (count: number): string =>
  Array.from({ length: count }, (_, i) => `require_once $_SERVER['DOCUMENT_ROOT'] . '/lib/f${i + 1}.php';`).join('\n');
const page = (count: number, ...more: string[]) => ['<?php', includesOf(count), ...more, ''].join('\n');

describe("the web root the project's includes show, with no webRoot (#3298)", () => {
  it('finds a site served from the project root, for pages in subfolders too', async () => {
    const graph = await index({
      'index.php': page(3),
      'news/item.php': page(1),
      ...libFiles('', 3),
    });
    expect(importsOf(graph, 'index.php')).toEqual(['lib/f1.php', 'lib/f2.php', 'lib/f3.php']);
    expect(importsOf(graph, 'news/item.php')).toEqual(['lib/f1.php']);
  });

  it("finds public/ when its includes name files only it holds, then links the one both folders hold to public's", async () => {
    const graph = await index({
      'public/index.php': page(3, "require $_SERVER['DOCUMENT_ROOT'] . '/config.php';"),
      ...libFiles('public', 3),
      'public/config.php': fn('public_config'),
      'config.php': fn('private_config'),
    });
    expect(importsOf(graph, 'public/index.php')).toEqual([
      'public/config.php', 'public/lib/f1.php', 'public/lib/f2.php', 'public/lib/f3.php',
    ]);
  });

  it('links nothing on fewer than three paths', async () => {
    const graph = await index({ 'index.php': page(2), ...libFiles('', 2) });
    expect(importsOf(graph, 'index.php')).toEqual([]);
  });

  it('links nothing when two folders explain the includes alike', async () => {
    const graph = await index({ 'public/index.php': page(3), ...libFiles('public', 3), ...libFiles('', 3) });
    expect(importsOf(graph, 'public/index.php')).toEqual([]);
  });

  it('gives each of two sites its own web root', async () => {
    const graph = await index({
      'sites/a/index.php': page(3),
      ...libFiles('sites/a', 3),
      'sites/b/index.php': page(3),
      ...libFiles('sites/b', 3),
    });
    expect(importsOf(graph, 'sites/a/index.php')).toEqual(['sites/a/lib/f1.php', 'sites/a/lib/f2.php', 'sites/a/lib/f3.php']);
    expect(importsOf(graph, 'sites/b/index.php')).toEqual(['sites/b/lib/f1.php', 'sites/b/lib/f2.php', 'sites/b/lib/f3.php']);
  });

  it('leaves a file outside the web root alone, even with a file of the same name at the root', async () => {
    const graph = await index({
      'public_html/index.php': page(3),
      ...libFiles('public_html', 3),
      'includes/db.php': page(1),
      'lib/f1.php': fn('root_f1'),
    });
    expect(importsOf(graph, 'public_html/index.php')).toEqual([
      'public_html/lib/f1.php', 'public_html/lib/f2.php', 'public_html/lib/f3.php',
    ]);
    expect(importsOf(graph, 'includes/db.php')).toEqual([]);
  });

  it('takes a configured webRoot over what the includes show', async () => {
    const graph = await index({
      'public/index.php': page(3, "require $_SERVER['DOCUMENT_ROOT'] . '/config.php';"),
      ...libFiles('public', 3),
      'public/config.php': fn('public_config'),
      'config.php': fn('private_config'),
      'codegraph.json': config('.'),
    });
    expect(importsOf(graph, 'public/index.php')).toEqual(['config.php']);
  });
});

describe('inferPhpWebRoots', () => {
  const infer = (includes: Array<[string, string]>, files: string[]) =>
    Object.fromEntries(inferPhpWebRoots(includes.map(([filePath, written]) => ({ filePath, written })), (p) => files.includes(p)));
  const from = (file: string, written: string[]) => written.map((w) => [file, w] as [string, string]);

  it('counts different paths, not include sites', () => {
    const pages = Array.from({ length: 50 }, (_, i) => [`p${i}.php`, 'inc/header.php'] as [string, string]);
    expect(infer(pages, ['inc/header.php'])).toEqual({ '': null });
  });

  it('wants the winner at twice any rival above the same folder', () => {
    const includes = from('public/index.php', ['a.php', 'b.php', 'c.php', 'd.php']);
    const inPublic = ['public/a.php', 'public/b.php', 'public/c.php', 'public/d.php'];
    expect(infer(includes, [...inPublic, 'a.php', 'b.php'])).toEqual({ public: 'public' });
    expect(infer(includes, [...inPublic, 'a.php', 'b.php', 'c.php'])).toEqual({ public: null });
  });

  it('never counts a path that leaves the project', () => {
    expect(infer(from('index.php', ['../a.php', '../b.php', '../c.php']), ['a.php', 'b.php', 'c.php'])).toEqual({ '': null });
  });

  it('places a climb out of the web root that stays in the project', () => {
    const includes = from('public/index.php', ['../lib/a.php', '../lib/b.php', '../lib/c.php']);
    expect(infer(includes, ['lib/a.php', 'lib/b.php', 'lib/c.php'])).toEqual({ public: 'public' });
  });

  it('answers for every folder holding such an include, the deeper ones too', () => {
    const includes = [...from('index.php', ['a.php', 'b.php', 'c.php']), ...from('x/y/page.php', ['a.php'])];
    expect(infer(includes, ['a.php', 'b.php', 'c.php'])).toEqual({ '': '', 'x/y': '' });
  });
});

describe('phpWebRootsMoved', () => {
  const snap = (roots: Record<string, string | null>) => phpWebRootSnapshot(null, new Map(Object.entries(roots)));

  it("moves for a folder both snapshots know that takes another root, and for webRoot coming or going", () => {
    expect(phpWebRootsMoved(snap({ '': null }), snap({ '': '' }))).toBe(true);
    expect(phpWebRootsMoved(snap({ public: 'public' }), snap({ public: null }))).toBe(true);
    expect(phpWebRootsMoved(snap({ '': '' }), phpWebRootSnapshot('public', new Map()))).toBe(true);
    expect(phpWebRootsMoved(phpWebRootSnapshot('public', new Map()), snap({ '': '' }))).toBe(true);
  });

  it('stays put for a folder that only appears or goes, and for the same roots in another order', () => {
    expect(phpWebRootsMoved(snap({ '': '' }), snap({ '': '', news: '' }))).toBe(false);
    expect(phpWebRootsMoved(snap({ '': '', old: '' }), snap({ '': '' }))).toBe(false);
    expect(snap({ b: '', a: '' })).toBe(snap({ a: '', b: '' }));
  });

  it('moves when a snapshot is unreadable', () => {
    expect(phpWebRootsMoved('not json', snap({ '': '' }))).toBe(true);
  });
});

describe('codegraph.json webRoot', () => {
  function webRootOf(value: unknown): string | null {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-php-web-root-config-'));
    write(root, { 'codegraph.json': JSON.stringify({ exclude: ['vendor/'], webRoot: value }) });
    clearProjectConfigCache();
    return loadWebRoot(root);
  }

  it.each([
    ['public', 'public'],
    ['./public/', 'public'],
    [' web ', 'web'],
    ['site\\htdocs', 'site/htdocs'],
    ['site//htdocs/', 'site/htdocs'],
    ['old/../public', 'public'],
    ['.', ''],
    ['./', ''],
  ])('reads %j as %j', (value, expected) => {
    expect(webRootOf(value)).toBe(expected);
  });

  it.each([
    [''],
    ['   '],
    [42],
    [null],
    [['public']],
    ['/var/www/html'],
    ['C:\\inetpub\\wwwroot'],
    ['c:public'],
    ['../site'],
    ['public/../..'],
  ])('sets none for %j', (value) => {
    expect(webRootOf(value)).toBeNull();
  });

  it('sets none without the key, or without the file', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-php-web-root-config-'));
    expect(loadWebRoot(root)).toBeNull();
    write(root, { 'codegraph.json': JSON.stringify({ exclude: ['vendor/'] }) });
    clearProjectConfigCache();
    expect(loadWebRoot(root)).toBeNull();
  });
});
