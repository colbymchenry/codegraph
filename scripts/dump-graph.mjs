#!/usr/bin/env node
/**
 * Dump a .codegraph/codegraph.db graph by NATURAL KEYS (no rowids, no
 * timestamps), sorted — two dumps diff clean iff the graphs are semantically
 * identical. The byte-identical gate used by every perf/kernel PR:
 *
 *   node scripts/dump-graph.mjs <repo-or-db> > a.dump
 *   node scripts/dump-graph.mjs <repo-or-db> > b.dump
 *   diff a.dump b.dump
 *
 * Volatile fields excluded: nodes.updated_at, files.modified_at/indexed_at/
 * content_hash+size (environment-dependent), edges.id / unresolved_refs.id
 * (insertion rowids), and unresolved_refs.status (resolution bookkeeping —
 * kept, actually: status is deterministic given the same input; excluded only
 * if it proves flaky. We keep status.)
 */

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: dump-graph.mjs <repo-root-or-db-path>');
  process.exit(2);
}
let dbPath = arg;
if (fs.statSync(arg).isDirectory()) {
  dbPath = path.join(arg, '.codegraph', 'codegraph.db');
}
const db = new DatabaseSync(dbPath, { readOnly: true });

function dump(title, sql) {
  const rows = db.prepare(sql).all();
  const lines = rows.map((r) => JSON.stringify(r)).sort();
  process.stdout.write(`== ${title} (${lines.length})\n`);
  for (const l of lines) process.stdout.write(l + '\n');
}

dump(
  'nodes',
  `SELECT id, kind, name, qualified_name, file_path, language, start_line, end_line,
          start_column, end_column, docstring, signature, visibility, is_exported,
          is_async, is_static, is_abstract, decorators, type_parameters, return_type
   FROM nodes`
);
dump(
  'edges',
  `SELECT source, target, kind, metadata, line, col, provenance FROM edges`
);
dump(
  'refs',
  `SELECT from_node_id, reference_name, reference_kind, line, col, candidates,
          file_path, language, status, name_tail
   FROM unresolved_refs`
);
dump('files', `SELECT path, language, node_count FROM files`);
