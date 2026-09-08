/**
 * The wire shapes of the graph API — types only, no runtime.
 *
 * These mirror the server's payloads (`src/ui-server/api/`, CG-42) rather than
 * re-deriving them: the API is versioned with the binary that serves it, so a
 * field the server stopped sending should break the type-check here, not
 * surface as `undefined` in a rail three screens later.
 *
 * They are also the vocabulary of {@link GraphAdapter} (`adapter.ts`): a host
 * embedding these components answers in exactly these shapes, whether it is
 * reading them over HTTP from `codegraph ui` or building them in-process from
 * its own engine. Keeping them in a file with no imports and no side effects is
 * what lets a host depend on the vocabulary without pulling in the transport.
 */

import type { WireHighlight } from './highlight';

/* ---------------------------------------------------------------- shapes -- */

export type NodeKind = string;
export type EdgeKind = string;

export interface WireNodeRef {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  /** Project-relative, forward slashes on every platform. */
  file: string;
  line: number;
  endLine: number;
  language: string;
  signature?: string;
  exported?: boolean;
  /** Lives in a file that looks like test or fixture code. */
  test: boolean;
  /**
   * Lives in a tool-generated file, so the row draws in ink-4. Optional: only
   * the endpoints that show it pay for the lookup, so `undefined` means "not
   * asked", never "no".
   */
  generated?: boolean;
}

export interface WireNodeDetail extends WireNodeRef {
  startColumn: number;
  endColumn: number;
  docstring?: string;
  visibility?: string;
  async?: boolean;
  static?: boolean;
  abstract?: boolean;
  decorators?: string[];
  typeParameters?: string[];
  returnType?: string;
  lines: number;
}

export interface WireMember extends WireNodeRef {
  parentId: string;
  /** 1 = a direct member; 2 = a member of a member (a method inside a file's class). */
  depth: number;
  fanIn: number;
  fanOut: number;
  /** This member redeclares one an ancestor type declares. */
  overrides?: WireOverride;
}

/** How a subtype is tied to the type above it. */
export type WireHierarchyRelation = 'extends' | 'implements';

/** A member that redeclares an ancestor's — a name match inside a linked chain. */
export interface WireOverride {
  baseId: string;
  baseTypeId: string;
  baseTypeName: string;
  relation: WireHierarchyRelation;
}

/** One type in the hierarchy tree, and the single edge that puts it there. */
export interface WireHierarchyNode extends WireNodeRef {
  /** Steps from the focus, in whichever direction the row sits. 1 = direct. */
  depth: number;
  /** The row this one hangs off — the focus's id at depth 1. */
  parentId: string;
  relation: WireHierarchyRelation;
  /** Synthesized rather than parsed (Go's implicit interface satisfaction). */
  synthesized: boolean;
  via?: string;
  registeredAt?: string;
  /** Direct subtypes of this row that are NOT in the payload. */
  hiddenSubtypes: number;
}

/** Ancestors up, subtypes down, and the fan an interface call dispatches into. */
export interface WireHierarchy {
  ancestors: WireList<WireHierarchyNode>;
  descendants: WireList<WireHierarchyNode>;
  /** True number of DIRECT subtypes, whatever `descendants` was capped to. */
  direct: number;
  /** Of `direct`, the ones tied by `implements`. */
  implementers: number;
  /** Subtypes exist below what the walk returned. */
  bounded: boolean;
  /** A call through this type dispatches at runtime rather than to one target. */
  polymorphic: boolean;
}

export interface WireEdge {
  kind: EdgeKind;
  line?: number;
  col?: number;
  confidence?: number;
  resolvedBy?: string;
  provenance?: string;
  synthesizedBy?: string;
  via?: string;
  registeredAt?: string;
  valueRef?: boolean;
  /** Branch conditions the call site runs under — `!isUploading && isCollected`. */
  when?: string;
}

