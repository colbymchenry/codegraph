/**
 * Callback / observer edge synthesis — Phase 1 + 2.
 *
 * Closes dynamic-dispatch holes where a dispatcher invokes callbacks registered
 * elsewhere. Two channel shapes:
 *
 *  (1) Field-backed observer (Phase 1):
 *      onUpdate(cb) { this.callbacks.add(cb); }            // registrar
 *      triggerUpdate() { for (cb of this.callbacks) cb(); } // dispatcher
 *      scene.onUpdate(this.triggerRender)                  // registration
 *      → synthesize triggerUpdate → triggerRender
 *
 *  (2) String-keyed EventEmitter (Phase 2):
 *      this.on('mount', function onmount(){...})           // registration
 *      fn.emit('mount', this)                              // dispatch
 *      → synthesize (method containing emit('mount')) → onmount
 *
 * Whole-graph pass after base resolution. High-precision/low-recall by design:
 * named callbacks only; field channels paired by file+field; EventEmitter
 * channels capped by event fan-out (generic names like 'error' skipped — they
 * need receiver-type matching, deferred to Phase 3). All synthesized edges are
 * tagged `provenance:'heuristic'`. See docs/design/callback-edge-synthesis.md.
 */
import type { Edge, Node, NodeKind } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import { isGeneratedFile } from '../extraction/generated-detection';
import { stripCommentsForRegex } from './strip-comments';
import { cFnPointerDispatchEdges } from './c-fnptr-synthesizer';
import { goframeRouteEdges } from './goframe-synthesizer';
import { createYielder, type MaybeYield } from './cooperative-yield';

const REGISTRAR_NAME = /^(on[A-Z]\w*|subscribe|addListener|addEventListener|register|watch|listen|addCallback)$/;
const DISPATCHER_NAME = /(emit|trigger|notify|dispatch|fire|publish|flush)/i;
const MAX_CALLBACKS_PER_CHANNEL = 40;
const EVENT_FANOUT_CAP = 6; // skip events with more handlers/dispatchers than this (too generic without type info)

const ON_RE = /\.(?:on|once|addListener)\(\s*['"]([^'"]+)['"]\s*,\s*(?:function\s+(\w+)|(?:this\.)?(\w+))/g;
const EMIT_RE = /\.(?:emit|fire|dispatchEvent)\(\s*['"]([^'"]+)['"]/g;
const SETSTATE_RE = /this\.setState\s*\(/;
const FLUTTER_SETSTATE_RE = /\bsetState\s*\(/; // Flutter: setState((){…}) / this.setState
const JSX_TAG_RE = /<([A-Z][A-Za-z0-9_]*)[\s/>]/g;
const MAX_JSX_CHILDREN = 30;
// Vue SFC templates: kebab-case child components (<el-button> → ElButton) and
// event bindings (@click="fn" / v-on:click="fn"). PascalCase children (<VPNav/>)
// are already caught by JSX_TAG_RE via the SFC component node.
const VUE_KEBAB_RE = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]/g;
// PascalCase component tags — `<MediaCard ...>`, `<NavBar/>`. HTML elements are
// lowercase, so an uppercase-initial tag is a component usage; built-ins
// (`<NuxtLink>`, `<Transition>`) simply resolve to nothing and emit no edge.
const VUE_PASCAL_RE = /<([A-Z][A-Za-z0-9]*)[\s/>]/g;
const VUE_HANDLER_RE = /(?:@|v-on:)([a-zA-Z][\w-]*)(?:\.[\w]+)*\s*=\s*"([^"]+)"/g;
// Composable/hook destructure: `const { close: closeSidebar } = useSidebarControl()`.
// Captures the destructure body + the called composable; only `use*` calls qualify.
const VUE_DESTRUCTURE_RE = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(\w+)\s*\(/g;

// Closure-collection dynamic dispatch (language-agnostic, Swift-first). A method
// appends a closure to a collection property; another method iterates that
// property *invoking each element* (`coll.forEach { $0() }` / `{ it() }`). The
// element-invoke (`$0(` / `it(`) PROVES the collection holds closures, so pairing
// a dispatcher to same-named registrars (`.append`/`.add`/`.push`/`.insert`,
// incl. Swift `prop.write { $0.append }`) is high-precision. Cross-file/class by
// design: Alamofire appends in `DataRequest.validate` but iterates in the base
// `Request.didCompleteTask` — neither same-file nor same-class pairing reaches it.
const CC_DISPATCH_RE = /(\w+)\.forEach\s*\{\s*(?:\$0|it)\s*\(/g;
const CC_APPEND_WRITE_RE = /(\w+)\.write\s*\{\s*\$0(?:\.(\w+))?\.(?:append|add|push|insert)\s*\(/g;
const CC_APPEND_DIRECT_RE = /(\w+)\.(?:append|add|push|insert)\s*\(/g;
const CC_FANOUT_CAP = 8; // skip a field name with more dispatchers/registrars than this (too generic to pair confidently)

function kebabToPascal(s: string): string {
  return s.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

/**
 * Nuxt auto-import name for a component, derived from its path UNDER `components/`:
 * `components/media/Card.vue` → `MediaCard`, `components/base/foo/Bar.vue` →
 * `BaseFooBar`. Each directory segment and the filename is PascalCased and
 * concatenated; a directory whose PascalCase name prefixes the next segment is
 * collapsed (Nuxt's de-dup: `base/BaseButton.vue` → `BaseButton`, not
 * `BaseBaseButton`). Returns null for a flat component (`components/NavBar.vue`)
 * — its node is already named by basename, so a direct tag match finds it.
 */
function nuxtComponentName(filePath: string): string | null {
  const marker = filePath.lastIndexOf('components/');
  if (marker === -1) return null;
  const rel = filePath.slice(marker + 'components/'.length).replace(/\.(vue|ts|tsx|js|jsx)$/i, '');
  const segs = rel.split('/').filter(Boolean).map(kebabToPascal);
  if (segs.length < 2) return null;
  const out: string[] = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && s.startsWith(prev)) out[out.length - 1] = s;
    else out.push(s);
  }
  return out.join('');
}

function sliceLines(content: string, startLine?: number, endLine?: number): string | null {
  if (!startLine || !endLine) return null;
  return content.split('\n').slice(startLine - 1, endLine).join('\n');
}

function registrarField(src: string): string | null {
  const m = src.match(/this\.(\w+)\.(?:add|push|set)\(/);
  return m ? m[1]! : null;
}

function dispatcherField(src: string): string | null {
  const forOf = src.match(/\bof\s+(?:Array\.from\(\s*)?this\.(\w+)/);
  if (forOf && /\b\w+\s*\(/.test(src)) return forOf[1]!;
  const forEach = src.match(/this\.(\w+)\.forEach\(/);
  if (forEach) return forEach[1]!;
  return null;
}

const FN_KINDS = new Set(['method', 'function', 'component']);

/** Innermost function/method node whose line range contains `line`. */
function enclosingFn(nodesInFile: Node[], line: number): Node | null {
  let best: Node | null = null;
  for (const n of nodesInFile) {
    if (!FN_KINDS.has(n.kind)) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= line && end >= line) {
      if (!best || n.startLine >= best.startLine) best = n; // prefer the tightest (latest-starting) encloser
    }
  }
  return best;
}

/**
 * Stream method + function nodes lazily. The synthesizers only scan-and-filter
 * down to a tiny matched subset, so materializing every function/method (which
 * is gigabytes on a symbol-dense project) just to iterate it once is what OOM'd
 * #610. Iterating keeps memory O(1) in the node count.
 */
function* methodAndFunctionNodes(queries: QueryBuilder): IterableIterator<Node> {
  yield* queries.iterateNodesByKind('method');
  yield* queries.iterateNodesByKind('function');
}

/** Phase 1: field-backed observer channels (registrar/dispatcher share a store). */
async function fieldChannelEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const registrars: Array<{ node: Node; field: string }> = [];
  const dispatchers: Array<{ node: Node; field: string }> = [];

  let scanned = 0;
  for (const m of methodAndFunctionNodes(queries)) {
    if ((++scanned & 255) === 0) await onYield(); // #1091: yield mid-scan on huge graphs
    const isReg = REGISTRAR_NAME.test(m.name);
    const isDisp = DISPATCHER_NAME.test(m.name);
    if (!isReg && !isDisp) continue;
    const content = ctx.readFile(m.filePath);
    const src = content && sliceLines(content, m.startLine, m.endLine);
    if (!src) continue;
    if (isReg) { const f = registrarField(src); if (f) registrars.push({ node: m, field: f }); }
    if (isDisp) { const f = dispatcherField(src); if (f) dispatchers.push({ node: m, field: f }); }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const reg of registrars) {
    const chDispatchers = dispatchers.filter(
      (d) => d.node.filePath === reg.node.filePath && d.field === reg.field
    );
    if (chDispatchers.length === 0) continue;
    const argRe = new RegExp(`${reg.node.name}\\s*\\(\\s*(?:this\\.)?(\\w+)`);
    let added = 0;
    for (const e of queries.getIncomingEdges(reg.node.id, ['calls'])) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      if (!e.line) continue;
      const caller = queries.getNodeById(e.source);
      if (!caller) continue;
      const line = ctx.readFile(caller.filePath)?.split('\n')[e.line - 1];
      const am = line?.match(argRe);
      if (!am) continue;
      const fn = ctx.getNodesByName(am[1]!).find((n) => n.kind === 'method' || n.kind === 'function');
      if (!fn) continue;
      for (const disp of chDispatchers) {
        if (disp.node.id === fn.id) continue;
        const key = `${disp.node.id}>${fn.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: disp.node.id, target: fn.id, kind: 'calls', line: disp.node.startLine,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'callback', via: reg.node.name, field: reg.field,
            // Where the callback was wired up (`scene.onUpdate(this.triggerRender)`).
            // This is the #1 thing an agent reads/greps to explain the flow — surface
            // it so node/trace/context can show it without a callers() + Read round-trip.
            registeredAt: `${caller.filePath}:${e.line}`,
          },
        });
        added++;
      }
    }
  }
  return edges;
}

/**
 * Closure-collection dispatch: dispatcher iterates a closure-collection property
 * invoking each element; registrar appends a closure to the same-named property.
 * Emits dispatcher → registrar so a flow reaches the registration site (where the
 * appended closure's body — and its callers — live). High-precision: the
 * dispatcher's element-invoke is the gate (a `.forEach` that does NOT invoke its
 * element is ignored), so a repo with no closure-collection dispatch yields zero
 * edges regardless of how many `.append`/`.push` sites it has.
 *
 * Pairs globally by field name (cross-file/class is required — see Alamofire's
 * base-class `Request.didCompleteTask` iterating `validators` appended by the
 * subclass `DataRequest.validate`), bounded by a fan-out cap so a generic field
 * name shared across unrelated classes can't fan out into noise.
 */
async function closureCollectionEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const dispatchers = new Map<string, Array<{ node: Node; line: number }>>(); // field → dispatcher methods + forEach line
  const registrars = new Map<string, Array<{ node: Node; line: number }>>();   // field → registrar methods + append line

  const addReg = (field: string | undefined, node: Node, absLine: number) => {
    if (!field || /^\d+$/.test(field)) return; // `$0.append` mis-captures the `0`; the write-RE owns that field
    const arr = registrars.get(field) ?? [];
    if (!arr.some((r) => r.node.id === node.id)) arr.push({ node, line: absLine });
    registrars.set(field, arr);
  };

  // Slices EVERY method/function's source (no cheap name-gate), so on a repo
  // with a huge file this is the heaviest synthesis pass — yield mid-scan so it
  // can't wedge the #850 watchdog on its own (#1091).
  let scanned = 0;
  for (const m of methodAndFunctionNodes(queries)) {
    if ((++scanned & 127) === 0) await onYield();
    const content = ctx.readFile(m.filePath);
    const src = content && sliceLines(content, m.startLine, m.endLine);
    if (!src) continue;
    const hasForEach = src.includes('.forEach');
    const hasAppend = src.includes('.append(') || src.includes('.add(') || src.includes('.push(') || src.includes('.insert(');
    if (!hasForEach && !hasAppend) continue;
    const lineAt = (idx: number) => (m.startLine ?? 1) + src.slice(0, idx).split('\n').length - 1;

    if (hasForEach) {
      CC_DISPATCH_RE.lastIndex = 0;
      let d: RegExpExecArray | null;
      while ((d = CC_DISPATCH_RE.exec(src))) {
        const arr = dispatchers.get(d[1]!) ?? [];
        if (!arr.some((n) => n.node.id === m.id)) arr.push({ node: m, line: lineAt(d.index) });
        dispatchers.set(d[1]!, arr);
      }
    }
    if (hasAppend) {
      CC_APPEND_WRITE_RE.lastIndex = 0;
      let w: RegExpExecArray | null;
      while ((w = CC_APPEND_WRITE_RE.exec(src))) addReg(w[2] || w[1], m, lineAt(w.index)); // nested `$0.streams` else the `.write` receiver
      CC_APPEND_DIRECT_RE.lastIndex = 0;
      let a: RegExpExecArray | null;
      while ((a = CC_APPEND_DIRECT_RE.exec(src))) addReg(a[1], m, lineAt(a.index));
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [field, disps] of dispatchers) {
    const regs = registrars.get(field);
    if (!regs || regs.length === 0) continue;
    if (disps.length > CC_FANOUT_CAP || regs.length > CC_FANOUT_CAP) continue; // generic field — can't pair confidently
    for (const disp of disps) for (const reg of regs) {
      if (disp.node.id === reg.node.id) continue;
      const key = `${disp.node.id}>${reg.node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: disp.node.id, target: reg.node.id, kind: 'calls', line: disp.line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'closure-collection', field, registeredAt: `${reg.node.filePath}:${reg.line}` },
      });
    }
  }
  return edges;
}

/** Phase 2: string-keyed EventEmitter channels (on('e', fn) ↔ emit('e')). */
async function eventEmitterEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const emitsByEvent = new Map<string, Set<string>>();          // event → dispatcher node ids
  const handlersByEvent = new Map<string, Map<string, string>>(); // event → handler id → registration site (file:line)

  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if ((++scanned & 255) === 0) await onYield(); // #1091: yield mid-scan on huge graphs
    const content = ctx.readFile(file);
    if (!content) continue;
    const hasEmit = content.includes('.emit(') || content.includes('.fire(') || content.includes('.dispatchEvent(');
    const hasOn = content.includes('.on(') || content.includes('.once(') || content.includes('.addListener(');
    if (!hasEmit && !hasOn) continue;
    const nodesInFile = ctx.getNodesInFile(file);
    const lineOf = (idx: number) => content.slice(0, idx).split('\n').length;

    if (hasEmit) {
      EMIT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = EMIT_RE.exec(content))) {
        const disp = enclosingFn(nodesInFile, lineOf(m.index));
        if (!disp) continue;
        const set = emitsByEvent.get(m[1]!) ?? new Set<string>();
        set.add(disp.id); emitsByEvent.set(m[1]!, set);
      }
    }
    if (hasOn) {
      ON_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ON_RE.exec(content))) {
        const handlerName = m[2] || m[3];
        if (!handlerName) continue;
        const handler = ctx.getNodesByName(handlerName).find((n) => n.kind === 'function' || n.kind === 'method');
        if (!handler) continue;
        const map = handlersByEvent.get(m[1]!) ?? new Map<string, string>();
        map.set(handler.id, `${file}:${lineOf(m.index)}`); handlersByEvent.set(m[1]!, map);
      }
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [event, dispatchers] of emitsByEvent) {
    const handlers = handlersByEvent.get(event);
    if (!handlers) continue;
    // Precision guard: a generic event name with many handlers/dispatchers can't
    // be matched without receiver-type info (Phase 3) — skip rather than over-link.
    if (dispatchers.size > EVENT_FANOUT_CAP || handlers.size > EVENT_FANOUT_CAP) continue;
    for (const d of dispatchers) for (const [h, registeredAt] of handlers) {
      if (d === h) continue;
      const key = `${d}>${h}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: d, target: h, kind: 'calls', provenance: 'heuristic', metadata: { synthesizedBy: 'event-emitter', event, registeredAt } });
    }
  }
  return edges;
}

/**
 * Phase 4: React class-component re-render. `this.setState(...)` re-runs the
 * component's `render()`, but that hop is React-internal — no static edge — so a
 * flow like "mutation → setState → canvas repaint" dead-ends at setState even
 * though `render → getRenderableElements → …` is fully call-connected after it.
 * Bridge it: for each class that has a `render` method, link every sibling method
 * whose body calls `this.setState(` → `render`. The setState gate keeps this to
 * React class components (a non-React class with a `render` method won't call
 * `this.setState`). Over-approximation (all setState methods reach render) is
 * accepted — it's reachability-correct, like the callback channels.
 */
function reactRenderEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const cls of queries.getNodesByKind('class')) {
    const children = queries.getOutgoingEdges(cls.id, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
    const render = children.find((n) => n.name === 'render');
    if (!render) continue;
    let added = 0;
    for (const m of children) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      if (m.id === render.id) continue;
      const content = ctx.readFile(m.filePath);
      const src = content && sliceLines(content, m.startLine, m.endLine);
      if (!src || !SETSTATE_RE.test(src)) continue;
      const key = `${m.id}>${render.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: m.id, target: render.id, kind: 'calls', line: m.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'react-render', via: 'setState', registeredAt: `${render.filePath}:${render.startLine}` },
      });
      added++;
    }
  }
  return edges;
}

/**
 * Phase 4b: Flutter setState → build (the Dart analog of react-render). In a
 * StatefulWidget's State class, `setState(() {…})` re-runs `build(context)`, but
 * that hop is framework-internal (Flutter calls build), so a flow like
 * "onPressed → _increment → setState → rebuilt UI" dead-ends at setState. Bridge
 * it: for each Dart class with a `build` method, link every sibling method whose
 * body calls `setState(` → `build`. The setState gate + `.dart` file keep this to
 * Flutter State classes. Over-approximation accepted (reachability-correct).
 */
function flutterBuildEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const cls of queries.getNodesByKind('class')) {
    const children = queries.getOutgoingEdges(cls.id, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
    const build = children.find((n) => n.name === 'build');
    if (!build || !build.filePath.endsWith('.dart')) continue;
    let added = 0;
    for (const m of children) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      if (m.id === build.id) continue;
      const content = ctx.readFile(m.filePath);
      const src = content && sliceLines(content, m.startLine, m.endLine);
      if (!src || !FLUTTER_SETSTATE_RE.test(src)) continue;
      const key = `${m.id}>${build.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: m.id, target: build.id, kind: 'calls', line: m.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'flutter-build', via: 'setState', registeredAt: `${build.filePath}:${build.startLine}` },
      });
      added++;
    }
  }
  return edges;
}

/**
 * Reactive ArkUI property decorators: assigning a property carrying one of
 * these re-runs the owning struct's `build()`. Covers both state models —
 * V1 (`@Component`: State/Prop/Link/Provide/Consume/Storage*) and V2
 * (`@ComponentV2`: Local/Provider/Consumer; `@Param` is read-only in V2 so
 * the assignment gate never fires on it, and `@Trace` lives on `@ObservedV2`
 * data classes, not struct properties).
 */
const ARKUI_REACTIVE_DECORATORS = new Set([
  'State', 'Prop', 'Link', 'Provide', 'Consume', 'StorageLink', 'StorageProp',
  'LocalStorageLink', 'LocalStorageProp', 'ObjectLink',
  'Local', 'Provider', 'Consumer',
]);

/** ArkUI-observed array mutators — `this.todos.push(x)` re-renders like an assignment. */
const ARKUI_ARRAY_MUTATORS = 'push|pop|shift|unshift|splice|sort|reverse|fill';

/**
 * Phase 4b-ets: ArkUI state → build (the ArkTS analog of react-render /
 * flutter-build). Assigning a reactive-decorated property (`@State count`,
 * `@Link selected`, …) re-runs the `@Component struct`'s `build()`, but that
 * hop is framework-internal — no static edge — so "onClick → markAllDone →
 * this.todos = […] → rebuilt list" dead-ends at the assignment. Bridge it:
 * for each arkts struct with a `build()` method and at least one reactive
 * property, link every sibling method whose body ASSIGNS (or array-mutates)
 * one of those properties → `build`. Assignment-gated on the struct's OWN
 * reactive property names — a method that merely reads state, or a struct
 * with no reactive properties, gets nothing (this is the precision line the
 * all-sibling-methods design would erase).
 */
function arkuiStateBuildEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const struct of queries.getNodesByKind('struct')) {
    if (struct.language !== 'arkts') continue;
    const children = queries.getOutgoingEdges(struct.id, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n);
    const build = children.find((n) => n.kind === 'method' && n.name === 'build');
    if (!build) continue;
    const reactiveProps = children.filter(
      (n) => n.kind === 'property' && (n.decorators ?? []).some((d) => ARKUI_REACTIVE_DECORATORS.has(d))
    );
    if (reactiveProps.length === 0) continue;
    const propAlternation = reactiveProps
      .map((p) => p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    // `this.count = …` / `+=` / `++` / `--` / `this.todos.push(…)`. The
    // `=(?!=)` keeps `this.done == x` comparisons out.
    const mutationRe = new RegExp(
      `this\\.(?:${propAlternation})\\s*(?:=(?!=)|\\+\\+|--|[+\\-*/%&|^]=|\\.(?:${ARKUI_ARRAY_MUTATORS})\\s*\\()`
    );
    let added = 0;
    for (const m of children) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      if (m.kind !== 'method' || m.id === build.id) continue;
      const content = ctx.readFile(m.filePath);
      const src = content && sliceLines(content, m.startLine, m.endLine);
      if (!src || !mutationRe.test(stripCommentsForRegex(src, 'typescript'))) continue;
      const key = `${m.id}>${build.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: m.id, target: build.id, kind: 'calls', line: m.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'arkui-state', via: 'state assignment', registeredAt: `${build.filePath}:${build.startLine}` },
      });
      added++;
    }
  }
  return edges;
}

/** Emit/subscribe call sites of HarmonyOS's `@ohos.events.emitter` bus. */
const ARKUI_EMITTER_CALL_RE = /\bemitter\s*\.\s*(emit|on|once)\s*\(\s*([A-Za-z_$][\w$.]*|\{[^)]{0,120}?\beventId\s*:\s*[^,}]+[^)]*?\})/g;

/** Cap per event bucket — a generic key with many parties is dynamic routing, not a static pair. */
const ARKUI_EMITTER_FANOUT_CAP = 8;

/**
 * Phase 4b-ets2: HarmonyOS `@ohos.events.emitter` bridge. The cross-component
 * bus — `emitter.emit(eventId)` fires `emitter.on(eventId, cb)` — is
 * framework-internal, so an order flow riding it (OrangeShopping's
 * add-to-cart) dead-ends at the emit. Link emit-site enclosing
 * function/method → on/once-site enclosing function/method when both
 * reference the SAME statically-recoverable event key.
 *
 * Key recovery, per call site (comment-stripped enclosing-file source): the
 * first argument is an `{ eventId: K }` literal, a `Names.Dotted` constant, or
 * a local whose same-file declaration is `new EventsId(K)` / `= K` — chase one
 * level. Precision scoping learned from the samples monorepo (thousands of
 * unrelated samples, most using eventId 1): NUMERIC keys pair within the same
 * FILE only; NAMED keys pair within the same workspace module directory (or
 * the whole project when it declares no modules — the single-app case), both
 * behind a fan-out cap. Inline `on(id, (e) => {…})` arrows need no special
 * handling — their bodies' calls already attribute to the registering method,
 * so targeting that method keeps the chain connected.
 */
function arkuiEmitterEdges(ctx: ResolutionContext): Edge[] {
  interface Site { nodeId: string; file: string; line: number }
  // bucket key -> emit sites / handler sites
  const emits = new Map<string, Site[]>();
  const handlers = new Map<string, Site[]>();

  const moduleDirs = (() => {
    const ws = ctx.getWorkspacePackages?.();
    return ws ? [...new Set(ws.byName.values())].sort((a, b) => b.length - a.length) : [];
  })();
  const moduleScopeOf = (file: string): string => {
    for (const dir of moduleDirs) {
      if (file === dir || file.startsWith(dir + '/')) return dir;
    }
    return '';
  };

  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.ets')) continue;
    const content = ctx.readFile(file);
    if (!content || !content.includes('emitter.')) continue;
    const safe = stripCommentsForRegex(content, 'typescript');
    const nodes = ctx.getNodesInFile(file)
      .filter((n) => n.kind === 'method' || n.kind === 'function');

    ARKUI_EMITTER_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ARKUI_EMITTER_CALL_RE.exec(safe))) {
      const verb = m[1]!;
      const arg = m[2]!.trim();
      const line = safe.slice(0, m.index).split('\n').length;
      const encl = nodes
        .filter((n) => n.startLine <= line && n.endLine >= line)
        .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
      if (!encl) continue;

      // Recover the event key from the first argument.
      let key: string | null = null;
      const idLit = arg.startsWith('{') ? arg.match(/\beventId\s*:\s*([\w$.]+)/)?.[1] : undefined;
      const token = idLit ?? arg;
      if (token !== undefined) {
        if (/^\d+$/.test(token)) {
          key = `num:${file}:${token}`; // numeric: same-file only
        } else if (token.includes('.')) {
          key = `name:${moduleScopeOf(file)}:${token}`;
        } else {
          // Local variable — chase its same-file declaration one level:
          // `let x = new EventsId(K)` / `const x = K`.
          const declRe = new RegExp(
            `\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b\\s*(?::[^=\\n]+)?=\\s*(?:new\\s+[\\w$.]+\\(\\s*([^)\\n]+?)\\s*\\)|([\\w$.]+))`
          );
          const decl = safe.match(declRe);
          const inner = (decl?.[1] ?? decl?.[2])?.trim();
          if (inner && /^\d+$/.test(inner)) key = `num:${file}:${inner}`;
          else if (inner && /^[\w$.]+$/.test(inner)) key = `name:${moduleScopeOf(file)}:${inner}`;
        }
      }
      if (!key) continue;

      const site: Site = { nodeId: encl.id, file, line };
      if (verb === 'emit') {
        (emits.get(key) ?? emits.set(key, []).get(key)!).push(site);
      } else {
        (handlers.get(key) ?? handlers.set(key, []).get(key)!).push(site);
      }
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [key, emitSites] of emits) {
    const handlerSites = handlers.get(key);
    if (!handlerSites) continue;
    if (emitSites.length > ARKUI_EMITTER_FANOUT_CAP || handlerSites.length > ARKUI_EMITTER_FANOUT_CAP) continue;
    const eventLabel = key.slice(key.lastIndexOf(':') + 1);
    for (const e of emitSites) for (const h of handlerSites) {
      if (e.nodeId === h.nodeId) continue;
      const dedupe = `${e.nodeId}>${h.nodeId}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      edges.push({
        source: e.nodeId, target: h.nodeId, kind: 'calls', line: e.line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'arkui-emitter', event: eventLabel, registeredAt: `${h.file}:${h.line}` },
      });
    }
  }
  return edges;
}

/** `router.pushUrl({ url: 'pages/Detail' })` / replaceUrl — literal urls only. */
const ARKUI_ROUTER_RE = /\brouter\s*\.\s*(?:pushUrl|replaceUrl)\s*\(\s*\{[^)]{0,200}?\burl\s*:\s*['"]([\w\-./]+)['"]/g;

/**
 * Phase 4b-ets3: HarmonyOS page navigation. `router.pushUrl({ url:
 * 'pages/Detail' })` reaches the `@Entry struct` of
 * `<module>/src/main/ets/pages/Detail.ets`, but the hop is a string — no
 * static edge — so "tap → openDetail → ???" ends at the router call. Bridge
 * literal urls to the page struct: the url resolves against the standard
 * `src/main/ets/` layout (what main_pages.json entries name); candidates
 * prefer the caller's own workspace module (routes are module-scoped), and
 * anything still ambiguous is dropped rather than guessed. Only `@Entry`
 * structs qualify as targets — the decorator is what makes a file a page.
 */
function arkuiRouterEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();

  const allFiles = ctx.getAllFiles();
  const moduleDirs = (() => {
    const ws = ctx.getWorkspacePackages?.();
    return ws ? [...new Set(ws.byName.values())].sort((a, b) => b.length - a.length) : [];
  })();
  const moduleScopeOf = (file: string): string => {
    for (const dir of moduleDirs) {
      if (file === dir || file.startsWith(dir + '/')) return dir;
    }
    return '';
  };

  for (const file of allFiles) {
    if (!file.endsWith('.ets')) continue;
    const content = ctx.readFile(file);
    if (!content || !content.includes('router.')) continue;
    const safe = stripCommentsForRegex(content, 'typescript');
    const nodes = ctx.getNodesInFile(file)
      .filter((n) => n.kind === 'method' || n.kind === 'function');

    ARKUI_ROUTER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ARKUI_ROUTER_RE.exec(safe))) {
      const url = m[1]!;
      const line = safe.slice(0, m.index).split('\n').length;
      const encl = nodes
        .filter((n) => n.startLine <= line && n.endLine >= line)
        .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
      if (!encl) continue;

      const suffix = `/src/main/ets/${url}.ets`;
      let candidates = allFiles.filter((f) => f.endsWith(suffix));
      if (candidates.length > 1) {
        const scope = moduleScopeOf(file);
        const sameModule = candidates.filter((f) => moduleScopeOf(f) === scope);
        if (sameModule.length > 0) candidates = sameModule;
      }
      if (candidates.length !== 1) continue; // ambiguous or unresolved — never guess

      const page = ctx.getNodesInFile(candidates[0]!).find(
        (n) => n.kind === 'struct' && (n.decorators ?? []).includes('Entry')
      );
      if (!page) continue;

      const key = `${encl.id}>${page.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: encl.id, target: page.id, kind: 'calls', line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'arkui-route', event: url, registeredAt: `${candidates[0]}:${page.startLine}` },
      });
    }
  }
  return edges;
}

/**
 * Phase 4c: C++ virtual override. A call through a base/interface pointer
 * (`db->Get(...)`, `iter->Next()`) dispatches at runtime to a subclass override,
 * but that hop is a vtable indirection — no static call edge — so a flow stops at
 * the abstract base method. Bridge it like react-render: for each C++ class that
 * `extends` a base, link each base method → the subclass method of the same name
 * (the override), so trace/callees from the interface method reach the
 * implementation(s). Over-approximation accepted (reachability-correct); capped
 * per class and gated to C++ to avoid touching other languages' dispatch.
 */
function cppOverrideEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const methodsOf = (classId: string): Node[] =>
    queries
      .getOutgoingEdges(classId, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
  for (const cls of queries.getNodesByKind('class')) {
    const subMethods = methodsOf(cls.id).filter((n) => n.language === 'cpp');
    if (subMethods.length === 0) continue;
    for (const ext of queries.getOutgoingEdges(cls.id, ['extends'])) {
      const base = queries.getNodeById(ext.target);
      if (!base || base.language !== 'cpp' || base.id === cls.id) continue;
      const baseMethods = new Map(methodsOf(base.id).map((m) => [m.name, m]));
      let added = 0;
      for (const m of subMethods) {
        if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
        const bm = baseMethods.get(m.name);
        if (!bm || bm.id === m.id) continue;
        const key = `${bm.id}>${m.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: bm.id,
          target: m.id,
          kind: 'calls',
          line: bm.startLine,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'cpp-override', via: m.name, registeredAt: `${m.filePath}:${m.startLine}` },
        });
        added++;
      }
    }
  }
  return edges;
}

/**
 * Phase 5.5: interface / abstract dispatch (Java, Kotlin). A call through an
 * injected interface (`@Autowired FooService svc; svc.list()`) or an abstract
 * base dispatches at runtime to the implementing class's override — a vtable
 * indirection with no static call edge — so a request→service flow stops at the
 * interface method. Bridge it like cpp-override: for each class that
 * `implements` an interface (or `extends` an abstract base), link each
 * base/interface method → the class's same-name method (the override) so
 * trace/callees reach the implementation. Over-approximation accepted
 * (reachability-correct); capped per class, gated to JVM languages.
 */
// Languages whose static `implements`/`extends` edges should bridge an
// interface (or abstract base) method to the matching concrete-class method.
// The set is "languages with explicit nominal subtyping and a single class
// kind that holds methods" — i.e. the shape this loop expects. Swift and
// Scala fit shape-wise (Swift `protocol`/`class`, Scala `trait`/`class`)
// and are added below; their concrete-side nodes can be a `struct` (Swift)
// or an `object` (Scala) so the loop also iterates those kinds.
const IFACE_OVERRIDE_LANGS = new Set([
  'java', 'kotlin', 'csharp', 'typescript', 'javascript', 'swift', 'scala', 'go', 'rust',
  'arkts',
]);
/**
 * Go implicit interface satisfaction (#584). Go has no `implements` keyword — a
 * struct satisfies an interface structurally when its method set covers the
 * interface's. Synthesize the missing `implements` edge (struct → interface) by
 * matching method-NAME sets, so impl-navigation works and the interface-dispatch
 * bridge ({@link interfaceOverrideEdges}, now 'go'-enabled) can link an interface
 * method call to the concrete overrides.
 *
 * Name-only matching (signatures ignored) — over-approximation accepted, in line
 * with the other dispatch synthesizers; capped per interface. Empty interfaces
 * (`any`) are skipped so they don't match every struct.
 */
function goImplementsEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();

  const methodNameSet = (id: string): Set<string> =>
    new Set(
      queries
        .getOutgoingEdges(id, ['contains'])
        .map((e) => queries.getNodeById(e.target))
        .filter((n): n is Node => !!n && n.kind === 'method')
        .map((n) => n.name),
    );

  const goStructs = queries.getNodesByKind('struct').filter((s) => s.language === 'go');
  const structMethods = new Map<string, Set<string>>();
  for (const s of goStructs) structMethods.set(s.id, methodNameSet(s.id));

  for (const iface of queries.getNodesByKind('interface')) {
    if (iface.language !== 'go') continue;
    const want = methodNameSet(iface.id);
    if (want.size === 0) continue; // empty interface (`any`) — would match everything
    let added = 0;
    for (const s of goStructs) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      const have = structMethods.get(s.id);
      if (!have || have.size < want.size) continue;
      let all = true;
      for (const m of want) {
        if (!have.has(m)) { all = false; break; }
      }
      if (!all) continue;
      const key = `${s.id}>${iface.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: s.id,
        target: iface.id,
        kind: 'implements',
        line: s.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'go-implements', via: iface.name, registeredAt: `${s.filePath}:${s.startLine}` },
      });
      added++;
    }
  }
  return edges;
}

/**
 * Cross-file Go method → receiver-type `contains` edges. In Go a type's methods
 * are commonly declared in a different file from the `type` declaration itself
 * (`type User struct{…}` in `user.go`, `func (u *User) Save()` in
 * `user_store.go`). Extraction attaches the struct→method `contains` edge only
 * when the receiver type is in the SAME file — the owner lookup in
 * `tree-sitter.ts` is scoped to the file being parsed — so a cross-file method
 * is left orphaned from its type (it's still `contains`ed by its file, just not
 * its struct). That breaks `codegraph_node` member outlines, any
 * callers/callees/impact traversal that goes through the type's `contains`
 * edges, and the {@link goImplementsEdges} method-set computation (which derives
 * a struct's method set from those same edges, so it under-counts interfaces a
 * cross-file struct satisfies).
 *
 * Go guarantees a method's receiver type is declared in the SAME PACKAGE as the
 * method, and a Go package is a single directory — so this is a deterministic
 * structural link, not a heuristic: find the same-named type in the method's own
 * directory and add the missing `contains` edge (no `provenance: 'heuristic'`,
 * matching the same-file edges extraction already emits). Skips methods that
 * already have a type parent (the same-file case). (#583, cross-file half)
 */
function goCrossFileMethodContainsEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const TYPE_KINDS = new Set<NodeKind>(['struct', 'class', 'interface', 'enum', 'type_alias']);
  const dirOf = (p: string): string => {
    const i = p.replace(/\\/g, '/').lastIndexOf('/');
    return i >= 0 ? p.slice(0, i) : '';
  };

  for (const method of queries.getNodesByKind('method')) {
    if (method.language !== 'go') continue;
    // The receiver type is encoded in the method's qualifiedName as `Recv::name`
    // (extraction sets `${receiverType}::${name}` for receiver methods).
    const qn = method.qualifiedName;
    if (!qn) continue;
    const sep = qn.lastIndexOf('::');
    if (sep <= 0) continue;
    const receiver = qn.slice(0, sep);
    if (!receiver) continue;

    // Already attached to its type (same-file case handled at extraction)?
    const hasTypeParent = queries
      .getIncomingEdges(method.id, ['contains'])
      .some((e) => {
        const src = queries.getNodeById(e.source);
        return src != null && TYPE_KINDS.has(src.kind);
      });
    if (hasTypeParent) continue;

    // Find the receiver type in the SAME directory (= same Go package). Go forbids
    // duplicate type names within a package, so a same-name same-dir match is
    // unambiguous; scoping to the directory avoids linking to a same-named type
    // in another package.
    const dir = dirOf(method.filePath);
    const owner = queries
      .getNodesByName(receiver)
      .find((n) => n.language === 'go' && TYPE_KINDS.has(n.kind) && dirOf(n.filePath) === dir);
    if (!owner) continue;

    const key = `${owner.id}>${method.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source: owner.id, target: method.id, kind: 'contains', line: method.startLine });
  }
  return edges;
}

/**
 * Kotlin Multiplatform `expect`/`actual` linking. A `common` source set declares
 * `expect fun foo()` / `expect class Bar`; each platform source set (jvm, native,
 * js, …) provides an `actual` implementation with the IDENTICAL fully-qualified
 * name in a different file. Callers in common code resolve to the `expect`
 * declaration, so every `actual` impl ends up with zero dependents — invisible to
 * impact/affected even though editing it can break every caller of the API.
 *
 * Synthesize a `calls` edge from the common declaration to each platform `actual`
 * (mirroring the interface-impl bridge: abstract → concrete), so editing a
 * platform impl surfaces the common `expect` and its callers, and the impl file
 * participates in the graph.
 *
 * `expect`/`actual` are captured onto the node's `decorators` list at extraction
 * (kotlin.ts `extractModifiers`). Members of an `expect class` are NOT themselves
 * keyword-marked, so the declaration side is matched as the same-FQN, same-kind
 * node that is NOT marked `actual`. Requiring an `actual`-marked counterpart also
 * gates out plain cross-file overloads (neither side is marked).
 */
// Kinds that an `expect`/`actual` pair may legitimately straddle. `expect class`
// is routinely fulfilled by an `actual typealias` (e.g. `actual typealias
// CancellationException = …`, `actual typealias SchedulerTask = Task`), so a
// strict kind match would miss those one-line alias files. Same-FQN + the
// `actual` marker already gates out unrelated symbols, so widening to the
// type-like kinds is safe.
const KMP_TYPE_KINDS = new Set(['class', 'interface', 'struct', 'enum', 'type_alias']);
function kmpKindsCompatible(a: string, b: string): boolean {
  return a === b || (KMP_TYPE_KINDS.has(a) && KMP_TYPE_KINDS.has(b));
}

function kotlinExpectActualEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const actuals = queries
    .getAllNodes()
    .filter((n) => n.language === 'kotlin' && !!n.decorators?.includes('actual'));
  for (const act of actuals) {
    let added = 0;
    for (const cand of queries.getNodesByQualifiedNameExact(act.qualifiedName)) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      // The declaration side: same FQN + compatible kind, a different file, NOT
      // itself an `actual` (that would be a sibling platform impl, not the decl).
      if (cand.language !== 'kotlin' || cand.id === act.id) continue;
      if (!kmpKindsCompatible(cand.kind, act.kind) || cand.filePath === act.filePath) continue;
      if (cand.decorators?.includes('actual')) continue;
      const key = `${cand.id}>${act.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: cand.id,
        target: act.id,
        kind: 'calls',
        line: cand.startLine,
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'kotlin-expect-actual',
          via: act.name,
          registeredAt: `${act.filePath}:${act.startLine}`,
        },
      });
      added++;
    }
  }
  return edges;
}

function interfaceOverrideEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const methodsOf = (classId: string): Node[] =>
    queries
      .getOutgoingEdges(classId, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
  // Concrete-side kinds vary by language: `class` covers Java / Kotlin /
  // C# / TS / Swift-classes / Scala-classes; `struct` covers Swift value
  // types that conform to protocols. Iterate both.
  const concreteKinds = ['class', 'struct'] as const;
  for (const kind of concreteKinds) {
  for (const cls of queries.getNodesByKind(kind)) {
    const implMethods = methodsOf(cls.id).filter((n) => IFACE_OVERRIDE_LANGS.has(n.language));
    if (implMethods.length === 0) continue;
    for (const sup of queries.getOutgoingEdges(cls.id, ['implements', 'extends'])) {
      const base = queries.getNodeById(sup.target);
      if (!base || !IFACE_OVERRIDE_LANGS.has(base.language) || base.id === cls.id) continue;
      // Group impl methods by name to handle OVERLOADS: an interface `list()` and
      // `list(params)` are distinct nodes and a call may resolve to either, so
      // link every base overload → every same-name impl overload (keying by name
      // alone would drop all but one and miss the resolved overload).
      const implByName = new Map<string, Node[]>();
      for (const m of implMethods) {
        const arr = implByName.get(m.name);
        if (arr) arr.push(m); else implByName.set(m.name, [m]);
      }
      let added = 0;
      for (const bm of methodsOf(base.id)) {
        if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
        for (const m of implByName.get(bm.name) ?? []) {
          if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
          if (bm.id === m.id) continue;
          const key = `${bm.id}>${m.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({
            source: bm.id,
            target: m.id,
            kind: 'calls',
            line: bm.startLine,
            provenance: 'heuristic',
            metadata: { synthesizedBy: 'interface-impl', via: m.name, registeredAt: `${m.filePath}:${m.startLine}` },
          });
          added++;
        }
      }
    }
  }
  }
  return edges;
}

/**
 * Go gRPC stub → impl bridge. The protoc-gen-go-grpc codegen emits an
 * `UnimplementedXxxServer` struct in `*_grpc.pb.go` carrying one method
 * per service RPC; the real handler is a hand-written struct in another
 * file (`x/bank/keeper/msg_server.go::msgServer.Send` in cosmos-sdk).
 * Go's structural typing means no `implements` edge exists for our
 * resolver to follow, so `trace("Send","SendCoins")` lands on the
 * empty stub and reports "no path" (validated empirically — the cosmos
 * Q1 r1 trace failure that drove this work).
 *
 * Bridge: for each `UnimplementedXxxServer` whose RPC-method names are
 * a SUBSET of some other Go struct's method names, emit `calls` edges
 * `stub.method → impl.method` (paired by name). Excludes the gRPC
 * internal markers `mustEmbedUnimplementedXxxServer` and
 * `testEmbeddedByValue`, and skips candidate impls that themselves
 * live in a generated file (their `xxxClient` / sibling stubs would
 * otherwise look like impls).
 *
 * Multiple candidates is allowed and capped at MAX_CALLBACKS_PER_CHANNEL —
 * a service often has both a production impl and one or more test
 * mocks; linking to all preserves trace utility without false-favoring.
 *
 * Provenance: `heuristic`, `synthesizedBy: 'go-grpc-stub-impl'`. The
 * stub's source line is the wiring site shown in the trace trail.
 */
function goGrpcStubImplEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();

  const STUB_RE = /^Unimplemented.*Server$/;
  // gRPC internal-helper methods that appear on every Unimplemented*Server;
  // not part of the service contract, so exclude when computing the RPC-method
  // signature used to match impls.
  const isInternalMarker = (n: string) => n.startsWith('mustEmbed') || n === 'testEmbeddedByValue';

  // Methods directly contained by each Go struct, name-only. Built once.
  const methodNamesByStruct = new Map<string, Set<string>>();
  const methodNodesByStruct = new Map<string, Node[]>();
  const goStructs: Node[] = [];
  for (const s of queries.getNodesByKind('struct')) {
    if (s.language !== 'go') continue;
    goStructs.push(s);
    const ms = queries
      .getOutgoingEdges(s.id, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
    methodNodesByStruct.set(s.id, ms);
    methodNamesByStruct.set(s.id, new Set(ms.map((m) => m.name)));
  }

  for (const stub of goStructs) {
    if (!STUB_RE.test(stub.name)) continue;
    // The stub MUST live in a generated file — that's what tells us this is
    // a protoc-emitted scaffold rather than someone naming a struct
    // `UnimplementedXxxServer` by hand. Without this gate we'd also bridge
    // such hand-written structs and create misleading edges.
    if (!isGeneratedFile(stub.filePath)) continue;

    const stubMethods = (methodNodesByStruct.get(stub.id) ?? []).filter(
      (m) => !isInternalMarker(m.name),
    );
    if (stubMethods.length === 0) continue;
    const stubMethodNames = stubMethods.map((m) => m.name);

    for (const cand of goStructs) {
      if (cand.id === stub.id) continue;
      // Skip generated-file candidates — they're siblings (msgClient,
      // UnsafeMsgServer, …) whose method sets coincidentally match.
      if (isGeneratedFile(cand.filePath)) continue;

      const candNames = methodNamesByStruct.get(cand.id);
      if (!candNames) continue;
      // Subset: every RPC method must exist on the candidate by name.
      // Signature-level match would tighten this further, but name-match
      // alone already gives one-to-one pairing in real codebases because
      // gRPC method-name sets are highly distinctive (Send + MultiSend +
      // UpdateParams + SetSendEnabled is unique to bank's MsgServer).
      if (!stubMethodNames.every((n) => candNames.has(n))) continue;

      const candMethods = methodNodesByStruct.get(cand.id) ?? [];
      let added = 0;
      for (const sm of stubMethods) {
        if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
        for (const cm of candMethods) {
          if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
          if (cm.name !== sm.name) continue;
          const key = `${sm.id}>${cm.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({
            source: sm.id,
            target: cm.id,
            kind: 'calls',
            line: sm.startLine,
            provenance: 'heuristic',
            metadata: {
              synthesizedBy: 'go-grpc-stub-impl',
              via: cm.name,
              registeredAt: `${cm.filePath}:${cm.startLine}`,
            },
          });
          added++;
        }
      }
    }
  }
  return edges;
}

/**
 * Phase 5: React JSX child rendering. A component that returns `<Child .../>`
 * mounts Child — React calls it — but JSX instantiation isn't a static call edge,
 * so a render tree (App.render → StaticCanvas → renderStaticScene) breaks at the
 * JSX hop. Link parent → each capitalized JSX child it renders. File-oriented
 * (read each JSX file once). Precision gate: the child name must resolve to a
 * component/function/class node — TS generics like `Array<Foo>` resolve to a type
 * (or nothing) and are dropped.
 */
async function reactJsxChildEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const PARENT_KINDS = new Set(['method', 'function', 'component']);
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if ((++scanned & 255) === 0) await onYield(); // #1091: yield mid-scan on huge graphs
    const content = ctx.readFile(file);
    if (!content || (!content.includes('</') && !content.includes('/>'))) continue; // JSX-file gate
    const parents = ctx.getNodesInFile(file).filter((n) => PARENT_KINDS.has(n.kind));
    for (const parent of parents) {
      const src = sliceLines(content, parent.startLine, parent.endLine);
      if (!src || (!src.includes('</') && !src.includes('/>'))) continue;
      const names = new Set<string>();
      JSX_TAG_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = JSX_TAG_RE.exec(src))) names.add(m[1]!);
      let added = 0;
      for (const name of names) {
        if (added >= MAX_JSX_CHILDREN) break;
        const child = ctx.getNodesByName(name).find(
          (n) => n.kind === 'component' || n.kind === 'function' || n.kind === 'class'
        );
        if (!child || child.id === parent.id) continue;
        const key = `${parent.id}>${child.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: parent.id, target: child.id, kind: 'calls', line: parent.startLine,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'jsx-render', via: name },
        });
        added++;
      }
    }
  }
  return edges;
}

/**
 * Phase 6: Vue SFC templates. The `.vue` extractor only parses `<script>`, so
 * template usage is invisible — child components and event handlers used ONLY in
 * the template have no edge to them. PascalCase children (`<VPNav/>`) are already
 * caught by reactJsxChildEdges (which scans the SFC component node), so this adds
 * the two Vue-specific shapes:
 *   - kebab-case children: `<el-button>` → `ElButton` component (renders).
 *   - event bindings: `@click="onClick"` / `v-on:submit="save"` → handler method.
 * Scoped to the `<template>` block of `.vue` files; resolution gate (kebab→
 * component, handler→function/method) keeps precision; inline arrows / `$emit`
 * skipped.
 */
function vueTemplateEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const COMPONENT_KINDS = new Set(['component', 'function', 'class']);
  const HANDLER_KINDS = new Set(['method', 'function']);
  // A composable's returned member may be a fn (`function close(){}`) or an
  // arrow assigned to a const (`const close = () => {}`).
  const RETURN_KINDS = new Set(['method', 'function', 'variable', 'constant']);
  // Nuxt auto-imports nested components by a DIRECTORY-PREFIXED name —
  // `components/media/Card.vue` is used as `<MediaCard/>`, not `<Card/>` — but
  // the component node is named by basename (`Card`), so a direct tag match
  // misses it (flat components match by basename and don't need this). Map each
  // nested component's Nuxt name → node so those template usages resolve.
  const nuxtComponents = new Map<string, Node>();
  for (const c of ctx.getNodesByKind('component')) {
    const nn = nuxtComponentName(c.filePath);
    if (nn && !nuxtComponents.has(nn)) nuxtComponents.set(nn, c);
  }
  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.vue')) continue;
    const content = ctx.readFile(file);
    const tpl = content && content.match(/<template[^>]*>([\s\S]*)<\/template>/i)?.[1];
    if (!tpl) continue;
    const comp = ctx.getNodesInFile(file).find((n) => n.kind === 'component');
    if (!comp) continue;

    // Composable-destructure map: alias → { composable, key }. Lets us resolve a
    // template handler that isn't a local function but a destructured composable
    // return (`@click="closeSidebar"` ← `const { close: closeSidebar } = useSidebarControl()`).
    const script = content.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? '';
    const destructured = new Map<string, { composable: string; key: string }>();
    VUE_DESTRUCTURE_RE.lastIndex = 0;
    let dm: RegExpExecArray | null;
    while ((dm = VUE_DESTRUCTURE_RE.exec(script))) {
      if (!/^use[A-Z]/.test(dm[2]!)) continue; // composables / hooks only
      for (const part of dm[1]!.split(',')) {
        const pm = part.trim().match(/^(\w+)\s*(?::\s*(\w+))?$/); // key | key: alias
        if (pm) destructured.set(pm[2] || pm[1]!, { composable: dm[2]!, key: pm[1]! });
      }
    }

    let added = 0;
    const addEdge = (target: Node | undefined, meta: Record<string, unknown>) => {
      if (added >= MAX_JSX_CHILDREN || !target || target.id === comp.id) return;
      const k = `${comp.id}>${target.id}>${meta.synthesizedBy}`;
      if (seen.has(k)) return;
      seen.add(k);
      edges.push({ source: comp.id, target: target.id, kind: 'calls', line: comp.startLine, provenance: 'heuristic', metadata: meta });
      added++;
    };
    // Prefer a target in THIS SFC (handlers live in the same file's script) —
    // avoids cross-file mis-match when a name repeats across a monorepo.
    const resolve = (name: string, kinds: Set<string>): Node | undefined => {
      const matches = ctx.getNodesByName(name).filter((n) => kinds.has(n.kind));
      return matches.find((n) => n.filePath === file) ?? matches[0];
    };

    let m: RegExpExecArray | null;
    VUE_KEBAB_RE.lastIndex = 0;
    while ((m = VUE_KEBAB_RE.exec(tpl))) {
      const tag = kebabToPascal(m[1]!);
      addEdge(resolve(tag, COMPONENT_KINDS) ?? nuxtComponents.get(tag), { synthesizedBy: 'jsx-render', via: m[1] });
    }
    // PascalCase component tags. Try a direct name match first (flat components
    // and explicit registrations), then the Nuxt dir-prefixed auto-import name
    // (`<MediaCard>` → components/media/Card.vue). Built-ins match neither → no edge.
    VUE_PASCAL_RE.lastIndex = 0;
    while ((m = VUE_PASCAL_RE.exec(tpl))) {
      const tag = m[1]!;
      addEdge(resolve(tag, COMPONENT_KINDS) ?? nuxtComponents.get(tag), { synthesizedBy: 'jsx-render', via: tag });
    }
    VUE_HANDLER_RE.lastIndex = 0;
    while ((m = VUE_HANDLER_RE.exec(tpl))) {
      const event = m[1]!;
      const expr = m[2]!.trim();
      if (expr.includes('=>') || expr.startsWith('$')) continue; // inline arrow / $emit
      const name = expr.match(/^([A-Za-z_]\w*)/)?.[1];
      if (!name) continue;
      const direct = resolve(name, HANDLER_KINDS);
      if (direct) { addEdge(direct, { synthesizedBy: 'vue-handler', event }); continue; }
      // Composable-destructure handler → resolve to the composable's returned fn.
      const d = destructured.get(name);
      if (!d) continue;
      const composable = resolve(d.composable, HANDLER_KINDS);
      // Resolve to the SPECIFIC returned member (e.g. `close`) defined in the
      // composable's file. No fallback to the composable itself — the component
      // already has a static `useX()` call edge, so that would just be redundant
      // and less precise.
      const keyFn = composable
        ? ctx.getNodesByName(d.key).find((n) => RETURN_KINDS.has(n.kind) && n.filePath === composable.filePath)
        : undefined;
      if (keyFn) addEdge(keyFn, { synthesizedBy: 'vue-handler', event, via: d.composable });
    }
  }
  return edges;
}

/**
 * React Native cross-language event channel (Phase 3 of the mixed-iOS/RN
 * bridging effort). Same shape as `eventEmitterEdges` but cross-language:
 *
 *   Native (ObjC, on RCTEventEmitter subclass):
 *     [self sendEventWithName:@"locationUpdate" body:@{...}];
 *
 *   Native (Java/Kotlin, via the JS module dispatcher):
 *     emitter.emit("locationUpdate", body);
 *     reactContext.getJSModule(RCTDeviceEventEmitter.class).emit("locationUpdate", body);
 *
 *   JS (subscriber):
 *     new NativeEventEmitter(NativeModules.Geo).addListener("locationUpdate", handler);
 *     DeviceEventEmitter.addListener("locationUpdate", handler);
 *
 * Synthesize: native dispatch site → JS handler, keyed by the literal
 * event name. Only matches NAMED handlers (the existing `ON_RE` named-
 * capture form). Inline arrow handlers like `addListener('x', d => …)`
 * aren't named at extraction time and would need link-through-body
 * support; matches the deliberate scope of the in-language synthesizer.
 *
 * Provenance `'heuristic'`, synthesizedBy `'rn-event-channel'`.
 */
// ObjC's `[self sendEventWithName:@"X" body:...]` shape (bracket syntax,
// `@` string literals).
const RN_OBJC_SEND_RE = /\bsendEventWithName\s*:\s*@"([^"]+)"/g;
// Swift's `sendEvent(withName: "X", body: ...)` shape — same RCTEventEmitter
// method, different call syntax. Both Objective-C and Swift subclass
// RCTEventEmitter so this catches the Swift-side equivalent emission sites
// (e.g. RNFusedLocation.swift's `sendEvent(withName: "geolocationDidChange",
// body: locationData)`).
const RN_SWIFT_SEND_RE = /\bsendEvent\s*\(\s*withName\s*:\s*"([^"]+)"/g;
// JVM-side emitter calls: `emitter.emit("X", body)`. Matches both Java
// and Kotlin syntax because the call form is identical. Restricted to
// JVM source files in the consumer so we don't re-process JS emits
// (which `eventEmitterEdges` already handles).
const RN_JVM_EMIT_RE = /\.emit\s*\(\s*"([^"]+)"\s*,/g;
// Custom `sendEvent(reactContext, "X", body)` wrapper — extremely common
// (react-native-device-info and many libs wrap `DeviceEventManagerModule…emit`
// behind a helper whose `.emit(eventName, …)` uses a VARIABLE, so RN_JVM_EMIT_RE
// misses it; the literal lives in the wrapper CALL instead). Captures the first
// string literal inside a `sendEvent(...)` call. `[^;{}]*?` keeps it on one
// statement and stops at a block boundary, so the wrapper DEFINITION (whose `(`
// is followed by `… ) {`) never matches. Multi-line tolerant. (java/kotlin/swift)
const RN_NATIVE_SENDEVENT_RE = /\bsendEvent\s*\([^;{}]*?"([^"]+)"/g;

