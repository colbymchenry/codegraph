/**
 * A PHP include built from the including file's own directory, `require_once
 * __DIR__ . '/inc/a.php'` or `dirname(__FILE__) . '/inc/b.php'` (the only
 * spelling before PHP 5.3), names one file as surely as a plain literal does,
 * so it gets the same file-to-file `imports` edge (#3298). `dirname(__DIR__)`
 * and `dirname(__FILE__, 2)` climb one directory. Anything else built at run
 * time (`$_SERVER['DOCUMENT_ROOT'] . '/x.php'`, `$base . '/x.php'`) stays
 * unlinked, as does a path that is no file of the project.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph | undefined;

afterEach(() => {
  cg?.close();
  cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-php-dir-include-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
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

describe('PHP includes built from the including file\'s directory', () => {
  it('links __DIR__ and dirname(__FILE__) paths like a plain literal (the #3298 repro)', async () => {
    const graph = await index({
      'app/index.php': [
        '<?php',
        "require_once 'lib.php';",
        "require_once __DIR__ . '/inc/a.php';",
        'require_once dirname(__FILE__) . "/inc/b.php";',
        "include(__DIR__ . '/inc/c.php');",
        "include_once __DIR__.'/inc/d.php';",
        '',
      ].join('\n'),
      'app/lib.php': fn('lib_fn'),
      'app/inc/a.php': fn('a_fn'),
      'app/inc/b.php': fn('b_fn'),
      'app/inc/c.php': fn('c_fn'),
      'app/inc/d.php': fn('d_fn'),
    });
    expect(importsOf(graph, 'app/index.php')).toEqual(['app/inc/a.php', 'app/inc/b.php', 'app/inc/c.php', 'app/inc/d.php', 'app/lib.php']);
  });

  it('climbs a directory for dirname(__DIR__), dirname(__FILE__, 2) and a .. in the literal', async () => {
    const graph = await index({
      'app/web/index.php': [
        '<?php',
        "require dirname(__DIR__) . '/config/a.php';",
        "require dirname(__FILE__, 2) . '/config/b.php';",
        "require __DIR__ . '/../config/c.php';",
        "require dirname(__DIR__, 2) . '/shared/d.php';",
        '',
      ].join('\n'),
      'app/config/a.php': fn('a_fn'),
      'app/config/b.php': fn('b_fn'),
      'app/config/c.php': fn('c_fn'),
      'shared/d.php': fn('d_fn'),
    });
    expect(importsOf(graph, 'app/web/index.php')).toEqual(['app/config/a.php', 'app/config/b.php', 'app/config/c.php', 'shared/d.php']);
  });

  it('links nothing for a path built at run time, a missing file, or one leaving the project', async () => {
    const graph = await index({
      'index.php': [
        '<?php',
        "require_once $_SERVER['DOCUMENT_ROOT'] . '/inc/a.php';",
        "require_once $base . '/inc/a.php';",
        'require_once __DIR__ . "/inc/{$name}.php";',
        "require_once __DIR__ . 'inc/a.php';",
        "require_once __DIR__ . '/inc/missing.php';",
        "require_once dirname(__DIR__) . '/outside.php';",
        "require_once dirname(__FILE__, $n) . '/inc/a.php';",
        '',
      ].join('\n'),
      'inc/a.php': fn('a_fn'),
      'inc/b/a.php': fn('nested_fn'),
    });
    expect(importsOf(graph, 'index.php')).toEqual([]);
  });

  it('folds DIRECTORY_SEPARATOR and further literals, and the fully qualified \\dirname', async () => {
    const graph = await index({
      'app/web/index.php': [
        '<?php',
        "require __DIR__ . DIRECTORY_SEPARATOR . 'c.php';",
        "require __DIR__ . '/inc/' . 'e.php';",
        "require \\dirname(__DIR__) . '/b.php';",
        '',
      ].join('\n'),
      'app/web/c.php': fn('c_fn'),
      'app/web/inc/e.php': fn('e_fn'),
      'app/b.php': fn('b_fn'),
    });
    expect(importsOf(graph, 'app/web/index.php')).toEqual(['app/b.php', 'app/web/c.php', 'app/web/inc/e.php']);
  });

  it('links exactly the path written, never one with .php guessed onto it', async () => {
    const graph = await index({
      'app/index.php': [
        '<?php',
        "require __DIR__ . '/config';",
        "require __DIR__ . '/settings.local';",
        "require __DIR__ . '/inc/k.inc';",
        '',
      ].join('\n'),
      'app/config.php': fn('config_fn'),
      'lib/config.php': '<?php\nclass config {}\n',
      'app/settings.local.php': fn('settings_fn'),
      'app/inc/k.inc.php': fn('k_fn'),
    });
    expect(importsOf(graph, 'app/index.php')).toEqual([]);
  });

  it('reads a levels argument as PHP does: decimal, at least 1, a trailing comma allowed', async () => {
    const graph = await index({
      'app/web/index.php': [
        '<?php',
        "require dirname(__FILE__, 01) . '/zero.php';",
        "require dirname(__DIR__, 0) . '/zero.php';",
        "require dirname(__FILE__, 2,) . '/two.php';",
        '',
      ].join('\n'),
      'app/web/zero.php': fn('zero_fn'),
      'app/zero.php': fn('zero_up_fn'),
      'app/two.php': fn('two_fn'),
    });
    expect(importsOf(graph, 'app/web/index.php')).toEqual(['app/two.php']);
  });

  it('leaves an unqualified dirname alone where the file declares or imports one of its own', async () => {
    const graph = await index({
      'app/declared.php': "<?php\nnamespace App;\nfunction dirname($p) { return '/srv/shared'; }\nrequire dirname(__FILE__) . '/d.php';\nrequire \\dirname(__FILE__) . '/e.php';\n",
      'app/imported.php': "<?php\nnamespace App;\nuse function Foo\\{dirname};\nrequire dirname(__FILE__) . '/d.php';\n",
      'app/listed.php': "<?php\nnamespace App;\nuse function Foo\\bar, Foo\\dirname;\nrequire dirname(__FILE__) . '/d.php';\n",
      'app/d.php': fn('d_fn'),
      'app/e.php': fn('e_fn'),
    });
    expect(importsOf(graph, 'app/declared.php')).toEqual(['app/e.php']);
    expect(importsOf(graph, 'app/imported.php')).toEqual([]);
    expect(importsOf(graph, 'app/listed.php')).toEqual([]);
  });

  it('still takes the built-in dirname past a method, a comment, an alias or a global import of that name', async () => {
    const graph = await index({
      'app/method.php': "<?php\nrequire dirname(__FILE__) . '/d.php';\nclass Fs { public function dirname($p) {} }\n",
      'app/comment.php': "<?php\n// function dirname() polyfill lived here\nrequire dirname(__FILE__) . '/d.php';\n",
      'app/alias.php': "<?php\nnamespace App;\nuse function Foo\\dirname as dn;\nrequire dirname(__FILE__) . '/d.php';\n",
      'app/global.php': "<?php\nnamespace App;\nuse function dirname;\nrequire dirname(__DIR__) . '/up.php';\n",
      'app/d.php': fn('d_fn'),
      'up.php': fn('up_fn'),
    });
    for (const f of ['method', 'comment', 'alias']) expect(importsOf(graph, `app/${f}.php`), f).toEqual(['app/d.php']);
    expect(importsOf(graph, 'app/global.php')).toEqual(['up.php']);
  });

  it('does not take a same-named file elsewhere for one the path does not reach', async () => {
    const graph = await index({
      'app/index.php': "<?php\nrequire_once __DIR__ . '/inc/a.php';\n",
      'other/inc/a.php': fn('a_fn'),
    });
    expect(importsOf(graph, 'app/index.php')).toEqual([]);
  });
});