/** Every edge between the focal symbol and ONE other symbol, as a single row. */
export interface WireRelation {
  node: WireNodeRef;
  edgeKinds: EdgeKind[];
  edges: WireEdge[];
  edgeCount: number;
  /** Distinct call-site lines, ascending — what the gutter ports anchor to. */
  lines: number[];
  confidence: number | null;
  uncertain: boolean;
  synthesized: boolean;
  fanIn?: number;
  hub?: boolean;
}

export interface WireList<T> {
  total: number;
  shown: number;
  truncated: boolean;
  items: T[];
}

export interface WireTestSummary {
  reached: boolean;
  hops: number | null;
  fileCount: number;
  files: string[];
  /** False weakens the claim to "no test calls this directly" — see the server. */
  exhaustive: boolean;
  hopsSearched: number;
}

export interface WireOutsideIndex {
  total: number;
  byKind: Record<string, number>;
  samples: Array<{ name: string; kind: string; line?: number; col?: number }>;
}

export interface WireBlastSummary {
  direct: number;
  withinHops: number;
  hops: number;
  files: number;
  testFiles: number;
  routes: number;
  topFiles: Array<{ file: string; symbols: number; test: boolean }>;
}

export interface WireSymbolPayload {
  node: WireNodeDetail;
  /** Outermost first: file, then module/class, then the symbol's own parent. */
  ancestors: WireNodeRef[];
  members: WireList<WireMember>;
  /** The type-hierarchy block. `null` for anything that is not a type, and for a type with none. */
  hierarchy: WireHierarchy | null;
  incoming: WireList<WireRelation>;
  outgoing: WireList<WireRelation>;
  typesUsed: WireRelation[];
  counts: {
    callers: number;
    callees: number;
    typesUsed: number;
    fanIn: number;
    fanOut: number;
    members: number;
    hub: boolean;
  };
  tests: WireTestSummary;
  outsideIndex: WireOutsideIndex;
  blast: WireBlastSummary | null;
  /** The file changed on disk since the index — line ranges may be shifted. */
  drift: boolean;
}

export interface WireSource {
  file: string;
  language: string;
  drift: boolean;
  /**
   * Which numbering `lines` belong to. `'indexed'` — the file matches the
   * index. `'current'` — it drifted and we asked for the bytes anyway
   * (`ondrift: 'current'`), so nothing the graph holds about this file lines up
   * with them. `'none'` — it drifted and no slice came back.
   */
  showing: 'indexed' | 'current' | 'none';
  contentHash: string;
  indexedAt: number;
  generated: boolean;
  totalLines: number | null;
  from?: number;
  to?: number;
  /** Absent when the file drifted and `ondrift` was left at its default. */
  lines?: string[];
  truncated?: boolean;
  reason?: string;
  /**
   * The same lines, classified by the server's tree-sitter parse — one entry
   * per line, each a list of `[classId, text]` pairs indexed into `classes`.
   * Absent whenever `lines` is, and `engine: 'plain'` whenever no grammar
   * covers the file. See `lib/highlight.ts`.
   */
  highlight?: WireHighlight;
}

/* ------------------------------------------------------------- file view -- */

/** A row in the file outline — a symbol, its nesting and its edge counts. */
export interface WireOutlineEntry extends WireNodeRef {
  /** Containing symbol within this file, or null for a top-level one. */
  parentId: string | null;
  /** Nesting depth from the top level of the file, starting at 0. */
  depth: number;
  fanIn: number;
  fanOut: number;
}

/** One file at the far end of an import rail, with the symbols the edges name. */
export interface WireImportRow {
  file: string;
  test: boolean;
  symbols: Array<{ id: string; name: string; kind: string; line: number }>;
  symbolCount: number;
}

export interface WireFilePayload {
  file: {
    path: string;
    language: string;
    size: number;
    modifiedAt: number;
    indexedAt: number;
    contentHash: string;
    nodeCount: number;
    generated: boolean;
    test: boolean;
    errors: string[];
    /** The file node's own id, so the viewer can open the file AS a symbol. */
    id: string | null;
  };
  /** Calls made outside every definition — module-level code. */
  topLevel: { calls: number };
  /** The file changed on disk since it was indexed; the outline's lines shifted. */
  drift: boolean;
  outline: WireList<WireOutlineEntry>;
  /** `imports` edges only — a subset of `dependencies`, with symbol names. */
  imports: WireList<WireImportRow>;
  importedBy: WireList<WireImportRow>;
  /** Import statements that resolved to nothing indexed: packages, builtins. */
  unresolvedImports: Array<{ name: string; line: number }>;
  /** Every file this one reaches by any cross-file edge — `getFileDependencies`. */
  dependencies: string[];
  /** Every file that reaches into this one — `getFileDependents`. */
  dependents: string[];
}

