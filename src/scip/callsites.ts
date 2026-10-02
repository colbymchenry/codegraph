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
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SqliteDatabase } from '../db/sqlite-adapter';

/** Symbols per answer, and call sites listed per symbol. */
const MAX_SYMBOLS = 3;
const MAX_SITES = 200;

interface Target { id: string; qualified_name: string; file_path: string; start_line: number }
interface Site { file: string; line: number; caller: string; provenance: string | null; metadata: string | null }

/**
 * The functions/methods the query names: one whose own name is a query word and
 * whose enclosing type is one too (`JSHandle.evaluate`, `Match::start`, "Frame
 * url()"), plus explore's exact targets (`exact`: a qualified name or a line
 * anchor) that are callable.
 */
function targets(db: SqliteDatabase, query: string, exact: Iterable<string>): Target[] {
  const words = new Set(query.split(/[^A-Za-z0-9_$]+/).filter(w => w.length > 1));
  const out = new Map<string, Target>();
  const byId = db.prepare(`SELECT id, qualified_name, file_path, start_line FROM nodes WHERE id = ? AND kind IN ('function', 'method')`);
  for (const id of exact) {
    const t = byId.get(id) as Target | undefined;
    if (t) out.set(t.id, t);
  }
  const byName = db.prepare(`SELECT id, qualified_name, file_path, start_line FROM nodes WHERE name = ? AND kind IN ('function', 'method')`);
  for (const w of words) {
    for (const t of byName.all(w) as Target[]) {
      const owner = t.qualified_name.split('::').slice(-2, -1)[0];
      if (owner && words.has(owner)) out.set(t.id, t);
    }
  }
  return [...out.values()];
}

export function callSitesSection(db: SqliteDatabase, projectRoot: string, query: string, exact: Iterable<string>): string {
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
  for (const t of targets(db, query, exact)) {
    const sites = sitesOf.all(t.id) as Site[];
    const verified = sites.filter(s => s.provenance === 'scip').length;
    if (verified === 0) continue; // no compiler data for it: nothing this section can vouch for
    const unverified = sites.length - verified;
    const lines = [
      `**Call sites of \`${t.qualified_name}\` (${t.file_path}:${t.start_line}) — ${sites.length}: ${verified} compiler-verified` +
        (unverified ? `, ${unverified} not (marked)` : '') + '**',
      unverified
        ? 'The compiler confirmed the unmarked sites; the marked ones are codegraph\'s guesses it could not confirm.'
        : 'Every site here is compiler-verified, and this is every call the compiler resolved to it — treat the list as the answer, no grep needed. Only a call it could not resolve (dynamic or untyped) would be missing.',
    ];
    for (const s of sites.slice(0, MAX_SITES)) {
      const mark = s.provenance === 'scip' ? '' : ' [unverified]';
      lines.push(`- ${s.file}:${s.line}${mark} — \`${lineText(s.file, s.line)}\` (in \`${s.caller}\`)`);
    }
    if (sites.length > MAX_SITES) lines.push(`- … +${sites.length - MAX_SITES} more`);
    sections.push(lines.join('\n'));
    if (sections.length === MAX_SYMBOLS) break;
  }
  return sections.length ? `${sections.join('\n\n')}\n` : '';
}
