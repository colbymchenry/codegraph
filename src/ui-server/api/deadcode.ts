/**
 * `GET /api/deadcode` — symbols nothing in this repository reaches, grouped by
 * the file they live in (design spec §3.11).
 *
 * The derivation is `src/graph/dead-code.ts`, shared so that a second surface
 * asking the same question cannot get a different answer. This module is the
 * renderer, and it has exactly two jobs beyond flattening: hand the report a
 * source reader that goes through the viewer's read chokepoint, and carry the
 * exclusion counts onto the wire so the screen can say what the list could not
 * see. A dead code list without that sentence is a screen that quietly invites
 * somebody to delete a route handler.
 *
 * The rows come back ranked (largest first) and are grouped by file for
 * display, not re-ranked: the group order follows the best row in it, so the
 * biggest finding is still at the top of the screen.
 */

import type { CodeGraph } from '../../index';
import type { NodeKind } from '../../types';
import {
  buildDeadCodeReport,
  DEAD_CODE_ALLOWED_KINDS,
  MAX_CORROBORATION_BYTES,
  MAX_DEAD_CODE_CANDIDATES,
  type DeadCodeExclusions,
} from '../../graph/dead-code';
import { intParam } from './respond';
import { readIndexedFileText } from './source';
import { toNodeRef, wireList, type WireList, type WireNodeRef } from './wire';

/** Rows carried on the payload. The screen shows every one it is given. */
export const MAX_DEAD_CODE_ROWS = 300;

/** Members folded under one row before the row just counts them. */
export const MAX_DEAD_CODE_MEMBERS = 12;

/** One symbol nothing reaches. */
export interface WireDeadCodeRow extends WireNodeRef {
  /** Source lines it spans — the rank, and what deleting it would remove. */
  lines: number;
  /**
   * Members that are unreferenced and live inside this one: a class nobody
   * instantiates takes its methods with it. Capped; `total` stays real.
   */
  members: WireList<WireNodeRef>;
}

/** The rows of one file, in source order. */
export interface WireDeadCodeGroup {
  file: string;
  /** Tool-generated — drawn dimmed wherever it appears (design spec §2.6). */
  generated: boolean;
  test: boolean;
  /** Lines the rows in this group add up to. */
  lines: number;
  rows: WireDeadCodeRow[];
}

/** One reason candidates were dropped, in the words the screen prints. */
export interface WireDeadCodeExclusion {
  reason: keyof DeadCodeExclusions;
  count: number;
  label: string;
}

export interface WireDeadCode {
  /** Ranked, flat, capped. `total` is the real number of findings. */
  rows: WireList<WireDeadCodeRow>;
  /** The SHOWN rows, grouped by file — group order follows the best row. */
  groups: WireDeadCodeGroup[];
  /** Symbols with no incoming reference at all, before any exclusion ran. */
  candidates: number;
  /** Every exclusion that removed at least one candidate, biggest first. */
  excluded: WireDeadCodeExclusion[];
  /** How many candidates every exclusion removed between them. */
  excludedTotal: number;
  kinds: NodeKind[];
  /** Symbols reachable from outside the index are on the list. */
  includeExported: boolean;
  includeTests: boolean;
  includeGenerated: boolean;
  /** The candidate scan stopped at its cap; there are more. */
  bounded: boolean;
  /** Every row was checked against the text of the files that can reach it. */
  corroborated: boolean;
  timing: { elapsedMs: number };
}

/**
 * The sentence each exclusion prints under the list.
 *
 * Written as "N <label>" — so each one reads as a count of candidates, in the
 * reader's language rather than in the rule's.
 */
const EXCLUSION_LABELS: Record<keyof DeadCodeExclusions, string> = {
  tests: 'in test files',
  generated: 'in generated files',
  exported: 'exported, or declared in a header',
  exportsUnknown: 'in languages this index records no exports for',
  declarations: 'abstract, or declared on an interface',
  decorated: 'carrying a decorator, so a framework registers them',
  overriding: 'overriding a member declared further up',
  implicit: 'named something the language calls by itself',
  vendored: 'in vendored directories',
  testScope: 'inside a test module',
  markup: 'in component files, where markup can reference them invisibly',
  unreachableFile: 'in files nothing reaches — islands, drawn on the map',
  unresolvedName: 'sharing a name the index failed to resolve somewhere',
  ambiguousName: 'sharing a name with a symbol that IS referenced',
  mentioned: 'written more than once in a file that can reach them',
  unreadable: 'in files that could not be read',
  nested: 'folded into a container on this list',
};

