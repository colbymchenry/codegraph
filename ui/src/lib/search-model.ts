/**
 * What the search palette decides, without a browser.
 *
 * The panel under the input is a flat keyboard list drawn as groups: ↑/↓ walk
 * every row in ranked order, and the group headers are captions on top of that
 * order rather than a second axis to navigate. So the model here is one
 * function — {@link buildPalette} — that turns whatever the palette has (a
 * search answer, two of them for a flow question, or the entry points it shows
 * when the box is empty) into `sections` for rendering and `items` for the
 * keyboard, with `items` being exactly the concatenation of the sections' rows.
 *
 * Tested in `__tests__/ui-search-model.test.ts`.
 */

import type {
  WireEntryPoints,
  WireNodeRef,
  WireSearch,
  WireSearchResult,
} from './api';
import { matchEntries, originLabel, type EntryRow } from './entry-model';
import { basename, plural } from './symbol-model';

/* ------------------------------------------------------------ flow query -- */

export interface FlowQuery {
  from: string;
  to: string;
}

/**
 * "how does X reach Y", "X -> Y", "X → Y".
 *
 * The parse drives two things: the palette's first row, which opens the Flow
 * strip for exactly this pair, and the search underneath it, which looks up
 * both endpoints rather than searching the whole sentence (which matches
 * nothing). Both are useful — the flow answers the question, the endpoints let
 * a reader who spelled a name wrong see what they actually named.
 */
const FLOW_SENTENCE =
  /^\s*(?:how\s+(?:does|do|would|can)\s+)?([\w$.]+)\s+(?:reach|reaches|call|calls|hit|hits|get\s+to|end\s+up\s+(?:in|at))\s+([\w$.]+)\s*\??\s*$/i;
const FLOW_ARROW = /^\s*([\w$.]+)\s*(?:->|→|=>)\s*([\w$.]+)\s*\??\s*$/;

/** The last dotted segment: `Service.load` asks about `load`. */
function lastSegment(name: string): string {
  const cut = name.lastIndexOf('.');
  return cut < 0 ? name : name.slice(cut + 1);
}

export function parseFlowQuery(query: string): FlowQuery | null {
  const match = FLOW_SENTENCE.exec(query) ?? FLOW_ARROW.exec(query);
  if (!match) return null;
  const from = lastSegment(match[1] as string);
  const to = lastSegment(match[2] as string);
  if (!from || !to || from === to) return null;
  return { from, to };
}

/* ----------------------------------------------------------------- rows -- */

export type PaletteItem =
  | { type: 'symbol'; id: string; node: WireNodeRef; name: string; meta: string; location: string }
  | { type: 'route'; id: string; url: string; handler: string; location: string; nodeId: string | null }
  | { type: 'flow'; id: string; from: string; to: string; name: string; meta: string; location: string }
  /**
   * An entry point that mentions what was typed. It carries the panel's own
   * row, so a route here names its HANDLER — which is the thing a `/api/search`
   * hit on the same URL cannot do.
   */
  | { type: 'entry'; id: string; row: EntryRow; name: string; meta: string; location: string };

export interface PaletteSection {
  /** Sentence-case caption, e.g. "Methods", "Files that run something". */
  title: string;
  /** A second line under the caption, when the group needs explaining. */
  note?: string;
  items: PaletteItem[];
}

export interface Palette {
  sections: PaletteSection[];
  /** Every row, in the order ↑/↓ walks them. */
  items: PaletteItem[];
  /** A sentence above the sections — the flow-question note, when there is one. */
  hint: string | null;
  /** Nothing to show, and why. Null when there is something. */
  empty: string | null;
}

