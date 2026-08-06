#!/usr/bin/env node
/**
 * Deterministic per-file budget-share probe for `codegraph_explore` (CG-6).
 *
 * `probe-explore.mjs` prints what explore returned. This prints how the response
 * was DIVIDED — which files won the byte envelope and in what proportion — and
 * checks that division against a declared expectation. It is the regression gate
 * for GitHub issue #1500 / epic CG-1: an architecture question that doesn't name
 * the exact use-case must concentrate the budget on the code that answers it, not
 * on a generated CRUD layer (or an eval script) that merely name-collides.
 *
 * The numbers come from the CG-4 diagnostic (`CODEGRAPH_EXPLORE_DEBUG`), read back
 * from a JSONL sidecar, so the probe measures the shipping allocator rather than
 * re-deriving shares from the markdown.
 *
 * Fixtures are declared in `allocation-fixtures.json`. A `kind: "fixture"` entry is
 * hermetic — the fixture tree is copied to a fresh temp dir and indexed per run, so
 * two runs on one build give identical numbers. A `kind: "self"` entry reads this
 * repo's live index and therefore moves as the repo changes; its assertions are
 * relative for that reason.
 *
 * Usage (needs a current `npm run build`):
 *   node scripts/agent-eval/probe-allocation.mjs                 # every fixture
 *   node scripts/agent-eval/probe-allocation.mjs payroll-go      # one fixture
 *   node scripts/agent-eval/probe-allocation.mjs --json          # machine-readable
 *   node scripts/agent-eval/probe-allocation.mjs --keep          # keep the temp index
 *
 * Exit code: 0 if every assertion holds, 1 if any fails, 2 on a setup error.
 * BOTH FIXTURES ARE EXPECTED TO FAIL until CG-10/CG-12 land — that failure is the
 * documented bug. Use --expect-fail to invert the exit code while it is the state
 * of the world (0 = still broken, 1 = fixed, go flip the gate).
 */
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const SPEC_PATH = join(HERE, 'allocation-fixtures.json');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const wanted = argv.filter((a) => !a.startsWith('--'));
const asJson = flags.has('--json');
const keepTemp = flags.has('--keep');
const expectFail = flags.has('--expect-fail');

const say = (line = '') => { if (!asJson) console.log(line); };
const pct = (f) => `${(f * 100).toFixed(1)}%`;
const num = (n) => Math.round(n).toLocaleString('en-US');

/** Load the built dist — the probe measures the shipping allocator, not src. */
async function loadDist() {
  const distIndex = join(REPO_ROOT, 'dist/index.js');
  if (!existsSync(distIndex)) {
    console.error('dist/ not built — run `npm run build` first.');
    process.exit(2);
  }
  const idx = await import(pathToFileURL(distIndex).href);
  const tools = await import(pathToFileURL(join(REPO_ROOT, 'dist/mcp/tools.js')).href);
  // esModuleInterop: dynamic import of CJS yields { default: module.exports, ...named }
  const CodeGraph = idx.default?.default ?? idx.default ?? idx.CodeGraph;
  const ToolHandler = tools.ToolHandler ?? tools.default?.ToolHandler;
  if (typeof CodeGraph?.openSync !== 'function' || typeof ToolHandler !== 'function') {
    console.error('could not resolve CodeGraph/ToolHandler from dist/');
    process.exit(2);
  }
  return { CodeGraph, ToolHandler };
}

/** `internal/gen/**` → /^internal\/gen\/.*$/ . Supports `**`, `*` and literals. */
function globToRegExp(glob) {
  // Park `**` on a sentinel no path can contain, so the `*` pass cannot eat it.
  // Written as an escape, not a literal byte — a raw NUL makes git treat this
  // whole script as binary, which costs every future diff of it.
  const DOUBLE_STAR = '\u0000';
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, '[^/]*')
    .replaceAll(DOUBLE_STAR, '.*');
  return new RegExp(`^${body}$`);
}

const groupOf = (path, groups) => {
  for (const [name, globs] of Object.entries(groups)) {
    if (globs.some((g) => globToRegExp(g).test(path))) return name;
  }
  return 'other';
};

/**
 * Run one explore call with the diagnostic pointed at a sidecar, and return the
 * report plus the response text.
 */
