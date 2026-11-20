/**
 * A Kotlin extension on a type from outside the project, declared on an
 * import alias of it — `import androidx.compose.ui.Modifier as DeclAlias` then
 * `fun DeclAlias.pad()` — is the extension a call on that type reaches, under
 * whatever name the calling file imports the type: the type's own, another
 * alias, or the same alias (#3084). The extension is indexed under the
 * receiver as written (`DeclAlias::pad`), and the call was looked up under the
 * type's own name only, so it linked nothing. An extension declared on an
 * alias of another type, or one the calling file can't see, still isn't it.
 */
import { describe, it, expect, afterEach } from 'vitest';
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
  root = '';
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kotlin-ext-alias-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
  return cg;
}

/** The files of what `calls` edges from the function `fn` reach. */
function calleeFiles(graph: CodeGraph, fn: string): string[] {
  const db = (graph as unknown as { db: { getDb(): { prepare(sql: string): { all(...a: unknown[]): Array<{ f: string }> } } } }).db;
  return db.getDb().prepare(`
    SELECT t.file_path f FROM edges e
    JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.kind = 'calls' AND s.kind = 'function' AND s.name = ?`).all(fn).map((r) => r.f.replace(/\\/g, '/')).sort();
}

const typeImport = (alias: string) => `import androidx.compose.ui.Modifier${alias === 'Modifier' ? '' : ` as ${alias}`}`;

describe('a Kotlin extension declared on an import alias of an outside type (#3084)', () => {
  it.each([
    ['DeclAlias', 'CallAlias'],
    ['SameAlias', 'SameAlias'],
    ['DeclAlias', 'Modifier'],
    ['Modifier', 'CallAlias'],
  ])('a receiver declared as %s links a call written on %s', async (declared, called) => {
    const graph = await index({
      'extensions/Extensions.kt': `package extensions\n${typeImport(declared)}\nfun ${declared}.pad() {}\n`,
      // An extension of the same name on another type behind the same alias.
      'decoy/Extensions.kt': `package decoy\nimport javax.lang.model.element.Modifier as ${declared}\nfun ${declared}.pad() {}\n`,
      'caller/Calls.kt': `package caller\n${typeImport(called)}\nimport extensions.pad\nfun caller() { ${called}.pad() }\n`,
      // A file that doesn't import the extension can't call it.
      'unimported/Calls.kt': `package unimported\n${typeImport(called)}\nfun hidden() { ${called}.pad() }\n`,
    });
    expect(calleeFiles(graph, 'caller')).toEqual(['extensions/Extensions.kt']);
    expect(calleeFiles(graph, 'hidden')).toEqual([]);
  });
});