/* ------------------------------------------------ whole-file source view -- */

/** A reference the resolver never landed: a gutter port with no destination. */
export interface WireFileOutsideRef {
  line: number;
  col: number;
  name: string;
  kind: string;
}

/** Every edge from ONE symbol in a file to ONE symbol anywhere. */
export interface WireFileCall {
  /** The symbol making the calls — the file node itself for top-level code. */
  ownerId: string;
  ownerLine: number;
  relation: WireRelation;
}

export interface WireFileCodePayload {
  file: {
    path: string;
    language: string;
    size: number;
    indexedAt: number;
    contentHash: string;
    generated: boolean;
    test: boolean;
    errors: string[];
    id: string | null;
    /** Lines on disk now — the height of the scrolling document. */
    totalLines: number | null;
  };
  drift: boolean;
  reason?: string;
  outline: WireList<WireOutlineEntry>;
  calls: WireList<WireFileCall>;
  outside: WireList<WireFileOutsideRef>;
  /** Calls landing on a definition in this same file — the arc diagram's total. */
  intraFileCalls: number;
  timing: { elapsedMs: number };
}

export interface WireBlastScale {
  maxDirect: number;
  maxWithinHops: number;
  hops: number;
  sampled: number;
  estimated: boolean;
}

/* ------------------------------------------------------- search palette -- */

/** How a result's text matched the query — the server's primary sort key. */
export type MatchKind = 'exact' | 'prefix' | 'substring' | 'qualified' | 'file' | 'related';

export interface WireSearchResult extends WireNodeRef {
  matchKind: MatchKind;
}

export interface WireSearchGroup {
  kind: NodeKind;
  count: number;
  items: WireSearchResult[];
}

export interface WireSearch {
  query: string;
  /** The free-text part, with any `kind:` / `lang:` / `path:` filters removed. */
  text: string;
  filters: { kinds: string[]; languages: string[]; paths: string[]; names: string[] };
  results: WireList<WireSearchResult>;
  /** Kind buckets in ranked order — flattening them reproduces the ranking. */
  groups: WireSearchGroup[];
}

export interface WireNodeRefs {
  items: WireNodeRef[];
  /** Ids that name nothing in this index — a stale link, not an error. */
  missing: string[];
}

/* --------------------------------------------------------------- routes -- */

/** One row of the URL -> handler map (`/api/routes`). */
export interface WireRoute {
  /** The route node's name, verbatim: "POST /v1/users/{id}". */
  url: string;
  /** The verb, when the name leads with one. Null for a file-routed page. */
  method: string | null;
  /** The URL without the verb — the same string as `url` when there is none. */
  path: string;
  handler: string;
  handlerKind: string;
  /** Where the request is SERVED. */
  file: string;
  line: number;
  handlerId: string | null;
  /** Where the URL is REGISTERED — the router file, which is how routes group. */
  routeFile: string;
  routeLine: number;
  routeId: string;
}

export interface WireRoutes {
  routed: boolean;
  /** Every URL the index holds, whether or not its handler resolved. */
  routeCount: number;
  /** Rows in `entries` — the ones whose handler the manifest could name. */
  shown: number;
  truncated: boolean;
  topHandlerFile: string | null;
  topHandlerFileCount: number;
  entries: WireRoute[];
}

/* ---------------------------------------------------------- entry points -- */