async function runExplore({ CodeGraph, ToolHandler }, repoPath, query, sidecar) {
  const cg = CodeGraph.openSync(repoPath);
  const prior = process.env.CODEGRAPH_EXPLORE_DEBUG;
  process.env.CODEGRAPH_EXPLORE_DEBUG = sidecar;
  try {
    const res = await new ToolHandler(cg).execute('codegraph_explore', { query });
    const text = res.content?.[0]?.text ?? '';
    const lines = readFileSync(sidecar, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) throw new Error('diagnostic produced no report');
    return { report: JSON.parse(lines[lines.length - 1]), text };
  } finally {
    if (prior === undefined) delete process.env.CODEGRAPH_EXPLORE_DEBUG;
    else process.env.CODEGRAPH_EXPLORE_DEBUG = prior;
    try { cg.close?.(); } catch {}
  }
}

/** Copy a fixture tree to a fresh temp dir and index it — hermetic per run. */
async function materializeFixture({ CodeGraph }, fixturePath) {
  const src = resolve(REPO_ROOT, fixturePath);
  if (!existsSync(src)) throw new Error(`fixture tree not found: ${src}`);
  const dir = mkdtempSync(join(tmpdir(), 'cg-alloc-'));
  cpSync(src, dir, { recursive: true });
  // A stray index inside the checked-in tree would be copied in and reused.
  rmSync(join(dir, '.codegraph'), { recursive: true, force: true });
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  cg.close?.();
  return dir;
}

/** Evaluate one fixture's assertions against its report. Returns check rows. */
function evaluate(fixture, report, text) {
  const { groups, assert: want } = fixture;
  const delivered = new Map();
  const allocated = new Map();
  for (const f of report.files) {
    const g = groupOf(f.path, groups);
    delivered.set(g, (delivered.get(g) ?? 0) + f.share);
    allocated.set(g, (allocated.get(g) ?? 0) + f.allocatedShare);
  }
  const share = (g) => delivered.get(g) ?? 0;
  const top = report.files
    .filter((f) => f.finalChars > 0)
    .sort((a, b) => b.finalChars - a.finalChars)[0];

  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  if (want.answerShareAtLeast !== undefined) {
    add(
      `answer group takes >= ${pct(want.answerShareAtLeast)} of the envelope`,
      share('answer') >= want.answerShareAtLeast,
      `answer ${pct(share('answer'))} delivered (${pct(allocated.get('answer') ?? 0)} allocated)`,
    );
  }
  if (want.incidentalShareAtMost !== undefined) {
    add(
      `incidental group takes <= ${pct(want.incidentalShareAtMost)} of the envelope`,
      share('incidental') <= want.incidentalShareAtMost,
      `incidental ${pct(share('incidental'))} delivered (${pct(allocated.get('incidental') ?? 0)} allocated)`,
    );
  }
  if (want.topFileGroup) {
    const actual = top ? groupOf(top.path, groups) : '(nothing delivered)';
    add(
      `largest delivered file is in "${want.topFileGroup}"`,
      actual === want.topFileGroup,
      top ? `${top.path} (${pct(top.share)}, group "${actual}")` : 'no file delivered any source',
    );
  }
  for (const path of want.mustDeliverBytes ?? []) {
    const rec = report.files.find((f) => f.path === path);
    add(
      `${path} delivers source`,
      !!rec && rec.finalChars > 0,
      rec
        ? `${num(rec.finalChars)} delivered of ${num(rec.emittedChars)} allocated` +
          (rec.finalChars === 0 && rec.emittedChars > 0 ? ' — hard ceiling dropped the whole section' : '') +
          (rec.emittedChars === 0 ? ` — never rendered (${rec.skipped ?? 'not reached'}, rank #${rec.rank})` : '')
        : 'not among the ranked candidates',
    );
  }
  for (const needle of want.mustContain ?? []) {
    add(`response contains "${needle}"`, text.includes(needle), text.includes(needle) ? 'present' : 'absent');
  }
  return { checks, delivered, allocated, top };
}

