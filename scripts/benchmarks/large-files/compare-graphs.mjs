#!/usr/bin/env node
// The "same graph" check for a change meant to make indexing faster and nothing else: index
// each project with two builds of the engine and compare what scripts/dump-graph.mjs prints
// for each, every node, edge, unresolved reference and file. See
// docs/design/large-file-performance.md.
//
//   node scripts/benchmarks/large-files/compare-graphs.mjs <dist before> <dist after> <project> [project…]
//   node scripts/benchmarks/large-files/compare-graphs.mjs <dist before> <dist after> --each <folder of projects>
//
// A project is copied (without .codegraph, node_modules, .git) and indexed in a process of
// its own for each build, so neither build sees the other. Set CODEGRAPH_KERNEL=0 to compare
// the wasm extractor; run it both ways. Exits 1 when a graph differs, and prints the first
// lines only one build has.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('usage: compare-graphs.mjs <dist before> <dist after> <project> [project…] | --each <folder of projects>');
  process.exit(2);
}
const [before, after] = args.slice(0, 2).map((d) => resolve(d));
const projects = [];
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--each') {
    const folder = resolve(args[++i]);
    for (const name of readdirSync(folder).sort()) {
      if (statSync(join(folder, name)).isDirectory()) projects.push(join(folder, name));
    }
  } else {
    projects.push(resolve(args[i]));
  }
}

const dumpScript = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dump-graph.mjs');
const env = { ...process.env, CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_DAEMON: '1' };
const INDEX = `
const { CodeGraph } = require(require('node:path').join(process.argv[1], 'index.js'));
(async () => { const cg = await CodeGraph.init(process.argv[2], { index: true }); cg.close(); })()
  .catch((error) => { console.error(error); process.exit(1); });
`;
const SKIPPED = /[\\/](?:\.codegraph|node_modules|\.git)(?:[\\/]|$)/;

/** Index a copy of `project` with the build at `dist`; the dump of its graph and the seconds it took. */
function graphOf(dist, project) {
  const dir = mkdtempSync(join(tmpdir(), 'cg-compare-'));
  try {
    cpSync(project, dir, { recursive: true, filter: (source) => !SKIPPED.test(source.slice(project.length)) });
    const started = Date.now();
    const indexed = spawnSync(process.execPath, ['-e', INDEX, dist, dir], { env, encoding: 'utf8' });
    const seconds = (Date.now() - started) / 1000;
    if (indexed.status !== 0) throw new Error(`indexing with ${dist} failed:\n${indexed.stderr}`);
    // To a file: the dump of a large project is longer than a string can be.
    const out = join(dir, '.codegraph', 'graph.dump');
    const dumped = spawnSync(process.execPath, [dumpScript, dir], { env, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 2 ** 31 - 1 });
    if (dumped.status !== 0 || !dumped.stdout) throw new Error(`dump-graph.mjs failed for ${project}`);
    writeFileSync(out, dumped.stdout);
    return { dump: readFileSync(out), seconds };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The lines of one dump that the other does not have. */
function onlyIn(a, b) {
  const other = new Set(b.toString('utf8').split('\n'));
  return a.toString('utf8').split('\n').filter((line) => !other.has(line));
}

let differing = 0;
for (const project of projects) {
  const a = graphOf(before, project);
  const b = graphOf(after, project);
  const lines = a.dump.toString('utf8').split('\n').length;
  const times = `${a.seconds.toFixed(1)} s before, ${b.seconds.toFixed(1)} s after`;
  if (a.dump.equals(b.dump)) {
    console.log(`same    ${basename(project)}: ${lines} lines, ${times}`);
    continue;
  }
  differing++;
  const gone = onlyIn(a.dump, b.dump);
  const added = onlyIn(b.dump, a.dump);
  console.log(`DIFFER  ${basename(project)}: ${gone.length} lines only before, ${added.length} only after, ${times}`);
  for (const line of gone.slice(0, 4)) console.log(`   - ${line.slice(0, 300)}`);
  for (const line of added.slice(0, 4)) console.log(`   + ${line.slice(0, 300)}`);
}
console.log(`\n${projects.length - differing} the same, ${differing} differ`);
process.exit(differing ? 1 : 0);
