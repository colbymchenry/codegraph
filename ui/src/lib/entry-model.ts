/**
 * What the entry-points panel decides, without a browser.
 *
 * `/api/entrypoints` answers four questions about where a project starts —
 * routes, files that run something, tests, hubs — as four flat ranked lists.
 * The panel draws them as file groups, because the first thing a reader wants
 * from twenty routes is *which router registers them*, and from twelve
 * executable files *which directory they live in*. That regrouping is the whole
 * of this module: it is presentation, it needs no round-trip, and it is a pure
 * function so it can be tested without a DOM.
 *
 * Two rules it keeps:
 *
 * - **A row that cannot be opened is not offered as if it could.** A route
 *   whose handler never resolved to a node still appears — "this URL exists and
 *   we could not place it" is true and worth saying — but it carries no target
 *   and the panel draws it as text.
 * - **A row only offers a flow if it names a callable symbol.** `/api/flow`
 *   searches the graph by NAME, and a file has no name the path finder can
 *   look up, so a "start a flow here" affordance on a file row would be a
 *   button that always fails.
 *
 * Tested in `__tests__/ui-entry-model.test.ts`.
 */

import type {
  WireEntryFile,
  WireEntryHub,
  WireEntryPoints,
  WireEntryRoute,
  WireEntryTest,
  WireList,
} from './api';
import { basename, plural } from './symbol-model';

/* ---------------------------------------------------------------- shapes -- */

/** Where a row goes when it is clicked. */
export type EntryTarget =
  | { type: 'symbol'; id: string; name: string; kind: string }
  | { type: 'file'; path: string }
  | null;

export interface EntryRow {
  /** Stable across refetches — the panel keys on it. */
  id: string;
  /** The row's own name column: a URL, a basename, a symbol name. */
  name: string;
  /** The verb, drawn ahead of the name in the same mono. Routes only. */
  method: string | null;
  /** One line under the name: handler + `file:line`, counts, what it reaches. */
  meta: string;
  /** Glyph kind — a NodeKind string, or 'route'. */
  kind: string;
  target: EntryTarget;
  /**
   * The symbol name a flow would start from, when this row names one.
   * Null on file rows: the path finder looks symbols up by name.
   */
  flowFrom: string | null;
  /** Hover text: the fuller truth the row had to shorten. */
  title: string;
}

export interface EntryGroup {
  /** The file or directory the rows share. */
  path: string;
  /** The file to open when the group heading is clicked, when there is one. */
  file: string | null;
  rows: EntryRow[];
}

export interface EntrySection {
  id: 'routes' | 'files' | 'tests' | 'hubs';
  title: string;
  /** The header's right-hand meta: counts, and the framework when detected. */
  meta: string;
  /** A sentence saying what the section is derived from. */
  note: string;
  groups: EntryGroup[];
  /** Rows drawn, and the real total behind them. */
  shown: number;
  total: number;
  /** `total` is a lower bound the server could not tighten. */
  floor: boolean;
}

export interface EntryPanel {
  sections: EntrySection[];
  /** Every row, in the order the sections draw them. */
  rows: EntryRow[];
  /** Nothing to show, and why. Null when there is something. */
  empty: string | null;
}

/* -------------------------------------------------------------- grouping -- */

/** `src/bin/codegraph.ts` -> `src/bin`; a root file -> `project root`. */
export function directoryOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? 'project root' : path.slice(0, cut);
}

/**
 * Fold rows into groups, first-seen order.
 *
 * First-seen rather than alphabetical, so the ranking the server computed is
 * still visible: the busiest router file, or the directory holding the highest
 * ranked executable, leads the section.
 */
