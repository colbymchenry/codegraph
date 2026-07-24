# Repository Topology UI V1

## Status

Proposed for the repository-documents V1 and implemented in the same change.

## Goals

Provide a local, read-only visual topology of the graph already stored by
CodeGraph, including source symbols, repository Markdown files, document
sections, and every relationship kind produced by the existing indexer.

The UI is a view over CodeGraph. It is not a second extraction pipeline and it
must not change, replace, aggregate, or reinterpret persisted relationships.

## Non-regression contract

Repository-document support is additive:

- every pre-existing node-kind numeric value remains unchanged;
- every pre-existing edge-kind numeric value remains unchanged;
- non-Markdown files continue through the existing tree-sitter/kernel
  extraction and resolution paths without a new filter or fallback;
- indexing or synchronizing Markdown must not delete or rewrite nodes or edges
  belonging to existing source files;
- the TypeScript and Rust native wire-kind tables must stay identical.

This contract is enforced by:

1. pinning the complete pre-document node-kind prefix and edge-kind table;
2. indexing a source-only repository, adding Markdown, synchronizing, and
   asserting that every original source node and edge still exists;
3. running the existing extraction/resolution suites;
4. compiling and testing the Rust kernel protocol.

## Service boundary

`codegraph ui [path]` opens the existing project synchronously and starts a
Node HTTP server. The default address is `http://127.0.0.1:7474`.

The server:

- reads through the public `CodeGraph` query surface;
- never initializes, indexes, synchronizes, watches, or writes a project;
- binds to loopback unless the caller explicitly supplies another host;
- serves only bundled static assets and JSON APIs;
- has no CDN or runtime network dependency;
- closes the graph connection on process termination.

The MCP stdio server remains unchanged. The topology server is a separate,
human-facing command so neither protocol owns the other process lifecycle.

## HTTP API

### `GET /api/graph`

Returns a deterministic, bounded topology snapshot:

- nodes ordered by graph degree, with repository file nodes preferred as
  stable topology anchors;
- all persisted edges whose source and target are both in the snapshot;
- whole-project statistics and a `truncated` flag;
- an optional comma-separated node-kind filter;
- a hard server-side node limit.

The limit protects browser memory; it is a presentation limit only. The
database and all graph relationships remain complete.

### `GET /api/search?q=...`

Uses CodeGraph's existing search implementation and returns a bounded list of
matching nodes. It does not maintain a second search index.

### `GET /api/node?id=...`

Returns one node plus a bounded first page of its persisted incoming and
outgoing edges, the full relationship counts, a truncation marker, and the
known endpoint nodes. This lets the UI inspect relationships that are outside
the initial bounded snapshot without an unbounded browser response.

### `GET /api/stats`

Returns the existing whole-project graph statistics.

## Front-end

The bundled front-end uses browser-native SVG and JavaScript. Its layout is a
deterministic repository topology:

- file nodes act as anchors;
- symbols and document sections cluster around their owning file;
- directed edges retain their persisted CodeGraph kind;
- pan and zoom operate locally in the browser.

The interaction model borrows the useful parts of Graphify's generated page:

- node search;
- kind legend and filtering;
- click-to-inspect details;
- clickable incoming and outgoing neighbors;
- visible node/edge/project counts.

Unlike Graphify's current HTML exporter, V1 does not load `vis-network` from a
public CDN, so an offline CodeGraph installation remains fully local.

## Security

- Dynamic graph content is rendered with DOM text nodes, not injected HTML.
- Responses set a same-origin Content Security Policy and disable MIME
  sniffing.
- Static paths are an allow-list, not filesystem-derived request paths.
- API query lengths, result sizes, node limits, and node-kind values are
  validated and bounded.
- There is no source-file content endpoint in V1.

## Acceptance criteria

1. `codegraph ui` is visible in CLI help and serves an initialized project.
2. The page loads without third-party network requests.
3. Code and Markdown nodes appear in the same topology.
4. Every edge returned by the API is an unchanged persisted CodeGraph edge.
5. Search, kind filtering, node inspection, pan, and zoom work in a real
   browser.
6. API, CLI, build, Rust protocol, integration, and browser smoke tests pass.

## Deferred work

- graph community detection or aggregated meta-graphs;
- mutable annotations and graph editing;
- source-code preview;
- live watcher updates or server-sent events;
- remote access controls;
- external-resource nodes and crawlers.

---

## V2 visual overview

### Problem

