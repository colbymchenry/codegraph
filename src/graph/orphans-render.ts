/**
 * The two shapes `codegraph orphans` prints: a text report for a reader and
 * JSON for a tool. Both list entries in the order `findOrphans` sorted them
 * (path, then start line).
 *
 * A guessed entry's evidence (edges, unresolved references, mentions) is
 * capped per kind: JSON carries at most `JSON_EVIDENCE_CAP` of each, text
 * prints at most `TEXT_EVIDENCE_CAP` of each and then `+N more`. `findOrphans`
 * itself keeps at most `EVIDENCE_KEPT` unresolved references and mentions per
 * entry (the same as `JSON_EVIDENCE_CAP`), so for those kinds the JSON cap
 * changes nothing; edges are kept whole and the JSON cap cuts them.
 * `edgeCount` is the full edge-list length; `unresolvedCount` and `mentionCount`
 * are the full counts computed before the storage cap. For mentions the count
 * is the distinct hit lines outside the symbol's span that the search kept,
 * not every occurrence in the repo: the search caps its hits, so `mentionCount`
 * can undercount (see the `./orphans` header).
 *
 * JSON always carries `searchUnread`, the indexed files the text-mention search
 * could not read. When it is above 0 the text report says so on the line right
 * after the orphaned list, the list it qualifies: a mention in such a file would
 * have made one of those symbols guessed.
 */
import { EVIDENCE_KEPT, type GuessedEntry, type OrphanEntry, type OrphansReport } from './orphans';

/**
 * Evidence items of each kind per guessed entry in JSON. For unresolved references and mentions
 * this is what findOrphans keeps; for edges this is the only cap. The counts carry the rest.
 */
export const JSON_EVIDENCE_CAP = EVIDENCE_KEPT;
/** Evidence lines of each kind per guessed entry in the text report. */
export const TEXT_EVIDENCE_CAP = 3;

/** The report with the range it was read from. */
export interface OrphansOutput extends OrphansReport {
  /** `<base>...HEAD`, or `<base>...HEAD plus uncommitted changes` when tracked files differ from HEAD. */
  basis: string;
  /** The full merge-base commit sha. */
  mergeBase: string;
}

function entryLine(e: OrphanEntry): string {
  const m = /^L(\d+)-L(\d+)$/.exec(e.span);
  const span = m ? `${m[1]}-${m[2]}` : e.span;
  const note = e.externalConformances?.length ? `  (type conforms to ${e.externalConformances.join(', ')})` : '';
  return `  ${e.path}:${span}  ${e.kind}  ${e.name}${note}`;
}

/** At most `TEXT_EVIDENCE_CAP` lines of one evidence kind, then `+N more <kind>` when there are more. */
function capped<T>(kind: string, items: readonly T[], total: number, line: (x: T) => string): string[] {
  const out = items.slice(0, TEXT_EVIDENCE_CAP).map((x) => `      ${kind.padEnd(11)}${line(x)}`);
  const more = total - Math.min(items.length, TEXT_EVIDENCE_CAP);
  if (more > 0) out.push(`      ${kind.padEnd(11)}+${more} more`);
  return out;
}

/** A guessed entry's evidence, each line led by its kind: edge, unresolved or mention. */
function guessLines(e: GuessedEntry): string[] {
  return [
    ...capped('edge', e.edges, e.edgeCount, (g) => {
      const how = [g.resolvedBy ?? 'no resolvedBy', g.confidence === null ? '' : `confidence ${g.confidence}`]
        .filter((x) => x !== '')
        .join(', ');
      return `← ${g.kind} from ${g.sourceName}  ${g.sourcePath}:${g.line}  (${how})`;
    }),
    ...capped('unresolved', e.unresolved, e.unresolvedCount, (u) => `← ${u.kind} ${u.name}  ${u.path}:${u.line}`),
    ...capped('mention', e.mentions, e.mentionCount, (m) => `${m.path}:${m.line}`),
  ];
}

/** The text report: header, both lists (the orphaned one with its unread-file note), the excluded summary, the added count. */
export function textReport(r: OrphansOutput): string {
  const out: string[] = [`orphans — ${r.basis} (merge base ${r.mergeBase.slice(0, 7)})`, ''];
  out.push(`orphaned (${r.orphans.length})`);
  for (const e of r.orphans) out.push(entryLine(e));
  if (r.searchUnread > 0) {
    out.push(`text search could not read ${r.searchUnread} indexed file(s); a mention there would be missed`);
  }
  out.push('');
  out.push(`orphaned unless the guess is right (${r.guessed.length})`);
  for (const e of r.guessed) out.push(entryLine(e), ...guessLines(e));
  out.push('');
  out.push(`excluded: test ${r.excluded.test}, implementation ${r.excluded.implementation}, constructor ${r.excluded.constructor}, entry ${r.excluded.entry}`);
  out.push(`added symbols: ${r.added}`);
  if (r.preImageUnread > 0) {
    out.push(`pre-image unread: ${r.preImageUnread} file(s); their symbols were taken as added by changed line alone (every symbol, in a file git reported no changed lines for)`);
  }
  out.push('checked: functions, methods and types; variables, constants and fields are not (their reads are under-edged)');
  return `${out.join('\n')}\n`;
}

/** The JSON report: range, added count, lists, exclusions and unread-file counts, in fixed order. */
export function jsonReport(r: OrphansOutput): string {
  return JSON.stringify({
    basis: r.basis,
    mergeBase: r.mergeBase,
    added: r.added,
    orphans: r.orphans,
    guessed: r.guessed.map((g) => ({
      ...g,
      edges: g.edges.slice(0, JSON_EVIDENCE_CAP),
      unresolved: g.unresolved.slice(0, JSON_EVIDENCE_CAP),
      mentions: g.mentions.slice(0, JSON_EVIDENCE_CAP),
    })),
    excluded: r.excluded,
    preImageUnread: r.preImageUnread,
    searchUnread: r.searchUnread,
  }, null, 2);
}
