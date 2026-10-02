/**
 * "Who calls X?" answered as a list the agent can stop on.
 *
 * Measured (FORK.md, agent runs): an agent asked for a method's call sites called
 * `codegraph_explore` once, got related source and other symbols' blast radius —
 * not the call sites — and re-derived them with grep, even when every site was in
 * the graph, compiler-verified. This section lists them: every call site of the
 * symbols the query names, with the line's text, and how far the list can be
 * trusted. Only for a symbol with compiler-verified callers, so a project without
 * SCIP indexes gets explore's output unchanged.
 *
 * With the list given, the agent still grepped the name and checked the hits it
 * had no answer for (bench T3: 6 calls after it). So the section also accounts
 * for the other calls of the name: to which project methods, and how many
 * codegraph could not resolve at all (dependencies, the standard library).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SqliteDatabase } from '../db/sqlite-adapter';
import type { Edge } from '../types';
import { scipVerdict } from './notes';
import { edgeFlag } from './store';

/** A path the query names (`src/x.ts`, `lib.rs`), not a `Type.method`. */
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift|c|cc|cpp|h|hpp)$/;

/** Symbols per answer, and call sites listed per symbol. */
const MAX_SYMBOLS = 3;
const MAX_SITES = 1000;
/**
 * Past this many chars a symbol's sites are listed as `file: line, line` without
 * their text: the section sits ahead of explore's source and outside its budget,
 * so a method called hundreds of times (Playwright's `Page::evaluate`: 2,165)
 * would otherwise push the source past the output cap.
 */
const MAX_DETAILED_CHARS = 8000;
interface Target { id: string; name: string; qualified_name: string; file_path: string; start_line: number; language: string }
interface Site { file: string; line: number; caller: string; provenance: string | null; metadata: string | null }

/** Appends `line`; its length as `join('\n')` counts it. */
const push = (out: string[], line: string): number => (out.push(line), line.length + 1);

/** Compiler-verified: same rule Flow/trail use — not just `provenance === 'scip'` (stale keeps that). */
function compilerVerified(provenance: string | null, metadata: string | null): boolean {
  let meta: Record<string, unknown> | undefined;
  if (metadata) {
    try { meta = JSON.parse(metadata) as Record<string, unknown>; } catch { /* ignore */ }
  }
  return scipVerdict({ provenance: provenance as Edge['provenance'], metadata: meta }) === 'verified';
}

/**
 * Callables for the Call sites section: explore's resolved ids first, then any
 * Type.method co-name the query still carries that explore under-resolved
 * (same-named methods in two files — bench T2). A file token in the query picks
 * among them.
 */