function rnEventEdges(ctx: ResolutionContext): Edge[] {
  // Native dispatchers (source = the native method whose body sends the
  // event) and JS handlers (target = the function/method registered as
  // the listener) keyed by event name.
  const nativeDispatchersByEvent = new Map<string, Set<string>>();
  const jsHandlersByEvent = new Map<string, Map<string, string>>();

  for (const file of ctx.getAllFiles()) {
    const content = ctx.readFile(file);
    if (!content) continue;

    const nodesInFile = ctx.getNodesInFile(file);
    const lineOf = (idx: number) => content.slice(0, idx).split('\n').length;
    const addDispatcher = (event: string, line: number) => {
      const disp = enclosingFn(nodesInFile, line);
      if (!disp) return;
      const set = nativeDispatchersByEvent.get(event) ?? new Set<string>();
      set.add(disp.id);
      nativeDispatchersByEvent.set(event, set);
    };

    // ObjC side: `sendEventWithName:@"X"` only fires inside `.m`/`.mm`
    // files (RCTEventEmitter subclasses).
    if (file.endsWith('.m') || file.endsWith('.mm')) {
      RN_OBJC_SEND_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = RN_OBJC_SEND_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index));
      }
    }

    // Swift side: same RCTEventEmitter method, parens/named-args syntax.
    if (file.endsWith('.swift')) {
      RN_SWIFT_SEND_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = RN_SWIFT_SEND_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index));
      }
      RN_NATIVE_SENDEVENT_RE.lastIndex = 0;
      while ((m = RN_NATIVE_SENDEVENT_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index));
      }
    }

    // JVM side: `.emit("X", …)` in Java/Kotlin, plus the common
    // `sendEvent(ctx, "X", body)` wrapper. (We pattern-match anywhere in the
    // file; the JS in-language path uses a separate emitter object pattern and
    // is already handled by eventEmitterEdges.)
    if (file.endsWith('.java') || file.endsWith('.kt')) {
      let m: RegExpExecArray | null;
      RN_JVM_EMIT_RE.lastIndex = 0;
      while ((m = RN_JVM_EMIT_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index));
      }
      RN_NATIVE_SENDEVENT_RE.lastIndex = 0;
      while ((m = RN_NATIVE_SENDEVENT_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index));
      }
    }

    // JS subscribers (.addListener("X", handler)). Restrict to JS-family
    // files so a native file's `addListener:` (the ObjC method) doesn't
    // get mistaken for a JS subscription — they're entirely different
    // things despite sharing a name.
    if (
      file.endsWith('.js') ||
      file.endsWith('.jsx') ||
      file.endsWith('.ts') ||
      file.endsWith('.tsx') ||
      file.endsWith('.mjs') ||
      file.endsWith('.cjs')
    ) {
      // Match BOTH the named-handler form (`.addListener('x', fn)`) and
      // an unnamed-handler form (`.addListener('x', listener)` where
      // `listener` is a parameter — common in RN wrapper APIs like
      // RNFirebase's `messaging().onMessageReceived(listener)`). For the
      // unnamed case we attribute the subscription to the ENCLOSING JS
      // function (the abstraction layer), giving a reachability-correct
      // hop even when the actual user-side handler lives one call up.
      const ADDLISTENER_ANY = /\.(?:on|once|addListener)\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_][\w.]*)/g;
      ADDLISTENER_ANY.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ADDLISTENER_ANY.exec(content))) {
        const event = m[1];
        const arg = m[2];
        if (!event || !arg) continue;
        const bareName = arg.includes('.') ? arg.slice(arg.lastIndexOf('.') + 1) : arg;
        // Try a named-symbol match first (matches the in-language semantic).
        const namedHandler = ctx
          .getNodesByName(bareName)
          .find((n) => n.kind === 'function' || n.kind === 'method');
        let targetId: string | null = namedHandler?.id ?? null;
        if (!targetId) {
          // Fall back to the enclosing function — the subscribe-wrapper
          // pattern means the event fires THROUGH this function on its
          // way to user code. Reachability-correct attribution.
          const enclosing = enclosingFn(nodesInFile, lineOf(m.index));
          targetId = enclosing?.id ?? null;
        }
        if (!targetId) {
          // Broader fallback for JS object-literal API shape
          // (`const Foo = { watchX(...) { … addListener(...) … } }`):
          // method shorthand inside an object literal isn't extracted
          // as a method node, so enclosingFn returns null. Attribute to
          // the smallest enclosing `constant` / `variable` node — that's
          // the API surface a downstream caller would `import` and
          // invoke. Reachability-correct.
          const line = lineOf(m.index);
          let smallest: typeof nodesInFile[number] | null = null;
          for (const n of nodesInFile) {
            if (n.kind !== 'constant' && n.kind !== 'variable') continue;
            const end = n.endLine ?? n.startLine;
            if (n.startLine <= line && end >= line) {
              if (!smallest || n.startLine >= smallest.startLine) smallest = n;
            }
          }
          targetId = smallest?.id ?? null;
        }
        if (!targetId) continue;
        const map = jsHandlersByEvent.get(event) ?? new Map<string, string>();
        map.set(targetId, `${file}:${lineOf(m.index)}`);
        jsHandlersByEvent.set(event, map);
      }
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [event, dispatchers] of nativeDispatchersByEvent) {
    const handlers = jsHandlersByEvent.get(event);
    if (!handlers) continue;
    // Same fan-out guard as the in-language channel: generic event names
    // (e.g. 'change', 'error', 'data') with many handlers/dispatchers
    // can't be matched precisely without receiver-type info.
    if (dispatchers.size > EVENT_FANOUT_CAP || handlers.size > EVENT_FANOUT_CAP) continue;
    for (const d of dispatchers) {
      for (const [h, registeredAt] of handlers) {
        if (d === h) continue;
        const key = `${d}>${h}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: d,
          target: h,
          kind: 'calls',
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'rn-event-channel', event, registeredAt },
        });
      }
    }
  }
  return edges;
}

/**
 * Phase 6 — React Native Fabric/Codegen view component bridge.
 *
 * The Fabric framework extractor (`frameworks/fabric.ts`) emits
 * `component` nodes named after the JS-visible component (e.g.
 * `RNSScreenStack`) from each `codegenNativeComponent<Props>('Name')`
 * spec declaration. The native implementation lives in an ObjC++/.mm or
 * Kotlin/Java class whose name follows one of RN's conventions:
 *
 *   - Exact: `RNSScreenStack`
 *   - With suffix: `RNSScreenStackView`, `RNSScreenStackViewManager`,
 *     `RNSScreenStackComponentView`, `RNSScreenStackManager`
 *
 * This synthesizer walks every Fabric component node and looks for a
 * native class matching one of those names; when found, emits a
 * `calls` edge `component → native class` (provenance `'heuristic'`,
 * `synthesizedBy:'fabric-native-impl'`) so trace from JSX usage of the
 * component continues into native.
 *
 * The convention-based suffix lookup is precise: there's no name
 * collision in RN view-manager codebases by design (Codegen output would
 * conflict otherwise).
 */
const FABRIC_NATIVE_SUFFIXES = ['', 'View', 'ViewManager', 'ComponentView', 'Manager'];

/**
 * Expo Modules cross-platform pairing. An Expo Module exposes the SAME
 * JS-visible method (`AsyncFunction("getBatteryLevelAsync")`) from BOTH an iOS
 * (Swift) and an Android (Kotlin) implementation. A JS callsite name-resolves to
 * only ONE of them, so the other platform's impl looked like nothing called it
 * (and editing it showed no blast radius). Link the iOS and Android impls of the
 * same `<module>.<method>` to each other (both directions), so a JS call that
 * reaches one platform reaches the other, and editing either surfaces the JS
 * caller. The Expo method nodes are id-prefixed `expo-module:` and qualified
 * `<file>::<module>.<method>` by the framework extractor.
 */
function expoCrossPlatformEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const byKey = new Map<string, Node[]>();
  for (const m of queries.getNodesByKind('method')) {
    if (!m.id.startsWith('expo-module:')) continue;
    const key = m.qualifiedName.split('::').pop(); // `<module>.<method>`
    if (!key) continue;
    const arr = byKey.get(key);
    if (arr) arr.push(m);
    else byKey.set(key, [m]);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const a of group) {
      for (const b of group) {
        if (a.id === b.id || a.language === b.language) continue; // cross-platform only
        const key = `${a.id}>${b.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: a.id,
          target: b.id,
          kind: 'calls',
          line: a.startLine,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'expo-cross-platform', via: a.name },
        });
      }
    }
  }
  return edges;
}

/**
 * Classic React Native NativeModules cross-platform pairing. A native module
 * method (`@ReactMethod` on Android, `RCT_EXPORT_METHOD` on iOS) is implemented
 * on BOTH platforms, but a JS callsite name-resolves to only ONE — so the other
 * platform's impl looked like nothing called it. A native method that HAS a JS
 * caller is a confirmed bridge method; link it to the same-named native method
 * in another language (the other platform's impl) so a JS call reaching one
 * platform reaches the other, and editing either surfaces the JS caller.
 *
 * Names are normalized to the first selector keyword (`getFreeDiskStorage:` →
 * `getFreeDiskStorage`) — that's the JS-visible name, and how the iOS selector
 * lines up with the bare Android method name.
 */
function rnCrossPlatformEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const NATIVE = new Set(['java', 'kotlin', 'objc', 'cpp']);
  const JS = new Set(['typescript', 'tsx', 'javascript', 'jsx']);
  // RN module INFRASTRUCTURE methods exist on every native module (called by the
  // RN runtime, not user JS), so pairing them by name would cross-link unrelated
  // modules in a multi-module repo. Skip them — they aren't user-facing methods.
  const RN_INFRA = new Set([
    'addListener', 'removeListeners', 'getConstants', 'constantsToExport', 'getName',
    'invalidate', 'initialize', 'getDefaultEventTypes', 'supportedEvents',
    'requiresMainQueueSetup', 'methodQueue',
  ]);
  const norm = (name: string): string => {
    const i = name.indexOf(':');
    return i >= 0 ? name.slice(0, i) : name;
  };

  // Index native methods by their JS-visible (normalized) name. Only names with
  // impls in ≥2 native languages can pair, so the per-method JS-caller check
  // below only runs for genuine cross-platform candidates.
  const byName = new Map<string, Node[]>();
  for (const m of queries.iterateNodesByKind('method')) {
    if (!NATIVE.has(m.language)) continue;
    const key = norm(m.name);
    const arr = byName.get(key);
    if (arr) arr.push(m);
    else byName.set(key, [m]);
  }

  for (const [groupName, group] of byName) {
    if (RN_INFRA.has(groupName)) continue;
    const langs = new Set(group.map((m) => m.language));
    if (langs.size < 2) continue; // single-platform — nothing to pair
    for (const m of group) {
      // Is m a bridge method? (a JS-language `calls` edge points at it)
      const incoming = queries.getIncomingEdges(m.id, ['calls']);
      if (incoming.length === 0) continue;
      const sources = queries.getNodesByIds(incoming.map((e) => e.source));
      const isBridge = incoming.some((e) => {
        const s = sources.get(e.source);
        return !!s && JS.has(s.language);
      });
      if (!isBridge) continue;
      // Link to the other-platform impls (both directions).
      for (const sib of group) {
        if (sib.id === m.id || sib.language === m.language) continue;
        for (const [a, b] of [[m, sib], [sib, m]] as const) {
          const key = `${a.id}>${b.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({
            source: a.id,
            target: b.id,
            kind: 'calls',
            line: a.startLine,
            provenance: 'heuristic',
            metadata: { synthesizedBy: 'rn-cross-platform', via: norm(m.name) },
          });
        }
      }
    }
  }
  return edges;
}

function fabricNativeImplEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();

  // The Fabric extractor IDs are prefixed `fabric-component:` so we can
  // filter to just those without iterating all `component` nodes.
  const components = ctx.getNodesByKind('component').filter((n) => n.id.startsWith('fabric-component:'));
  if (components.length === 0) return edges;

  // Pre-index native classes by name for O(1) lookup.
  const nativeClassesByName = new Map<string, Node[]>();
  for (const n of ctx.getNodesByKind('class')) {
    if (n.language !== 'objc' && n.language !== 'kotlin' && n.language !== 'java' && n.language !== 'cpp') continue;
    const arr = nativeClassesByName.get(n.name);
    if (arr) arr.push(n);
    else nativeClassesByName.set(n.name, [n]);
  }

  for (const component of components) {
    for (const suffix of FABRIC_NATIVE_SUFFIXES) {
      const candidate = component.name + suffix;
      const matches = nativeClassesByName.get(candidate);
      if (!matches || matches.length === 0) continue;
      // Link the component node to every matching native class (iOS +
      // Android each have one).
      for (const native of matches) {
        const key = `${component.id}>${native.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: component.id,
          target: native.id,
          kind: 'calls',
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'fabric-native-impl',
            viaSuffix: suffix || '(exact)',
            componentName: component.name,
          },
        });
      }
    }
  }

  return edges;
}

/**
 * MyBatis: link a Java mapper interface method to the XML statement that holds
 * its SQL. The XML extractor (`src/extraction/mybatis-extractor.ts`) qualifies
 * each `<select|insert|update|delete|sql id="X">` as `<namespace>::<id>` where
 * `<namespace>` is the Java FQN of the mapper interface. A Java method's
 * qualifiedName ends with `<ClassName>::<methodName>`, so we suffix-match the
 * last two segments of the XML qualified name to find a unique Java method by
 * `<ClassName>::<methodName>` (`ClassName` = last dotted segment of the XML
 * namespace). Cross-mapper `<include refid="other.X">` references go through
 * the normal qualified-name resolver — only the Java↔XML bridge is synthetic.
 *
 * Precision over recall: ambiguous mappers (multiple Java classes with the
 * same simple name) are dropped. We need-not bridge by package because Java
 * mapper interfaces are typically uniquely named within a project.
 */
function mybatisJavaXmlEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  // Index Java methods by `<ClassName>::<methodName>` for O(1) lookup.
  const javaIndex = new Map<string, Node[]>();
  for (const m of queries.iterateNodesByKind('method')) {
    if (m.language !== 'java' && m.language !== 'kotlin') continue;
    const parts = m.qualifiedName.split('::');
    const last = parts[parts.length - 1];
    const cls = parts[parts.length - 2];
    if (!last || !cls) continue;
    const key = `${cls}::${last}`;
    const arr = javaIndex.get(key);
    if (arr) arr.push(m); else javaIndex.set(key, [m]);
  }

  for (const xml of queries.iterateNodesByKind('method')) {
    if (xml.language !== 'xml') continue;
    // Qualified name: `<namespace>::<id>`. Extract the simple class name.
    const colonIdx = xml.qualifiedName.lastIndexOf('::');
    if (colonIdx < 0) continue;
    const namespace = xml.qualifiedName.slice(0, colonIdx);
    const id = xml.qualifiedName.slice(colonIdx + 2);
    if (!namespace || !id) continue;
    const dotIdx = namespace.lastIndexOf('.');
    const className = dotIdx >= 0 ? namespace.slice(dotIdx + 1) : namespace;
    const candidates = javaIndex.get(`${className}::${id}`);
    if (!candidates || candidates.length === 0) continue;
    // Drop ambiguous matches (multiple same-name classes); the user can
    // disambiguate by adding the package-suffix match in a future enhancement.
    if (candidates.length > 1) continue;
    const java = candidates[0]!;
    const key = `${java.id}>${xml.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      source: java.id,
      target: xml.id,
      kind: 'calls',
      line: java.startLine,
      provenance: 'heuristic',
      metadata: {
        synthesizedBy: 'mybatis-java-xml',
        via: `${className}.${id}`,
        registeredAt: `${xml.filePath}:${xml.startLine}`,
      },
    });
  }
  return edges;
}

/**
 * Gin middleware chain. Gin runs its entire handler chain through one dynamic
 * line in `(*Context).Next`:
 *     for c.index < len(c.handlers) { c.handlers[c.index](c); c.index++ }
 * `c.handlers` is a `HandlersChain` (`[]HandlerFunc`) assembled at registration
 * time by `combineHandlers` from the funcs passed to `r.Use(...)` /
 * `r.GET("/path", h...)` / `r.Handle(...)`. Because the call is a computed index
 * into a runtime-built slice, tree-sitter resolves `c.handlers[c.index](c)` to
 * NOTHING — so `callees(Next)` is just the `len()` helper and the flow
 * `ServeHTTP → handleHTTPRequest → Next` dead-ends at the exact symbol the
 * "how do requests flow through the middleware chain" question is about. The
 * agent then re-queries Next and falls back to Read/grep (validated: the gin
 * WITH-arm rabbit-holed on precisely this dead-end).
 *
 * Bridge it: find the chain DISPATCHER (a Go method whose body invokes a
 * `handlers` slice by index) and link it → every HandlerFunc registered via a
 * gin registration call, so `callees(Next)` and `trace(ServeHTTP, <handler>)`
 * connect end-to-end. Named handlers only (`gin.Logger()` → `Logger`,
 * `authMiddleware`); inline closures are anonymous and skipped. Like
 * react-render / interface-impl this is a deliberate over-approximation —
 * reachability-correct (any registered handler CAN run for some route), capped,
 * and gated on the dispatcher existing so it never runs on non-gin Go repos.
 * Provenance `heuristic`, `synthesizedBy:'gin-middleware-chain'`; `registeredAt`
 * is the `.Use`/`.GET` site an agent would otherwise grep for.
 */
const GIN_DISPATCH_RE = /\.handlers\s*\[[^\]]*\]\s*\(/;                 // c.handlers[c.index](c)
const GIN_REG_RE = /\.(?:Use|GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any|Handle)\s*\(/g;

/** Balanced `(...)` body starting at the '(' index; null if unbalanced. */
function goBalancedArgs(s: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return s.slice(openIdx + 1, i); }
  }
  return null;
}
/** Split a top-level comma list, respecting nested () [] {}. */
function goSplitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const c of args) {
    if (c === '(' || c === '[' || c === '{') { depth++; cur += c; }
    else if (c === ')' || c === ']' || c === '}') { depth--; cur += c; }
    else if (c === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
/** Tail ident of a handler arg: `gin.Logger()`→`Logger`, `mw`→`mw`; null for string paths / closures. */
function goHandlerIdent(expr: string): string | null {
  const cleaned = expr.trim().replace(/\(\s*\)$/, '');                  // drop a trailing call ()
  if (!cleaned || cleaned.startsWith('"') || cleaned.startsWith('`') || cleaned.startsWith('func')) return null;
  const m = cleaned.match(/(?:\.|^)([A-Za-z_]\w*)$/);
  return m ? m[1]! : null;
}

function ginMiddlewareChainEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  // 1. Find the chain dispatcher(s): a Go method that invokes a `handlers` slice by index.
  const dispatchers: Node[] = [];
  for (const n of queries.iterateNodesByKind('method')) {
    if (n.language !== 'go') continue;
    const content = ctx.readFile(n.filePath);
    const src = content && sliceLines(content, n.startLine, n.endLine);
    if (src && GIN_DISPATCH_RE.test(src)) dispatchers.push(n);
  }
  if (dispatchers.length === 0) return [];                              // not a gin repo — bail

  // 2. Collect handler identifiers registered via gin registration calls
  //    (.Use / .GET / … / .Handle). String args (paths/methods) and inline
  //    closures are dropped by goHandlerIdent; the rest are HandlerFuncs.
  const registered = new Map<string, string>();                         // name → registeredAt (file:line)
  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.go')) continue;
    const content = ctx.readFile(file);
    if (!content || (!content.includes('.Use(') && !/\.(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any|Handle)\(/.test(content))) continue;
    const safe = stripCommentsForRegex(content, 'go');
    GIN_REG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = GIN_REG_RE.exec(safe))) {
      const parenIdx = m.index + m[0].length - 1;
      const argStr = goBalancedArgs(safe, parenIdx);
      if (!argStr) continue;
      const line = safe.slice(0, m.index).split('\n').length;
      for (const arg of goSplitArgs(argStr)) {
        const name = goHandlerIdent(arg);
        if (name && !registered.has(name)) registered.set(name, `${file}:${line}`);
      }
    }
  }
  if (registered.size === 0) return [];

  // 3. Link each dispatcher → each registered handler node (dedup, capped).
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const disp of dispatchers) {
    let added = 0;
    for (const [name, registeredAt] of registered) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      const handler = ctx.getNodesByName(name).find(
        (n) => (n.kind === 'function' || n.kind === 'method') && n.language === 'go'
      );
      if (!handler || handler.id === disp.id) continue;
      const key = `${disp.id}>${handler.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: disp.id, target: handler.id, kind: 'calls', line: disp.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'gin-middleware-chain', via: name, registeredAt },
      });
      added++;
    }
  }
  return edges;
}

/**
 * Delphi form code-behind: a form unit `UFRMAbout.pas` owns its visual form
 * definition `UFRMAbout.dfm` (VCL) / `.fmx` (FireMonkey) — paired by basename in
 * the same directory, wired by the `{$R *.dfm}` directive rather than a `uses`
 * clause. Link the unit → its form so a `.dfm`/`.fmx` used only as a form
 * definition isn't orphaned, and editing the form surfaces its code-behind unit.
 */
function pascalFormEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const allFiles = new Set(ctx.getAllFiles());
  for (const file of allFiles) {
    if (!/\.(dfm|fmx)$/i.test(file)) continue;
    const pasFile = file.replace(/\.(dfm|fmx)$/i, '.pas');
    if (!allFiles.has(pasFile)) continue;
    const formNode = ctx.getNodesInFile(file).find((n) => n.kind === 'file');
    const unitNode = ctx.getNodesInFile(pasFile).find((n) => n.kind === 'file');
    if (!formNode || !unitNode) continue;
    edges.push({
      source: unitNode.id,
      target: formNode.id,
      kind: 'references',
      line: unitNode.startLine,
      provenance: 'heuristic',
      metadata: { synthesizedBy: 'pascal-form', registeredAt: pasFile },
    });
  }
  return edges;
}

/**
 * SvelteKit file-convention data flow. A route directory's `+page.svelte` (a
 * `component` node) receives its `data` from the sibling `+page.server.{ts,js}`
 * / `+page.{ts,js}` `load` function and posts forms to its `actions` — wired by
 * the framework BY FILE PATH, with no static import between them. So editing a
 * `load` shows no impact on the page it feeds, and the page looks like it has no
 * server-side dependency. Link the page component to its sibling loader's
 * `load` / `actions` (same for `+layout`). The pairing is path-deterministic
 * (same directory, matching `+page`/`+layout` prefix), so it's precise — but
 * it's a framework-convention edge, so provenance stays `heuristic`.
 *
 * Direction: page → load, so `getImpactRadius(load)` surfaces the page (editing
 * a loader's data shows the page it feeds) and the page's dependencies include
 * its loader.
 */
function svelteKitLoadEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const allFiles = new Set(ctx.getAllFiles());
  const HOOKS = new Set(['load', 'actions']);
  const HOOK_KINDS = new Set(['function', 'method', 'constant', 'variable']);
  for (const file of allFiles) {
    const m = file.match(/(.*\/)(\+(?:page|layout))\.svelte$/);
    if (!m) continue;
    const dir = m[1]!;
    const prefix = m[2]!;
    const page = ctx.getNodesInFile(file).find((n) => n.kind === 'component');
    if (!page) continue;
    for (const ext of ['.server.ts', '.server.js', '.ts', '.js']) {
      const loaderFile = `${dir}${prefix}${ext}`;
      if (!allFiles.has(loaderFile)) continue;
      for (const hook of ctx.getNodesInFile(loaderFile)) {
        if (!HOOK_KINDS.has(hook.kind) || !HOOKS.has(hook.name)) continue;
        edges.push({
          source: page.id,
          target: hook.id,
          kind: 'references',
          line: page.startLine,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'sveltekit-load',
            via: hook.name,
            registeredAt: `${loaderFile}:${hook.startLine ?? 0}`,
          },
        });
      }
    }
  }
  return edges;
}

/**
 * Redux-thunk dispatch chain. `export const X = createAsyncThunk(prefix, async (a, api) => {...})`
 * (or a wrapper like trezor's `createThunk(...)`) passes the async body as an ARGUMENT, so
 * tree-sitter never extracts it as a function node: `X` is a `constant` whose body's calls are
 * ORPHANED. The `dispatch(nextThunk(...))` calls that drive a thunk chain forward therefore produce
 * no edges, so `callees(X)` is empty and a flow `dispatch(X(...)) → X → nextThunk` dead-ends at the
 * constant (validated on trezor-suite: the signXxxThunk constants had ZERO outgoing edges). Bridge
 * it: body-scan each thunk constant for `dispatch(Y(...))` and link `X → Y`, so the dispatch chain
 * connects. High-precision — the `dispatch(` keyword plus `Y` must resolve to a function/constant/
 * method node; capped; gated on thunk constants existing so it never runs on non-RTK repos.
 * Cross-file by design (a suite thunk dispatches a wallet-core thunk). Provenance `heuristic`,
 * `synthesizedBy:'redux-thunk'`; `registeredAt` is the dispatch site.
 */
const THUNK_DECL_RE = /create(?:Async)?Thunk/;
const THUNK_DISPATCH_RE = /\bdispatch\s*\(\s*([A-Za-z_]\w*)\s*[(),]/g;
const THUNK_FANOUT_CAP = 24;

function reduxThunkEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const node of queries.iterateNodesByKind('constant')) {
    // Cheap gate: the initializer (captured in `signature`) must be a create(Async)Thunk call —
    // avoids reading every constant's body on a large repo.
    if (!node.signature || !THUNK_DECL_RE.test(node.signature)) continue;
    const content = ctx.readFile(node.filePath);
    const src = content && sliceLines(content, node.startLine, node.endLine);
    if (!src) continue;
    // Thunks are TS/JS-family (same // and /* */ comment syntax); map to a CommentLang.
    const safe = stripCommentsForRegex(src, node.language === 'javascript' || node.language === 'jsx' ? 'javascript' : 'typescript');
    THUNK_DISPATCH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let added = 0;
    while ((m = THUNK_DISPATCH_RE.exec(safe)) && added < THUNK_FANOUT_CAP) {
      const name = m[1]!;
      if (name === node.name) continue; // self-dispatch (recursive thunk) — skip
      // Resolve the dispatched name, PREFERRING the thunk/action-creator over a same-named
      // service function. `dispatch(X(...))` dispatches a thunk or an action-creator (both
      // `constant`s) — never an unrelated helper that merely shares the name. On octo-call,
      // `leaveCall` is BOTH a `createAsyncThunk` const AND a service function, and the bare
      // `.find()` picked the function (wrong). Order: thunk const > other const > same-file
      // callable > first match. A single candidate (no collision) is unaffected.
      const cands = ctx
        .getNodesByName(name)
        .filter((n) => n.kind === 'constant' || n.kind === 'function' || n.kind === 'method');
      const target =
        cands.find((n) => !!n.signature && THUNK_DECL_RE.test(n.signature)) ??
        cands.find((n) => n.kind === 'constant') ??
        cands.find((n) => n.filePath === node.filePath) ??
        cands[0];
      if (!target || target.id === node.id) continue;
      const key = `${node.id}>${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = node.startLine + safe.slice(0, m.index).split('\n').length - 1;
      edges.push({
        source: node.id,
        target: target.id,
        kind: 'calls',
        line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'redux-thunk', via: name, registeredAt: `${node.filePath}:${line}` },
      });
      added++;
    }
  }
  return edges;
}

// ── Object-literal registry dispatch ─────────────────────────────────────────
// A command/handler registry maps string keys → handler class/function symbols in an
// object literal, then dispatches by a RUNTIME key static parsing can't follow:
//   this.commands = { [Cmd.ADD]: AddObjectCommand, ... }    // registration
//   new this.commands[command](args).execute()              // dynamic dispatch
// Bridge it like gin-middleware-chain: link each dispatching function → each registered
// handler's callable entry (a class's execute/run/handle/… method — preferring the method
// chained at the dispatch site — or the function value). Scoped to a registry + dispatch in
// the SAME file (the cross-file barrel-namespace variant, e.g. trezor's getMethod, is
// deferred). Gated on a real object literal with ≥2 entries that RESOLVE to callables (a
// `{ width: 5 }` literal resolves to nothing → no edges); fan-out capped.
const REGISTRY_ASSIGN_RE = /(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)|((?:this\.)?[A-Za-z_$][\w$]*))\s*=\s*\{/g;
const REGISTRY_DISPATCH_RE = /(?:\bnew\s+)?((?:this\.)?[A-Za-z_$][\w$]*)\s*\[\s*([A-Za-z_$][\w$.]*)\s*\]\s*(?:\(|\.[A-Za-z_$])/g;
const REGISTRY_MIN_ENTRIES = 2;
const REGISTRY_FANOUT_CAP = 40;
const REGISTRY_CLASS_ENTRY = new Set(['execute', 'run', 'handle', 'perform', 'process', 'call', 'apply', 'dispatch']);
const REGISTRY_JS_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

/** From the index of an opening `{`, return the brace-balanced body up to its matching `}`. */
function braceBody(src: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(openIdx + 1, i);
  }
  return null;
}

/** Top-level `key: Identifier` entries of an object-literal body. DEPTH-AWARE: only depth-0
 *  segments are considered, so method-shorthand bodies (`number(a,b){…}`), arrow values
 *  (`x: () => …`), and nested objects (`x: { … }`) don't leak their inner `k: v` pairs as
 *  bogus handlers. The per-segment anchor (`^… key: Ident …$`) keeps only pure identifier
 *  values — a data value (`x: 5`), call, or arrow fails to match. */
function registryEntryNames(body: string): string[] {
  const segs: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { segs.push(body.slice(start, i)); start = i + 1; }
  }
  segs.push(body.slice(start));
  const names: string[] = [];
  for (const seg of segs) {
    const m = /^\s*(?:\[[^\]]+\]|['"]?[\w$]+['"]?)\s*:\s*([A-Za-z_$][\w$]*)\s*$/.exec(seg);
    if (m && m[1]!.length >= 3 && !names.includes(m[1]!)) names.push(m[1]!);
  }
  return names;
}

/** Resolve a registered handler name to its callable entry: a function value, or a class's
 *  `execute`-like method (preferring the method chained at the dispatch site), else the class. */
function resolveRegistryHandler(ctx: ResolutionContext, name: string, chained: string | null): Node | null {
  const cands = ctx.getNodesByName(name);
  const fn = cands.find((n) => n.kind === 'function');
  if (fn) return fn;
  const cls = cands.find((n) => n.kind === 'class' || n.kind === 'struct');
  if (cls) {
    const methods = ctx
      .getNodesInFile(cls.filePath)
      .filter((n) => n.kind === 'method' && n.startLine >= cls.startLine && n.startLine <= (cls.endLine ?? cls.startLine));
    const want = chained && REGISTRY_CLASS_ENTRY.has(chained) ? chained : null;
    const entry =
      (want && methods.find((m) => m.name === want)) ||
      methods.find((m) => REGISTRY_CLASS_ENTRY.has(m.name)) ||
      methods.find((m) => m.name === 'constructor');
    return entry ?? cls;
  }
  // Require a CALLABLE target — a registry dispatched as `reg[k](…)` invokes a function/
  // method, never a data `constant` (dropping it removes false positives like a `{ x: URL }`
  // entry resolving to the global URL constant).
  return cands.find((n) => n.kind === 'method') ?? null;
}

async function objectRegistryEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if ((++scanned & 255) === 0) await onYield(); // #1091: yield mid-scan on huge graphs
    if (!REGISTRY_JS_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    // Cheap pre-filter: a computed member access BY NAME (`ident[ident`) — the dispatch shape.
    if (!content || !/[\w$]\s*\[\s*[A-Za-z_$]/.test(content)) continue;
    // Skip minified/generated bundles (draco, three.min, base64…): their pervasive `h[x](...)`
    // calls + single-letter `{a:b}` literals are a false-positive minefield. Average line
    // length is the reliable tell — real source ~30–80, minified in the hundreds/thousands.
    const newlines = (content.match(/\n/g)?.length ?? 0) + 1;
    if (content.length / newlines > 200) continue;
    const safe = stripCommentsForRegex(content, /\.(?:jsx?|mjs|cjs)$/.test(file) ? 'javascript' : 'typescript');

    // 1. Dispatch sites: `(new )?<ref>[<ident-key>]` followed by a call or a chained method.
    //    A quoted-string key (`['save']`) does NOT match — that's a static access, not dispatch.
    REGISTRY_DISPATCH_RE.lastIndex = 0;
    const dispatches: Array<{ ref: string; line: number; chained: string | null }> = [];
    let dm: RegExpExecArray | null;
    while ((dm = REGISTRY_DISPATCH_RE.exec(safe))) {
      const win = safe.slice(dm.index, dm.index + 160);
      const cm = /\]\s*\([^)]*\)\s*\.\s*([A-Za-z_$][\w$]*)/.exec(win) || /\]\s*\.\s*([A-Za-z_$][\w$]*)/.exec(win);
      dispatches.push({ ref: dm[1]!, line: safe.slice(0, dm.index).split('\n').length, chained: cm ? cm[1]! : null });
    }
    if (!dispatches.length) continue;
    // Normalize a leading `this.` so a class FIELD-INITIALIZER registry (`commands = {…}`)
    // matches a `this.commands[k]` dispatch, not just the constructor form `this.commands = {…}`.
    const norm = (r: string) => r.replace(/^this\./, '');
    const refs = new Set(dispatches.map((d) => norm(d.ref)));

    // 2. Registries: an object literal assigned to a dispatched ref, ≥2 entries resolving to callables.
    REGISTRY_ASSIGN_RE.lastIndex = 0;
    const registries = new Map<string, { names: string[]; line: number }>();
    let am: RegExpExecArray | null;
    while ((am = REGISTRY_ASSIGN_RE.exec(safe))) {
      const lhs = norm(am[1] ?? am[2]!);
      if (!refs.has(lhs) || registries.has(lhs)) continue;
      const body = braceBody(safe, am.index + am[0].length - 1);
      if (!body) continue;
      const names = registryEntryNames(body); // depth-0 `key: Identifier` entries only
      if (names.length >= REGISTRY_MIN_ENTRIES) {
        registries.set(lhs, { names, line: safe.slice(0, am.index).split('\n').length });
      }
    }
    if (!registries.size) continue;

    // 3. Link each dispatcher → each registered handler's callable entry.
    const nodesInFile = ctx.getNodesInFile(file);
    for (const d of dispatches) {
      const reg = registries.get(norm(d.ref));
      if (!reg) continue;
      const disp = enclosingFn(nodesInFile, d.line);
      if (!disp) continue;
      let added = 0;
      for (const name of reg.names) {
        if (added >= REGISTRY_FANOUT_CAP) break;
        const target = resolveRegistryHandler(ctx, name, d.chained);
        if (!target || target.id === disp.id) continue;
        const key = `${disp.id}>${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: disp.id,
          target: target.id,
          kind: 'calls',
          line: d.line,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'object-registry', via: name, registeredAt: `${file}:${reg.line}` },
        });
        added++;
      }
    }
  }
  return edges;
}

// ── RTK Query generated-hook → endpoint ──────────────────────────────────────
// RTK Query generates one `useGetXQuery`/`useUpdateYMutation` hook per endpoint
// (`createApi({ endpoints: b => ({ getX: b.query(...) }) })`). Components call the
// hook; the fetch logic lives in the endpoint's queryFn. The hook↔endpoint link is
// pure NAMING CONVENTION (no static edge): strip `use` + the optional `Lazy`
// variant + the `Query|Mutation` suffix, lowercase the head → the endpoint key.
// Both are extracted as function nodes (the hook from its `export const {…}=api`
// binding, carrying a sentinel signature; the endpoint from the createApi object),
// so bridging hook→endpoint connects `component → useGetXQuery → getX → queryFn`.
// Gated on the extraction sentinel so it only ever fires on genuinely-generated
// hooks (never a hand-written `useFooQuery`), and on a SAME-FILE endpoint (RTK
// colocates the hooks and their api in one module) — 0 on any non-RTK repo.
const RTK_HOOK_DERIVE_RE = /^use([A-Z][A-Za-z0-9]*?)(?:Query|Mutation)$/;
// MUST match the signature set in tree-sitter.ts `extractRtkHookBindings`.
const RTK_GENERATED_HOOK_SIGNATURE = '= RTK Query generated hook';

/** Derive the endpoint key from a generated-hook name (`useLazyGetRecordsQuery`
 *  → `getRecords`), or null if it doesn't fit the convention. */
function rtkEndpointNameFromHook(hook: string): string | null {
  const m = RTK_HOOK_DERIVE_RE.exec(hook);
  if (!m) return null;
  let mid = m[1]!;
  if (mid.startsWith('Lazy')) mid = mid.slice(4); // useLazyGetX → getX (same endpoint)
  if (!mid) return null;
  return mid.charAt(0).toLowerCase() + mid.slice(1);
}

function rtkQueryEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const hook of queries.iterateNodesByKind('function')) {
    // Only our extracted generated-hook bindings (sentinel) — not a real hook fn.
    if (hook.signature !== RTK_GENERATED_HOOK_SIGNATURE) continue;
    const endpointName = rtkEndpointNameFromHook(hook.name);
    if (!endpointName) continue;
    // The endpoint is a same-file function by the derived name (RTK colocates the
    // api definition and its generated-hook exports in one module).
    const target = ctx
      .getNodesByName(endpointName)
      .find((n) => n.kind === 'function' && n.filePath === hook.filePath);
    if (!target || target.id === hook.id) continue;
    const key = `${hook.id}>${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      source: hook.id,
      target: target.id,
      kind: 'calls',
      line: hook.startLine,
      provenance: 'heuristic',
      metadata: { synthesizedBy: 'rtk-query', via: endpointName, registeredAt: `${hook.filePath}:${hook.startLine}` },
    });
  }
  return edges;
}

