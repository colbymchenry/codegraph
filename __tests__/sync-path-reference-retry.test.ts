/**
 * A sync links a reference written as a path once the file it names appears.
 *
 * Sync retries parked failed refs by name tail (#1240): the tail is matched
 * against the names of the nodes a sync adds, and a file's node is named for
 * the file. A reference written as a path — Liquid's `{% render 'price' %}` is
 * `snippets/price.liquid`, a JSON template's section `"type": "404"` is
 * `sections/404.liquid` — was parked under its extension, `liquid`, which no
 * node is named, so it linked only once the file naming it changed or on a
 * full index. #2392 fixed the same gap for imports.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion, runMigrations } from '../src/db/migrations';
import { QueryBuilder } from '../src/db/queries';
import { referenceNameTail } from '../src/db/reference-tail';

let root: string | undefined;
let cg: CodeGraph | undefined;
let db: DatabaseConnection | undefined;

afterEach(() => {
  cg?.close();
  cg = undefined;
  db?.close();
  db = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function write(files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root!, file)), { recursive: true });
    fs.writeFileSync(path.join(root!, file), text);
  }
}

describe('referenceNameTail', () => {
  it('parks a reference written as a path under the name of the file it names', () => {
    expect(referenceNameTail('snippets/price.liquid', 'references')).toBe('price.liquid');
    expect(referenceNameTail('sections/404.liquid', 'references')).toBe('404.liquid');
    expect(referenceNameTail('snippets/icon.logo.liquid', 'references')).toBe('icon.logo.liquid');
  });

  it('keeps the symbol tail of a reference that names no file', () => {
    // No path, a path with no file name at its end, or an Erlang arity. (A
    // route's module, `lazy-import:./routes/about.tsx` or
    // `import:./home.component#HomeComponent`, is sync-route-module-retry's.)
    expect(referenceNameTail('Foo.Bar', 'references')).toBe('Bar');
    expect(referenceNameTail('snippets/price', 'references')).toBe('snippets/price');
    expect(referenceNameTail('lists::map/2', 'references')).toBe('map');
    // A call's slashes sit in its arguments, a comment or a division.
    expect(referenceNameTail('assert.logfile("logs/error.log").has.line', 'calls')).toBe('line');
    expect(referenceNameTail('(rss_kb / 1024.0).to_i', 'calls')).toBe('to_i');
    // An import keeps the stem of its path (#2392).
    expect(referenceNameTail('package:app/b.dart', 'imports')).toBe('b');
  });
});

describe('sync links a path reference whose file appears later', () => {
  it('in an index whose references an older version parked', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-path-ref-'));
    write({
      'layout/theme.liquid': "{% render 'price' %}{{ content_for_layout }}\n",
      'templates/404.json': JSON.stringify({ sections: { main: { type: '404' } }, order: ['main'] }),
    });
    cg = await CodeGraph.init(root, { index: true });
    cg.close();
    cg = undefined;

    // What a version before 13 left: the extension as the tail.
    db = DatabaseConnection.open(getDatabasePath(root));
    db.getDb().exec(`UPDATE unresolved_refs SET name_tail = 'liquid' WHERE reference_kind = 'references';
      DELETE FROM schema_versions WHERE version >= 13;
      INSERT OR IGNORE INTO schema_versions(version, applied_at, description) VALUES (12, 0, 'legacy fixture');`);
    db.close();
    db = undefined;

    cg = await CodeGraph.open(root);
    write({ 'sections/404.liquid': '<h1>404</h1>\n', 'snippets/price.liquid': '{{ product.price }}\n' });
    expect((await cg.sync()).filesAdded).toBe(2);
    expect(cg.getFileDependencies('templates/404.json')).toEqual(['sections/404.liquid']);
    expect(cg.getFileDependencies('layout/theme.liquid')).toEqual(['snippets/price.liquid']);
    expect(cg.getPendingReferenceCount()).toBe(0);
  }, 60_000);
});

describe('schema v13', () => {
  function fixture(): QueryBuilder {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-path-ref-'));
    db = DatabaseConnection.initialize(path.join(root, 'test.db'));
    const queries = new QueryBuilder(db.getDb());
    queries.insertNode({ id: 'a', kind: 'file', name: 'theme.liquid', qualifiedName: 'layout/theme.liquid', filePath: 'layout/theme.liquid',
      language: 'liquid', startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0 });
    for (const [referenceName, referenceKind, status, tail] of [
      ['snippets/price.liquid', 'references', 'failed', 'liquid'],
      ['sections/icon.logo.liquid', 'references', 'failed', 'liquid'],
      ['snippets/card.liquid', 'references', 'pending', ''],
      ['package:app/b.dart', 'imports', 'failed', 'b'],
      ['assert.logfile("logs/error.log").has.line', 'calls', 'failed', 'line'],
      ['lists::map/2', 'calls', 'failed', 'map'],
    ] as const) {
      queries.insertUnresolvedRef({ fromNodeId: 'a', referenceName, referenceKind, line: 1, column: 0, filePath: 'layout/theme.liquid', language: 'liquid' });
      db.getDb().prepare('UPDATE unresolved_refs SET status = ?, name_tail = ? WHERE reference_name = ?').run(status, tail, referenceName);
    }
    return queries;
  }

  const tails = () => db!.getDb().prepare('SELECT reference_name AS name, name_tail AS tail FROM unresolved_refs ORDER BY id').all();

  it('rewrites the tail of a path reference parked by an older version, and replays cleanly', () => {
    fixture();
    db!.getDb().exec(`DELETE FROM schema_versions WHERE version >= 13;
      INSERT OR IGNORE INTO schema_versions(version, applied_at, description) VALUES (12, 0, 'legacy fixture');`);
    db!.close();
    db = DatabaseConnection.open(path.join(root!, 'test.db'));
    expect(getCurrentVersion(db.getDb())).toBe(CURRENT_SCHEMA_VERSION);
    const migrated = tails();
    expect(migrated).toEqual([
      { name: 'snippets/price.liquid', tail: 'price.liquid' },
      { name: 'sections/icon.logo.liquid', tail: 'icon.logo.liquid' },
      // Only a failed row is looked up by its tail.
      { name: 'snippets/card.liquid', tail: '' },
      { name: 'package:app/b.dart', tail: 'b' },
      { name: 'assert.logfile("logs/error.log").has.line', tail: 'line' },
      { name: 'lists::map/2', tail: 'map' },
    ]);
    const queries = new QueryBuilder(db.getDb());
    expect(queries.getRetryableFailedReferences(['price.liquid', 'liquid']).map((ref) => ref.referenceName)).toEqual(['snippets/price.liquid']);

    db.getDb().exec('DELETE FROM schema_versions WHERE version >= 13');
    runMigrations(db.getDb(), 12);
    expect(tails()).toEqual(migrated);
  });
});