/** Plural caption for a kind bucket: "Methods", "Type aliases", "Files". */
export function kindGroupTitle(kind: string, count: number): string {
  const word = kind.replace(/_/g, ' ');
  const many = word.endsWith('s') ? `${word}es` : `${word}s`;
  const title = count === 1 ? word : many;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/**
 * `tools.ts:412` — where the symbol is, short enough for the right column.
 *
 * A file's location is its DIRECTORY, because its name column is already the
 * basename: printing the path twice tells a reader nothing and pushes the row
 * past the panel's width on any deeply-nested file.
 */
export function locationOf(node: WireNodeRef): string {
  if (node.kind !== 'file') return `${basename(node.file)}:${node.line}`;
  const cut = node.file.lastIndexOf('/');
  return cut < 0 ? 'project root' : node.file.slice(0, cut);
}

function symbolItem(node: WireNodeRef, meta = ''): PaletteItem {
  return {
    type: 'symbol',
    id: node.id,
    node,
    name: node.kind === 'file' ? basename(node.file) : node.name,
    meta: meta || signatureOf(node),
    location: locationOf(node),
  };
}

/** The signature, trimmed to something that fits one row. */
function signatureOf(node: WireNodeRef): string {
  if (!node.signature) return '';
  const oneLine = node.signature.replace(/\s+/g, ' ').trim();
  return oneLine.length > 72 ? `${oneLine.slice(0, 71)}…` : oneLine;
}

/* --------------------------------------------------------------- search -- */

/**
 * Interleave two answers, keeping each one's rank.
 *
 * A flow question names two symbols and both matter equally, so taking the
 * first of each before the second of either is the only merge that does not
 * quietly rank one endpoint above the other. Duplicates (a symbol that matched
 * both halves) keep their earliest position.
 */
export function interleaveResults(
  a: readonly WireSearchResult[],
  b: readonly WireSearchResult[]
): WireSearchResult[] {
  const merged: WireSearchResult[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    for (const list of [a, b]) {
      const item = list[i];
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }
  }
  return merged;
}

/**
 * Group results by kind, a group appearing where its best result did.
 *
 * The same rule the server uses, re-applied here because a flow question merges
 * two answers and the merged order is not the order either of them shipped.
 */
export function groupByKind(results: readonly WireSearchResult[]): PaletteSection[] {
  const sections: PaletteSection[] = [];
  const byKind = new Map<string, PaletteSection>();
  for (const result of results) {
    let section = byKind.get(result.kind);
    if (!section) {
      section = { title: '', items: [] };
      byKind.set(result.kind, section);
      sections.push(section);
    }
    section.items.push(symbolItem(result));
  }
  for (const [kind, section] of byKind) section.title = kindGroupTitle(kind, section.items.length);
  return sections;
}

export function buildSearchPalette(
  answers: readonly WireSearch[],
  flow: FlowQuery | null,
  entryOpts: { entries: WireEntryPoints | null; query: string; entryRows: number } | null = null
): Palette {
  const results =
    answers.length > 1
      ? interleaveResults(answers[0]?.results.items ?? [], answers[1]?.results.items ?? [])
      : answers[0]?.results.items ?? [];

  const sections = groupByKind(results);
  // The flow row goes FIRST, so Enter opens the path: someone who typed
  // "how does X reach Y" asked for the path, not for a list of symbols.
  if (flow) {
    sections.unshift({
      title: 'Flow',
      note: 'The call path between them, one card per hop.',
      items: [
        {
          type: 'flow',
          id: `flow:${flow.from}:${flow.to}`,
          from: flow.from,
          to: flow.to,
          name: `${flow.from} → ${flow.to}`,
          meta: '',
          location: 'read as a flow',
        },
      ],
    });
  }
  // Entry points come LAST, under their own heading: they are context on rows
  // the search above may already have found, and putting context above matches
  // would push what was actually asked for off the panel. Rows whose target is
  // already in the results are dropped — the same symbol twice under two
  // headings makes the panel look like it is guessing.
  if (entryOpts) {
    const seen = new Set(results.map((result) => result.id));
    const matches = matchEntries(entryOpts.entries, entryOpts.query, entryOpts.entryRows).filter(
      (match) => !(match.row.target?.type === 'symbol' && seen.has(match.row.target.id))
    );
    if (matches.length > 0) {
      sections.push({
        title: 'Entry points',
        note: 'Where a flow starts — routes, files that run something, tests.',
        items: matches.map(({ row, origin }) => ({
          type: 'entry' as const,
          id: `entry:${row.id}`,
          row,
          name: row.method ? `${row.method} ${row.name}` : row.name,
          meta: row.meta,
          location: originLabel(origin),
        })),
      });
    }
  }

  const items = sections.flatMap((section) => section.items);

  const hint = flow
    ? `Reading the path from ${flow.from} to ${flow.to}. Below it, what each name matches.`
    : null;

  return {
    sections,
    items,
    hint,
    empty: items.length === 0 ? 'No symbol or file in the index matches that.' : null,
  };
}

/* ---------------------------------------------------------- entry points -- */

/**
 * Where to start reading — the palette's resting state and the empty screen.
 *
 * The three sections say what they are derived from rather than asserting that
 * a file IS the entry point: "runs something at module level" is a fact about
 * the graph, "this is the main file" would be a guess.
 */
export function buildEntryPalette(
  entries: WireEntryPoints | null,
  opts: { perSection?: number } = {}
): Palette {
  if (!entries) return { sections: [], items: [], hint: null, empty: null };

  const cap = opts.perSection ?? Number.POSITIVE_INFINITY;
  const take = <T>(items: readonly T[]): T[] =>
    Number.isFinite(cap) ? items.slice(0, cap) : [...items];
  const sections: PaletteSection[] = [];

  if (entries.routes.routed && entries.routes.items.items.length > 0) {
    sections.push({
      title: 'Routes',
      note: entries.routes.items.items.every((r) => !r.method)
        ? 'A screen of the app.'
        : 'A request from outside arrives here.',
      items: take(entries.routes.items.items).map((route) => ({
        type: 'route' as const,
        id: `route:${route.routeId}`,
        url: route.url,
        handler: route.handler,
        location: `${basename(route.file)}:${route.line}`,
        nodeId: route.handlerId,
      })),
    });
  }

  if (entries.files.items.length > 0) {
    sections.push({
      title: 'Files that run something',
      note: 'Statements at the top level of the file — a CLI, a worker entry, a script.',
      items: take(entries.files.items).map((file) =>
        symbolItem(file, `${plural(file.calls, 'call')} at module level · reaches ${plural(file.reaches, 'file')}`)
      ),
    });
  }

  if (entries.tests.items.length > 0) {
    sections.push({
      title: 'Tests',
      note: 'What already exercises this code, widest reach first.',
      items: take(entries.tests.items).map((test) =>
        symbolItem(test, `exercises ${plural(test.reaches, 'file')}`)
      ),
    });
  }

  if (entries.hubs.items.length > 0) {
    sections.push({
      title: 'Most depended on',
      note: 'The symbols a change radiates furthest from.',
      items: take(entries.hubs.items).map((hub) =>
        symbolItem(hub, `${plural(hub.dependents, 'dependent')}`)
      ),
    });
  }

  return {
    sections,
    items: sections.flatMap((section) => section.items),
    hint: null,
    empty:
      sections.length === 0
        ? 'This index has no routes, no file that runs anything, no test that reaches outside itself, and nothing depended on yet.'
        : null,
  };
}

/* ------------------------------------------------------------- keyboard -- */

/** Wrap-around ↑/↓ over the flat item list. */
export function moveSelection(index: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (((index + delta) % length) + length) % length;
}