function targets(db: SqliteDatabase, query: string, ids: Iterable<string>): Target[] {
  const words = new Set(query.split(/[^A-Za-z0-9_$]+/).filter(w => w.length > 1));
  const out = new Map<string, Target>();
  const byId = db.prepare(`SELECT id, name, qualified_name, file_path, start_line, language FROM nodes WHERE id = ? AND kind IN ('function', 'method')`);
  for (const id of ids) {
    const t = byId.get(id) as Target | undefined;
    if (t) out.set(t.id, t);
  }
  // Supplement: explore's bag can miss a same-named method the query co-names
  // (Invoice.totalPrice → both client and server). File filter below picks.
  const byName = db.prepare(`SELECT id, name, qualified_name, file_path, start_line, language FROM nodes WHERE name = ? AND kind IN ('function', 'method')`);
  for (const w of words) {
    for (const t of byName.all(w) as Target[]) {
      const owner = t.qualified_name.split('::').slice(-2, -1)[0];
      if (owner && words.has(owner)) out.set(t.id, t);
    }
  }
  const files = (query.match(/[\w@./-]+/g) ?? []).map(f => f.replace(/^\.\//, '').replace(/\.$/, '')).filter(f => SOURCE_FILE.test(f));
  const named = (t: Target) => files.some(f => t.file_path === f || t.file_path.endsWith(`/${f}`) || f.endsWith(`/${t.file_path}`));
  const all = [...out.values()];
  const namedNames = new Set(all.filter(named).map(t => t.name));
  return all.filter(t => !namedNames.has(t.name) || named(t));
}

/** `ids`: explore's exact + named callable node ids (one naming policy). */
export function callSitesSection(db: SqliteDatabase, projectRoot: string, query: string, ids: Iterable<string>): string {
  const sitesOf = db.prepare(`SELECT s.file_path AS file, e.line, s.qualified_name AS caller, e.provenance, e.metadata
    FROM edges e JOIN nodes s ON s.id = e.source WHERE e.target = ? AND e.kind = 'calls' AND e.line IS NOT NULL
    ORDER BY s.file_path, e.line`);
  const texts = new Map<string, string[] | null>();
  const lineText = (file: string, line: number): string => {
    if (!texts.has(file)) {
      try {
        texts.set(file, fs.readFileSync(path.join(projectRoot, file), 'utf8').split(/\r?\n/));
      } catch {
        texts.set(file, null);
      }
    }
    return (texts.get(file)?.[line - 1] ?? '').trim().slice(0, 140);
  };

  const sections: string[] = [];
  for (const t of targets(db, query, ids)) {
    const sites = sitesOf.all(t.id) as Site[];
    const ok = sites.map(s => compilerVerified(s.provenance, s.metadata));
    const verified = ok.filter(Boolean).length;
    if (verified === 0) continue; // no compiler data for it: nothing this section can vouch for
    const unverified = sites.length - verified;
    const lines = [
      `**Call sites of \`${t.qualified_name}\` (${t.file_path}:${t.start_line}) — ${sites.length}: ${verified} compiler-verified` +
        (unverified ? `, ${unverified} not (marked)` : '') + '**',
      unverified
        ? 'The compiler confirmed the unmarked sites; the marked ones are codegraph\'s guesses it could not confirm' +
          (t.language === 'python' ? ' (in Python, mostly receivers without type hints: the type checker has nothing to resolve them with).' : '.')
        : 'Every site here is compiler-verified, and this is every call the compiler resolved to it — treat the list as the answer, no grep needed. Only a call it could not resolve (dynamic or untyped) would be missing.',
    ];
    const shown = sites.slice(0, MAX_SITES);
    // Detailed (each line's text) while it fits; past MAX_DETAILED_CHARS stop — no caller
    // file is read beyond that point — and list every line compactly instead.
    const detailed: string[] = [];
    let chars = -1; // as `detailed.join('\n').length`: one newline fewer than lines
    let file = '';
    for (let i = 0; i < shown.length && chars <= MAX_DETAILED_CHARS; i++) {
      const s = shown[i]!;
      if (s.file !== file) chars += push(detailed, `\`${(file = s.file)}\``);
      chars += push(detailed, `- ${s.line}${ok[i] ? '' : ' [unverified]'} — \`${lineText(s.file, s.line)}\` (in \`${s.caller}\`)`);
    }
    if (chars <= MAX_DETAILED_CHARS) {
      lines.push(...detailed);
    } else {
      const byFile = new Map<string, string[]>();
      shown.forEach((s, i) => byFile.set(s.file, [...(byFile.get(s.file) ?? []), `${s.line}${ok[i] ? '' : '?'}`]));
      lines.push(`Lines per file${unverified ? ' (`?`: unverified)' : ''}; name a file in another codegraph_explore for its source:`);
      for (const [f, ls] of byFile) lines.push(`- \`${f}\`: ${ls.join(', ')}`);
    }
    if (sites.length > MAX_SITES) lines.push(`- … +${sites.length - MAX_SITES} more`);
    const others = otherCalls(db, t, sites);
    if (others) lines.push(others);
    sections.push(lines.join('\n'));
    if (sections.length === MAX_SYMBOLS) break;
  }
  return sections.length ? `${sections.join('\n\n')}\n` : '';
}

/**
 * Failed unresolved call refs named `name`, less those on a line where `t` already
 * has a call edge (`sites`: `t`'s call sites, in the call-sites list). A Set anti-join:
 * the old correlated NOT EXISTS re-probed `t`'s edges once per unresolved row
 * (vscode `DisposableStore::add`: ~90 s → ~0.1 s), and taking the sites the section
 * already loaded saves reading them twice (~36 ms there).
 */
export function countUnresolvedOtherCalls(db: SqliteDatabase, name: string, sites: Iterable<{ file: string; line: number }>): number {
  const siteLines = new Set<string>();
  for (const r of sites) siteLines.add(`${r.file}\0${r.line}`);
  let n = 0;
  for (const r of db.prepare(
    `SELECT file_path AS file, line FROM unresolved_refs
     WHERE status = 'failed' AND name_tail = ? AND reference_kind = 'calls'`,
  ).all(name) as { file: string; line: number | null }[]) {
    if (!siteLines.has(`${r.file}\0${r.line}`)) n++;
  }
  return n;
}

/**
 * The rest of what a grep for `name(` finds: calls of the name to other project
 * methods, and the calls codegraph could not resolve to any (a failed reference:
 * into a dependency or the standard library, or untyped) — less those on a line
 * the compiler linked to `t`, which are in the list.
 */
function otherCalls(db: SqliteDatabase, t: Target, sites: readonly Site[]): string {
  // Aggregate in SQL: loading every same-name edge then grouping in JS was
  // multi-ms–tens of ms on common names (vscode `toString`: ~60 ms / 3k rows).
  const ordered = db.prepare(
    `SELECT n.qualified_name AS qn, n.file_path AS file, COUNT(*) AS n,
            SUM(e.provenance = 'scip' AND NOT (${edgeFlag('scipSilent', 'e.metadata')}) AND NOT (${edgeFlag('scipStale', 'e.metadata')})) AS verified
     FROM edges e JOIN nodes n ON n.id = e.target
     WHERE n.name = ? AND NOT (n.qualified_name = ? AND n.file_path = ?) AND e.kind = 'calls'
     GROUP BY n.qualified_name, n.file_path
     ORDER BY n DESC`,
  ).all(t.name, t.qualified_name, t.file_path) as { qn: string; file: string; n: number; verified: number }[];
  const unresolved = countUnresolvedOtherCalls(db, t.name, sites);
  if (ordered.length === 0 && unresolved === 0) return '';
  const parts = ordered.slice(0, 5).map(o => `${o.n} to \`${o.qn}\` (${o.file}${o.verified === o.n ? ', compiler-verified' : ''})`);
  if (ordered.length > 5) parts.push(`${ordered.slice(5).reduce((a, o) => a + o.n, 0)} to ${ordered.length - 5} other methods`);
  if (unresolved) parts.push(`${unresolved} codegraph resolved to no project symbol (a dependency, the standard library, or untyped)`);
  return `Other calls named \`${t.name}\`, which neither the compiler nor codegraph resolved to this one: ${parts.join('; ')}.`;
}