export interface WireEntryRoute {
  /** The route node's name, verbatim: "POST /v1/users/{id}". */
  url: string;
  /** The verb, when the name leads with one. Null for a file-routed page. */
  method: string | null;
  /** The URL without the verb — the same string as `url` when there is none. */
  path: string;
  handler: string;
  handlerKind: string;
  /** Where the request is SERVED. */
  file: string;
  line: number;
  handlerId: string | null;
  /** Where the URL is REGISTERED — the router file, which is how routes group. */
  routeFile: string;
  routeLine: number;
  routeId: string;
}

export interface WireEntryFile extends WireNodeRef {
  /** Calls and instantiations made at the top level of the file. */
  calls: number;
  /** Distinct other files this one's symbols reach. */
  reaches: number;
  /** Other files reaching into this one. Zero means nothing imports it. */
  dependents: number;
}

export interface WireEntryHub extends WireNodeRef {
  dependents: number;
}

export interface WireEntryTest extends WireNodeRef {
  /** Distinct other files this test reaches — what it exercises. */
  reaches: number;
  /** References behind that reach. */
  refs: number;
}

export interface WireEntryPoints {
  /** Frameworks the resolver detected — named in the Routes header. */
  frameworks: string[];
  routes: {
    routed: boolean;
    /** Every `route` node in the graph, resolved handler or not. */
    routeCount: number;
    items: WireList<WireEntryRoute>;
  };
  /** `total` is a floor on `files` and `hubs`; on `tests` it is exact. */
  files: WireList<WireEntryFile>;
  tests: WireList<WireEntryTest>;
  hubs: WireList<WireEntryHub>;
  index: { lastIndexedAt: number | null; files: number };
  timing: { elapsedMs: number; cached: boolean };
}

export interface WireStats {
  project: { root: string; name: string };
  index: {
    state: string | null;
    lastIndexedAt: number | null;
    stale: boolean;
    version: string | null;
    extractionVersion: number | null;
    backend: string;
    journalMode: string;
    pendingReferences: number;
    generatedFiles: number;
    watching: boolean;
    watcherDegraded: boolean;
  };
  graph: {
    nodes: number;
    edges: number;
    files: number;
    nodesByKind: Record<string, number>;
    edgesByKind: Record<string, number>;
    filesByLanguage: Record<string, number>;
    dbSizeBytes: number;
    walSizeBytes: number;
  };
  frameworks: string[];
  thresholds: { hub: number; uncertainBelow: number };
  blastScale: WireBlastScale;
}

/* ------------------------------------------------------------- flow strip -- */

export interface WireFlowEdge extends WireEdge {
  /** The link's label: "calls", "via callback · registered at file:line". */
  label: string;
  /** This hop reads callee → caller — the reader stepped UP into it. */
  upward: boolean;
  /** Confidence below 0.6: the link is dashed `2 3`. */
  uncertain: boolean;
  /** A synthesized dynamic-dispatch bridge: dashed `5 3`. */
  synthesized: boolean;
}

export interface WireFlowSource {
  file: string;
  language: string;
  from: number;
  to: number;
  /** Absent when `drift` — a mis-sliced window is worse than an empty card. */
  lines?: string[];
  highlight?: WireHighlight;
  drift: boolean;
  reason?: string;
}

/** The call site a card is opened at — the identifier drawn as an accent link. */
export interface WireFlowCallRef {
  line: number;
  col: number | null;
  name: string;
  targetId: string;
  /** The link points back at the previous card, not on to the next one. */
  backwards: boolean;
}

export interface WireFlowHop {
  node: WireNodeRef;
  /** The edge from the PREVIOUS hop into this one; null on the first. */
  edge: WireFlowEdge | null;
  callRef: WireFlowCallRef | null;
  source: WireFlowSource | null;
}

/** One plausible runtime target of a keyed dispatch — a clickable cap row. */
export interface WireBoundaryCandidate {
  node: WireNodeRef;
  display: string;
  named: boolean;
}

/** A dynamic-dispatch site: the form, the key when it is visible, the targets. */
export interface WireBoundarySite {
  form: string;
  label: string;
  snippet: string;
  line: number;
  key: string | null;
  keyIsType: boolean;
  moreSites: number;
  candidates: WireBoundaryCandidate[];
  candidateNote: string | null;
}