export function groupRows(
  placed: ReadonlyArray<{ row: EntryRow; path: string; file: string | null }>
): EntryGroup[] {
  const groups: EntryGroup[] = [];
  const byPath = new Map<string, EntryGroup>();
  for (const { row, path, file } of placed) {
    let group = byPath.get(path);
    if (!group) {
      group = { path, file, rows: [] };
      byPath.set(path, group);
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

/* ------------------------------------------------------------------ rows -- */

export function routeRow(route: WireEntryRoute): EntryRow {
  const where = `${basename(route.file)}:${route.line}`;
  return {
    id: `route:${route.routeId}`,
    name: route.path,
    method: route.method,
    kind: 'route',
    // The handler is the answer to "what serves this URL", so it leads the
    // meta line; the file only says where to find it.
    meta: route.handlerId ? `${route.handler} · ${where}` : `${route.handler} · not in the index`,
    target: route.handlerId
      ? { type: 'symbol', id: route.handlerId, name: route.handler, kind: route.handlerKind }
      : null,
    flowFrom: route.handlerId ? route.handler : null,
    title: `${route.url} → ${route.handler} (${route.file}:${route.line}), registered at ${route.routeFile}:${route.routeLine}`,
  };
}

export function fileRow(file: WireEntryFile): EntryRow {
  return {
    id: `file:${file.file}`,
    name: basename(file.file),
    method: null,
    kind: 'file',
    meta: `${plural(file.calls, 'call')} at module level · reaches ${plural(file.reaches, 'file')}${
      file.dependents === 0 ? ' · nothing imports it' : ''
    }`,
    target: { type: 'file', path: file.file },
    flowFrom: null,
    title: file.file,
  };
}

export function testRow(test: WireEntryTest): EntryRow {
  return {
    id: `test:${test.file}`,
    name: basename(test.file),
    method: null,
    kind: 'file',
    meta: `exercises ${plural(test.reaches, 'file')} · ${plural(test.refs, 'reference')}`,
    target: { type: 'file', path: test.file },
    flowFrom: null,
    title: test.file,
  };
}

export function hubRow(hub: WireEntryHub): EntryRow {
  return {
    id: `hub:${hub.id}`,
    name: hub.name,
    method: null,
    kind: hub.kind,
    meta: `${plural(hub.dependents, 'dependent')} · ${basename(hub.file)}:${hub.line}`,
    target: { type: 'symbol', id: hub.id, name: hub.name, kind: hub.kind },
    flowFrom: hub.name,
    title: `${hub.qualifiedName} — ${hub.file}:${hub.line}`,
  };
}

/* ----------------------------------------------------------------- panel -- */

/** "42 of 208" when the list was cut, "42" when it was not. */
function countMeta(list: { shown: number; total: number }, floor: boolean): string {
  if (list.shown >= list.total) return `${list.shown}`;
  return `${list.shown} of ${floor ? 'at least ' : ''}${list.total}`;
}

/**
 * "gin", "express and spring" — the frameworks behind a route list.
 *
 * Named because a route list is a claim about a framework's conventions; a
 * reader who knows the app is Gin and sees "spring" learns something useful
 * about the index rather than being quietly misled by it.
 */
export function frameworkPhrase(frameworks: readonly string[]): string {
  if (frameworks.length === 0) return '';
  if (frameworks.length === 1) return frameworks[0] as string;
  if (frameworks.length === 2) return `${frameworks[0]} and ${frameworks[1]}`;
  return `${frameworks.slice(0, -1).join(', ')} and ${frameworks[frameworks.length - 1]}`;
}

function section(
  id: EntrySection['id'],
  title: string,
  note: string,
  list: WireList<unknown>,
  groups: EntryGroup[],
  floor: boolean,
  extraMeta = ''
): EntrySection {
  const counts = countMeta(list, floor);
  return {
    id,
    title,
    meta: extraMeta ? `${counts} · ${extraMeta}` : counts,
    note,
    groups,
    shown: list.shown,
    total: list.total,
    floor,
  };
}

export function buildEntryPanel(entries: WireEntryPoints | null): EntryPanel {
  if (!entries) return { sections: [], rows: [], empty: null };
  const sections: EntrySection[] = [];

  // A project with fewer than three resolvable routes is not a routed app, and
  // the engine says so rather than half-answering. No Routes heading at all in
  // that case — an empty box under a heading reads as a failure, and this is
  // the ordinary shape of a library.
  if (entries.routes.routed && entries.routes.items.items.length > 0) {
    sections.push(
      section(
        'routes',
        'Routes',
        entries.routes.items.items.every((r) => !r.method)
          ? 'A screen of the app — its path, and the component that renders it.'
          : 'A request from outside arrives here — the URL, and the symbol that serves it.',
        entries.routes.items,
        groupRows(
          entries.routes.items.items.map((route) => ({
            row: routeRow(route),
            // Grouped by where the URL is REGISTERED, not by where it is
            // served: a router file is the shape a reader already has in mind,
            // and handlers scatter across a package.
            path: route.routeFile,
            file: route.routeFile,
          }))
        ),
        false,
        frameworkPhrase(entries.frameworks)
      )
    );
  }

  if (entries.files.items.length > 0) {
    sections.push(
      section(
        'files',
        'Top-level files with calls',
        'Statements at the top level of the file — a CLI, a worker entry, a script.',
        entries.files,
        groupRows(
          entries.files.items.map((file) => ({
            row: fileRow(file),
            path: directoryOf(file.file),
            file: null,
          }))
        ),
        true
      )
    );
  }

  if (entries.tests.items.length > 0) {
    sections.push(
      section(
        'tests',
        'Tests',
        'What already exercises this code, widest reach first.',
        entries.tests,
        groupRows(
          entries.tests.items.map((test) => ({
            row: testRow(test),
            path: directoryOf(test.file),
            file: null,
          }))
        ),
        false
      )
    );
  }

  if (entries.hubs.items.length > 0) {
    sections.push(
      section(
        'hubs',
        'Most depended on',
        'Not where the project starts — where a change radiates furthest.',
        entries.hubs,
        groupRows(
          entries.hubs.items.map((hub) => ({
            row: hubRow(hub),
            path: hub.file,
            file: hub.file,
          }))
        ),
        true
      )
    );
  }

  return {
    sections,
    rows: sections.flatMap((s) => s.groups.flatMap((g) => g.rows)),
    empty:
      sections.length === 0
        ? 'This index has no routes, no file that runs anything at module level, no test that reaches outside itself, and nothing depended on yet.'
        : null,
  };
}

/* --------------------------------------------------------------- palette -- */

/** Entry-point rows the palette shows under a typed query, ranked and capped. */
export interface EntryMatch {
  row: EntryRow;
  /** Which list it came from, for the row's location column. */
  origin: 'route' | 'file' | 'test' | 'hub';
}

/**
 * Entry points that mention what was typed.
 *
 * The palette already searches the graph, and route nodes, files and symbols
 * all come back from that search — so what this adds is not the row but its
 * CONTEXT: a `/api/search` hit on `POST /v1/payroll/cycles/{cycleID}/run` is a
 * route node with no handler attached, and this one carries the handler, its
 * file and line, and a target that opens the code rather than the URL.
 *
 * Matching is a plain case-insensitive substring over the text the row draws.
 * Anything cleverer would rank differently from the search above it, and two
 * different rankings of the same words in one panel is how a palette stops
 * being predictable.
 */
export function matchEntries(
  entries: WireEntryPoints | null,
  query: string,
  limit: number
): EntryMatch[] {
  const needle = query.trim().toLowerCase();
  if (!entries || needle === '') return [];

  const pools: Array<[EntryMatch['origin'], EntryRow[]]> = [
    ['route', entries.routes.routed ? entries.routes.items.items.map(routeRow) : []],
    ['file', entries.files.items.map(fileRow)],
    ['test', entries.tests.items.map(testRow)],
    ['hub', entries.hubs.items.map(hubRow)],
  ];

  const matches: EntryMatch[] = [];
  for (const [origin, rows] of pools) {
    for (const row of rows) {
      if (matches.length >= limit) return matches;
      const haystack = `${row.method ?? ''} ${row.name} ${row.meta} ${row.title}`.toLowerCase();
      if (haystack.includes(needle)) matches.push({ row, origin });
    }
  }
  return matches;
}

/** The location column for a palette entry row — where it came from. */
export function originLabel(origin: EntryMatch['origin']): string {
  switch (origin) {
    case 'route':
      return 'route';
    case 'file':
      return 'runs at module level';
    case 'test':
      return 'test';
    case 'hub':
      return 'depended on';
  }
}

/* ------------------------------------------------------------------ flow -- */

/**
 * The href a flow between two named symbols opens at, or null when the pair is
 * not a question. Same name twice has no path to draw, and `/api/flow` refuses
 * it — better to disable the button than to navigate into a 400.
 */
export function flowPair(from: string, to: string): { from: string; to: string } | null {
  const a = from.trim();
  const b = to.trim();
  if (!a || !b || a.toLowerCase() === b.toLowerCase()) return null;
  return { from: a, to: b };
}