The first implementation placed every visible node into a file constellation
and labeled files, sections, and high-degree symbols. That worked for
inspection, but on a real repository the labels became the dominant visual
mark. The viewer could read individual names yet could not quickly perceive:

- which semantic categories dominate the repository;
- how code, documents, types, behavior, and dependencies are distributed;
- which top-level directories or languages carry most of the graph;
- where relationships cross those groups.

### Design references

V2 follows two established visualization principles:

- space-filling hierarchy views use area to make macro distribution and micro
  detail visible at the same time, as in treemaps;
- code graph explorers separate an overview from focused node inspection and
  provide explicit controls for node types, edge types, labels, and grouping.

The implementation remains dependency-free and bundled. These are interaction
and information-design references, not runtime libraries.

References:

- D3 hierarchy and treemap design:
  <https://d3js.org/d3-hierarchy/treemap>
- GitNexus code-knowledge graph explorer:
  <https://github.com/nxpatterns/gitnexus>

### Default view

The graph canvas becomes a weighted, binary-partition treemap:

- each group receives screen area proportional to its visible node count;
- the default grouping is **semantic role**:
  `Documents`, `Structure`, `Types`, `Behavior`, `Data`, and `Dependencies`;
- users can regroup the same nodes by top-level directory or language;
- every group shows its name, node count, and percentage of the current view;
- nodes are compact dots within their group, sized by local degree;
- node color can encode kind, language, or semantic role.

This makes classification and distribution readable before the user selects a
single node.

### Relationship levels

Relationship rendering has four explicit levels:

1. **Between groups** (default): exact persisted edges are counted by
   source/target group and rendered as weighted aggregate curves.
2. **Selected node**: only exact edges incident to the selected node are
   rendered.
3. **All visible**: every exact edge in the bounded snapshot is rendered.
4. **None**: no relationship layer.

Aggregation is visual only. The inspector continues to retrieve exact
persisted edges and full counts from the graph API.

Users can independently include or exclude each persisted edge kind. Aggregate
counts and exact-edge views always respect those choices.

### Label policy

Long labels no longer determine the overview geometry.

- `Auto` (default) shows only group labels at overview zoom, adds key-node
  labels after zooming, and reveals more labels at detail zoom.
- `Key nodes` labels only high-degree nodes.
- `All` labels every visible node.
- `None` hides all node labels.

Displayed node labels are compacted to 20 characters. Full names and qualified
names remain available through the SVG title, search results, and inspector.
Hovering or selecting a node always reveals its compact label.

### Optional generated display labels

Generated summaries are allowed only as a presentation overlay. A future
OpenAI-compatible provider (for example a low-cost DeepSeek Flash-class model)
may generate:

- a short display alias for a long document heading or symbol label;
- a one-line summary for a visual group;
- a compact explanation of why a selected document and code symbol connect.

The overlay must obey these invariants:

- it is disabled by default and the UI works fully offline without it;
- generated text is stored in a separate UI sidecar/cache, never in the graph
  node or edge tables;
- cache keys use the immutable node ID plus a source-content hash;
- `name`, `qualifiedName`, node IDs, edge kinds, edge endpoints, metadata, and
  relationship counts are never rewritten;
- provider failure, timeout, or missing credentials falls back to the
  deterministic compact label;
- repository content is not sent externally without explicit user
  configuration.

This keeps graph identity and relationship truth deterministic while allowing
low-cost models to improve presentation when users opt in.

### Right-side controls

The useful V1 right panel remains the interaction center. V2 adds:

- group by: semantic role / directory / language;
- color by: node kind / language / semantic role;
- relationships: between groups / selected node / all visible / none;
- labels: auto / key nodes / all / none;
- node-kind filters;
- edge-kind filters;
- live group-distribution bars.

The inspector remains below these controls and continues to show the exact
node identity plus incoming and outgoing neighbors.

### V2 acceptance criteria

1. A 1,000+ node repository shows its dominant categories and proportions
   without reading node labels.
2. The default view renders substantially fewer node labels than nodes.
3. Regrouping by semantic role, directory, or language recomputes the visual
   distribution without another server request.
4. Aggregate relationship curves preserve exact visible-edge counts.
5. Node- and edge-kind filters update groups, counts, and relationship totals.
6. Direct node selection and the right-side inspector still expose exact
   persisted relationships.
7. Search, regrouping, filtering, label modes, relationship modes, pan, and
   zoom pass real-browser tests with no console errors or external requests.