// ── Pinia useStore().action() dispatch bridge ────────────────────────────────
// A Pinia store factory `export const useXStore = defineStore(...)` exposes its
// actions as methods on the store instance; a consumer does `const s = useXStore()`
// then `s.action()`. The call is a method-on-instance with no static edge to the
// action (which lives in the store's module). Bridge it: map each factory → its
// file, bind `const <var> = useXStore()` per consumer file, and link the enclosing
// function → the `<var>.method()` action node IN THE STORE'S FILE. The same-store-
// file gate keeps it precise (a Pinia built-in like `$patch` or an unrelated
// same-named method resolves to nothing). Covers both the options and setup store
// forms uniformly (the action is a function node in the store file either way).
const PINIA_CONSUMER_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue)$/;
const PINIA_FACTORY_RE = /\b(?:export\s+)?const\s+(\w+)\s*=\s*defineStore\s*\(/g;
const PINIA_BIND_RE = /\bconst\s+(\w+)\s*=\s*(?:await\s+)?(\w+)\s*\(/g;
const PINIA_CALL_RE = /(\w+)\s*\.\s*(\w+)\s*\(/g;
const PINIA_FANOUT_CAP = 80;

function piniaStoreEdges(ctx: ResolutionContext): Edge[] {
  // 1. Map each `const useXStore = defineStore(...)` factory → its store file.
  const factoryFile = new Map<string, string>();
  for (const file of ctx.getAllFiles()) {
    if (!PINIA_CONSUMER_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || !content.includes('defineStore')) continue;
    PINIA_FACTORY_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PINIA_FACTORY_RE.exec(content))) factoryFile.set(m[1]!, file);
  }
  if (!factoryFile.size) return [];

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if (!PINIA_CONSUMER_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || !content.includes('Store')) continue;
    const safe = stripCommentsForRegex(content, /\.(?:jsx?|mjs|cjs)$/.test(file) ? 'javascript' : 'typescript');

    // 2. Bind store vars in this file: `const <var> = <known-factory>(...)`.
    const varStore = new Map<string, string>();
    PINIA_BIND_RE.lastIndex = 0;
    let bm: RegExpExecArray | null;
    while ((bm = PINIA_BIND_RE.exec(safe))) {
      const sf = factoryFile.get(bm[2]!);
      if (sf) varStore.set(bm[1]!, sf);
    }
    if (!varStore.size) continue;

    // 3. Link `<var>.<method>(` → the action function node in the store's file.
    const nodesInFile = ctx.getNodesInFile(file);
    const fallbackDispatcher = nodesInFile.find((n) => n.kind === 'component'); // .vue top-level setup
    PINIA_CALL_RE.lastIndex = 0;
    let cm: RegExpExecArray | null;
    let added = 0;
    while ((cm = PINIA_CALL_RE.exec(safe)) && added < PINIA_FANOUT_CAP) {
      const storeFile = varStore.get(cm[1]!);
      if (!storeFile) continue;
      const method = cm[2]!;
      const line = safe.slice(0, cm.index).split('\n').length;
      const disp = enclosingFn(nodesInFile, line) ?? fallbackDispatcher;
      if (!disp) continue;
      const target = ctx
        .getNodesByName(method)
        .find((n) => n.kind === 'function' && n.filePath === storeFile);
      if (!target || target.id === disp.id) continue;
      const key = `${disp.id}>${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: disp.id,
        target: target.id,
        kind: 'calls',
        line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'pinia-store', via: method, registeredAt: `${file}:${line}` },
      });
      added++;
    }
  }
  return edges;
}

// ── Vuex string-keyed dispatch / commit bridge ───────────────────────────────
// Vuex dispatches actions/mutations by a runtime STRING key: `dispatch('user/login')`
// / `commit('SET_TOKEN')` / `this.$store.dispatch('app/toggleDevice')`. The action
// & mutation definitions are object-literal methods in store module files (now
// extracted as function nodes). Bridge the string key to its node: the LAST `/`
// segment is the action/mutation name; the preceding segment is the namespace
// (≈ the store module's file). Resolve the name to a function node IN A STORE FILE
// (the store-file gate excludes a same-named `api/` helper — `getInfo`/`login`
// commonly collide), disambiguated by the namespace appearing in the path (or, for
// a root key, the same file — Vuex's local-module `commit('M')` inside an action).
const VUEX_DISPATCH_RE = /\b(?:dispatch|commit)\s*\(\s*['"]([A-Za-z][\w/]*)['"]/g;
const VUEX_STORE_SIGNAL = /\bdefineStore\b|\bcreateStore\b|\bVuex\b|\bmutations\b|\bactions\b|\bgetters\b|\bnamespaced\b/g;
const VUEX_FANOUT_CAP = 120;

/** A path segment (dir or filename stem) equals `seg` — `…/modules/user.js` has
 *  the segment `user` for namespace `user`. */
function pathHasSegment(filePath: string, seg: string): boolean {
  return new RegExp('[\\\\/]' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\\\/.]').test(filePath);
}

function vuexDispatchEdges(ctx: ResolutionContext): Edge[] {
  const storeFileCache = new Map<string, boolean>();
  const isStoreFile = (file: string): boolean => {
    let v = storeFileCache.get(file);
    if (v === undefined) {
      const c = ctx.readFile(file);
      const seen = new Set<string>();
      if (c) {
        VUEX_STORE_SIGNAL.lastIndex = 0;
        let sm: RegExpExecArray | null;
        while ((sm = VUEX_STORE_SIGNAL.exec(c))) { seen.add(sm[0]); if (seen.size >= 2) break; }
      }
      v = seen.size >= 2;
      storeFileCache.set(file, v);
    }
    return v;
  };

  const resolve = (key: string, dispatchFile: string): Node | null => {
    const segs = key.split('/');
    const action = segs[segs.length - 1]!;
    const cands = ctx.getNodesByName(action).filter((n) => n.kind === 'function' && isStoreFile(n.filePath));
    if (!cands.length) return null;
    if (segs.length > 1) {
      const mod = segs[segs.length - 2]!; // immediate namespace ≈ the module file
      return cands.find((c) => pathHasSegment(c.filePath, mod)) ?? (cands.length === 1 ? cands[0]! : null);
    }
    // Root key: a local `commit('M')` inside an action targets the same module file;
    // otherwise accept only an unambiguous single store-wide match.
    return cands.find((c) => c.filePath === dispatchFile) ?? (cands.length === 1 ? cands[0]! : null);
  };

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if (!PINIA_CONSUMER_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || (!content.includes('dispatch(') && !content.includes('commit('))) continue;
    const safe = stripCommentsForRegex(content, /\.(?:jsx?|mjs|cjs)$/.test(file) ? 'javascript' : 'typescript');
    const nodesInFile = ctx.getNodesInFile(file);
    const fallback = nodesInFile.find((n) => n.kind === 'component'); // .vue top-level
    VUEX_DISPATCH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let added = 0;
    while ((m = VUEX_DISPATCH_RE.exec(safe)) && added < VUEX_FANOUT_CAP) {
      const key = m[1]!;
      const line = safe.slice(0, m.index).split('\n').length;
      const disp = enclosingFn(nodesInFile, line) ?? fallback;
      if (!disp) continue;
      const target = resolve(key, file);
      if (!target || target.id === disp.id) continue;
      const edgeKey = `${disp.id}>${target.id}`;
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);
      edges.push({
        source: disp.id,
        target: target.id,
        kind: 'calls',
        line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'vuex-dispatch', via: key, registeredAt: `${file}:${line}` },
      });
      added++;
    }
  }
  return edges;
}

// ── Celery task dispatch (Python) ─────────────────────────────────────────────
// Celery decouples a task's call site from its body through async dispatch:
//   # tasks.py
//   @shared_task                       # also @app.task / @celery_app.task / @<app>.task / @task
//   def process(account_ids): ...
//   # views.py — a DIFFERENT module
//   process.apply_async(kwargs={...})  # or process.delay(...) — dynamic, no static edge
// Bridge it: link the enclosing function/method at each `.delay(`/`.apply_async(` site → the
// task function body. Precision rests on the DECORATOR gate — the dispatched name must resolve
// to a Python function carrying a celery task decorator (read from the source lines above its
// `def`, since the def's own startLine excludes the decorator). A `.delay()` on a non-task
// object resolves to no task node → no edge, so a Celery-free repo yields 0. Same-file /
// unique-candidate disambiguation like vuex. (Canvas forms — `group(t).delay()`, `t.s()`/`.si()`
// — have no single identifier before `.delay`/`.apply_async`, so they're skipped, not mis-bridged.)
const CELERY_DISPATCH_RE = /\b([A-Za-z_]\w*)\s*\.\s*(?:delay|apply_async)\s*\(/g;
// A task decorator: bare `@shared_task`/`@task` or attribute `@app.task`/`@celery_app.task`,
// each optionally called with args. `\b`-bounded and `@`-anchored so `@mytask`, or a symbol
// merely named `task`, can't match. No `/g`, so `.test()` is stateless across reuse.
const CELERY_TASK_DECORATOR_RE = /@\s*(?:[A-Za-z_][\w.]*\.)?(?:shared_task|task)\b/;
const CELERY_PY_EXT = /\.py$/;
const CELERY_FANOUT_CAP = 80;
const CELERY_DECORATOR_LOOKBACK = 12; // max lines above a `def` to scan for its decorators

function celeryDispatchEdges(ctx: ResolutionContext): Edge[] {
  // Memoize the decorator check per task-candidate node: it reads the file and scans a few
  // lines above the def. Only called on names that are actually `.delay`/`.apply_async`
  // receivers, so the candidate set stays small.
  const taskCache = new Map<string, boolean>();
  const isCeleryTask = (node: Node): boolean => {
    let v = taskCache.get(node.id);
    if (v !== undefined) return v;
    v = false;
    if (node.kind === 'function' && CELERY_PY_EXT.test(node.filePath)) {
      const content = ctx.readFile(node.filePath);
      if (content) {
        const lines = content.split('\n');
        // startLine is the `def` line (decorators sit ABOVE it). Walk upward, stopping at the
        // previous declaration so a non-task def can never inherit the prior def's decorator.
        const stop = Math.max(0, node.startLine - 1 - CELERY_DECORATOR_LOOKBACK);
        for (let i = node.startLine - 2; i >= stop; i--) {
          const t = (lines[i] ?? '').trim();
          if (/^(?:async\s+def|def|class)\b/.test(t)) break; // previous decl → stop
          if (CELERY_TASK_DECORATOR_RE.test(t)) { v = true; break; }
        }
      }
    }
    taskCache.set(node.id, v);
    return v;
  };

  const resolve = (name: string, dispatchFile: string): Node | null => {
    const cands = ctx.getNodesByName(name).filter((n) => n.kind === 'function' && isCeleryTask(n));
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0]!;
    // Cross-module name collision: prefer a task defined in the dispatching file, else bail
    // (ambiguous — precision over recall, like vuex's root-key resolution).
    return cands.find((c) => c.filePath === dispatchFile) ?? null;
  };

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if (!CELERY_PY_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || (!content.includes('.delay(') && !content.includes('.apply_async('))) continue;
    const safe = stripCommentsForRegex(content, 'python');
    const nodesInFile = ctx.getNodesInFile(file);
    CELERY_DISPATCH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let added = 0;
    while ((m = CELERY_DISPATCH_RE.exec(safe)) && added < CELERY_FANOUT_CAP) {
      const name = m[1]!;
      const line = safe.slice(0, m.index).split('\n').length;
      const disp = enclosingFn(nodesInFile, line);
      if (!disp) continue; // module-level dispatch — no source symbol to attribute
      const target = resolve(name, file);
      if (!target || target.id === disp.id) continue;
      const key = `${disp.id}>${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: disp.id,
        target: target.id,
        kind: 'calls',
        line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'celery-dispatch', via: name, registeredAt: `${file}:${line}` },
      });
      added++;
    }
  }
  return edges;
}

