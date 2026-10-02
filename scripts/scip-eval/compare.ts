/**
 * SCIP eval gate: "who calls X?" answered three ways, judged by SCIP.
 * Port of the POC's compare.py (random-target mode).
 *
 *   npx tsx scripts/scip-eval/compare.ts <repo> <index.scip> <heuristic.db> <merged.db> \
 *     [--random 50] [--seed 1] [--prefix src/] [--rg-type ts] [--json] [--explain: each caller judged wrong, to stderr]
 *
 * Every candidate call line is labelled by SCIP:
 *   true    — SCIP resolves a call on that line to the target
 *   wrong   — SCIP resolves the same callee name on that line to something else
 *   unknown — SCIP has no resolution there (dynamic code)
 * Recall is against SCIP-resolved call lines; precision excludes unknowns.
 *
 * Gate (FORK.md): codegraph+SCIP precision >= 95%, recall >= codegraph-only.
 */

import { SqliteDatabase, createDatabase } from '../../src/db/sqlite-adapter';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ROLE_DEFINITION, ScipIndex, loadScipIndex, parseSymbol } from '../../src/scip/reader';
import { callLine } from '../../src/scip/site';
import { callShape } from '../../src/scip/syntax';

type Line = string; // `${path}:${line}`

interface Target {
  symbol: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  /**
   * Every line SCIP defines the symbol on (each overload's signature): two nodes may share a
   * qualified name in one file (Rust's `fn check` and `mod tests { fn check }`), overloads are one target.
   */
  lines: number[];
  grep: string;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/**
 * `${path}:${line}:${callee}` → SCIP symbols called there (external ones included).
 * `atChainStart`: a call in a multi-line chain counts at the chain's first line,
 * where codegraph keys it (site.ts callLine) — the graph's view, not grep's.
 */
function scipCalls(ix: ScipIndex, repo: string, atChainStart = false): Map<string, Set<string>> {
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
      const line = atChainStart ? callLine(lines, o.range.startLine, o.range.startCol) : o.range.startLine;
      const key = `${doc.relativePath}:${line + 1}:${p.last.name}`;
      let s = out.get(key);
      if (!s) out.set(key, (s = new Set()));
      s.add(o.symbol);
    }
  }
  return out;
}

/** The target's nodes `n`, bound to (qualifiedName, filePath, JSON of lines). */
const TARGET = 'n.qualified_name = ? AND n.file_path = ? AND EXISTS (SELECT 1 FROM json_each(?) j WHERE n.start_line <= j.value AND n.end_line >= j.value)';

