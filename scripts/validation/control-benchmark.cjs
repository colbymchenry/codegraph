// node scripts/validation/control-benchmark.cjs <engine checkout> <fresh control checkout> <result.json>
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
process.env.CODEGRAPH_TELEMETRY = '0';
process.env.CODEGRAPH_PARSE_WORKERS = '2';
process.env.CODEGRAPH_RESOLVE_WORKERS = '0';
const [engine, corpus, output] = process.argv.slice(2).map(p => path.resolve(p));
const { CodeGraph } = require(path.join(engine, 'dist'));
(async () => {
  const started = performance.now();
  const graph = await CodeGraph.init(corpus);
  let result;
  try { result = await graph.indexAll(); } finally { graph.close(); }
  if (!result.success || result.filesErrored) throw Error(JSON.stringify(result.errors));
  const ms = Math.round(performance.now() - started);
  const db = new DatabaseSync(path.join(corpus, '.codegraph/codegraph.db'), { readOnly: true });
  let nodes, edges;
  try {
    nodes = db.prepare('SELECT * FROM nodes ORDER BY id').all().map(({ updated_at, ...n }) => n);
    edges = db.prepare('SELECT source,target,kind,metadata,line,col,provenance FROM edges ORDER BY source,target,kind,line,col,metadata').all();
  } finally { db.close(); }
  const record = { engine, revision: cp.execFileSync('git', ['-C', engine, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    corpus, corpusRevision: cp.execFileSync('git', ['-C', corpus, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    ms, files: result.filesIndexed, nodes: nodes.length, edges: edges.length,
    hash: crypto.createHash('sha256').update(JSON.stringify({ nodes, edges })).digest('hex') };
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
})().catch(error => { console.error(error); process.exitCode = 1; });