// ── Spring application events (Java) ──────────────────────────────────────────
// Spring decouples an event PUBLISHER from its LISTENER(s) through the application
// event bus, linked by the EVENT TYPE (not a name):
//   // SomeService.java
//   eventPublisher.publishEvent(new PasswordChangedEvent(this, username));   // publish
//   // RememberMeTokenRevoker.java — a DIFFERENT file
//   @EventListener(PasswordChangedEvent.class)                              // listen
//   public void onPasswordChanged(PasswordChangedEvent event) { ... }
// Bridge it: link the enclosing method at each `publishEvent(new XEvent(...))` site →
// every listener method of XEvent. Listeners are `@EventListener` / `@TransactionalEventListener`
// methods (event type = the first param type, or the `@EventListener(X.class)` value form) and
// the older `class … implements ApplicationListener<X> { void onApplicationEvent(X e) }`. Keyed
// by exact type name, usually cross-file. A repo with no `@EventListener`/`publishEvent` yields 0.
// (Java method nodes INCLUDE their leading annotations in the range — startLine is the first
// `@…` line — so the annotation block is scanned DOWNWARD from startLine, bounded to consecutive
// `@`-lines so it can't bleed into an adjacent method.)
const SPRING_PUBLISH_RE = /\.publishEvent\s*\(\s*new\s+([A-Z][A-Za-z0-9_]*)/g;
const SPRING_LISTENER_ANNO_RE = /@(?:EventListener|TransactionalEventListener)\b/;
const SPRING_ANNO_TYPE_RE = /@(?:EventListener|TransactionalEventListener)\s*\(\s*([A-Z][A-Za-z0-9_]*)\.class/;
const SPRING_APP_LISTENER_RE = /\bApplicationListener\s*</;
const SPRING_JAVA_EXT = /\.java$/;
const SPRING_FANOUT_CAP = 80;

/** The first parameter's type from a Java method `signature` (`"void (XEvent e)"` → `XEvent`).
 *  Skips a leading `final`/`@Anno`, strips generics, and requires a PascalCase class name (event
 *  types are classes) — so a no-arg or primitive-param method yields null. */
function springFirstParamType(sig: string | undefined): string | null {
  if (!sig) return null;
  const open = sig.indexOf('(');
  if (open < 0) return null;
  const close = sig.indexOf(')', open);
  const inner = sig.slice(open + 1, close < 0 ? sig.length : close).trim();
  if (!inner) return null;
  const first = inner.split(',')[0]!.trim();
  const toks = first.split(/\s+/).filter((t) => t && t !== 'final' && !t.startsWith('@'));
  if (toks.length < 2) return null; // need `Type name`
  const type = toks[toks.length - 2]!.replace(/<.*$/, ''); // drop generic args
  return /^[A-Z][A-Za-z0-9_]*$/.test(type) ? type : null;
}

function springEventEdges(ctx: ResolutionContext): Edge[] {
  // Pass 1 — event-type → listener methods, scanning only event-relevant files.
  const listeners = new Map<string, Node[]>();
  for (const file of ctx.getAllFiles()) {
    if (!SPRING_JAVA_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content) continue;
    const hasAnno = content.includes('@EventListener') || content.includes('@TransactionalEventListener');
    const hasAppListener = SPRING_APP_LISTENER_RE.test(content);
    if (!hasAnno && !hasAppListener) continue;
    const lines = content.split('\n');
    for (const node of ctx.getNodesInFile(file)) {
      if (node.kind !== 'method') continue;
      // Collect this method's own leading annotation block (consecutive `@`-lines from startLine).
      const annoLines: string[] = [];
      for (let i = node.startLine - 1; i < lines.length && i < node.startLine + 7; i++) {
        const t = (lines[i] ?? '').trim();
        if (!t.startsWith('@')) break; // reached the declaration → stop (no bleed into next method)
        annoLines.push(t);
      }
      const head = annoLines.join('\n');
      const annotated = hasAnno && SPRING_LISTENER_ANNO_RE.test(head);
      const isAppListener = hasAppListener && node.name === 'onApplicationEvent';
      if (!annotated && !isAppListener) continue;
      let type = springFirstParamType(node.signature);
      if (!type && annotated) {
        const m = SPRING_ANNO_TYPE_RE.exec(head);
        if (m) type = m[1]!;
      }
      if (!type) continue;
      let arr = listeners.get(type);
      if (!arr) { arr = []; listeners.set(type, arr); }
      arr.push(node);
    }
  }
  if (!listeners.size) return [];

  // Pass 2 — link each publishEvent(new XEvent(...)) site → every listener of XEvent.
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if (!SPRING_JAVA_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || !content.includes('.publishEvent(')) continue;
    const safe = stripCommentsForRegex(content, 'java');
    const nodesInFile = ctx.getNodesInFile(file);
    SPRING_PUBLISH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let added = 0;
    while ((m = SPRING_PUBLISH_RE.exec(safe)) && added < SPRING_FANOUT_CAP) {
      const targets = listeners.get(m[1]!);
      if (!targets || !targets.length) continue;
      const line = safe.slice(0, m.index).split('\n').length;
      const disp = enclosingFn(nodesInFile, line);
      if (!disp) continue;
      for (const target of targets) {
        if (target.id === disp.id) continue;
        const key = `${disp.id}>${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: disp.id,
          target: target.id,
          kind: 'calls',
          line,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'spring-event', via: m[1]!, registeredAt: `${file}:${line}` },
        });
        added++;
      }
    }
  }
  return edges;
}

// ── MediatR request/notification dispatch (C#/.NET) ───────────────────────────
// MediatR decouples a Send/Publish call site from its Handle method through a mediator,
// linked by the request/notification TYPE (the IRequestHandler<T,…> generic):
//   // CancelOrderCommandHandler.cs — the handler
//   public class CancelOrderCommandHandler : IRequestHandler<CancelOrderCommand, bool> {
//       public async Task<bool> Handle(CancelOrderCommand request, CancellationToken ct) { … }
//   // some controller — the dispatch (usually a DIFFERENT file)
//   var command = new CancelOrderCommand(orderId);   await _mediator.Send(command);
// Bridge it: link the enclosing method at each mediator `.Send(x)`/`.Publish(x)` site → the
// `Handle` method of the handler for x's type. The sent type is resolved from the argument —
// inline `new X(…)`, a local `var v = new X(…)`, or a parameter/local declared `X v` — bounded
// to the enclosing method. Precision rests on TWO gates: the receiver must be mediator-ish
// (`mediator`/`sender`/`publisher`, so MAUI `MessagingCenter.Send` is ignored) AND the resolved
// type must be a known handler request type (so a same-named non-request DTO is never bridged).
// C# has no `signature` on method nodes, so the handler's request type is read from the class
// base-list source (`: IRequestHandler<X,…>`), not a param signature.
const MEDIATR_HANDLER_BASE_RE = /(?:IRequestHandler|INotificationHandler)\s*<\s*([A-Za-z_]\w*)/;
const MEDIATR_DISPATCH_RE = /([A-Za-z_][\w.]*)\s*\.\s*(?:Send|Publish)\s*\(\s*(new\s+[A-Z]\w*|[A-Za-z_]\w*)/g;
const MEDIATR_RECEIVER_RE = /(?:mediator|sender|publisher)/i;
const MEDIATR_CS_EXT = /\.cs$/;
const MEDIATR_FANOUT_CAP = 80;
const MEDIATR_HANDLER_DECL_LOOKAHEAD = 4; // lines from a class startLine to find a wrapped base list

/** The type sent at a MediatR `.Send(arg)`/`.Publish(arg)` site: an inline `new X(…)`, else
 *  `arg` as an identifier resolved within the enclosing method — a `… arg = new X(…)` assignment
 *  (wins), or a parameter/local declared `X arg`. Returns null when the type can't be seen. */
function resolveMediatrArgType(arg: string, lines: string[], methodStart: number, dispatchLine: number): string | null {
  const inl = /^new\s+([A-Z]\w*)/.exec(arg);
  if (inl) return inl[1]!;
  if (!/^[A-Za-z_]\w*$/.test(arg)) return null;
  const assignRe = new RegExp(`\\b${arg}\\b\\s*=\\s*new\\s+([A-Z]\\w*)`);
  const declRe = new RegExp(`\\b([A-Z]\\w*)\\b\\s+${arg}\\b`);
  let declType: string | null = null;
  for (let i = Math.max(0, methodStart - 1); i < dispatchLine && i < lines.length; i++) {
    const ln = lines[i] ?? '';
    const a = assignRe.exec(ln);
    if (a) return a[1]!; // an explicit `arg = new X` is the most specific — take it
    if (!declType) {
      const d = declRe.exec(ln);
      if (d) declType = d[1]!; // a `X arg` declaration — remember, but keep scanning for an assignment
    }
  }
  return declType;
}

function mediatrDispatchEdges(ctx: ResolutionContext): Edge[] {
  // Pass 1 — request/notification type → the Handle method of each handler class.
  const handlers = new Map<string, Node[]>();
  for (const file of ctx.getAllFiles()) {
    if (!MEDIATR_CS_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || (!content.includes('IRequestHandler<') && !content.includes('INotificationHandler<'))) continue;
    const lines = content.split('\n');
    const nodesInFile = ctx.getNodesInFile(file);
    for (const cls of nodesInFile) {
      if (cls.kind !== 'class') continue;
      const decl = lines.slice(cls.startLine - 1, cls.startLine - 1 + MEDIATR_HANDLER_DECL_LOOKAHEAD).join('\n');
      const m = MEDIATR_HANDLER_BASE_RE.exec(decl);
      if (!m) continue;
      const type = m[1]!;
      const end = cls.endLine ?? cls.startLine;
      const handle = nodesInFile.find(
        (n) => n.kind === 'method' && n.name === 'Handle' && n.startLine >= cls.startLine && n.startLine <= end
      );
      if (!handle) continue;
      let arr = handlers.get(type);
      if (!arr) { arr = []; handlers.set(type, arr); }
      arr.push(handle);
    }
  }
  if (!handlers.size) return [];

  // Pass 2 — link each mediator-ish .Send(x)/.Publish(x) → the handler of x's type.
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if (!MEDIATR_CS_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || (!content.includes('.Send(') && !content.includes('.Publish('))) continue;
    const safe = stripCommentsForRegex(content, 'csharp');
    const safeLines = safe.split('\n');
    const nodesInFile = ctx.getNodesInFile(file);
    MEDIATR_DISPATCH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let added = 0;
    while ((m = MEDIATR_DISPATCH_RE.exec(safe)) && added < MEDIATR_FANOUT_CAP) {
      if (!MEDIATR_RECEIVER_RE.test(m[1]!)) continue; // not a mediator (MessagingCenter, HttpClient, …)
      const line = safe.slice(0, m.index).split('\n').length;
      const disp = enclosingFn(nodesInFile, line);
      if (!disp) continue;
      const type = resolveMediatrArgType(m[2]!, safeLines, disp.startLine, line);
      if (!type) continue;
      const targets = handlers.get(type);
      if (!targets) continue;
      for (const target of targets) {
        if (target.id === disp.id) continue;
        const key = `${disp.id}>${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: disp.id,
          target: target.id,
          kind: 'calls',
          line,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'mediatr-dispatch', via: type, registeredAt: `${file}:${line}` },
        });
        added++;
      }
    }
  }
  return edges;
}

// ── Sidekiq job dispatch (Ruby) ───────────────────────────────────────────────
// Sidekiq decouples a job's enqueue site from the worker's `perform`, linked by the WORKER
// CLASS NAME:
//   # app/workers/destroy_user_worker.rb
//   class DestroyUserWorker
//     include Sidekiq::Worker          # or Sidekiq::Job (the modern alias)
//     def perform(user_id) … end
//   # app/services/… — a DIFFERENT file
//   DestroyUserWorker.perform_async(user.id)   # also .perform_in(t, …) / .perform_at(t, …)
// Bridge it: link the enclosing method at each `Worker.perform_async/_in/_at(…)` site → that
// worker's instance `perform`. Name-keyed (like Celery): the receiver class must be a Sidekiq
// worker — gated by reading `include Sidekiq::Job|Worker` from the class body, since that mixin
// is an external gem module that forms no resolvable edge. ActiveJob's `perform_later`/`_now` is
// a different shape and deliberately not matched, so an ActiveJob-only app yields 0.
const SIDEKIQ_DISPATCH_RE = /([A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*)\s*\.\s*perform_(?:async|in|at)\b/g;
const SIDEKIQ_WORKER_RE = /\binclude\s+Sidekiq::(?:Job|Worker)\b/;
const SIDEKIQ_RB_EXT = /\.rb$/;
const SIDEKIQ_FANOUT_CAP = 80;

function sidekiqDispatchEdges(ctx: ResolutionContext): Edge[] {
  // class node id → its instance `perform` method (null if the class isn't a Sidekiq worker),
  // memoized. Reads the class body for the mixin; only consulted for actual dispatch receivers.
  const performCache = new Map<string, Node | null>();
  const performOf = (cls: Node): Node | null => {
    let v = performCache.get(cls.id);
    if (v !== undefined) return v;
    v = null;
    const content = ctx.readFile(cls.filePath);
    if (content) {
      const end = cls.endLine ?? cls.startLine;
      const body = content.split('\n').slice(cls.startLine - 1, end).join('\n');
      if (SIDEKIQ_WORKER_RE.test(body)) {
        v = ctx.getNodesInFile(cls.filePath).find(
          (n) => n.kind === 'method' && n.name === 'perform' && n.startLine >= cls.startLine && n.startLine <= end
        ) ?? null;
      }
    }
    performCache.set(cls.id, v);
    return v;
  };

  // Resolve a (possibly namespaced) worker reference to its `perform`. A namespaced ref is
  // matched by EXACT qualified name first, so same-named workers in different namespaces
  // (forem has four `SendEmailNotificationWorker`s) resolve to the right one; an unqualified
  // ref falls back to the simple name and links only when a single worker bears it — an
  // ambiguous collision bails (precision over recall).
  const resolve = (ref: string): Node | null => {
    if (ref.includes('::')) {
      const q = ctx.getNodesByQualifiedName(ref).find((n) => n.kind === 'class' && performOf(n));
      if (q) return performOf(q);
    }
    const workers = ctx.getNodesByName(ref.split('::').pop()!).filter((n) => n.kind === 'class' && performOf(n));
    return workers.length === 1 ? performOf(workers[0]!) : null;
  };

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if (!SIDEKIQ_RB_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || !/\.perform_(?:async|in|at)\b/.test(content)) continue;
    const safe = stripCommentsForRegex(content, 'ruby');
    const nodesInFile = ctx.getNodesInFile(file);
    SIDEKIQ_DISPATCH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let added = 0;
    while ((m = SIDEKIQ_DISPATCH_RE.exec(safe)) && added < SIDEKIQ_FANOUT_CAP) {
      const line = safe.slice(0, m.index).split('\n').length;
      const disp = enclosingFn(nodesInFile, line);
      if (!disp) continue;
      const target = resolve(m[1]!);
      if (!target || target.id === disp.id) continue;
      const key = `${disp.id}>${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: disp.id,
        target: target.id,
        kind: 'calls',
        line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'sidekiq-dispatch', via: m[1]!, registeredAt: `${file}:${line}` },
      });
      added++;
    }
  }
  return edges;
}

// ── Erlang behaviour-callback dispatch ────────────────────────────────────────
// An Erlang behaviour is a compile-checked callback contract: the behaviour
// module declares `-callback init(...) -> ...`, implementers declare
// `-behaviour(B)` and export the callbacks, and the framework side dispatches
// through a VARIABLE module — cowboy's `Handler:init(Req, Opts)` and
// `Middleware:execute(Req, Env)` folds, ejabberd's `Mod:start/2`. Extraction
// deliberately leaves var-module calls silent (no static target), so the flow
// breaks at exactly the hop agents ask about (request → handler init). Bridge:
//
//   dispatch site `Var:fn(args…)` → every in-repo implementer of the behaviour
//   declaring `fn` with the SITE's arity — provided exactly ONE in-repo
//   behaviour declares (fn, arity); a name+arity collision across behaviours
//   bails (silent beats wrong) — and the implementer defines and exports `fn`.
//
// Behaviours are discovered by scanning every Erlang file for `-callback`
// declarations (not just `implements` targets), so a behaviour with zero
// implementers still participates in the ambiguity gate. Fan-out control: a
// mega-behaviour (ejabberd's gen_mod, ~200 mod_* implementers) would mint
// hundreds of edges per site that READ as complete coverage while being
// arbitrary — above the cap the site is skipped entirely and the boundary
// stays visibly dynamic (explore's boundary announcer covers it) instead of
// silently truncated.
const ERLANG_EXT = /\.(?:erl|hrl)$/;
// `Var:fn(` — variable (capitalized) module, lowercase function, immediate
// open-paren. The leading char class rejects `?MODULE:fn(` (macro), `a:b(`
// (static remote call, already linked), and mid-word matches.
const ERLANG_DISPATCH_RE = /(^|[^?\w@'])([A-Z][A-Za-z0-9_@]*):([a-z][A-Za-z0-9_@]*)\(/g;
const ERLANG_CALLBACK_DECL_RE = /(^|\n)\s*-callback\s+('[^'\n]+'|[a-z][A-Za-z0-9_@]*)\s*\(/g;
const ERLANG_BEHAVIOUR_FANOUT_CAP = 24;

/**
 * Argument count of the call/declaration whose `(` sits at `openIdx` —
 * top-level commas + 1, `()` → 0, unbalanced/oversized → -1. Skips nested
 * (), [], {}, <<>> content, `"strings"`, `'atoms'`, and `$c` char literals,
 * so `-callback init(fun((a, b) -> ok), #{k => v}) -> ok.` counts 2.
 */
function erlangArityAt(src: string, openIdx: number): number {
  let depth = 1;
  let commas = 0;
  let sawArg = false;
  const limit = Math.min(src.length, openIdx + 4000);
  for (let i = openIdx + 1; i < limit; i++) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      i++;
      while (i < limit && src[i] !== ch) {
        if (src[i] === '\\') i++;
        i++;
      }
      sawArg = true;
      continue;
    }
    if (ch === '$') {
      i++;
      if (src[i] === '\\') i++;
      sawArg = true;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; sawArg = true; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return sawArg ? commas + 1 : 0;
      continue;
    }
    if (ch === ',' && depth === 1) { commas++; continue; }
    if (!/\s/.test(ch)) sawArg = true;
  }
  return -1;
}

/**
 * Nix module-system option wiring. A NixOS/home-manager/nix-darwin option is
 * DECLARED in one module (`options.launchd.user.agents = mkOption { ... }`)
 * and SET in others (`launchd.user.agents.yabai = { ... }` inside a module's
 * config) — the connection happens by option-path unification inside the
 * module-system evaluator, so there is no static call/import edge to follow
 * and flow questions ("how does services.yabai.enable become a launchd
 * service?") go dark at the module boundary.
 *
 * This pass links each config-write binding to the option declaration whose
 * path is the longest static-segment prefix of the write path. Precision gates:
 *  - only STATIC segments participate: plain identifiers, plus quoted segments
 *    (`"git/config"`, `"com.apple.dock"`) as opaque verbatim tokens that match
 *    only quote-exactly; an interpolated (`${name}`) segment ends the prefix,
 *    so dynamic paths never match beyond their static head;
 *  - matched prefixes must be ≥2 segments: 1-segment paths would wrongly link
 *    every package's `meta = { ... }` attrset to nixos's `options.meta`;
 *  - a prefix declared in more than one file is ambiguous → no edge (a wrong
 *    edge is worse than none);
 *  - writes physically inside an options block are declaration internals
 *    (types, defaults, examples), never config writes → excluded.
 * Both declaration spellings register: flat (`options.a.b = ...`) by name, and
 * nested (`options = { a.b = ...; }`) by line-span containment.
 */
function nixLeadingPlainSegments(name: string): string[] {
  const segs: string[] = [];
  let i = 0;
  const n = name.length;
  while (i < n) {
    if (name[i] === '"') {
      // Quoted segment — an opaque verbatim token (quotes kept, so it can
      // never collide with a plain identifier). `NSGlobalDomain."com.apple.
      // mouse.tapBehavior"` must match ITS OWN quoted declaration, not
      // whichever sibling registered the shared plain prefix first.
      let j = i + 1;
      while (j < n && name[j] !== '"') {
        if (name[j] === '\\') j++;
        j++;
      }
      if (j >= n) return segs; // unterminated — stop at the static head
      const tok = name.slice(i, j + 1);
      if (tok.includes('${')) return segs; // interpolated → dynamic → stop
      segs.push(tok);
      i = j + 1;
      if (i >= n) break;
      if (name[i] !== '.') return segs;
      i++;
      continue;
    }
    let j = i;
    while (j < n && name[j] !== '.') {
      if (name[j] === '"' || (name[j] === '$' && name[j + 1] === '{')) return segs;
      j++;
    }
    const seg = name.slice(i, j);
    if (!/^[A-Za-z_][A-Za-z0-9_'-]*$/.test(seg)) return segs;
    segs.push(seg);
    i = j + 1;
  }
  return segs;
}

async function nixOptionPathEdges(queries: QueryBuilder, onYield: MaybeYield): Promise<Edge[]> {
  type Rec = { id: string; filePath: string; startLine: number; endLine: number; segs: string[] };

  // One streaming pass over nix bindings (variables + the odd function-valued
  // option); memory stays O(bindings-kept), not O(all nodes) (#610).
  const byFile = new Map<string, Rec[]>();
  let scanned = 0;
  for (const kind of ['variable', 'function'] as NodeKind[]) {
    for (const node of queries.iterateNodesByKind(kind)) {
      if ((++scanned & 0x3fff) === 0 && onYield) await onYield();
      if (node.language !== 'nix') continue;
      const segs = nixLeadingPlainSegments(node.name);
      if (segs.length === 0) continue;
      const rec: Rec = {
        id: node.id,
        filePath: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
        segs,
      };
      const arr = byFile.get(node.filePath);
      if (arr) arr.push(rec);
      else byFile.set(node.filePath, [rec]);
    }
  }

  // Per file: walk bindings outermost-first with a stack of active option
  // spans, composing nested declaration paths (`options = { services.foo = {
  // enable = mkOption ...; }; }` registers services.foo AND services.foo.enable).
  // An `options` binding nested inside another option span is a SUBMODULE's
  // own namespace (`attrsOf (submodule { options = ...; })`) — its internals
  // are not globally addressable, so the sentinel blocks registration below it
  // while still excluding the region from write candidates.
  const SUBMODULE = ' submodule';
  const decls = new Map<string, Rec[]>();
  const writes: Rec[] = [];
  const register = (path: string[], rec: Rec) => {
    if (path.length < 2 || path.includes(SUBMODULE)) return;
    const key = path.join('.');
    const arr = decls.get(key);
    if (arr) arr.push(rec);
    else decls.set(key, [rec]);
  };
  for (const recs of byFile.values()) {
    recs.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
    const stack: Array<{ start: number; end: number; prefix: string[] }> = [];
    for (const rec of recs) {
      while (stack.length > 0 && stack[stack.length - 1]!.end < rec.startLine) stack.pop();
      // Strict containment at line granularity: a one-line nested binding is
      // indistinguishable from its container, so it stays unclassified (rare
      // in module code, where option blocks are multi-line).
      const enclosing =
        stack.length > 0 &&
        rec.startLine >= stack[stack.length - 1]!.start &&
        rec.endLine <= stack[stack.length - 1]!.end &&
        !(rec.startLine === stack[stack.length - 1]!.start && rec.endLine === stack[stack.length - 1]!.end)
          ? stack[stack.length - 1]!
          : null;

      if (rec.segs[0] === 'options') {
        const ownPath = rec.segs.slice(1); // [] for the bare `options = { ... }` spelling
        const prefix = enclosing ? [SUBMODULE] : ownPath;
        register(prefix, rec);
        stack.push({ start: rec.startLine, end: rec.endLine, prefix });
        continue;
      }
      if (enclosing) {
        const composed = [...enclosing.prefix, ...rec.segs];
        register(composed, rec);
        stack.push({ start: rec.startLine, end: rec.endLine, prefix: composed });
        continue;
      }
      if (rec.segs.length >= 2) {
        writes.push(rec);
      }
    }
  }
  if (decls.size === 0 || writes.length === 0) return [];

  const edges: Edge[] = [];
  for (const w of writes) {
    // `config.services.x = ...` spells the same write with an explicit prefix.
    const segs = w.segs[0] === 'config' ? w.segs.slice(1) : w.segs;
    if (segs.length < 2) continue;
    // Longest prefix wins; an ambiguous longest match does NOT fall back to a
    // shorter one (that would link `services.nginx.virtualHosts.x` to
    // `options.services.nginx` when virtualHosts is the contested path).
    for (let len = Math.min(segs.length, 6); len >= 2; len--) {
      const candidates = decls.get(segs.slice(0, len).join('.'));
      if (!candidates || candidates.length === 0) continue;
      const files = new Set(candidates.map((c) => c.filePath));
      if (files.size === 1) {
        const target = candidates[0]!;
        if (target.id !== w.id) {
          edges.push({
            source: w.id,
            target: target.id,
            kind: 'references',
            line: w.startLine,
            provenance: 'heuristic',
            metadata: {
              synthesizedBy: 'nix-option-path',
              optionPath: segs.slice(0, len).join('.'),
              registeredAt: `${target.filePath}:${target.startLine}`,
            },
          });
        }
      }
      break; // longest hit decides, matched or ambiguous
    }
  }
  return edges;
}

function erlangBehaviourDispatchEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  // Cheap language gate: no Erlang modules → no cost beyond one kind query.
  const erlangModules = queries.getNodesByKind('namespace').filter((n) => n.language === 'erlang');
  if (erlangModules.length === 0) return [];

  // Pass 1 — scan every Erlang file with `-callback` decls: behaviour module →
  // its (name, arity) callback set, and the global `name/arity` → declaring
  // behaviours map that drives the ambiguity gate.
  const moduleByFile = new Map<string, Node>();
  for (const ns of erlangModules) {
    if (!moduleByFile.has(ns.filePath)) moduleByFile.set(ns.filePath, ns);
  }
  const declaringBehaviours = new Map<string, Node[]>(); // `fn/arity` → behaviour namespaces
  const callbackNames = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if (!ERLANG_EXT.test(file)) continue;
    const behaviour = moduleByFile.get(file);
    if (!behaviour) continue; // a .hrl or module-less file can't be a behaviour
    const content = ctx.readFile(file);
    if (!content || !content.includes('-callback')) continue;
    const safe = stripCommentsForRegex(content, 'erlang');
    ERLANG_CALLBACK_DECL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ERLANG_CALLBACK_DECL_RE.exec(safe))) {
      const name = m[2]!.replace(/^'|'$/g, '');
      const arity = erlangArityAt(safe, m.index + m[0].length - 1);
      if (arity < 0) continue;
      const key = `${name}/${arity}`;
      const arr = declaringBehaviours.get(key);
      if (arr) {
        if (!arr.some((b) => b.id === behaviour.id)) arr.push(behaviour);
      } else {
        declaringBehaviours.set(key, [behaviour]);
      }
      callbackNames.add(name);
    }
  }
  if (declaringBehaviours.size === 0) return [];

  // Implementer target lookup, lazy per (behaviour, fn): implementers come
  // from the `implements` edges extraction resolved, and the target is the
  // implementer module's own exported `fn` function node.
  const targetCache = new Map<string, Node[]>();
  const targetsOf = (behaviour: Node, fn: string): Node[] => {
    const cacheKey = `${behaviour.id}#${fn}`;
    let targets = targetCache.get(cacheKey);
    if (targets) return targets;
    targets = [];
    for (const e of queries.getIncomingEdges(behaviour.id, ['implements'])) {
      const impl = queries.getNodeById(e.source);
      if (!impl || impl.language !== 'erlang' || impl.kind !== 'namespace') continue;
      const fnNode = ctx
        .getNodesInFile(impl.filePath)
        .find((n) => n.kind === 'function' && n.name === fn && n.isExported !== false);
      if (fnNode) targets.push(fnNode);
    }
    targetCache.set(cacheKey, targets);
    return targets;
  };

  // Pass 2 — dispatch sites. Only files containing a var-module call shape are
  // scanned in full.
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if (!ERLANG_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || !/[A-Z][A-Za-z0-9_@]*:[a-z]/.test(content)) continue;
    const safe = stripCommentsForRegex(content, 'erlang');
    const nodesInFile = ctx.getNodesInFile(file);
    ERLANG_DISPATCH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ERLANG_DISPATCH_RE.exec(safe))) {
      const fn = m[3]!;
      if (!callbackNames.has(fn)) continue;
      const openIdx = m.index + m[0].length - 1;
      const arity = erlangArityAt(safe, openIdx);
      if (arity < 0) continue;
      const behaviours = declaringBehaviours.get(`${fn}/${arity}`);
      if (!behaviours || behaviours.length !== 1) continue; // unknown or ambiguous
      const behaviour = behaviours[0]!;
      const targets = targetsOf(behaviour, fn);
      if (targets.length === 0 || targets.length > ERLANG_BEHAVIOUR_FANOUT_CAP) continue;
      const line = safe.slice(0, m.index).split('\n').length;
      const disp = enclosingFn(nodesInFile, line);
      if (!disp) continue;
      for (const target of targets) {
        if (target.id === disp.id) continue;
        const key = `${disp.id}>${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: disp.id,
          target: target.id,
          kind: 'calls',
          line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'erlang-behaviour',
            via: `${behaviour.name}:${fn}/${arity}`,
            registeredAt: `${file}:${line}`,
          },
        });
      }
    }
  }
  return edges;
}

// ── Laravel events (PHP) ──────────────────────────────────────────────────────
// Laravel decouples an event dispatch from its listener(s), linked by the EVENT CLASS:
//   // app/Events/PlaybackStarted.php  +  app/Listeners/UpdateLastfmNowPlaying.php
//   class UpdateLastfmNowPlaying { public function handle(PlaybackStarted $event) { … } }
//   // a controller / service — a DIFFERENT file
//   event(new PlaybackStarted($song, $user));
// Bridge it: link the enclosing method at each `event(new XEvent(...))` site → every listener's
// `handle` for XEvent. Listeners come from TWO registration mechanisms (both real, both needed):
//   (A) auto-discovery — a `handle(EventType $e)` typed first param (also splits a union A|B);
//   (B) the `protected $listen = [ XEvent::class => [Listener::class, …] ]` map in an
//       EventServiceProvider, which also covers a listener whose `handle()` is UNTYPED.
// Only `event(new X)` is matched — queued JOBS dispatch via `::dispatch()` and their `handle()`
// takes an injected service, never an event type, so jobs are excluded by construction.
const LARAVEL_DISPATCH_RE = /\bevent\s*\(\s*new\s+\\?([A-Za-z_][\w\\]*)/g;
const LARAVEL_PHP_EXT = /\.php$/;
const LARAVEL_FANOUT_CAP = 200;
// A `$listen` entry: `Event::class => [Listener::class, …]`, key/values as `::class` or strings.
const LISTEN_ENTRY_RE = /(?:([A-Za-z_\\][\w\\]*)::class|'([^']+)'|"([^"]+)")\s*=>\s*\[([^\]]*)\]/g;
const LISTEN_CLASS_RE = /(?:([A-Za-z_\\][\w\\]*)::class|'([^']+)'|"([^"]+)")/g;

/** Short class name from a PHP reference: `\App\Events\Foo` / `App\Events::Foo` → `Foo`. */
function phpSimpleName(s: string): string {
  return s.replace(/^\\/, '').split('\\').pop()!.split('::').pop()!.trim();
}

/** The first-parameter class type(s) of a `handle(...)` declaration — union-split, short-named,
 *  primitives dropped. `handle(A|B $e)` → [A, B]; `handle(string $x)` / `handle()` → []. */
function laravelHandleEventTypes(decl: string): string[] {
  const m = /function\s+handle\s*\(\s*(?:\.\.\.\s*)?(\??[A-Za-z_\\][\w\\|]*)\s+&?\s*(?:\.\.\.\s*)?\$/.exec(decl);
  if (!m) return [];
  return m[1]!
    .replace(/^\?/, '')
    .split('|')
    .map((t) => phpSimpleName(t))
    .filter((t) => /^[A-Z]\w*$/.test(t));
}

/** From an opening `[`, the bracket-balanced body up to its matching `]`. */
function phpArrayBody(src: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']' && --depth === 0) return src.slice(openIdx + 1, i);
  }
  return null;
}

function laravelEventEdges(ctx: ResolutionContext): Edge[] {
  // event short name → its listener `handle` methods (deduped by node id).
  const listeners = new Map<string, Map<string, Node>>();
  const add = (event: string, handle: Node) => {
    let m = listeners.get(event);
    if (!m) { m = new Map(); listeners.set(event, m); }
    m.set(handle.id, handle);
  };
  const handleOf = (cls: Node): Node | null =>
    ctx
      .getNodesInFile(cls.filePath)
      .find(
        (n) => n.kind === 'method' && n.name === 'handle'
          && n.startLine >= cls.startLine && n.startLine <= (cls.endLine ?? cls.startLine)
      ) ?? null;

  // Pass 1 — build the event→handle map from both registration mechanisms.
  for (const file of ctx.getAllFiles()) {
    if (!LARAVEL_PHP_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content) continue;

    // (A) typed listener handles — node-driven, so a commented-out method can't leak in.
    if (content.includes('function handle')) {
      const lines = content.split('\n');
      for (const node of ctx.getNodesInFile(file)) {
        if (node.kind !== 'method' || node.name !== 'handle') continue;
        const decl = lines.slice(node.startLine - 1, node.startLine + 2).join('\n');
        for (const ev of laravelHandleEventTypes(decl)) add(ev, node);
      }
    }

    // (B) the EventServiceProvider `$listen` map — parsed from comment-stripped source so a
    // fully-commented map (firefly's, on auto-discovery) contributes nothing.
    if (content.includes('$listen')) {
      const safe = stripCommentsForRegex(content, 'php');
      const decl = safe.search(/\$listen\s*=\s*\[/);
      const body = decl >= 0 ? phpArrayBody(safe, safe.indexOf('[', decl)) : null;
      if (body) {
        LISTEN_ENTRY_RE.lastIndex = 0;
        let em: RegExpExecArray | null;
        while ((em = LISTEN_ENTRY_RE.exec(body))) {
          const event = phpSimpleName(em[1] ?? em[2] ?? em[3] ?? '');
          LISTEN_CLASS_RE.lastIndex = 0;
          let lm: RegExpExecArray | null;
          while ((lm = LISTEN_CLASS_RE.exec(em[4]!))) {
            const ln = phpSimpleName(lm[1] ?? lm[2] ?? lm[3] ?? '');
            const cls = ctx.getNodesByName(ln).find((n) => n.kind === 'class' && handleOf(n));
            if (cls) add(event, handleOf(cls)!);
          }
        }
      }
    }
  }
  if (!listeners.size) return [];

  // Pass 2 — link each event(new X(...)) site → every listener of X.
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const file of ctx.getAllFiles()) {
    if (!LARAVEL_PHP_EXT.test(file)) continue;
    const content = ctx.readFile(file);
    if (!content || !content.includes('event(')) continue;
    const safe = stripCommentsForRegex(content, 'php');
    const nodesInFile = ctx.getNodesInFile(file);
    LARAVEL_DISPATCH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let added = 0;
    while ((m = LARAVEL_DISPATCH_RE.exec(safe)) && added < LARAVEL_FANOUT_CAP) {
      const targets = listeners.get(phpSimpleName(m[1]!));
      if (!targets) continue;
      const line = safe.slice(0, m.index).split('\n').length;
      const disp = enclosingFn(nodesInFile, line);
      if (!disp) continue;
      for (const target of targets.values()) {
        if (target.id === disp.id) continue;
        const key = `${disp.id}>${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: disp.id,
          target: target.id,
          kind: 'calls',
          line,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'laravel-event', via: phpSimpleName(m[1]!), registeredAt: `${file}:${line}` },
        });
        added++;
      }
    }
  }
  return edges;
}