export function parseDeadCodeQuery(query: URLSearchParams): {
  limit: number;
  includeExported: boolean;
  includeTests: boolean;
  includeGenerated: boolean;
  kinds: NodeKind[] | undefined;
} {
  const raw = query.get('kinds');
  const kinds = raw
    ? (raw
        .split(',')
        .map((kind) => kind.trim())
        .filter((kind) => DEAD_CODE_ALLOWED_KINDS.has(kind as NodeKind)) as NodeKind[])
    : undefined;
  return {
    limit: intParam(query, 'limit', { min: 1, max: MAX_DEAD_CODE_ROWS, default: MAX_DEAD_CODE_ROWS }),
    includeExported: query.get('exported') === '1',
    includeTests: query.get('tests') === '1',
    includeGenerated: query.get('generated') === '1',
    kinds: kinds && kinds.length > 0 ? kinds : undefined,
  };
}

export function buildDeadCode(
  cg: CodeGraph,
  projectRoot: string,
  query: URLSearchParams
): WireDeadCode {
  const started = Date.now();
  const options = parseDeadCodeQuery(query);

  const report = buildDeadCodeReport(cg, {
    kinds: options.kinds,
    includeExported: options.includeExported,
    includeTests: options.includeTests,
    includeGenerated: options.includeGenerated,
    limit: options.limit,
    // The chokepoint, not `fs`: the viewer never opens a path the index does
    // not name and `resolveProjectFile` has not cleared.
    readSource: (filePath) =>
      readIndexedFileText(cg, projectRoot, filePath, MAX_CORROBORATION_BYTES),
  });

  const generatedFiles = cg.generatedFilePredicate(
    report.entries.map((entry) => entry.node.filePath)
  );

  // Groups follow the rows' order: the first time a file appears is where its
  // group sits, so the largest finding is still at the top of the screen.
  const rows: WireDeadCodeRow[] = [];
  const groups: WireDeadCodeGroup[] = [];
  const byFile = new Map<string, WireDeadCodeGroup>();

  for (const entry of report.entries) {
    const row: WireDeadCodeRow = {
      ...toNodeRef(entry.node),
      lines: entry.lines,
      members: wireList(
        entry.members.slice(0, MAX_DEAD_CODE_MEMBERS).map((member) => toNodeRef(member)),
        entry.members.length
      ),
    };
    rows.push(row);

    let group = byFile.get(row.file);
    if (!group) {
      group = {
        file: row.file,
        // The path convention plus the indexed banner verdict, both, so a
        // generated file dims here for the same reason it dims on the map.
        generated: generatedFiles(entry.node.filePath),
        test: row.test,
        lines: 0,
        rows: [],
      };
      byFile.set(row.file, group);
      groups.push(group);
    }
    group.rows.push(row);
    group.lines += row.lines;
  }
  for (const group of groups) group.rows.sort((a, b) => a.line - b.line);

  const excluded: WireDeadCodeExclusion[] = (
    Object.keys(report.excluded) as Array<keyof DeadCodeExclusions>
  )
    .map((reason) => ({ reason, count: report.excluded[reason], label: EXCLUSION_LABELS[reason] }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  return {
    rows: wireList(rows, report.total),
    groups,
    candidates: report.candidates,
    excluded,
    excludedTotal: excluded.reduce((sum, entry) => sum + entry.count, 0),
    kinds: report.kinds,
    includeExported: report.includeExported,
    includeTests: options.includeTests,
    includeGenerated: options.includeGenerated,
    bounded: report.bounded,
    corroborated: report.corroborated,
    timing: { elapsedMs: Date.now() - started },
  };
}

export { MAX_DEAD_CODE_CANDIDATES };
