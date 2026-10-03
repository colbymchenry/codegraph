# G6 graph workbench

Implementation: 2026-09-08. All four canvases use `@antv/g6` **5.1.1** and `@antv/layout` **2.0.0**, pinned in the UI package and lockfile. Svelte pages, GraphAdapter, HTTP payloads, navigation URLs and public component parameters remain compatible.

## Boundaries and ownership

- `graph-adapters.ts` converts existing domain models to `GraphScene`. Real directed relations are independent of display edges, folded edges and code-order edges.
- `GraphCanvas.svelte` owns front-end analysis state and accessible controls. `G6Runtime` owns the Canvas graph, HTML mounts, resize/theme observers, playback timer and actual path capture. Business views only use `GraphController`.
- Layout and shared routing run through the existing cancellable Worker boundary. Every request is budget checked, obsolete workers terminate, and generation checks reject late results. Teardown cancels work, unmounts Svelte cards and destroys G6.
- Selection, edge labels and hover update element data/states without rerendering geometry or recomputing routes. The surface exposes `data-graph-render-ms/count/nodes/edges` for browser verification.

## Semantics and presentation

Map uses left-to-right AntV Dagre. SCC condensation prevents dense cycles from creating enormous dummy-rank graphs; SCC members have stable internal positions. Multiple directory groups reserve separate areas. Explicit compact placement arranges incoming → current → outgoing, with mutual neighbours separately below.

Map and Screens also offer **force-directed, concentric and circular** layouts in the shared toolbar. They use the pinned AntV layout algorithms in the cancellable Worker: bounded D3 force ticks, degree-based concentric rings, and a stable ID-ordered circle. Group interiors and group shells reserve separate bounds. Layout changes retain real directed relations, selection, folding, edge style and current-scene export. The layout choice and manual positions are remembered separately per layout in the existing view history. Selection, hover and folding do not restart layout calculation. Restore layout returns to the semantic default; Map's compact placement also returns to that default before applying its focused positions. Flow and Steps retain their code/path order.

All four canvases have a subtle square background using the existing `--route-grid` theme token. At 100% zoom cells are 30px; the grid follows the viewport, dropping alternate lines at low zoom to avoid a dense pattern. It is a CSS background beneath the transparent Canvas, independent of scene geometry, minimap and layout calculation.

Screens keeps entry-distance layers and source/trigger/boundary details. Flow retains path order, Svelte code cards, keyboard links and terminal caps. Steps submits its existing code-order/impact-tree positions and specialized paths, including branches and regions. A code-order connector is never added to the BFS graph merely because it is drawn.

Native edges use 1–2px strokes and 2.5px highlights. Counts appear on hover/highlight. Map merges opposite directions into a display edge with two arrows and both counts; original IDs remain available. Selection uses an outline/halo, evidence retains its dash pattern, and actual cycle members carry an independent `↻` marker. Missing confidence is not invented.

Small routed scenes use G6 `shortest-path` with obstacle avoidance explicitly enabled. **Above 100 routed edges**, `graph-routing.ts` computes routes in a Worker using a shared occupancy grid and passes the control points to G6. The grid has a bounded allocation and reports blocked/overlapping layouts instead of allocating without limit. G6's generic `orth` fallback is not considered automatic obstacle avoidance. Specialized Flow/Steps paths remain unchanged.

This threshold is a deliberate implementation adjustment: repeating G6's per-edge obstacle-map construction at 400 nodes / 2,000 edges blocked the browser. A shared grid removed that bottleneck while retaining routable control points and exact path export.

Large circular scenes can span more space than layered ones. Shared routing uses 16px cells, or 32px for larger extents, while retaining its 2,000,000-cell allocation limit. A* breaks equal scores toward the goal to avoid flooding an empty ring centre. Straight edges remain selectable and bypass obstacle routing explicitly.

The minimum viewport zoom is 0.005 so a 400-node ring can fit entirely on screen; search, selection and zoom controls remain available for local reading.

## Analysis, budgets and history

