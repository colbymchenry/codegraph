/**
 * SCIP eval gate: "who calls X?" answered three ways, judged by SCIP.
 * Port of the POC's compare.py (random-target mode).
 *
 *   npx tsx scripts/scip-eval/compare.ts <repo> <index.scip> <heuristic.db> <merged.db> \
 *     [--random 50] [--seed 1] [--prefix src/] [--rg-type ts] [--json]
 *
 * Every candidate call line is labelled by SCIP:
 *   true    — SCIP resolves a call on that line to the target
 *   wrong   — SCIP resolves the same callee name on that line to something else
 *   unknown — SCIP has no resolution there (dynamic code)
 * Recall is against SCIP-resolved call lines; precision excludes unknowns.
 *
 * Gate (FORK.md): codegraph+SCIP precision >= 95%, recall >= codegraph-only.
 */

import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ROLE_DEFINITION, ScipIndex, loadScipIndex, parseSymbol } from '../../src/scip/reader';
import { callShape } from '../../src/scip/syntax';

type Line = string; // `${path}:${line}`

interface Target {
  symbol: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  grep: string;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** `${path}:${line}:${callee}` → SCIP symbols called there (external ones included). */
function scipCalls(ix: ScipIndex, repo: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const doc of ix.documents) {
    let lines: string[];
    try {
      lines = fs.readFileSync(path.join(repo, doc.relativePath), 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    for (const o of doc.occurrences) {
      if (o.roles & ROLE_DEFINITION) continue;
      const p = parseSymbol(o.symbol);
      if (!p || (p.last.kind !== 'method' && p.last.kind !== 'term')) continue;
      if (callShape(o, doc.positionEncoding, lines) !== 'call') continue; // the merge's own call test
      const key = `${doc.relativePath}:${o.range.startLine + 1}:${p.last.name}`;
      let s = out.get(key);
      if (!s) out.set(key, (s = new Set()));
      s.add(o.symbol);
    }
  }
  return out;
}

function randomTargets(ix: ScipIndex, db: DatabaseSync, calls: Map<string, Set<string>>, n: number, seed: number, prefix: string): Target[] {
  const called = new Map<string, number>();
  for (const syms of calls.values()) for (const s of syms) called.set(s, (called.get(s) ?? 0) + 1);
  const lookup = db.prepare(`SELECT qualified_name FROM nodes WHERE file_path = ? AND name = ? AND kind IN ('function','method')
    AND start_line <= ? AND end_line >= ? ORDER BY end_line - start_line LIMIT 1`);
  const pool: Target[] = [];
  for (const doc of ix.documents) {
    if (!doc.relativePath.startsWith(prefix)) continue;
    for (const o of doc.occurrences) {
      if (!(o.roles & ROLE_DEFINITION) || (called.get(o.symbol) ?? 0) < 3) continue;
      const p = parseSymbol(o.symbol);
      if (!p || (p.last.kind !== 'method' && p.last.kind !== 'term') || p.last.name.startsWith('<') || p.last.name.startsWith('__')) continue;
      const line = o.range.startLine + 1;
      const row = lookup.get(doc.relativePath, p.last.name, line, line) as { qualified_name: string } | undefined;
      if (!row) continue;
      const isMember = p.owner.endsWith('#');
      pool.push({
        symbol: o.symbol, name: p.last.name, qualifiedName: row.qualified_name, filePath: doc.relativePath,
        grep: isMember ? `\\.${p.last.name}\\(` : `\\b${p.last.name}\\(`,
      });
    }
  }
  // mulberry32 — deterministic per seed, so two runs pick the same targets
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n);
}

function grep(repo: string, pattern: string, rgType: string): { hits: Set<Line>; bytes: number } {
  const res = spawnSync('rg', ['-n', '--no-heading', '-t', rgType, pattern, '.'], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (res.status !== 0 && res.status !== 1) throw new Error(`rg failed: ${res.stderr}`);
  const hits = new Set<Line>();
  let bytes = 0;
  for (const row of res.stdout.split('\n')) {
    if (!row) continue;
    const [p, ln] = row.split(':', 2);
    hits.add(`${p!.replace(/^\.\//, '')}:${ln}`);
    bytes += row.length + 1;
  }
  return { hits, bytes };
}

function graphCallers(db: DatabaseSync, t: Target): Set<Line> {
  const rows = db.prepare(`SELECT s.file_path AS p, e.line AS ln FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes n ON n.id = e.target
    WHERE e.kind = 'calls' AND n.qualified_name = ? AND n.file_path = ?`).all(t.qualifiedName, t.filePath) as { p: string; ln: number }[];
  return new Set(rows.map(r => `${r.p}:${r.ln}`));
}

function main(): void {
  const [repo, scipFile, hPath, mPath] = process.argv.slice(2);
  if (!repo || !scipFile || !hPath || !mPath) {
    console.error('usage: compare.ts <repo> <index.scip> <heuristic.db> <merged.db> [--random N] [--seed S] [--prefix P] [--rg-type T] [--json]');
    process.exit(2);
  }
  const n = Number(arg('random', '50'));
  const seed = Number(arg('seed', '1'));
  const ix = loadScipIndex(scipFile);
  const calls = scipCalls(ix, repo);
  const hDb = new DatabaseSync(hPath, { readOnly: true });
  const mDb = new DatabaseSync(mPath, { readOnly: true });
  const targets = randomTargets(ix, hDb, calls, n, seed, arg('prefix', '')!);

  type Tot = { candidates: number; true: number; wrong: number; unknown: number; truth: number; bytes: number; recalls: number[] };
  const tot = new Map<string, Tot>();
  for (const t of targets) {
    let truth = 0;
    for (const [k, syms] of calls) if (k.endsWith(`:${t.name}`) && syms.has(t.symbol)) truth++;
    const g = grep(repo, t.grep, arg('rg-type', 'ts')!);
    const methods: Record<string, { hits: Set<Line>; bytes: number }> = {
      'grep naive': g,
      codegraph: { hits: graphCallers(hDb, t), bytes: 0 },
      'codegraph+SCIP': { hits: graphCallers(mDb, t), bytes: 0 },
    };
    for (const [name, { hits, bytes }] of Object.entries(methods)) {
      let c = tot.get(name);
      if (!c) tot.set(name, (c = { candidates: 0, true: 0, wrong: 0, unknown: 0, truth: 0, bytes: 0, recalls: [] }));
      let tp = 0;
      for (const line of hits) {
        const syms = calls.get(`${line}:${t.name}`);
        if (!syms) c.unknown++;
        else if (syms.has(t.symbol)) tp++;
        else c.wrong++;
      }
      c.candidates += hits.size;
      c.true += tp;
      c.truth += truth;
      c.bytes += bytes;
      c.recalls.push(truth ? tp / truth : 1);
    }
  }

  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
  };
  const rows = [...tot.entries()].map(([name, c]) => ({
    method: name, candidates: c.candidates, true: c.true, wrong: c.wrong, unknown: c.unknown,
    recall: c.truth ? c.true / c.truth : 0,
    recallMedian: median(c.recalls),
    good: c.recalls.filter(r => r >= 0.9).length,
    precision: c.true + c.wrong ? c.true / (c.true + c.wrong) : null,
    kb: name.startsWith('grep') ? c.bytes / 1024 : null,
  }));
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ seed, targets: targets.length, truth: tot.get('codegraph')?.truth ?? 0, rows }, null, 2));
    return;
  }
  console.log(`${targets.length} random targets (seed ${seed}), SCIP-resolved call lines total: ${tot.get('codegraph')?.truth ?? 0}\n`);
  console.log('| method | candidates | true | wrong | unknown | recall (micro) | recall (median target) | targets ≥90% recall | precision* | output KB |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.method} | ${r.candidates} | ${r.true} | ${r.wrong} | ${r.unknown} | ${pct(r.recall)} | ${pct(r.recallMedian)} | ${r.good}/${targets.length} | ${r.precision === null ? '–' : pct(r.precision)} | ${r.kb === null ? '–' : r.kb.toFixed(0)} |`);
  }
  console.log('\n* precision over lines SCIP could judge (true+wrong); unknown excluded.');
}

main();
