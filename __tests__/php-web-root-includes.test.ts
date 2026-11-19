/**
 * A PHP include built from the web server's root, `require
 * $_SERVER['DOCUMENT_ROOT'] . '/inc/header.php'`, links to its file once the
 * project names that folder as `webRoot` in `codegraph.json` (#3298). The
 * folder is set in the server's configuration, not in the project, so without
 * the setting nothing links: a guess at the project root would link
 * `public/index.php` to the root's `config.php`, not the `public/config.php`
 * PHP loads. A sync after the setting changes is in
 * sync-module-config-change.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { clearProjectConfigCache, loadWebRoot } from '../src/project-config';

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
  it("link nothing without a webRoot, not even the project root's file of the same name", async () => {
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