export interface WireFlowContinuation {
  node: WireNodeRef;
  line: number | null;
  confidence: number | null;
}

/** Where the graph stops — the strip's end cap (design spec §3.5). */
export interface WireFlowBoundary {
  node: WireNodeRef;
  sites: WireBoundarySite[];
  uncertain: WireList<WireFlowContinuation>;
  further: WireList<WireFlowContinuation>;
  missed: WireNodeRef[];
}

export interface WireFlow {
  id: string;
  /** "execute → rowToFileRecord", for the header's flow picker. */
  label: string;
  hops: WireFlowHop[];
  /** Null on a flow that reaches everything it was asked about. */
  boundary: WireFlowBoundary | null;
  /** One card at the dispatch site, not a path: the answer ran out here. */
  partial: boolean;
}

export interface WireFlowAmbiguity {
  token: string;
  chosen: WireNodeRef | null;
  others: WireNodeRef[];
}

export interface WireFlowPayload {
  query: {
    kind: 'directed' | 'symbols' | 'trail';
    from: string | null;
    to: string | null;
    symbols: string[];
  };
  flows: WireFlow[];
  ambiguous: WireFlowAmbiguity[];
  /** Tokens that named nothing in this index. */
  unresolved: string[];
  /** Why there is no flow, when there is none. */
  reason: string | null;
  index: { lastIndexedAt: number | null; edges: number; files: number };
  timing: { elapsedMs: number };
}

/* -------------------------------------------------------------- the map -- */

export interface WireMapModule {
  /** Directory path, the `(root files)` bucket, or a façade file's own path. */
  id: string;
  label: string;
  files: number;
  symbols: number;
  languages: Array<{ language: string; files: number }>;
  /** More than half its files are tests. */
  test: boolean;
  /** How many of its files are tool-generated. All of them → drawn in ink-4. */
  generated: number;
  /** Which of `fileList.items` are generated, so a row in the panel can dim too. */
  generatedFiles: string[];
  /** A single file kept out of the root bucket because it is the façade. */
  facade: boolean;
  /** Its files, capped — the side panel's list when the module is selected. */
  fileList: { total: number; shown: number; truncated: boolean; items: string[] };
}

export interface WireMapLink {
  source: string;
  target: string;
  /** Every confident cross-module edge behind this link. */
  count: number;
  /**
   * The subset resolved through an import, a qualified name, an inheritance
   * clause or a typed receiver — what the layering trusts.
   */
  declared: number;
  byKind: Array<{ kind: EdgeKind; count: number }>;
  topPairs: Array<{ from: string; to: string; count: number; declared: number }>;
}

export interface WireMapCycle {
  size: number;
  files: string[];
  modules: string[];
}

export interface WireMapPayload {
  root: string;
  depth: number;
  roots: Array<{ root: string; label: string; files: number }>;
  modules: WireMapModule[];
  links: WireMapLink[];
  cycles: { total: number; shown: number; truncated: boolean; items: WireMapCycle[] };
  excluded: { uncertainEdges: number; confidenceBelow: number };
  index: { lastIndexedAt: number | null; edges: number; files: number };
  timing: { elapsedMs: number; cached: boolean };
}

/* ---------------------------------------------------------------- screens -- */

export interface WireScreen {
  id: string;
  path: string;
  file: string;
  line: number;
  component: WireNodeRef | null;
  incoming: number;
  outgoing: number;
}

export interface WireScreenOrigin {
  id: string;
  node: WireNodeRef;
  outgoing: number;
  /** Shared chrome: how many screens render it. */
  sharedBy?: number;
}

export interface WireScreenSite {
  file: string;
  line: number;
  href: string;
  method: string;
  /** The conditions THIS site runs under (the whole chain's plus its own); '' when unconditional. */
  when: string;
}

export interface WireScreenLink {
  id: string;
  from: string;
  to: string;
  fromOrigin: boolean;
  via: WireNodeRef[];
  when: string;
  sites: WireScreenSite[];
  synthesized: boolean;
}

