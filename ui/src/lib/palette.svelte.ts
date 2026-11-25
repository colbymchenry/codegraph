/**
 * The search palette's live state.
 *
 * Everything that decides *what* is on screen lives in `search-model.ts` as
 * plain functions; this module only owns the parts that need time: the debounce
 * that keeps a fast typist from firing a request per keystroke, the abort that
 * throws away an answer to a query nobody is asking any more, and the selection
 * the ↑/↓ keys move.
 *
 * The entry points are fetched once and kept — they describe the index, not the
 * query — so the palette has something to show the instant it opens.
 */

import { fetchEntryPoints, fetchSearch, type WireEntryPoints, type WireSearch } from './api';
import {
  buildEntryPalette,
  buildSearchPalette,
  moveSelection,
  parseFlowQuery,
  type Palette,
  type PaletteItem,
} from './search-model';

/** Results asked of the server for one search. */
const SEARCH_LIMIT = 40;

/**
 * Entry-point rows fetched, and how many of them the palette shows.
 *
 * One fetch serves both readers: the palette wants a short list under the box,
 * the empty screen wants the long one. Fetching the long list and slicing is a
 * request saved and — more to the point — keeps the two lists in the same
 * order, which they would not be if they were two answers taken at two times.
 */
const ENTRY_LIMIT = 24;
export const PALETTE_ENTRY_ROWS = 6;

/**
 * Route rows fetched.
 *
 * Separate from `ENTRY_LIMIT` because routes are the one list whose useful
 * length is the project's, not the reader's: the panel groups them under their
 * router files, where two hundred rows are still navigable, while two hundred
 * "most depended on" symbols are a wall.
 */
const ENTRY_ROUTE_LIMIT = 200;

/** Entry-point rows the palette adds under a typed query. */
export const PALETTE_ENTRY_MATCHES = 6;

/**
 * Milliseconds of quiet before a query is sent.
 *
 * The server answers a search in single-digit milliseconds on this repo's own
 * index, so this is not about protecting it — it is about not showing three
 * different result sets while a word is still being typed.
 */
const DEBOUNCE_MS = 90;

let query = $state('');
let open = $state(false);
let selected = $state(0);
let loading = $state(false);
let failure = $state<string | null>(null);
let answers = $state<WireSearch[]>([]);
let entries = $state<WireEntryPoints | null>(null);
/** Null until the first attempt settles — the panel says "reading" until then. */
let entriesSettled = $state(false);
let entriesFailure = $state<string | null>(null);

let inflight: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Guards against an older answer landing after a newer one. */
let generation = 0;

let entriesInflight: Promise<void> | null = null;

function loadEntries(): Promise<void> {
  if (entriesInflight) return entriesInflight;
  entriesInflight = fetchEntryPoints({ limit: ENTRY_LIMIT, routes: ENTRY_ROUTE_LIMIT })
    .then((value) => {
      entries = value;
      entriesFailure = null;
    })
    .catch((cause: unknown) => {
      // The palette still works without them; a failed "where do I start"
      // should never stop someone from typing a name. The entry-points panel
      // is the one screen that has nothing else to show, so the reason is
      // kept rather than swallowed.
      entries = null;
      entriesFailure = cause instanceof Error ? cause.message : String(cause);
    })
    .finally(() => {
      entriesSettled = true;
    });
  return entriesInflight;
}

function cancel(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  inflight?.abort();
  inflight = null;
}

async function run(text: string, mine: number): Promise<void> {
  const flow = parseFlowQuery(text);
  const controller = new AbortController();
  inflight = controller;
  loading = true;
  try {
    const queries = flow ? [flow.from, flow.to] : [text];
    const results = await Promise.all(
      queries.map((q) => fetchSearch(q, { limit: SEARCH_LIMIT }, controller.signal))
    );
    if (mine !== generation) return;
    answers = results;
    failure = null;
  } catch (cause) {
    if (controller.signal.aborted || mine !== generation) return;
    answers = [];
    failure = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (mine === generation) loading = false;
  }
}

function schedule(text: string): void {
  cancel();
  const mine = (generation += 1);
  if (text.trim() === '') {
    answers = [];
    failure = null;
    loading = false;
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    void run(text, mine);
  }, DEBOUNCE_MS);
}

/** The palette as it should be drawn right now. */
function current(): Palette {
  if (query.trim() === '') return buildEntryPalette(entries, { perSection: PALETTE_ENTRY_ROWS });
  return buildSearchPalette(answers, parseFlowQuery(query), {
    entries,
    query,
    entryRows: PALETTE_ENTRY_MATCHES,
  });
}

export const palette = {
  get query(): string {
    return query;
  },
  set query(next: string) {
    if (next === query) return;
    query = next;
    selected = 0;
    schedule(next);
  },
  get open(): boolean {
    return open;
  },
  get loading(): boolean {
    return loading;
  },
  get failure(): string | null {
    return failure;
  },
  get view(): Palette {
    return current();
  },
  get selected(): number {
    return selected;
  },
  get selectedItem(): PaletteItem | null {
    const items = current().items;
    return items[Math.min(selected, items.length - 1)] ?? null;
  },
  /** True while a typed query has no answer yet — the panel says so. */
  get pending(): boolean {
    return query.trim() !== '' && (loading || timer !== null);
  },

  show(): void {
    open = true;
    void loadEntries();
  },
  hide(): void {
    open = false;
  },
  select(index: number): void {
    selected = index;
  },
  move(delta: number): void {
    selected = moveSelection(selected, delta, current().items.length);
  },
  /** Close and empty the box — what picking a result leaves behind. */
  reset(): void {
    cancel();
    generation += 1;
    query = '';
    answers = [];
    failure = null;
    loading = false;
    selected = 0;
    open = false;
  },
  /** Load the entry points without opening the panel (the empty screen wants them). */
  ensureEntries: loadEntries,
  /**
   * Ask again, because the index moved.
   *
   * Entry points describe the index, so they are fetched once and kept — which
   * means a sync would otherwise leave the resting palette, the empty screen
   * and the entry-points panel all describing the graph as it was.
   */
  reloadEntries(): Promise<void> {
    entriesInflight = null;
    return loadEntries();
  },
  get entries(): WireEntryPoints | null {
    return entries;
  },
  /** False until the first fetch settles, however it settled. */
  get entriesSettled(): boolean {
    return entriesSettled;
  },
  get entriesFailure(): string | null {
    return entriesFailure;
  },
};
