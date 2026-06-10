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
function fieldChannelEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const registrars: Array<{ node: Node; field: string }> = [];
  const dispatchers: Array<{ node: Node; field: string }> = [];

  for (const m of methodAndFunctionNodes(queries)) {
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
function closureCollectionEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const dispatchers = new Map<string, Array<{ node: Node; line: number }>>(); // field → dispatcher methods + forEach line
  const registrars = new Map<string, Array<{ node: Node; line: number }>>();   // field → registrar methods + append line

  const addReg = (field: string | undefined, node: Node, absLine: number) => {
    if (!field || /^\d+$/.test(field)) return; // `$0.append` mis-captures the `0`; the write-RE owns that field
    const arr = registrars.get(field) ?? [];
    if (!arr.some((r) => r.node.id === node.id)) arr.push({ node, line: absLine });
    registrars.set(field, arr);
  };

  for (const m of methodAndFunctionNodes(queries)) {
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
function eventEmitterEdges(ctx: ResolutionContext): Edge[] {
  const emitsByEvent = new Map<string, Set<string>>();          // event → dispatcher node ids
  const handlersByEvent = new Map<string, Map<string, string>>(); // event → handler id → registration site (file:line)

  for (const file of ctx.getAllFiles()) {
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
function reactJsxChildEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const PARENT_KINDS = new Set(['method', 'function', 'component']);
  for (const file of ctx.getAllFiles()) {
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
 * Synthesize dispatcher→callback edges (field observers + EventEmitters +
 * React re-render + JSX children + Vue templates + SvelteKit load + RN event
 * channel + Fabric native-impl + MyBatis Java↔XML + Gin middleware chain).
 * Returns the count added. Never throws into indexing — callers wrap in try/catch.
 */
export function synthesizeCallbackEdges(queries: QueryBuilder, ctx: ResolutionContext): number {
  // Cross-file Go method→type `contains` edges must be synthesized AND persisted
  // FIRST: a method declared in a different file from its receiver type is
  // otherwise orphaned from the struct, and goImplementsEdges (next) derives a
  // struct's method set from its `contains` edges — so without this it would
  // under-count the interfaces a cross-file struct satisfies. (#583)
  const goMethodContains = goCrossFileMethodContainsEdges(queries);
  if (goMethodContains.length > 0) queries.insertEdges(goMethodContains);

  // Go implicit `implements` edges must be synthesized AND persisted next: the
  // interface-dispatch bridge below reads `implements` edges from the DB, and
  // Go has none statically. (Other languages already have static implements
  // edges from extraction, so they don't need this pre-pass.)
  const goImpl = goImplementsEdges(queries);
  if (goImpl.length > 0) queries.insertEdges(goImpl);

  const fieldEdges = fieldChannelEdges(queries, ctx);
  const closureCollEdges = closureCollectionEdges(queries, ctx);
  const emitterEdges = eventEmitterEdges(ctx);
  const renderEdges = reactRenderEdges(queries, ctx);
  const jsxEdges = reactJsxChildEdges(ctx);
  const vueEdges = vueTemplateEdges(ctx);
  const svelteKitEdges = svelteKitLoadEdges(ctx);
  const pascalEdges = pascalFormEdges(ctx);
  const flutterEdges = flutterBuildEdges(queries, ctx);
  const cppEdges = cppOverrideEdges(queries);
  const ifaceEdges = interfaceOverrideEdges(queries);
  const kotlinExpectActual = kotlinExpectActualEdges(queries);
  const goGrpcEdges = goGrpcStubImplEdges(queries);
  const rnEventEdgesList = rnEventEdges(ctx);
  const fabricNativeEdges = fabricNativeImplEdges(ctx);
  const expoXPlatEdges = expoCrossPlatformEdges(queries);
  const rnXPlatEdges = rnCrossPlatformEdges(queries);
  const mybatisEdges = mybatisJavaXmlEdges(queries);
  const ginEdges = ginMiddlewareChainEdges(queries, ctx);

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
  ]) {
    const key = `${e.source}>${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  if (merged.length > 0) queries.insertEdges(merged);
  return merged.length + goImpl.length + goMethodContains.length;
}