export interface WireScreensPayload {
  routed: boolean;
  entry: string | null;
  screens: WireScreen[];
  origins: WireScreenOrigin[];
  links: WireScreenLink[];
  dropped: number;
  index: { lastIndexedAt: number | null; edges: number; files: number };
  timing: { elapsedMs: number };
}

/* ------------------------------------------------------------------ steps -- */

export type WireStepKind = 'anchor' | 'screen' | 'trigger' | 'bridge' | 'event' | 'store' | 'effect';

export type WireStepLinkKind = 'calls' | 'navigates' | 'handler' | 'bridge' | 'event' | 'store' | 'effect';

export interface WireStepSite {
  file: string;
  line: number;
  /** `push /capture`, `calls`, `client.post` — what the site does, in a word or two. */
  text: string;
  /** What the site passes, abbreviated (`'userEmail', values.email`); '' for none; absent when unreadable. */
  args?: string;
  /** The conditions THIS site runs under (the whole chain's); '' when unconditional. */
  when: string;
  /** What fires THIS site, when it differs from the link's first. */
  trigger?: WireStepTrigger;
  /** For a response site: the status code it sends, when literal. */
  status?: number;
  /**
   * The decision the site's INNERMOST condition belongs to, when one was
   * read. Two sites that agree on `branch` and disagree on `arm` are the two
   * ways of ONE fork — which a joined condition string can never say, however
   * exactly one reads as the other's negation.
   */
  decision?: WireStepDecision;
}

/** One arm of one decision, as the site that runs under it records it. */
export interface WireStepDecision {
  /** Where the branching construct starts (`line:column`) — the fork's identity. */
  branch: string;
  /** The decision as a reader says it, always positive: `await hasSeenWelcome(…)`. */
  on: string;
  /** THIS arm's own condition — an `if` and its `else` differ here and nowhere else. */
  arm: string;
  form: 'if' | 'switch' | 'ternary' | 'try';
  /** The arm taken when the condition does NOT hold — the `else` side. */
  not?: true;
}

/** What fires a step or a link: the event it is written under, and the function that writes it there. */
export interface WireStepTrigger {
  /**
   * `prop` / `option` / `callback`: a binding at the call site (JSX attribute,
   * `on*` key, runs-later argument). `request`: the route a handler serves —
   * `name` the verb, `of` the path. `decorator`: a decorator on the handler —
   * `name` its name, `of` its literal argument (`@Process('email')`). `load`:
   * a page's own load-time work — `of` the page path.
   */
  kind: 'prop' | 'option' | 'callback' | 'request' | 'decorator' | 'load';
  /** `onPress`, `onSubmit`, `useEffect`, `addListener`, `POST`, `Process`. */
  name: string;
  /** `Button` for a prop, `useFormik` for an option, the first string argument for a callback; null when unknown. */
  of: string | null;
  /** The function the binding is written in. */
  in: string;
  /** What runs before it fires: the middleware / guard chain, in order (`authenticate`, `validate(…)`). */
  after?: string[];
}

export interface WireStep {
  /** The node's id, or `effect:<function id>:<api>` for a call leaving the index. */
  id: string;
  kind: WireStepKind;
  /** The step the picture starts from. A screen anchor keeps `kind: 'screen'`. */
  anchor: boolean;
  /** Null only for an effect, which is a call site rather than a symbol. */
  node: WireNodeRef | null;
  label: string;
  sub: string;
  /** Steps from the anchor: the row. */
  depth: number;
  /**
   * Why the walk did not go on from this step: a cap (`depth`, `fan-out`,
   * `folded`, `steps`), or `screen` — another screen, or an endpoint reached
   * across a tier, drawn as a boundary.
   */
  cut: 'depth' | 'fan-out' | 'folded' | 'steps' | 'screen' | 'component' | null;
  /** The event name a native event step arrived on — the first, when several land here. */
  event?: string;
  /** Every event that lands on this step. */
  events?: string[];
  /** For a handler: what fires it. */
  trigger?: WireStepTrigger;
  /** The step's place in its row, in the code's order (a hop written inside another site's arguments before that site). */
  order?: number;
  /**
   * A screen anchor's picture only: the region of the screen this step belongs
   * to — the top-level component (or hook) the walk first reached it through,
   * the screen's own component for the screen body. The viewer lays a screen's
   * picture out by these; absent, the rows are distance.
   */
  region?: { id: string; label: string };
  /**
   * For a screen or an endpoint — also a `bridge` step that is an endpoint
   * reached across a tier: its path and the symbol that serves it.
   * `endpoint` when the route leads with an HTTP verb; `inline` when the
   * handler is anonymous at the registration site (component is null).
   */
  screen?: { path: string; component: WireNodeRef | null; endpoint: boolean; inline: boolean };
  /**
   * The calls one function makes into one category, and the function. A
   * database call names its model / table and read vs write when the call
   * says; a response box lists the status codes its sites send.
   */
  effect?: {
    api: string;
    apis: string[];
    category: string;
    by: WireNodeRef;
    line: number;
    model?: string;
    access?: 'read' | 'write';
    statuses?: number[];
  };
}

