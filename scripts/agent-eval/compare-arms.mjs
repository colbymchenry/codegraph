#!/usr/bin/env node
// One side-by-side table for the three feedback metrics, across the arms of a
// single A/B output directory. This is the "did it move?" view — the per-run
// blocks parse-run.mjs prints are the "why did it move?" view, and both are
// printed by the harnesses (ab-new-vs-baseline.sh, run-all.sh).
//
//   residual context occupancy  how much window the arm's retrieval still holds
//   explore sufficiency         whether a response was ENOUGH (agent's next act)
//   allocation efficiency       what share of returned bytes the answer used
//
// Usage: compare-arms.mjs <out-dir> <label> [<label> ...]
//   e.g.  compare-arms.mjs /tmp/ab-new-vs-baseline new baseline
//         compare-arms.mjs /tmp/agent-eval headless-with headless-without
//
// Run discovery handles both shapes the harnesses write, per label:
//   run-<label>-<i>.jsonl        N independent runs   (ab-new-vs-baseline, RUNS=N)
//   run-<label>.jsonl + .tN      ONE session, N turns (run-all.sh multi-turn)
// A `.tN` file is always a resumed SEGMENT of the run it hangs off, never a run
// of its own — mixing those up would report a three-turn session as three runs
// and average away the residual the later turns exist to charge.
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { parseSession, SUFFICIENCY } from './parse-run.mjs';