function randomTargets(ix: ScipIndex, db: SqliteDatabase, calls: Map<string, Set<string>>, n: number, seed: number, prefix: string): Target[] {
  const called = new Map<string, number>();
  for (const syms of calls.values()) for (const s of syms) called.set(s, (called.get(s) ?? 0) + 1);
  const lookup = db.prepare(`SELECT qualified_name FROM nodes WHERE file_path = ? AND name = ? AND kind IN ('function','method')
    AND start_line <= ? AND end_line >= ? ORDER BY end_line - start_line LIMIT 1`);
  const defLines = new Map<string, number[]>();
  for (const doc of ix.documents) {
    for (const o of doc.occurrences) {
      if (!(o.roles & ROLE_DEFINITION)) continue;
      const k = `${doc.relativePath}\0${o.symbol}`;
      defLines.set(k, [...defLines.get(k) ?? [], o.range.startLine + 1]);
    }
  }
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
        lines: defLines.get(`${doc.relativePath}\0${o.symbol}`)!,
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

interface CallSite { file: string; line: number; name: string; symbol: string }

/**
 * Every call site in the index, by this file's own test — the name is followed by
 * `(`, optionally after generic arguments — not the merge's (syntax.ts callShape):
 * the caller table below shares no site logic with what it judges.
 */
function callSites(ix: ScipIndex, repo: string): { bySymbol: Map<string, CallSite[]>; byFileName: Map<string, CallSite[]> } {
  const bySymbol = new Map<string, CallSite[]>();
  const byFileName = new Map<string, CallSite[]>(); // `${file}\0${callee name}`
  const add = (m: Map<string, CallSite[]>, k: string, s: CallSite) => {
    const list = m.get(k);
    if (list) list.push(s);
    else m.set(k, [s]);
  };
  for (const doc of ix.documents) {
    let lines: string[];
    try {
      lines = fs.readFileSync(path.join(repo, doc.relativePath), 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    for (const o of doc.occurrences) {
      if (o.roles & ROLE_DEFINITION) continue;
      const after = (lines[o.range.startLine] ?? '').slice(o.range.endCol);
      if (!/^\s*(::)?(<[^()]*>)?\s*\(/.test(after)) continue;
      const name = parseSymbol(o.symbol)?.last.name;
      if (!name) continue;
      const site = { file: doc.relativePath, line: o.range.startLine + 1, name, symbol: o.symbol };
      add(bySymbol, o.symbol, site);
      add(byFileName, `${site.file}\0${name}`, site);
    }
  }
  return { bySymbol, byFileName };
}

/**
 * "Who calls X?" by caller rather than by line: the functions SCIP shows calling
 * the target (each site's narrowest enclosing function or method, else its file)
 * against the distinct sources of the graph's `calls` edges into it. A graph
 * caller is judged by the calls of the target's name inside its span: one
 * resolved to the target, true; else one on a line of its edges resolved
 * elsewhere, wrong; else unknown (an untyped receiver SCIP could not resolve, or
 * no document). Other calls of the name in the span say nothing about the edge:
 * Django's `options.get(…)` (untyped) beside a `dict.get` is not a wrong edge.
 */
function callerScore(db: SqliteDatabase, t: Target, sites: ReturnType<typeof callSites>, graph: string) {
  const enclosing = db.prepare(`SELECT id FROM nodes WHERE file_path = ? AND kind IN ('function','method')
    AND start_line <= ? AND end_line >= ? ORDER BY end_line - start_line LIMIT 1`);
  const fileNode = db.prepare(`SELECT id FROM nodes WHERE file_path = ? AND kind = 'file'`);
  const truthOf = new Map<CallSite, string>(); // each call to the target → the caller SCIP shows
  for (const s of sites.bySymbol.get(t.symbol) ?? []) {
    const row = (enclosing.get(s.file, s.line, s.line) ?? fileNode.get(s.file)) as { id: string } | undefined;
    if (row) truthOf.set(s, row.id);
  }
  const truth = new Set(truthOf.values());
  const covered = new Set<string>(); // SCIP's callers some graph caller accounts for
  const callers = db.prepare(`SELECT s.id, s.file_path AS file, s.kind, s.start_line AS start, s.end_line AS end, json_group_array(e.line) AS lines
    FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes n ON n.id = e.target
    WHERE e.kind = 'calls' AND ${TARGET} GROUP BY s.id`)
    .all(t.qualifiedName, t.filePath, JSON.stringify(t.lines)) as { id: string; file: string; kind: string; start: number; end: number; lines: string }[];
  let tp = 0;
  let wrong = 0;
  let unknown = 0;
  for (const c of callers) {
    if (truth.has(c.id)) {
      tp++;
      covered.add(c.id);
      continue;
    }
    // A caller codegraph names differently (a class body, a property's initializer) still holds the call.
    const inside = (sites.byFileName.get(`${c.file}\0${t.name}`) ?? [])
      .filter(s => c.kind === 'file' || (s.line >= c.start && s.line <= c.end));
    const hits = inside.filter(s => s.symbol === t.symbol);
    if (hits.length > 0) {
      tp++;
      for (const s of hits) covered.add(truthOf.get(s)!);
      continue;
    }
    const edgeLines = new Set(JSON.parse(c.lines) as (number | null)[]);
    const elsewhere = inside.filter(s => edgeLines.has(s.line));
    if (elsewhere.length > 0) {
      wrong++;
      if (process.argv.includes('--explain')) {
        console.error(`${graph} wrong: ${t.qualifiedName} (${t.filePath}) ← ${c.kind} ${c.file}:${c.start}-${c.end}; its \`${t.name}\` calls resolve to ` +
          [...new Set(elsewhere.map(s => `${s.line}: ${s.symbol}`))].join(', '));
      }
    } else unknown++;
  }
  return { candidates: callers.length, tp, found: covered.size, wrong, unknown, truth: truth.size };
}

function graphCallers(db: SqliteDatabase, t: Target): Set<Line> {
  const rows = db.prepare(`SELECT s.file_path AS p, e.line AS ln FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes n ON n.id = e.target
    WHERE e.kind = 'calls' AND ${TARGET}`).all(t.qualifiedName, t.filePath, JSON.stringify(t.lines)) as { p: string; ln: number }[];
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
  const graphCalls = scipCalls(ix, repo, true);
  const hDb = createDatabase(hPath, { readOnly: true }).db;
  const mDb = createDatabase(mPath, { readOnly: true }).db;
  const targets = randomTargets(ix, hDb, calls, n, seed, arg('prefix', '')!);

  type Tot = { candidates: number; true: number; wrong: number; unknown: number; truth: number; bytes: number; recalls: number[]; found?: number };
  const tot = new Map<string, Tot>();
  const sites = callSites(ix, repo);
  const byCaller = new Map<string, Tot>();
  for (const t of targets) {
    for (const [name, db] of [['codegraph', hDb], ['codegraph+SCIP', mDb]] as const) {
      const s = callerScore(db, t, sites, name);
      let c = byCaller.get(name);
      if (!c) byCaller.set(name, (c = { candidates: 0, true: 0, wrong: 0, unknown: 0, truth: 0, bytes: 0, recalls: [] }));
      c.candidates += s.candidates;
      c.true += s.tp;
      c.found = (c.found ?? 0) + s.found;
      c.wrong += s.wrong;
      c.unknown += s.unknown;
      c.truth += s.truth;
      c.recalls.push(s.truth ? s.found / s.truth : 1);
    }
    const truthIn = (m: Map<string, Set<string>>) => { let n = 0; for (const [k, syms] of m) if (k.endsWith(`:${t.name}`) && syms.has(t.symbol)) n++; return n; };
    const g = grep(repo, t.grep, arg('rg-type', 'ts')!);
    const methods: Record<string, { hits: Set<Line>; bytes: number; calls: Map<string, Set<string>> }> = {
      'grep naive': { ...g, calls },
      codegraph: { hits: graphCallers(hDb, t), bytes: 0, calls: graphCalls },
      'codegraph+SCIP': { hits: graphCallers(mDb, t), bytes: 0, calls: graphCalls },
    };
    for (const [name, { hits, bytes, calls }] of Object.entries(methods)) {
      const truth = truthIn(calls);
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
      if (name === 'codegraph+SCIP' && process.argv.includes('--explain')) {
        for (const [k, syms] of calls) {
          const line = k.slice(0, k.length - t.name.length - 1);
          if (k.endsWith(`:${t.name}`) && syms.has(t.symbol) && !hits.has(line)) console.error(`${name} missed: ${t.qualifiedName} (${t.filePath}:${t.lines.join(',')}) ← ${line}`);
        }
      }
    }
  }

  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
  };
  const toRows = (m: Map<string, Tot>) => [...m.entries()].map(([name, c]) => ({
    method: name, candidates: c.candidates, true: c.true, wrong: c.wrong, unknown: c.unknown,
    recall: c.truth ? (c.found ?? c.true) / c.truth : 0, // by caller: SCIP callers covered
    recallMedian: median(c.recalls),
    good: c.recalls.filter(r => r >= 0.9).length,
    precision: c.true + c.wrong ? c.true / (c.true + c.wrong) : null,
    kb: name.startsWith('grep') ? c.bytes / 1024 : null,
  }));
  const rows = toRows(tot);
  const callerRows = toRows(byCaller);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ seed, targets: targets.length, truth: tot.get('codegraph')?.truth ?? 0, rows, callerRows }, null, 2));
    return;
  }
  console.log(`${targets.length} random targets (seed ${seed}), SCIP-resolved call lines total: ${tot.get('codegraph')?.truth ?? 0}\n`);
  console.log('| method | candidates | true | wrong | unknown | recall (micro) | recall (median target) | targets ≥90% recall | precision* | output KB |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.method} | ${r.candidates} | ${r.true} | ${r.wrong} | ${r.unknown} | ${pct(r.recall)} | ${pct(r.recallMedian)} | ${r.good}/${targets.length} | ${r.precision === null ? '–' : pct(r.precision)} | ${r.kb === null ? '–' : r.kb.toFixed(0)} |`);
  }
  console.log('\n* precision over lines SCIP could judge (true+wrong); unknown excluded.');
  console.log(`\nBy caller, judged without the merge's site keys or call test (SCIP callers total: ${byCaller.get('codegraph')?.truth ?? 0}):\n`);
  console.log('| method | callers | true | wrong | unknown | recall (micro) | recall (median target) | targets ≥90% recall | precision |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of callerRows) {
    console.log(`| ${r.method} | ${r.candidates} | ${r.true} | ${r.wrong} | ${r.unknown} | ${pct(r.recall)} | ${pct(r.recallMedian)} | ${r.good}/${targets.length} | ${r.precision === null ? '–' : pct(r.precision)} |`);
  }
}

main();