- One-hop focus supports incoming, outgoing and both; the focus projection only shows the chosen range. Ordinary selection does not rearrange nodes.
- Directory and SCC grouping modes are mutually exclusive for Map. Other views use only existing page, path or code-region groups. G6 Combos hide members; crossing edges aggregate counts and retain provenance. Expanding restores model/manual positions and selection.
- Tarjan SCC detects actual directed cycles, including self-loops. Module-level cycles are labelled separately from the existing server-provided file-level cycle detail.
- BFS uses loaded, filtered real directed relations, with stable target-ID/edge-ID tie breaking. Folding cannot create or destroy a path. Successful queries expand hidden members; failure says “当前范围内未找到路径”. Flow's cross-scope symbol query still uses its existing adapter method.
- Limits remain **400 nodes / 2,000 edges before folding**. No dependency matrix or repository-wide path query is introduced. Drilldown uses existing APIs.
- History stores viewport, selection, filters, grouping, folds and manual positions alongside existing fields, keyed by project/view URLs. Theme, language and reduced-motion preferences remain in effect.
- Map's toolbar places a recent-node strip immediately after Groups. It remembers up to ten distinct selected nodes in the same scope history, newest first; revisiting moves a node to the front and an eleventh entry evicts the oldest. Entries select and locate the node, expanding its group and leaving one-hop focus as needed. Unavailable nodes are disabled until they return to the loaded scope. The strip scrolls horizontally and supports keyboard buttons and full-ID tooltips.
- Map/Flow exports capture the current visible graph geometry, routed paths, labels, group bounds and code text. The old public SVG helper functions remain available for compatible library consumers but no longer drive the canvas export buttons.

## Verification

`ui/g6-verify.html` is a development-only entry. `?view=map|flow|screens|steps` mounts actual views through a fixture GraphAdapter; `?nodes=400` exercises 400 native nodes and 2,000 directed relationships. Production Vite builds use only the normal app entry.

Automated regression suites cover directed BFS ties/no-path, cycles/self-loops, merged provenance, folding counts, obstacle intersections, the maximum grid/layout budget, state-only updates, stale request cancellation, teardown, SVG escaping and captured geometry. Existing Svelte adapter/model suites continue to cover navigation, code order, boundaries, filters and history.

Browser observations on this Windows host (development build; indicative, not a performance SLA): SCC layout approximately **41ms** in the automated fixture; shared routing approximately **0.53s** in the routing test; first 400/2,000 Canvas render including Worker routing approximately **2.3s**. A 2-hop path query kept geometry render count at **1**. A whole-directory fold rendered in approximately **0.67s**. Small Screens and Steps fixtures rendered in approximately **61ms** and **48ms** respectively. Initial G6 module loading is additional cold-start cost.

Final production verification used the real indexed fixture produced by `scripts/generate-ui-canvas-fixture.mjs`: **400 nodes / 2,000 edges**, scene render including routing **1,194ms**, no console errors. The high-connectivity `?view=map&hub=1` fixture includes opposite directions and a self-loop. A path through folded members reopened the directory; incoming focus reduced it to **4 nodes / 3 display edges**. Map and Flow SVG downloads were inspected on disk, including routed path data and Flow source text. Keyboard Tab reached the code call link. Same-document Flow → Map switching left four G6 layer canvases and zero stale HTML cards.

Validation completed: **19 Vitest files / 274 tests passed**, final affected-suite rerun passed **53 tests**, Svelte check reported **0 errors / 0 warnings**, and both UI and component-library builds passed. Vite still reports the size of the lazily loaded G6 chunk (approximately 395KB gzip); it is not loaded by non-graph views.

Grid/layout follow-up verification: **15 targeted Vitest files / 221 tests passed**, including deterministic alternative layouts, disjoint group bounds, all three 400/2,000 layouts and routes, per-layout manual history, stale Worker cancellation and teardown. A focused lifecycle rerun also passed after guarding delayed viewport work on unmount. On the development browser fixture, concentric layout took **205ms** plus **2,339ms** rendering/routing; circular took **255ms** plus **2,508ms**; force took **1,099ms** plus **3,250ms**. These include Worker overhead and are illustrative, not guarantees. The full ring fitted at approximately **2.46%** zoom. Finding a node kept render count at **1**. Light/dark grids were checked on the actual Map, Screens, Flow and Steps components, with code cards and branch ordering retained.

Static graph paths express relationships inferred from indexed source. They do not assert that runtime execution took place.

References: [G6 polyline routing](https://g6.antv.antgroup.com/manual/element/edge/polyline), [G6 collapse/expand](https://g6.antv.antgroup.com/manual/behavior/collapse-expand). Exact runtime behavior was also checked against the installed 5.1.1 source.

Alternative layouts: [D3 force](https://g6.antv.antgroup.com/manual/layout/d3-force-layout), [concentric](https://g6.antv.antgroup.com/manual/layout/concentric-layout), [circular](https://g6.antv.antgroup.com/manual/layout/circular-layout); execution APIs are verified against the pinned `@antv/layout` 2.0.0 source.