/** Segment files of one run, in turn order: run-X.jsonl, run-X.t2.jsonl, … */
function segmentsOf(dir, stem) {
  const first = join(dir, `${stem}.jsonl`);
  if (!existsSync(first)) return null;
  const rest = readdirSync(dir)
    .map((f) => [f, new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.t(\\d+)\\.jsonl$`).exec(f)])
    .filter(([, m]) => m)
    .sort((a, b) => Number(a[1][1]) - Number(b[1][1]))
    .map(([f]) => join(dir, f));
  return [first, ...rest];
}

/** Every run of one arm, newest-numbering-first-run order. */
export function discoverRuns(dir, label) {
  const session = segmentsOf(dir, `run-${label}`);
  if (session) return [{ name: label, files: session }];
  const indexed = readdirSync(dir)
    .map((f) => new RegExp(`^run-${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.jsonl$`).exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  return indexed.map((i) => ({ name: `${label}-${i}`, files: segmentsOf(dir, `run-${label}-${i}`) }));
}

const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** The numbers one arm's runs contribute to the table. */
function measure(run) {
  const s = parseSession(run.files);
  const o = s.occupancy;
  const a = s.allocation;
  return {
    name: run.name,
    ok: s.ok,
    raced: s.raced,
    turns: s.turns,
    dur: s.dur,
    tools: s.tools,
    reads: s.reads,
    grep: s.grep,
    bash: s.counts.Bash || 0,
    cg: s.cg,
    cliCalls: s.cliCalls,
    cliContaminated: s.cliContaminated,
    ctx: o.ctxFinal,
    occCg: o.residual.codegraph,
    occFile: o.residualFileAccess,
    // The arm's OWN retrieval residual: codegraph in a with-arm, Read/Grep/Bash
    // in a without-arm. Comparing these two is the apples-to-apples pair.
    occSelf: o.residual.codegraph + o.residualFileAccess,
    occShare: o.ctxFinal > 0 ? ((o.residual.codegraph + o.residualFileAccess) / o.ctxFinal) * 100 : 0,
    suffAnswered: s.sufficiency.answered,
    suffCounts: s.sufficiency.counts,
    suffErrors: s.sufficiency.errors,
    // Allocation is byte-weighted, so a run with no explore contributes nothing
    // rather than a zero — a zero would drag the pooled number toward "wasteful"
    // for a run that never spent a byte.
    allocUsed: a.envelope ? a.used : null,
    allocEnvelope: a.envelope || null,
    allocCalls: a.calls.length,
  };
}

/** median [min–max] over runs; the range is the point — never quote one run. */
function span(runs, pick, fmt = (x) => String(Math.round(x))) {
  const xs = runs.map(pick).filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  if (!xs.length) return '—';
  const m = fmt(median(xs));
  if (xs.length === 1) return m;
  const lo = fmt(Math.min(...xs)); const hi = fmt(Math.max(...xs));
  return lo === hi ? m : `${m} [${lo}–${hi}]`;
}

const int = (x) => Math.round(x).toLocaleString('en-US');
const pct1 = (x) => `${x.toFixed(1)}%`;

export function formatComparison(arms) {
  const W = 36; const C = 24;
  const out = [];
  // The leading space is a separator, not padding: a `median [min–max]` cell can
  // fill its column, and two of those with only padStart between them run
  // together into one unreadable number.
  const row = (label, cells) => out.push('  ' + label.padEnd(W) + cells.map((c) => ' ' + String(c).padStart(C - 1)).join(''));
  const rule = (title) => out.push(`  ${title}`);

  row('', arms.map((a) => a.label));
  row('runs', arms.map((a) => a.runs.length));
  const anyFailed = arms.some((a) => a.runs.some((r) => !r.ok));
  if (anyFailed) row('  of which non-success', arms.map((a) => a.runs.filter((r) => !r.ok).length));
  if (arms.some((a) => a.runs.some((r) => r.raced))) {
    row('  MCP cold-start race', arms.map((a) => a.runs.filter((r) => r.raced).length));
  }
  out.push('');

  rule('behavior');
  row('  duration (s)', arms.map((a) => span(a.runs, (r) => r.dur)));
  row('  tool calls', arms.map((a) => span(a.runs, (r) => r.tools)));
  row('  Read', arms.map((a) => span(a.runs, (r) => r.reads)));
  row('  Grep/Glob', arms.map((a) => span(a.runs, (r) => r.grep)));
  row('  Bash', arms.map((a) => span(a.runs, (r) => r.bash)));
  row('  codegraph calls', arms.map((a) => span(a.runs, (r) => r.cg)));
  out.push('');

  rule('residual context occupancy (CG-7) — tokens still resident at end of run');
  row('  final context (tok)', arms.map((a) => span(a.runs, (r) => r.ctx, int)));
  row('  codegraph residual (tok)', arms.map((a) => span(a.runs, (r) => r.occCg, int)));
  row('  file-access residual (tok)', arms.map((a) => span(a.runs, (r) => r.occFile, int)));
  row('  → retrieval residual (tok)', arms.map((a) => span(a.runs, (r) => r.occSelf, int)));
  row('  → share of final context', arms.map((a) => span(a.runs, (r) => r.occShare, pct1)));
  out.push('');

  rule('explore sufficiency (CG-8) — pooled over every answered explore call');
  row('  answered explore calls', arms.map((a) => a.runs.reduce((s, r) => s + r.suffAnswered, 0)));
  for (const [key, label] of SUFFICIENCY) {
    row(`  ${label}`, arms.map((a) => {
      const n = a.runs.reduce((s, r) => s + r.suffCounts[key], 0);
      const tot = a.runs.reduce((s, r) => s + r.suffAnswered, 0);
      return tot ? `${n}  ${((n / tot) * 100).toFixed(0)}%` : '—';
    }));
  }
  if (arms.some((a) => a.runs.some((r) => r.suffErrors))) {
    row('  errored/unanswered (not bucketed)', arms.map((a) => a.runs.reduce((s, r) => s + r.suffErrors, 0)));
  }
  out.push('');

  rule('explore allocation efficiency (CG-9) — share of returned bytes the answer cited');
  row('  explore calls with source', arms.map((a) => a.runs.reduce((s, r) => s + r.allocCalls, 0)));
  row('  pooled efficiency', arms.map((a) => {
    const env = a.runs.reduce((s, r) => s + (r.allocEnvelope || 0), 0);
    const used = a.runs.reduce((s, r) => s + (r.allocUsed || 0), 0);
    return env ? pct1((used / env) * 100) : '—';
  }));
  row('  per-run efficiency', arms.map((a) =>
    span(a.runs, (r) => (r.allocEnvelope ? (r.allocUsed / r.allocEnvelope) * 100 : null), pct1)));
  row('  envelope (chars)', arms.map((a) => int(a.runs.reduce((s, r) => s + (r.allocEnvelope || 0), 0))));
  out.push('');

  rule('contamination — the CLI must never be how codegraph is reached');
  row('  CLI calls that RETURNED output', arms.map((a) => a.runs.reduce((s, r) => s + r.cliContaminated, 0)));
  row('  CLI attempts blocked', arms.map((a) => a.runs.reduce((s, r) => s + r.cliCalls, 0)));
  const contaminated = arms.filter((a) => a.runs.some((r) => r.cliContaminated));
  if (contaminated.length) {
    out.push(`  !! ${contaminated.map((a) => a.label).join(', ')} reached codegraph through Bash — those runs are CONTAMINATED`);
    out.push('     (a without-arm was not without codegraph; a with-arm has bytes attributed to Bash, not codegraph)');
  }
  out.push('');

  out.push('  how to read this');
  out.push('    occupancy  compare each arm\'s RETRIEVAL residual (codegraph in a with-arm,');
  out.push('               file-access in a without-arm). Shares are Claude Code on a 200k');
  out.push('               window and do NOT transfer to another host; the ratio does.');
  out.push('    sufficiency  pooled across runs because it is per-CALL. "explore again" is');
  out.push('               ambiguous by construction; "Read a file we returned" is an');
  out.push('               allocation miss, the two recall rows are recall misses.');
  out.push('    allocation  RELATIVE, not absolute — attribution is by citation, and an agent');
  out.push('               can use a file without naming it. Compare builds on the SAME');
  out.push('               question; never quote it as "codegraph wastes N% of what it returns."');
  out.push('    all three  small-n. Runs make 1–5 explore calls, so read the range, not the');
  out.push('               median of one run. RUNS>=2, and the 7-repo campaign for a verdict.');
  return out.join('\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [dir, ...labels] = process.argv.slice(2);
  if (!dir || !labels.length) {
    console.error('usage: compare-arms.mjs <out-dir> <label> [<label> ...]');
    process.exit(1);
  }
  const arms = labels.map((label) => ({ label, runs: discoverRuns(dir, label).map(measure) }));
  const empty = arms.filter((a) => !a.runs.length);
  if (empty.length === arms.length) {
    console.error(`no run logs for ${labels.join('/')} in ${dir}`);
    process.exit(1);
  }
  for (const a of empty) console.error(`  WARN: no run logs for arm '${a.label}' in ${dir}`);
  console.log(`\n====== ARM COMPARISON — ${dir} ======`);
  console.log(formatComparison(arms.filter((a) => a.runs.length)));
}