export interface WireStepLink {
  id: string;
  from: string;
  to: string;
  kind: WireStepLinkKind;
  /** The symbols folded between the two steps, in order. */
  via: WireNodeRef[];
  /** Conditions along the whole chain, joined; '' when unconditional. */
  when: string;
  /** How the last hop was established when it was not a plain call. */
  label: string;
  /** The call the first hop is written inside the arguments of — `res.json` for a token signed while building the reply. */
  within?: string;
  synthesized: boolean;
  uncertain: boolean;
  sites: WireStepSite[];
  /** What fires the first site, when something binds it to an event. */
  trigger?: WireStepTrigger;
}

/* ------------------------------------------- the same walk, in the code's order -- */

/** How an arm of a fork leaves, when it does — the rail stops there. */
export type WireArmEnd = 'reply' | 'return' | 'throw' | 'exit';

export interface WireArm {
  /** This arm's own condition, in the words the rest of the view uses. */
  when: string;
  /** The arm taken when the fork's condition does NOT hold — the `else` side. */
  not?: true;
  /** How it leaves: it answers the request, returns, or throws. Null = it runs on. */
  ends: WireArmEnd | null;
  body: WireBlock;
}

export type WireBlock = WireItem[];

export type WireItem =
  /**
   * A step of the picture, where the code writes it. `body` is what it does,
   * when the walk entered it; `again` says it happens here too and was read
   * above — a function is read ONCE in a rail, however many times it is called.
   */
  | { kind: 'step'; step: string; link?: string; within?: string; body?: WireBlock; again?: true }
  /** A decision: `if` / `else`, a `switch`, a ternary, a `try`, or an early exit. */
  | { kind: 'fork'; on: string; form: 'if' | 'switch' | 'ternary' | 'try'; arms: WireArm[] }
  /**
   * A run of items that is not plain sequence: a helper drawn where it is
   * called (`inline`), a body that runs for each item (`loop`), work that runs
   * after this function returns (`later`), or calls started together
   * (`together`).
   */
  | {
      kind: 'block';
      block: 'inline' | 'loop' | 'later' | 'together';
      by?: string;
      /** For a loop: whether it runs once per item or while a condition holds. */
      loop?: 'each' | 'while';
      via?: WireNodeRef;
      within?: string;
      body: WireBlock;
      again?: true;
    }
  /** Where the reading stopped: a helper that calls itself, or a cap the walk hit. */
  | { kind: 'cut'; why: 'folded' | 'depth' };

export interface WireProgram {
  root: WireBlock;
  /** Items the reading could not place — a recursion or a cap it hit. */
  truncated: number;
}

export interface WireStepsPayload {
  anchor: WireNodeRef;
  /** Other symbols that share the anchor's name, when it was given by name. */
  ambiguous: WireNodeRef[];
  /** An `app` of screens, an `api` of endpoints, or a `web` app with both — the viewer's words follow it. */
  project: 'app' | 'api' | 'web';
  steps: WireStep[];
  links: WireStepLink[];
  /**
   * The same walk read in the code's ORDER — the anchor's body as a rail that
   * forks where the code forks. Null when the anchor has no body to read.
   */
  program: WireProgram | null;
  /** Which reading to open with; the URL's `view` overrides it. */
  defaultView: 'order' | 'tree';
  depth: number;
  limit: number;
  /** Screens reached from the anchor were entered rather than drawn as boundaries. */
  through: boolean;
  truncated: { steps: number; hubs: number; chrome: number };
  index: { lastIndexedAt: number | null; edges: number; files: number };
  timing: { elapsedMs: number };
}

