import type { SqliteDatabase } from './sqlite-adapter';

// Fork-only schema additions must not allocate another upstream migration
// number. These feature guards also handle databases created by upstream at
// the current version, where there is no pending numbered migration to run.
const cursorIndexes = {
  idx_edges_source_id: 'CREATE INDEX IF NOT EXISTS idx_edges_source_id ON edges(source, id)',
  idx_edges_target_id: 'CREATE INDEX IF NOT EXISTS idx_edges_target_id ON edges(target, id)',
  idx_nodes_file_id: 'CREATE INDEX IF NOT EXISTS idx_nodes_file_id ON nodes(file_path, id)',
} as const;

/**
 * Reconcile the two historical version collisions without rewriting history.
 *
 * Pinable v10 meant cursor indexes, not upstream synthesis inputs; Pinable
 * v12 meant the v10 repair, not upstream failed-import retry. Reuse the actual
 * upstream migration bodies for those missed changes instead of copying SQL
 * or renumbering already-applied migrations. Healthy opens do no writes.
 */
export function repairPinableSchema(
  db: SqliteDatabase,
  fromVersion: number,
  replayUpstream: (version: number) => void,
): void {
  const names = new Set((db.prepare(`
    SELECT name FROM sqlite_master
    WHERE (type = 'table' AND name = 'synthesis_inputs')
       OR (type = 'index' AND name IN (
         'idx_unresolved_failed_import_tail', 'idx_unresolved_failed_import_name',
         'idx_edges_source_id', 'idx_edges_target_id', 'idx_nodes_file_id'
       ))
  `).all() as Array<{ name: string }>).map((row) => row.name));
  // Earlier versions run these changes through the normal migration chain.
  const missedSynthesis = fromVersion >= 10 && !names.has('synthesis_inputs');
  const missedImports = fromVersion >= 12 && (
    !names.has('idx_unresolved_failed_import_tail') ||
    !names.has('idx_unresolved_failed_import_name')
  );
  const missingCursors = Object.entries(cursorIndexes).filter(([name]) => !names.has(name));
  if (!missedSynthesis && !missedImports && missingCursors.length === 0) return;

  // DDL and the legacy data rewrite must roll back together on any failure.
  // The presence checks make retries and repeated opens idempotent; do not
  // change schema_versions or re-mark a healthy graph as synthesis_pending.
  db.transaction(() => {
    if (missedSynthesis) replayUpstream(10);
    if (missedImports) replayUpstream(12);
    for (const [, ddl] of missingCursors) db.exec(ddl);
  })();
}