/**
 * Synthesize dispatcher→callback edges (field observers + EventEmitters +
 * React re-render + JSX children + Vue templates + SvelteKit load + RN event
 * channel + Fabric native-impl + MyBatis Java↔XML + Gin middleware chain +
 * Redux-thunk dispatch chain + object-literal registry dispatch + RTK Query
 * generated-hook → endpoint + Pinia useStore().action() + Vuex string dispatch +
 * Celery task .delay()/.apply_async() → task body + Spring publishEvent → @EventListener +
 * MediatR Send/Publish → IRequestHandler/INotificationHandler +
 * Sidekiq Worker.perform_async → #perform + Laravel event(new X) → listener handle).
 * Returns the count added. Never throws into indexing — callers wrap in try/catch.
 */
export async function synthesizeCallbackEdges(queries: QueryBuilder, ctx: ResolutionContext): Promise<number> {
  // Each sub-pass below is a whole-graph scan, and there are ~30 of them, all
  // running synchronously on the indexer's main thread. Their AGGREGATE can run
  // for well over a minute on a large repo — long enough for the #850 liveness
  // watchdog to SIGKILL the process mid-index (#1091), since its heartbeat lives
  // on this same thread. Yield between passes so the heartbeat can fire; a pass
  // that itself hangs (a real wedge) never reaches the next yield, so the
  // watchdog still catches that. See ./cooperative-yield.
  const yieldToLoop = createYielder();

  // Cross-file Go method→type `contains` edges must be synthesized AND persisted
  // FIRST: a method declared in a different file from its receiver type is
  // otherwise orphaned from the struct, and goImplementsEdges (next) derives a
  // struct's method set from its `contains` edges — so without this it would
  // under-count the interfaces a cross-file struct satisfies. (#583)
  const goMethodContains = goCrossFileMethodContainsEdges(queries);
  if (goMethodContains.length > 0) queries.insertEdges(goMethodContains);
  await yieldToLoop();

  // Go implicit `implements` edges must be synthesized AND persisted next: the
  // interface-dispatch bridge below reads `implements` edges from the DB, and
  // Go has none statically. (Other languages already have static implements
  // edges from extraction, so they don't need this pre-pass.)
  const goImpl = goImplementsEdges(queries);
  if (goImpl.length > 0) queries.insertEdges(goImpl);
  await yieldToLoop();

  const fieldEdges = await fieldChannelEdges(queries, ctx, yieldToLoop); await yieldToLoop();
  const closureCollEdges = await closureCollectionEdges(queries, ctx, yieldToLoop); await yieldToLoop();
  const emitterEdges = await eventEmitterEdges(ctx, yieldToLoop); await yieldToLoop();
  const renderEdges = reactRenderEdges(queries, ctx); await yieldToLoop();
  const jsxEdges = await reactJsxChildEdges(ctx, yieldToLoop); await yieldToLoop();
  const vueEdges = vueTemplateEdges(ctx); await yieldToLoop();
  const svelteKitEdges = svelteKitLoadEdges(ctx); await yieldToLoop();
  const pascalEdges = pascalFormEdges(ctx); await yieldToLoop();
  const flutterEdges = flutterBuildEdges(queries, ctx); await yieldToLoop();
  const arkuiStateEdges = arkuiStateBuildEdges(queries, ctx); await yieldToLoop();
  const arkuiEmitter = arkuiEmitterEdges(ctx); await yieldToLoop();
  const arkuiRoutes = arkuiRouterEdges(ctx); await yieldToLoop();
  const cppEdges = cppOverrideEdges(queries); await yieldToLoop();
  const ifaceEdges = interfaceOverrideEdges(queries); await yieldToLoop();
  const kotlinExpectActual = kotlinExpectActualEdges(queries); await yieldToLoop();
  const goGrpcEdges = goGrpcStubImplEdges(queries); await yieldToLoop();
  const rnEventEdgesList = rnEventEdges(ctx); await yieldToLoop();
  const fabricNativeEdges = fabricNativeImplEdges(ctx); await yieldToLoop();
  const expoXPlatEdges = expoCrossPlatformEdges(queries); await yieldToLoop();
  const rnXPlatEdges = rnCrossPlatformEdges(queries); await yieldToLoop();
  const mybatisEdges = mybatisJavaXmlEdges(queries); await yieldToLoop();
  const ginEdges = ginMiddlewareChainEdges(queries, ctx); await yieldToLoop();
  const thunkEdges = reduxThunkEdges(queries, ctx); await yieldToLoop();
  const registryEdges = await objectRegistryEdges(ctx, yieldToLoop); await yieldToLoop();
  const rtkEdges = rtkQueryEdges(queries, ctx); await yieldToLoop();
  const piniaEdges = piniaStoreEdges(ctx); await yieldToLoop();
  const vuexEdges = vuexDispatchEdges(ctx); await yieldToLoop();
  const celeryEdges = celeryDispatchEdges(ctx); await yieldToLoop();
  const springEdges = springEventEdges(ctx); await yieldToLoop();
  const mediatrEdges = mediatrDispatchEdges(ctx); await yieldToLoop();
  const sidekiqEdges = sidekiqDispatchEdges(ctx); await yieldToLoop();
  const erlangBehaviourEdges = erlangBehaviourDispatchEdges(queries, ctx); await yieldToLoop();
  const laravelEdges = laravelEventEdges(ctx); await yieldToLoop();
  const cFnPtrEdges = cFnPointerDispatchEdges(queries, ctx); await yieldToLoop();
  const goframeEdges = goframeRouteEdges(ctx); await yieldToLoop();
  const nixOptionEdges = await nixOptionPathEdges(queries, yieldToLoop); await yieldToLoop();

  const merged: Edge[] = [];
  const seen = new Set<string>();
  for (const e of [
    ...fieldEdges,
    ...closureCollEdges,
    ...emitterEdges,
    ...renderEdges,
    ...jsxEdges,
    ...vueEdges,
    ...svelteKitEdges,
    ...pascalEdges,
    ...flutterEdges,
    ...arkuiStateEdges,
    ...arkuiEmitter,
    ...arkuiRoutes,
    ...cppEdges,
    ...ifaceEdges,
    ...kotlinExpectActual,
    ...goGrpcEdges,
    ...rnEventEdgesList,
    ...fabricNativeEdges,
    ...expoXPlatEdges,
    ...rnXPlatEdges,
    ...mybatisEdges,
    ...ginEdges,
    ...thunkEdges,
    ...registryEdges,
    ...rtkEdges,
    ...piniaEdges,
    ...vuexEdges,
    ...celeryEdges,
    ...springEdges,
    ...mediatrEdges,
    ...sidekiqEdges,
    ...erlangBehaviourEdges,
    ...laravelEdges,
    ...cFnPtrEdges,
    ...goframeEdges,
    ...nixOptionEdges,
  ]) {
    const key = `${e.source}>${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  if (merged.length > 0) queries.insertEdges(merged);
  return merged.length + goImpl.length + goMethodContains.length;
}