/* -------------------------------------------------------------- dead code -- */

/** One symbol nothing in the index reaches. */
export interface WireDeadCodeRow extends WireNodeRef {
  /** Source lines it spans — the rank, and what deleting it would remove. */
  lines: number;
  /** Unreferenced members inside it: a dead class takes its methods with it. */
  members: WireList<WireNodeRef>;
}

/** The rows of one file, in source order. */
export interface WireDeadCodeGroup {
  file: string;
  /** Tool-generated — drawn dimmed wherever it appears. */
  generated: boolean;
  test: boolean;
  lines: number;
  rows: WireDeadCodeRow[];
}

/** One reason candidates were dropped, already worded for the screen. */
export interface WireDeadCodeExclusion {
  reason: string;
  count: number;
  label: string;
}

export interface WireDeadCode {
  rows: WireList<WireDeadCodeRow>;
  /** The SHOWN rows, grouped by file — group order follows the best row. */
  groups: WireDeadCodeGroup[];
  /** Symbols with no incoming reference at all, before any exclusion ran. */
  candidates: number;
  excluded: WireDeadCodeExclusion[];
  excludedTotal: number;
  kinds: string[];
  includeExported: boolean;
  includeTests: boolean;
  includeGenerated: boolean;
  bounded: boolean;
  /** Every row was checked against the text of the files that can reach it. */
  corroborated: boolean;
  timing: { elapsedMs: number };
}

/* ---------------------------------------------------------- saved trails -- */

/**
 * How a saved hop fared against the index as it is NOW.
 *
 * A trail is stored by qualified name rather than by node id (a node id
 * contains its start line, so any edit above a symbol renames it), and every
 * hop is re-resolved on the way out. This is what that re-resolution found.
 */
export type WireTrailHopStatus = 'ok' | 'moved' | 'ambiguous' | 'missing';

export interface WireTrailHop {
  dir: 'start' | 'down' | 'up';
  /** The name as it was when the trail was saved. */
  name: string;
  qualifiedName: string;
  kind: string;
  savedFile: string;
  savedLine: number;
  status: WireTrailHopStatus;
  /** The symbol's id NOW. Null when nothing answers to it any more. */
  id: string | null;
  file: string | null;
  line: number | null;
  /** Finished screen wording for a status that is not `ok`; null when it is. */
  note: string | null;
}

export interface WireTrail {
  id: string;
  name: string;
  note: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  hops: WireTrailHop[];
  /** Hops that still resolve to a symbol in this index. */
  resolved: number;
  /** Every hop resolved, and none of them moved. */
  intact: boolean;
  /**
   * The longest run of CONSECUTIVE resolved hops, as the `t` param. Null when
   * nothing in the trail resolves. Never stitched across a hole — the trail is
   * a path, and a fabricated adjacency is worse than a short one.
   */
  encoded: string | null;
  /** 1-based index of the first hop `encoded` carries. */
  openFrom: number;
  /** How many hops `encoded` carries. */
  openCount: number;
  /** The symbol the trail opens at — the last hop of that run. */
  openId: string | null;
}

export interface WireTrails {
  trails: WireTrail[];
  /** Writes are off. Save and Delete are hidden, and the screen says why. */
  readOnly: boolean;
  readOnlyReason: string | null;
  /** Project-relative directory the files live in. */
  directory: string;
  /** Files in that directory that were not readable trails. */
  skipped: number;
  bounded: boolean;
  /** The id just written, on the answer to a save. */
  saved?: string;
  /** That save replaced a trail of the same name. */
  replaced?: boolean;
  /** The id just removed, on the answer to a delete. */
  deleted?: string;
}