function printReport(fixture, report, evaluated) {
  const { checks, delivered, allocated } = evaluated;
  const env = report.envelope;
  say('');
  say(`── ${fixture.id} — ${fixture.title}`);
  say(`   query   "${report.query}"`);
  say(`   project ${report.projectRoot} · ${num(report.indexedFileCount)} files indexed`);
  say(
    `   envelope ${num(env.chars)} delivered · ${num(env.allocatedChars)} allocated` +
    ` of ${num(report.budget.maxOutputChars)} budget (hard ceiling ${num(report.budget.hardCeiling)})` +
    `${env.overBudget ? ' [over budget]' : ''}${env.truncated ? ' [TRUNCATED]' : ''}`,
  );
  say('');
  say('   group        alloc%  deliv%');
  for (const g of ['answer', 'incidental', 'other']) {
    if (!delivered.has(g) && !allocated.has(g)) continue;
    say(`   ${g.padEnd(12)} ${pct(allocated.get(g) ?? 0).padStart(6)}  ${pct(delivered.get(g) ?? 0).padStart(6)}`);
  }
  say('');
  say('    #  alloc%  deliv%    bytes  score    graph  hits  gen  render     file');
  for (const f of report.files.filter((f) => f.emittedChars > 0 || f.finalChars > 0)) {
    say(
      '   ' + String(f.rank).padStart(2) + '  ' +
      pct(f.allocatedShare).padStart(6) + '  ' +
      pct(f.share).padStart(6) + '  ' +
      num(f.emittedChars).padStart(7) + '  ' +
      String(f.score).padStart(5) + '  ' +
      f.graphScore.toFixed(5).padStart(7) + '  ' +
      String(f.termHits).padStart(4) + '  ' +
      (f.generated ? ' ✓ ' : '   ') + '  ' +
      ((f.render ?? '-') + (f.clipped ? '*' : '')).padEnd(9) + '  ' +
      f.path,
    );
  }
  say('');
  for (const c of checks) say(`   ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n         ${c.detail}`);
}

async function main() {
  const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf-8'));
  const fixtures = spec.fixtures.filter((f) => wanted.length === 0 || wanted.includes(f.id));
  if (fixtures.length === 0) {
    console.error(`no fixture matched ${JSON.stringify(wanted)}; known: ${spec.fixtures.map((f) => f.id).join(', ')}`);
    process.exit(2);
  }

  const dist = await loadDist();
  const sidecarDir = mkdtempSync(join(tmpdir(), 'cg-alloc-diag-'));
  const results = [];
  const temps = [];

  for (const fixture of fixtures) {
    let repoPath;
    if (fixture.kind === 'fixture') {
      repoPath = await materializeFixture(dist, fixture.path);
      temps.push(repoPath);
    } else {
      repoPath = resolve(REPO_ROOT, fixture.path);
      if (!existsSync(join(repoPath, '.codegraph'))) {
        console.error(`${fixture.id}: ${repoPath} has no .codegraph index — run \`codegraph init\` there first.`);
        process.exit(2);
      }
    }

    const sidecar = join(sidecarDir, `${fixture.id}.jsonl`);
    mkdirSync(dirname(sidecar), { recursive: true });
    const { report, text } = await runExplore(dist, repoPath, fixture.query, sidecar);
    const evaluated = evaluate(fixture, report, text);
    printReport(fixture, report, evaluated);
    results.push({
      id: fixture.id,
      kind: fixture.kind,
      query: fixture.query,
      passed: evaluated.checks.every((c) => c.pass),
      checks: evaluated.checks,
      shares: {
        delivered: Object.fromEntries(evaluated.delivered),
        allocated: Object.fromEntries(evaluated.allocated),
      },
      envelope: report.envelope,
      files: report.files.filter((f) => f.emittedChars > 0 || f.finalChars > 0),
    });
  }

  if (!keepTemp) {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
    rmSync(sidecarDir, { recursive: true, force: true });
  } else {
    say('');
    say(`   kept: ${[...temps, sidecarDir].join(' ')}`);
  }

  const allPassed = results.every((r) => r.passed);
  if (asJson) {
    console.log(JSON.stringify({ passed: allPassed, fixtures: results }, null, 2));
  } else {
    say('');
    for (const r of results) say(`${r.passed ? 'PASS' : 'FAIL'}  ${r.id}`);
    if (!allPassed) {
      say('');
      say('Failures here are the DOCUMENTED #1500 bug — the budget goes to files that merely');
      say('name-collide with the query. They become the pass gate once CG-10/CG-12 land.');
    }
  }
  process.exit(expectFail ? (allPassed ? 1 : 0) : (allPassed ? 0 : 1));
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(2);
});
