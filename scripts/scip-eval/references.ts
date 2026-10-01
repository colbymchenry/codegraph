/**
 * How precise are codegraph's `references` edges? Judges every edge of each
 * graph against an independent SCIP index (the judge), at the edge's own site.
 *
 *   npx tsx scripts/scip-eval/references.ts <repo> <judge.scip>... --graph <name>=<db>... [--json] [--examples 3]
 *
 * Per edge, the judge's references on the caller's file and line by the target's
 * name decide:
 *   right     one of them is a symbol defined in the target node
 *   wrong     they resolve elsewhere: another node, a symbol with no node (a
 *             parameter, a local), or outside the project
 *   unjudged  the judge has no document for the file, or no reference by that name there
 * precision = right / (right + wrong). A judge built by this fork's adapter keeps
 * references only at the sites of the graph it was built against (compact.ts), so
 * pass graphs of that same snapshot — corpora.sh does.
 */

import { DatabaseSync } from 'node:sqlite';
import { ROLE_DEFINITION, loadScipIndex, parseSymbol } from '../../src/scip/reader';

const args = process.argv.slice(2);
const json = args.includes('--json');
const exAt = args.indexOf('--examples');
const examplesPer = exAt >= 0 ? Number(args[exAt + 1]) : 3;
const graphs: Array<[string, string]> = [];
const judges: string[] = [];
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--graph') graphs.push(args[++i]!.split('=', 2) as [string, string]);
  else if (args[i] === '--examples') i++;
  else if (args[i] !== '--json') judges.push(args[i]!);
}
if (!args[0] || judges.length === 0 || graphs.length === 0) {
  process.stderr.write('usage: references.ts <repo> <judge.scip>... --graph <name>=<db>... [--json] [--examples N]\n');
  process.exit(2);
}

/** Judge definitions and references, independent of any graph. */
const definedAt = new Map<string, { file: string; line: number }>(); // symbol → first definition (1-based line)
const refs = new Map<string, Array<{ name: string; symbol: string }>>(); // file\0line → references
const documents = new Set<string>();
for (const j of judges) {
  for (const d of loadScipIndex(j).documents) {
    if (documents.has(d.relativePath)) continue; // overlapping projects: the first document wins, as in the merge
    documents.add(d.relativePath);
    for (const o of d.occurrences) {
      const p = parseSymbol(o.symbol);
      if (!p) continue;
      const line = o.range.startLine + 1;
      if (o.roles & ROLE_DEFINITION) {
        if (!definedAt.has(o.symbol)) definedAt.set(o.symbol, { file: d.relativePath, line });
        continue;
      }
      const k = `${d.relativePath}\0${line}`;
      let list = refs.get(k);
      if (!list) refs.set(k, (list = []));
      list.push({ name: p.last.name, symbol: o.symbol });
    }
  }
}

const rows = graphs.map(([name, file]) => {
  const db = new DatabaseSync(file, { readOnly: true });
  // The node a judge symbol is defined in: same file and name, narrowest span around its definition.
  const narrowest = db.prepare(`SELECT id FROM nodes WHERE file_path = ? AND name = ?
    AND start_line <= ? AND end_line >= ? ORDER BY end_line - start_line LIMIT 1`);
  const nodeOf = new Map<string, string | null>();
  const node = (symbol: string, name: string) => {
    let id = nodeOf.get(symbol);
    if (id === undefined) {
      const at = definedAt.get(symbol);
      const row = at && (narrowest.get(at.file, name, at.line, at.line) as { id: string } | undefined);
      nodeOf.set(symbol, (id = row ? row.id : null));
    }
    return id;
  };
  const counts = { right: 0, wrong: 0, unjudged: 0, noLine: 0 };
  const examples: string[] = [];
  const edges = db.prepare(`SELECT e.line, s.file_path AS file, s.qualified_name AS source, t.id AS target, t.name, t.file_path AS tfile
    FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target WHERE e.kind = 'references'`).iterate() as Iterable<{
      line: number | null; file: string; source: string; target: string; name: string; tfile: string;
    }>;
  for (const e of edges) {
    if (e.line === null) { counts.noLine++; continue; }
    const here = documents.has(e.file) ? (refs.get(`${e.file}\0${e.line}`) ?? []).filter(r => r.name === e.name) : [];
    if (here.length === 0) { counts.unjudged++; continue; }
    if (here.some(r => node(r.symbol, r.name) === e.target)) { counts.right++; continue; }
    counts.wrong++;
    if (examples.length < examplesPer) examples.push(`${e.file}:${e.line} ${e.source} → ${e.name} (${e.tfile}); judge: ${here[0]!.symbol}`);
  }
  const judged = counts.right + counts.wrong;
  return { graph: name, ...counts, precision: judged ? counts.right / judged : null, examples };
});

if (json) console.log(JSON.stringify({ repo: args[0], judges, rows }, null, 2));
else {
  for (const r of rows) {
    const p = r.precision === null ? '-' : `${(100 * r.precision).toFixed(1)}%`;
    console.log(`${r.graph.padEnd(16)} precision ${p.padStart(6)}  right ${r.right}, wrong ${r.wrong}, unjudged ${r.unjudged}, no line ${r.noLine}`);
    for (const x of r.examples) console.log(`    ${x}`);
  }
}
