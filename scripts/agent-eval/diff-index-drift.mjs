#!/usr/bin/env node
/**
 * Diff two CodeGraph indexes of the SAME tree — typically a live,
 * incrementally-synced `.codegraph/codegraph.db` against a clean full rebuild
 * of the identical working tree (CG-33).
 *
 * Non-destructive: it only reads. Rebuilding is the caller's job, so the live
 * index is never clobbered by the tool measuring it — the mistake that cost the
 * original CG-33 artifact.
 *
 *   # snapshot the live index BEFORE touching it
 *   cp .codegraph/codegraph.db /tmp/live.db
 *   node dist/bin/codegraph.js index .
 *   node scripts/agent-eval/diff-index-drift.mjs /tmp/live.db .codegraph/codegraph.db
 *
 * Edges are compared as distinct `(source, target, kind)` triples. Raw row
 * counts are NOT a drift signal: a bidirectional divergence nets out. On the
 * codegraph repo the raw counts differed by +0.7% while 4.3% of distinct edges
 * were actually wrong.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const [livePath, rebuiltPath] = process.argv.slice(2);
if (!livePath || !rebuiltPath) {
  console.error('usage: diff-index-drift.mjs <live.db> <rebuilt.db>');
  process.exit(2);
}
for (const p of [livePath, rebuiltPath]) {
  if (!existsSync(p)) {
    // node:sqlite CREATES a missing file rather than failing, which silently
    // yields an empty schema and a confident, wrong conclusion. Refuse first.
    console.error(`not found: ${p}`);
    process.exit(2);
  }
}

const open = (p) => new DatabaseSync(p, { readOnly: true });
const live = open(livePath);
const rebuilt = open(rebuiltPath);

const scalar = (db, q) => db.prepare(q).get().n;
const edgeKey = (r) => `${r.source}\u0000${r.target}\u0000${r.kind}`;

const liveEdges = live.prepare('select source, target, kind from edges').all();
const rebuiltEdges = rebuilt.prepare('select source, target, kind from edges').all();
const liveSet = new Set(liveEdges.map(edgeKey));
const rebuiltSet = new Set(rebuiltEdges.map(edgeKey));

const missing = rebuiltEdges.filter((r) => !liveSet.has(edgeKey(r)));   // should exist, doesn't
const stale = liveEdges.filter((r) => !rebuiltSet.has(edgeKey(r)));      // exists, shouldn't
const divergent = missing.length + stale.length;

const byKind = (rows) => {
  const m = new Map();
  for (const r of rows) m.set(r.kind, (m.get(r.kind) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)';
};

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0');

console.log(`live    ${livePath}`);
console.log(`rebuilt ${rebuiltPath}`);
console.log('');
console.log('counts                 live      rebuilt');
for (const [label, q] of [
  ['files', 'select count(*) n from files'],
  ['nodes', 'select count(*) n from nodes'],
  ['edges (rows)', 'select count(*) n from edges'],
  // Grouped rather than `count(distinct a || b || c)`: bare concatenation has no
  // separator, so `(ab, c)` and `(a, bc)` would collapse into one.
  ['edges (distinct)', 'select count(*) n from (select distinct source, target, kind from edges)'],
  ['heuristic edges', "select count(*) n from edges where provenance='heuristic'"],
]) {
  console.log(`  ${label.padEnd(20)} ${String(scalar(live, q)).padEnd(9)} ${scalar(rebuilt, q)}`);
}

console.log('');
console.log('edge divergence (distinct triples)');
console.log(`  missing from live: ${missing.length}  — ${byKind(missing)}`);
console.log(`  stale in live:     ${stale.length}  — ${byKind(stale)}`);
console.log(`  TOTAL divergent:   ${divergent}  (${pct(divergent, rebuiltSet.size)}% of ${rebuiltSet.size})`);

// Integrity checks — these separate "resolution went stale" (edges wrong, nodes
// identical) from "residue accumulated" (duplicate/orphan rows). CG-33 is the
// former: on the codegraph repo every check below was 0 on BOTH indexes.
console.log('');
console.log('integrity                        live   rebuilt');
for (const [label, q] of [
  ['duplicate nodes', 'select count(*) n from (select file_path,name,kind,start_line from nodes group by 1,2,3,4 having count(*)>1)'],
  ['orphan edges', 'select count(*) n from edges e where not exists(select 1 from nodes where id=e.source) or not exists(select 1 from nodes where id=e.target)'],
  ['nodes w/ missing file row', 'select count(*) n from nodes nd where not exists(select 1 from files f where f.path=nd.file_path)'],
]) {
  console.log(`  ${label.padEnd(30)} ${String(scalar(live, q)).padEnd(6)} ${scalar(rebuilt, q)}`);
}

console.log('');
console.log(divergent === 0
  ? 'CONVERGED — the synced index matches a full rebuild.'
  : `DRIFTED — ${divergent} edges differ. Rebuild-vs-rebuild is 0 (the indexer is deterministic), so this is sync divergence, not noise.`);

process.exitCode = divergent === 0 ? 0 : 1;
