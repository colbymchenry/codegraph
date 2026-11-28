/**
 * EventEmitter channels: `x.on('e', handler)` ↔ `y.emit('e')`.
 *
 * An emitter calls each listener from inside `emit`, so the function holding
 * an `emit('e')` reaches every handler registered for `'e'` on the same object.
 * Static parsing sees neither half of that hop; this pass synthesizes
 * `dispatcher → handler` (`provenance: 'heuristic'`, `synthesizedBy:
 * 'event-emitter'`, the event, the registration site, and the line of the
 * `emit`).
 *
 * The event name alone pairs too much: two modules that each keep their own
 * emitter and both use `'save'` are two channels, not one (#2973). So a pair
 * needs three things:
 *
 *  - The handler is the function the registration names IN ITS OWN SCOPE: the
 *    function reference the resolver already resolved at that argument, else a
 *    function of the registering file, else the one it imports under that name.
 *    Never a namesake elsewhere in the project.
 *  - The `emit` and the `on` are made on what can be the same object. Each
 *    receiver gets the identities the code gives it (see `receiverKeys`): the
 *    module binding it is, the import it came from, the class whose instance
 *    `this` is or `new C()` made (or a TypeScript or JSDoc type names), a field
 *    of such an instance, a local of one function, or a global like `process`.
 *    Two receivers that both have identities pair when one is shared — classes
 *    related by `extends` count as shared, since a method of the base runs on
 *    the subclass's instances. A receiver the code doesn't tie to anything (an
 *    untyped parameter, a call's result) pairs only with another such receiver
 *    in the same file, and never with one that has an identity.
 *  - The event is specific enough: more than `EVENT_FANOUT_CAP` handlers or
 *    dispatchers for one event name project-wide skips it, as before.
 *
 * See docs/design/callback-edge-synthesis.md.
 */
import type { Edge, Language, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { FN_KINDS } from './synth-utils';
import { resolveImportPath } from './import-resolver';
import { isManualMockHiddenFrom } from './name-matcher';
import { nodesAroundLineIn, nodesNamedIn } from './nodes-around';

/** `.on('e', handler)`: 1 the event; 2 an inline `function name`, or 3 `this.` and 4 a name. */
const ON_RE = /\.(?:on|once|addListener)\(\s*['"]([^'"]+)['"]\s*,\s*(?:function\s+(\w+)|(this\.)?(\w+))/g;
const EMIT_RE = /\.(?:emit|fire|dispatchEvent)\(\s*['"]([^'"]+)['"]/g;
/** Skip events with more handlers/dispatchers than this, project-wide: the name is too generic to pair on. */
const EVENT_FANOUT_CAP = 6;
/** The languages whose receivers this pass reads: JavaScript's `this`, bindings and imports. */
const RECEIVER_LANGUAGES: ReadonlySet<string> = new Set(['javascript', 'jsx', 'typescript', 'tsx', 'vue', 'svelte']);
/** One object wherever the code runs. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['process', 'window', 'document', 'globalThis', 'global']);
/** Node kinds a class-typed receiver can name. */
const CLASS_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'component']);

interface FileFacts {
  file: string;
  language: Language;
  content: string;
  nodes: Node[];
  /** Offset of each line's first character: line n starts at lineStarts[n - 1]. */
  lineStarts: number[];
  /** name → the offsets of the file's `const|let|var` declarations of it. */
  declarations: Map<string, number[]>;
}

interface Site {
  file: string;
  /** Offset of the `.` before `on` / `emit`. */
  index: number;
  line: number;
  /** The function nodes around the call, innermost first. */
  chain: Node[];
  /** The receiver's identities (see `receiverKeys`); null when the code ties it to nothing. */
  keys?: readonly string[] | null;
}

interface EmitSite extends Site { dispatcher: Node }
interface OnSite extends Site { handler: Node }

/** What one run reads more than once. */
interface Env {
  ctx: ResolutionContext;
  queries: QueryBuilder;
  /** `source id` → its function references by name (`refName` → edges). */
  fnRefs: Map<string, Map<string, Edge[]>>;
  /** method id → the class it belongs to (or null). */
  owners: Map<string, Node | null>;
  /** class id → the classes it extends, transitively. */
  ancestors: Map<string, Set<string>>;
  /** `file#name` → the names a module exports that binding under. */
  exportNames: Map<string, string[]>;
  /** `class id#field` → the class of what the class stores in that field. */
  fields: Map<string, Node | null>;
  /** node id → its `instantiates` and type `references` edges. */
  typeEdges: Map<string, Edge[]>;
}

export async function eventEmitterEdges(queries: QueryBuilder, ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const env: Env = {
    ctx, queries, fnRefs: new Map(), owners: new Map(), ancestors: new Map(), exportNames: new Map(), fields: new Map(), typeEdges: new Map(),
  };
  const emitsByEvent = new Map<string, EmitSite[]>();
  const onsByEvent = new Map<string, OnSite[]>();

  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if ((++scanned & 15) === 0) await onYield();
    const content = ctx.readFile(file);
    if (!content) continue;
    const hasEmit = content.includes('.emit(') || content.includes('.fire(') || content.includes('.dispatchEvent(');
    const hasOn = content.includes('.on(') || content.includes('.once(') || content.includes('.addListener(');
    if (!hasEmit && !hasOn) continue;
    const facts = fileFacts(ctx, file, content);

    if (hasEmit) {
      EMIT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = EMIT_RE.exec(content))) {
        const line = lineOf(facts, m.index);
        const chain = fnChain(facts.nodes, line);
        const dispatcher = chain[0];
        if (!dispatcher) continue;
        push(emitsByEvent, m[1]!, { file, index: m.index, line, chain, dispatcher });
      }
    }
    if (hasOn) {
      ON_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ON_RE.exec(content))) {
        if (!m[2] && !m[4]) continue;
        const line = lineOf(facts, m.index);
        const chain = fnChain(facts.nodes, line);
        const handler = handlerAt(env, facts, m, line, chain);
        // A manual mock's function is a handler only test code registers (#2455).
        if (!handler || isManualMockHiddenFrom(handler.filePath, file)) continue;
        push(onsByEvent, m[1]!, { file, index: m.index, line, chain, handler });
      }
    }
  }

  // The events that can pair. Precision guard: a name with many handlers or
  // dispatchers is a generic one (`error`, `close`, `data`) — too common to
  // pair on, receivers or not.
  const channels: Array<{ event: string; emits: EmitSite[]; ons: OnSite[] }> = [];
  const byFile = new Map<string, Site[]>();
  for (const [event, emits] of emitsByEvent) {
    const ons = onsByEvent.get(event);
    if (!ons) continue;
    if (distinct(emits, (e) => e.dispatcher.id) > EVENT_FANOUT_CAP || distinct(ons, (o) => o.handler.id) > EVENT_FANOUT_CAP) continue;
    channels.push({ event, emits, ons });
    for (const site of [...emits, ...ons]) push(byFile, site.file, site);
  }
  // Each file's receivers, read with the file once.
  for (const [file, sites] of byFile) {
    await onYield();
    const content = ctx.readFile(file);
    const facts = content ? fileFacts(ctx, file, content) : null;
    for (const site of sites) site.keys = facts ? receiverKeys(env, facts, site) : null;
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  let paired = 0;
  for (const { event, emits, ons } of channels) {
    for (const e of emits) {
      for (const o of ons) {
        if ((++paired & 255) === 0) await onYield();
        const d = e.dispatcher.id;
        const h = o.handler.id;
        if (d === h) continue;
        const key = `${d}>${h}`;
        if (seen.has(key) || !sameObject(env, e, o)) continue;
        seen.add(key);
        edges.push({
          source: d,
          target: h,
          kind: 'calls',
          line: e.line,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'event-emitter', event, registeredAt: `${o.file}:${o.line}` },
        });
      }
    }
  }
  return edges;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function distinct<T>(items: readonly T[], key: (item: T) => string): number {
  return new Set(items.map(key)).size;
}

function fileFacts(ctx: ResolutionContext, file: string, content: string): FileFacts {
  const nodes = ctx.getNodesInFile(file);
  const language = (nodes.find((n) => n.kind === 'file')?.language ?? 'javascript') as Language;
  const lineStarts = [0];
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  return { file, language, content, nodes, lineStarts, declarations: new Map() };
}

function lineOf(facts: FileFacts, index: number): number {
  const starts = facts.lineStarts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The source of `node`'s lines, and the offset it starts at. */
function textOf(facts: FileFacts, node: Pick<Node, 'startLine' | 'endLine'>): { text: string; start: number } {
  const start = facts.lineStarts[node.startLine - 1] ?? 0;
  const end = facts.lineStarts[node.endLine ?? node.startLine] ?? facts.content.length;
  return { text: facts.content.slice(start, end), start };
}

/** The function/method nodes whose lines contain `line`, innermost first. */
function fnChain(nodes: readonly Node[], line: number): Node[] {
  return nodesAroundLineIn(nodes, line)
    .filter((n) => FN_KINDS.has(n.kind) && n.startLine <= line && (n.endLine ?? n.startLine) >= line)
    .sort((a, b) => b.startLine - a.startLine || (a.endLine ?? a.startLine) - (b.endLine ?? b.startLine));
}

// =============================================================================
// The handler a registration names
// =============================================================================

function handlerAt(env: Env, facts: FileFacts, m: RegExpExecArray, line: number, chain: readonly Node[]): Node | null {
  const inline = m[2];
  if (inline) {
    // `on('mount', function onmount(parent) {…})`: the function expression is its own node.
    const nameLine = lineOf(facts, m.index + m[0].length - inline.length);
    return nodesNamedIn(facts.nodes, inline).find((n) => FN_KINDS.has(n.kind) && n.name === inline && n.startLine === nameLine) ?? null;
  }
  const name = m[4]!;
  const viaThis = m[3] !== undefined;
  // The reference the resolver made for this very argument already went
  // through the scope a bare call would: the file's own functions, its
  // imports, `this`'s class and the classes it extends.
  const refName = viaThis ? `this.${name}` : name;
  const sources = referenceSources(facts, line, chain);
  if (!viaThis) {
    // A name a function around the registration declares is that local:
    // `const onPacket = this.onPacket.bind(this)` is the method, a nested
    // `const onReady = () => …` is its own node, and a parameter or any other
    // local is no function this pass can name.
    for (let i = 0; i < chain.length; i++) {
      const fn = chain[i]!;
      const { text } = textOf(facts, fn);
      const n = escapeRe(name);
      const bound = new RegExp(String.raw`\b(?:const|let|var)\s+${n}\s*=\s*this\.([A-Za-z_$][\w$]*)\.bind\s*\(`).exec(text);
      if (bound) return ownMethod(env, facts, bound[1]!, chain.slice(i)) ?? resolvedReference(env, sources, `this.${bound[1]!}`, () => true);
      if (new RegExp(String.raw`\b(?:const|let|var)\s+${n}\s*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*(?::[^=]*)?=>|[\w$]+\s*=>)|\bfunction\s*\*?\s*${n}\s*\(`).test(text)) {
        const end = fn.endLine ?? fn.startLine;
        return nodesNamedIn(facts.nodes, name).find((x) => x.kind === 'function' && x.name === name && x.startLine >= fn.startLine && (x.endLine ?? x.startLine) <= end) ?? null;
      }
      const local = localBinding(text, name, '');
      if (local?.kind === 'import') break;
      if (local?.kind === 'field') {
        // `const onEnd = this.onEnd`: the method, when the class has one.
        return ownMethod(env, facts, local.name, chain.slice(i)) ?? resolvedReference(env, sources, `this.${local.name}`, () => true);
      }
      if (local) return null;
    }
  }
  const atLine = resolvedReference(env, sources, refName, (r) => r.line === line);
  if (atLine) return atLine;
  // The extractor keeps one reference per scope and name, at its first use. A
  // later registration names the same function unless the file defines
  // several of that name — one per test callback, say — so the file's own
  // definitions are read first.
  const own = viaThis ? ownMethod(env, facts, name, chain) : ownFunction(facts, name, line, chain);
  if (own !== undefined) return own;
  return resolvedReference(env, sources, refName, () => true) ?? (viaThis ? null : importedFunction(env, facts, name));
}

/** The function the first of `sources` with a matching resolved reference to `refName` points at. */
function resolvedReference(env: Env, sources: readonly string[], refName: string, accept: (ref: Edge) => boolean): Node | null {
  for (const sourceId of sources) {
    const ref = fnRefsOf(env, sourceId).get(refName)?.find(accept);
    if (!ref) continue;
    const target = env.ctx.getNodeById?.(ref.target) ?? env.queries.getNodeById(ref.target);
    if (target && (target.kind === 'function' || target.kind === 'method')) return target;
  }
  return null;
}

/** The nodes a reference at `line` can be attributed to: the enclosing functions, then whatever else spans the line, then the file. */
function referenceSources(facts: FileFacts, line: number, chain: readonly Node[]): string[] {
  const ids = chain.map((n) => n.id);
  for (const n of nodesAroundLineIn(facts.nodes, line)) {
    if (n.kind === 'file' || FN_KINDS.has(n.kind)) continue;
    if (n.startLine <= line && (n.endLine ?? n.startLine) >= line) ids.push(n.id);
  }
  ids.push(`file:${facts.file}`);
  return ids;
}

function fnRefsOf(env: Env, sourceId: string): Map<string, Edge[]> {
  let byName = env.fnRefs.get(sourceId);
  if (!byName) {
    byName = new Map();
    for (const e of env.queries.getOutgoingEdges(sourceId, ['references'])) {
      const refName = e.metadata?.fnRef === true ? e.metadata.refName : undefined;
      if (typeof refName === 'string') push(byName, refName, e);
    }
    env.fnRefs.set(sourceId, byName);
  }
  return byName;
}

/**
 * `this.name`: the method of that name of the class around the registration.
 * Undefined when the file has none (it may come from a class elsewhere), null
 * when it can't tell which.
 */
function ownMethod(env: Env, facts: FileFacts, name: string, chain: readonly Node[]): Node | null | undefined {
  const methods = nodesNamedIn(facts.nodes, name).filter((n) => n.kind === 'method' && n.name === name);
  if (methods.length === 0) return undefined;
  const owner = thisFunction(facts, chain);
  const cls = owner ? ownerClass(env, owner) : null;
  if (cls) {
    const own = methods.filter((n) => ownerClass(env, n)?.id === cls.id);
    if (own.length === 1) return own[0]!;
    // The class's own file has none: an inherited method, which the
    // resolved reference finds.
    if (own.length === 0) return undefined;
  }
  return methods.length === 1 ? methods[0]! : null;
}

/**
 * A bare name: the file's function of that name in the registration's scope.
 * Several of one name (a `listener` per test callback) pick the one declared
 * where the registration is, nearest before it. Undefined when the file
 * defines none.
 */
function ownFunction(facts: FileFacts, name: string, line: number, chain: readonly Node[]): Node | null | undefined {
  const local = nodesNamedIn(facts.nodes, name).filter((n) => n.kind === 'function' && n.name === name);
  if (local.length <= 1) return local[0];
  const scope = chain[0]?.id ?? null;
  const inScope = local
    .filter((n) => (fnChain(facts.nodes, n.startLine).find((f) => f.id !== n.id)?.id ?? null) === scope)
    .sort((a, b) => a.startLine - b.startLine);
  const before = inScope.filter((n) => n.startLine <= line);
  return before.length > 0 ? before[before.length - 1]! : (inScope[0] ?? null);
}

/** A bare name the file imports: the function the module exports under it. */
function importedFunction(env: Env, facts: FileFacts, name: string): Node | null {
  const imported = importedModule(env, facts, name);
  if (!imported || imported.module === null) return null;
  const exported = env.ctx.getNodesInFile(imported.module).filter((n) =>
    n.kind === 'function' && (imported.exported === 'default' ? n.isExported === true : n.name === imported.exported));
  return exported.length === 1 ? exported[0]! : null;
}

// =============================================================================
// Which object a receiver is
// =============================================================================

/** Can the `emit` and the `on` be made on the same object? */
function sameObject(env: Env, e: Site, o: Site): boolean {
  const ke = e.keys ?? null;
  const ko = o.keys ?? null;
  // Neither tied to anything: the old event-name pairing, kept to one file.
  if (ke === null || ko === null) return ke === null && ko === null && e.file === o.file;
  for (const a of ke) for (const b of ko) if (keysMatch(env, a, b)) return true;
  return false;
}

function keysMatch(env: Env, a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith('obj:') && b.startsWith('obj:')) return related(env, a.slice(4), b.slice(4));
  if (a.startsWith('field:') && b.startsWith('field:')) {
    const ia = a.lastIndexOf('#');
    const ib = b.lastIndexOf('#');
    return a.slice(ia) === b.slice(ib) && related(env, a.slice(6, ia), b.slice(6, ib));
  }
  return false;
}

/** One class extends the other, or they are one class. */
function related(env: Env, a: string, b: string): boolean {
  return a === b || ancestorsOf(env, a).has(b) || ancestorsOf(env, b).has(a);
}

function ancestorsOf(env: Env, id: string): Set<string> {
  let out = env.ancestors.get(id);
  if (out) return out;
  out = new Set();
  env.ancestors.set(id, out);
  const queue = [id];
  for (let depth = 0; queue.length > 0 && depth < 16; depth++) {
    const next = queue.shift()!;
    const parents = env.ctx.getSuperclassNodes?.(next)
      ?? env.queries.getOutgoingEdges(next, ['extends']).map((e) => ({ id: e.target }));
    for (const p of parents) {
      if (out.has(p.id) || p.id === id) continue;
      out.add(p.id);
      queue.push(p.id);
    }
  }
  return out;
}

/**
 * The identities of the receiver of the call at `site`, or null when the code
 * ties it to nothing:
 *  - `obj:<class id>` — `this` in a method of the class, or a binding made by `new C()` / typed `C`;
 *  - `field:<class id>#<path>` — `this.<path>` in a method of the class, or the same path on a `new C()` binding;
 *  - `bind:<file>#<name>` — a module-level binding of the file;
 *  - `mod:<file>#<export>` — what a module exports: the binding of its own that it exports, or an import of it;
 *  - `pkg:<specifier>#<export>` — an import from a package;
 *  - `local:<scope>#<path>` — a local of one function (or anonymous callback) that no class types;
 *  - `global:<path>` — `process`, `window`, …
 * A parameter typed with a class outside the project gets none (`[]`): it
 * is a known object, but no project emitter.
 */
function receiverKeys(env: Env, facts: FileFacts, site: Site): readonly string[] | null {
  if (!RECEIVER_LANGUAGES.has(facts.language)) return null;
  const path = receiverPathAt(facts.content, site.index);
  if (!path) return null;
  const segs = path.split('.');
  const head = segs[0] === 'super' ? 'this' : segs[0]!;
  const tail = segs.slice(1).join('.');
  if (head === 'this') return thisKeys(env, facts, site, site.chain, tail, true);
  return bindingKeys(env, facts, site, head, tail);
}

/** The plain path a call is made on (`emitter`, `this.bus`, `server.events`), or null for anything else. */
function receiverPathAt(src: string, dot: number): string | null {
  let end = dot;
  if (src[end - 1] === '?') end--; // `emitter?.emit(`
  let i = end - 1;
  while (i >= 0 && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r')) i--; // `emitter\n  .on(`
  const stop = i + 1;
  while (i >= 0 && /[\w$#.?]/.test(src[i]!)) i--;
  const path = src.slice(i + 1, stop).replace(/\?\./g, '.');
  // The tail of a call or an index (`make().on(`, `list[0].on(`) is no plain path.
  if (!/^[A-Za-z_$#][\w$#]*(?:\.[A-Za-z_$#][\w$#]*)*$/.test(path)) return null;
  return path;
}

/**
 * The identities of `this` (`tail` '') or `this.<tail>` in the innermost of
 * `chain`. `atSite`: the call itself is the one read, so an anonymous
 * `function` around it — which rebinds `this` — is looked for.
 */
function thisKeys(env: Env, facts: FileFacts, site: Site, chain: readonly Node[], tail: string, atSite: boolean): readonly string[] | null {
  const fn = thisFunction(facts, chain);
  if (!fn) return null;
  if (atSite && insideAnonymousFunction(facts, fn, site.index)) return null;
  const owner = ownerClass(env, fn);
  if (!owner) return null;
  if (!tail) return [`obj:${owner.id}`];
  const keys = [`field:${owner.id}#${tail}`];
  if (!tail.includes('.')) {
    const cls = fieldClass(env, owner, tail);
    if (cls) keys.push(`obj:${cls.id}`);
  }
  return keys;
}

/** The function whose `this` code in the innermost of `chain` sees: an arrow function has none of its own. */
function thisFunction(facts: FileFacts, chain: readonly Node[]): Node | null {
  for (const fn of chain) if (fn.kind !== 'function' || !isArrowFunction(facts, fn)) return fn;
  return null;
}

/** `const f = (…) => …`: its head, up to the body, holds `=>` and no `function`. */
function isArrowFunction(facts: FileFacts, fn: Node): boolean {
  const { text } = textOf(facts, { startLine: fn.startLine, endLine: fn.startLine });
  const brace = text.indexOf('{');
  const head = brace === -1 ? text : text.slice(0, brace);
  return head.includes('=>') && !/\bfunction\b/.test(head);
}

/** The class `fn` is a method of. */
function ownerClass(env: Env, fn: Node): Node | null {
  if (fn.kind !== 'method') return null;
  if (env.owners.has(fn.id)) return env.owners.get(fn.id)!;
  let owner: Node | null = null;
  for (const e of env.queries.getIncomingEdges(fn.id, ['contains'])) {
    const n = env.ctx.getNodeById?.(e.source) ?? env.queries.getNodeById(e.source);
    if (n && CLASS_KINDS.has(n.kind)) {
      owner = n;
      break;
    }
  }
  env.owners.set(fn.id, owner);
  return owner;
}

/**
 * Whether the call at `index` sits inside an anonymous `function () {…}` within
 * `fn` — a callback whose `this` is whatever calls it, not `fn`'s. Scans back
 * from the call for the blocks that enclose it; an arrow's block keeps `this`.
 */
function insideAnonymousFunction(facts: FileFacts, fn: Node, index: number): boolean {
  const { text, start } = textOf(facts, fn);
  const rel = index - start;
  const body = text.indexOf('{');
  if (body === -1 || rel <= body) return false;
  let depth = 0;
  for (let i = rel - 1; i > body; i--) {
    const c = text[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth > 0) {
        depth--;
        continue;
      }
      // An unclosed `{` before the call: a block the call is in.
      const head = text.slice(Math.max(0, i - 160), i);
      if (/\bfunction\b\s*\*?\s*[\w$]*\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*$/.test(head)) return true;
    }
  }
  return false;
}

/**
 * The class of what `owner` keeps in a field: the type its declaration names
 * (`transport: Transport`, as the resolver bound it), else the class a
 * constructor parameter property or a `this.field = new C(…)` names.
 */
function fieldClass(env: Env, owner: Node, field: string): Node | null {
  const memoKey = `${owner.id}#${field}`;
  if (env.fields.has(memoKey)) return env.fields.get(memoKey)!;
  let cls: Node | null = null;
  const content = env.ctx.readFile(owner.filePath);
  if (content) {
    const facts = fileFacts(env.ctx, owner.filePath, content);
    const declared = nodesNamedIn(facts.nodes, field).find((n) => (n.kind === 'property' || n.kind === 'field') && n.name === field &&
      n.startLine >= owner.startLine && (n.endLine ?? n.startLine) <= (owner.endLine ?? owner.startLine));
    if (declared) cls = classReferencedAt(env, owner.filePath, [declared.id], declared.startLine, null);
    if (!cls) {
      const { text, start } = textOf(facts, owner);
      const f = escapeRe(field);
      const m =
        new RegExp(String.raw`\b(?:public|private|protected|readonly)\s+(?:readonly\s+)?${f}\s*[?!]?\s*:\s*([A-Z][\w$]*)`).exec(text) ??
        new RegExp(String.raw`\bthis\.${f}\s*=\s*[^;\n]*?\bnew\s+([A-Za-z_$][\w$]*)`).exec(text);
      if (m) cls = classNamed(env, facts, m[1]!, lineOf(facts, start + m.index));
    }
  }
  env.fields.set(memoKey, cls);
  return cls;
}

/**
 * The identities of a receiver whose path starts with the binding `name`
 * (then `.tail`). The innermost function that declares the name decides what
 * it is; a name no named function declares is a local of an anonymous
 * callback (a test's `it(() => { const r = new Receiver() … })`), a module
 * binding or import, or a global.
 */
function bindingKeys(env: Env, facts: FileFacts, site: Site, name: string, tail: string): readonly string[] | null {
  for (let i = 0; i < site.chain.length; i++) {
    const fn = site.chain[i]!;
    const { text, start } = textOf(facts, fn);
    const binding = localBinding(text, name, jsDocBefore(facts, fn));
    if (binding) return bindingIdentity(env, facts, site, site.chain.slice(i), fn.id, start, binding, name, tail);
  }
  const decl = anonymousLocal(facts, site, name);
  if (decl !== null) {
    const binding = localBinding(facts.content.slice(decl, facts.content.indexOf('\n', decl) >>> 0), name, '');
    if (binding) return bindingIdentity(env, facts, site, [], `${facts.file}:${decl}`, decl, binding, name, tail);
  }
  const keys = moduleKeys(env, facts, name, tail);
  if (keys) return keys;
  return GLOBAL_OBJECTS.has(name) ? [`global:${tail ? `${name}.${tail}` : name}`] : null;
}

/** Types that say nothing about which object a parameter holds. */
const GENERIC_TYPES: ReadonlySet<string> = new Set(['EventEmitter', 'Emitter', 'EventTarget', 'Object', 'Function']);

type LocalBinding =
  | { kind: 'this' }
  | { kind: 'field'; name: string }
  | { kind: 'import' }
  | { kind: 'typed'; type: string; index: number; param: boolean }
  | { kind: 'param' }
  | { kind: 'local' };

/**
 * How `text` (one function's source, `jsDoc` its doc comment) binds `name`,
 * when it declares it at all: `const self = this`, `const con =
 * this.connection`, a `require`, a binding made by `new C(…)` or typed `C`
 * (TypeScript, or a JSDoc `@param {C} name`), any other parameter (of the
 * function or of a callback in it) or local.
 */
function localBinding(text: string, name: string, jsDoc: string): LocalBinding | null {
  const n = escapeRe(name);
  if (new RegExp(String.raw`(?:\b(?:const|let|var)\s+|[,(]\s*)${n}\s*=\s*this\b(?!\s*[.[])`).test(text)) return { kind: 'this' };
  const alias = new RegExp(String.raw`\b(?:const|let|var)\s+${n}\s*=\s*this\.([A-Za-z_$][\w$]*)\s*(?:[;,)\n]|$)`).exec(text);
  if (alias) return { kind: 'field', name: alias[1]! };
  if (new RegExp(String.raw`\b(?:const|let|var)\s+(?:${n}\b|\{[^}]*\b${n}\b[^}]*\})\s*=\s*require\s*\(`).test(text)) return { kind: 'import' };
  const made = new RegExp(String.raw`(?<![\w$.])${n}\s*(?::\s*[\w$.<>, ]+)?=\s*(?:await\s+)?new\s+([A-Za-z_$][\w$]*)`).exec(text);
  if (made) return { kind: 'typed', type: made[1]!, index: made.index, param: false };
  const typed = new RegExp(String.raw`(\b(?:const|let|var)\s+|[(,]\s*)${n}\s*\??\s*:\s*([A-Z][\w$]*)\b(?!\s*[.\[])`).exec(text);
  if (typed) return { kind: 'typed', type: typed[2]!, index: typed.index, param: !/^(?:const|let|var)/.test(typed[1]!) };
  if (new RegExp(String.raw`^[^(]*\([^()]*\b${n}\b[^()]*\)`).test(text)) {
    // A parameter of the function itself: its doc comment may type it.
    const doc = new RegExp(String.raw`@param\s*\{\s*([A-Z][\w$]*)\s*\}\s*\[?${n}\b`).exec(jsDoc);
    return doc ? { kind: 'typed', type: doc[1]!, index: 0, param: true } : { kind: 'param' };
  }
  if (new RegExp(String.raw`(?:\bfunction\b[^(]*|=>\s*|[=(,:]\s*(?:async\s*)?)\([^()]*\b${n}\b[^()]*\)|\b${n}\s*=>`).test(text)) return { kind: 'param' };
  if (new RegExp(String.raw`\b(?:const|let|var)\s+(?:${n}\b|[{[][^}\]]*\b${n}\b)`).test(text)) return { kind: 'local' };
  return null;
}

/**
 * What a binding a function (`scope`, its source starting at `start`) declares
 * is: `this` or a field of it, an import, an instance of a project class, or a
 * local of that scope. An untyped parameter is tied to nothing; one typed with
 * a class outside the project is a known object no project class makes.
 */
function bindingIdentity(
  env: Env, facts: FileFacts, site: Site, chain: readonly Node[], scope: string, start: number,
  binding: LocalBinding, name: string, tail: string,
): readonly string[] | null {
  switch (binding.kind) {
    case 'this':
      return thisKeys(env, facts, site, chain, tail, false);
    case 'field':
      return thisKeys(env, facts, site, chain, tail ? `${binding.name}.${tail}` : binding.name, false);
    case 'import':
      return moduleKeys(env, facts, name, tail);
    case 'typed': {
      const cls = classNamed(env, facts, binding.type, lineOf(facts, start + binding.index));
      if (cls) return objectKeys(cls, tail);
      if (!binding.param) return [`local:${scope}#${tail ? `${name}.${tail}` : name}`];
      return GENERIC_TYPES.has(binding.type) ? null : [];
    }
    case 'param':
      return null;
    case 'local':
      return [`local:${scope}#${tail ? `${name}.${tail}` : name}`];
  }
}

/** The doc comment right above `fn`, or ''. */
function jsDocBefore(facts: FileFacts, fn: Node): string {
  const start = facts.lineStarts[fn.startLine - 1] ?? 0;
  const before = facts.content.slice(Math.max(0, start - 4000), start).trimEnd();
  if (!before.endsWith('*/')) return '';
  const open = before.lastIndexOf('/*');
  return open !== -1 && before.startsWith('/**', open) ? before.slice(open) : '';
}

/**
 * The offset of the declaration of `name` nearest before the call, when it is
 * a local of an anonymous callback: not a module binding (a node of its own),
 * not inside a named function around something else.
 */
function anonymousLocal(facts: FileFacts, site: Site, name: string): number | null {
  let offsets = facts.declarations.get(name);
  if (!offsets) {
    const n = escapeRe(name);
    offsets = [...facts.content.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(?:${n}\b|[{[][^}\]]*\b${n}\b)`, 'g'))].map((m) => m.index!);
    facts.declarations.set(name, offsets);
  }
  let found: number | null = null;
  for (const offset of offsets) {
    if (offset >= site.index) break;
    const line = lineOf(facts, offset);
    const inOther = nodesAroundLineIn(facts.nodes, line).some((f) => FN_KINDS.has(f.kind) && f.startLine <= line && (f.endLine ?? f.startLine) >= line &&
      !site.chain.some((c) => c.id === f.id));
    if (!inOther) found = offset;
  }
  if (found === null) return null;
  const line = lineOf(facts, found);
  const moduleLevel = nodesNamedIn(facts.nodes, name).some((x) => (x.kind === 'constant' || x.kind === 'variable') && x.name === name && x.startLine === line);
  return moduleLevel ? null : found;
}

function objectKeys(cls: Node, tail: string): string[] {
  return tail ? [`field:${cls.id}#${tail}`] : [`obj:${cls.id}`];
}

/** A module-level binding of the file: what it is imported from, or the file's own (and what it exports it as). */
function moduleKeys(env: Env, facts: FileFacts, name: string, tail: string): readonly string[] | null {
  const suffix = tail ? `.${tail}` : '';
  const imported = importedModule(env, facts, name);
  if (imported) {
    const where = imported.module !== null ? `mod:${imported.module}` : `pkg:${imported.source}`;
    return [`${where}#${imported.exported}${suffix}`];
  }
  const decl = nodesNamedIn(facts.nodes, name).find((n) =>
    (n.kind === 'constant' || n.kind === 'variable') && n.name === name &&
    !nodesAroundLineIn(facts.nodes, n.startLine).some((f) => FN_KINDS.has(f.kind) && f.startLine < n.startLine && (f.endLine ?? f.startLine) >= n.startLine));
  if (!decl) return null;
  const keys = [`bind:${facts.file}#${name}${suffix}`];
  for (const exported of exportNamesOf(env, facts, name)) keys.push(`mod:${facts.file}#${exported}${suffix}`);
  const { text, start } = textOf(facts, decl);
  const made = new RegExp(String.raw`(?<![\w$.])${escapeRe(name)}\s*(?::\s*[\w$.<>, ]+)?=\s*(?:await\s+)?new\s+([A-Za-z_$][\w$]*)`).exec(text);
  if (made) {
    const cls = classNamed(env, facts, made[1]!, lineOf(facts, start + made.index));
    if (cls) keys.push(...objectKeys(cls, tail));
  }
  return keys;
}

/** The module `name` is imported from in `facts.file` (null for a package), and the export the import names. */
function importedModule(env: Env, facts: FileFacts, name: string): { module: string | null; source: string; exported: string } | null {
  const binding = env.ctx.getImportMappings(facts.file, facts.language).find((m) => m.localName === name);
  if (!binding) return null;
  const module = binding.resolvedPath ?? resolveImportPath(binding.source, facts.file, facts.language, env.ctx);
  const exported = binding.isNamespace ? '*' : binding.isDefault || binding.exportedName === 'default' ? 'default' : binding.exportedName;
  return { module: module ?? null, source: binding.source, exported };
}

/** The names `facts.file` exports its module-level binding `name` under (`default` for `module.exports = name`). */
function exportNamesOf(env: Env, facts: FileFacts, name: string): string[] {
  const memoKey = `${facts.file}#${name}`;
  const hit = env.exportNames.get(memoKey);
  if (hit) return hit;
  const n = escapeRe(name);
  const src = facts.content;
  const out = new Set<string>();
  if (new RegExp(String.raw`\bexport\s+(?:const|let|var)\s+${n}\b`).test(src)) out.add(name);
  if (new RegExp(String.raw`(?:\bexport\s+default|\bmodule\.exports\s*=)\s*${n}\s*;?\s*$`, 'm').test(src)) out.add('default');
  if (new RegExp(String.raw`\b${n}\s*=\s*(?:exports\s*=\s*)?module\.exports\s*=`).test(src)) out.add('default');
  for (const m of src.matchAll(new RegExp(String.raw`\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*${n}\s*;?\s*$`, 'gm'))) out.add(m[1]!);
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)|\bmodule\.exports\s*=\s*\{([^}]*)\}/g)) {
    const esm = m[1] !== undefined;
    for (const part of (m[1] ?? m[2]!).split(',')) {
      const spec = part.trim();
      const as = esm ? /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(spec) : /^(?:([\w$]+)\s*:\s*)?([\w$]+)$/.exec(spec);
      if (!as) continue;
      if (esm && as[1] === name) out.add(as[2] ?? name);
      if (!esm && as[2] === name) out.add(as[1] ?? name);
    }
  }
  const names = [...out];
  env.exportNames.set(memoKey, names);
  return names;
}

/**
 * The class `name` names in `facts.file` at `line`: the one the resolver bound
 * a `new name(…)` there to, else the file's own, else the one it imports —
 * declared in the module it names, or, behind an index that hands it on
 * (`const { WebSocket } = require('..')`), the project's only class of that name.
 */
function classNamed(env: Env, facts: FileFacts, name: string, line: number): Node | null {
  const spanning = nodesAroundLineIn(facts.nodes, line).filter((n) => n.startLine <= line && (n.endLine ?? n.startLine) >= line).map((n) => n.id);
  const bound = classReferencedAt(env, facts.file, spanning, line, name);
  if (bound) return bound;
  const own = nodesNamedIn(facts.nodes, name).filter((n) => CLASS_KINDS.has(n.kind) && n.name === name);
  if (own.length > 0) return own.length === 1 ? own[0]! : null;
  const imported = importedModule(env, facts, name);
  if (!imported || imported.module === null) return null;
  const exported = exportedClass(env, imported.module, imported.exported, 0);
  if (exported !== undefined) return exported;
  // Behind an entry point no source declares (`require('..')`, a workspace
  // package's built `main`): the only class of that name in its package.
  const wanted = imported.exported === 'default' || imported.exported === '*' ? name : imported.exported;
  const pkg = packageDirOf(env, imported.module);
  const named = env.ctx.getNodesByName(wanted).filter((n) =>
    CLASS_KINDS.has(n.kind) && RECEIVER_LANGUAGES.has(n.language) && (pkg === '' || n.filePath.startsWith(`${pkg}/`)));
  return named.length === 1 ? named[0]! : null;
}

/** The directory of the package.json nearest above `file` ('' for the project root). */
function packageDirOf(env: Env, file: string): string {
  for (let dir = file.slice(0, Math.max(0, file.lastIndexOf('/'))); dir; dir = dir.slice(0, Math.max(0, dir.lastIndexOf('/')))) {
    if (env.ctx.fileExists(`${dir}/package.json`)) return dir;
  }
  return '';
}

/**
 * The class `module` exports as `exported`: declared there, or handed on —
 * `export { Server } from './server'`, or imported and exported again
 * (`import { Server } from './server'; export { Server }`). Undefined when
 * the trail ends without one, null when it finds several.
 */
function exportedClass(env: Env, module: string, exported: string, depth: number): Node | null | undefined {
  const classes = env.ctx.getNodesInFile(module).filter((n) =>
    CLASS_KINDS.has(n.kind) && (exported === 'default' ? n.isExported === true : n.name === exported));
  if (classes.length > 0) return classes.length === 1 ? classes[0]! : null;
  if (depth >= 4 || exported === 'default') return undefined;
  const language = (env.ctx.getNodesInFile(module).find((n) => n.kind === 'file')?.language ?? 'typescript') as Language;
  const next = (source: string, name: string): Node | null | undefined => {
    const file = resolveImportPath(source, module, language, env.ctx);
    return file ? exportedClass(env, file, name, depth + 1) : undefined;
  };
  for (const re of env.ctx.getReExports?.(module, language) ?? []) {
    if (re.kind === 'named' && re.exportedName === exported) return next(re.source, re.originalName);
  }
  const binding = env.ctx.getImportMappings(module, language).find((m) => m.localName === exported && !m.isNamespace);
  if (binding) return next(binding.source, binding.isDefault ? 'default' : binding.exportedName);
  return undefined;
}

/**
 * The class an `instantiates` or type `references` edge of one of `sources`
 * at `line` of `file` binds (named `name`, when given). Only an edge the
 * resolver bound through an import or to the file's own class: a project-wide
 * guess at a common class name (`Socket`) would tie unrelated objects.
 */
function classReferencedAt(env: Env, file: string, sources: readonly string[], line: number, name: string | null): Node | null {
  for (const id of sources) {
    let edges = env.typeEdges.get(id);
    if (!edges) {
      edges = env.queries.getOutgoingEdges(id, ['instantiates', 'references']).filter((e) => e.metadata?.fnRef !== true);
      env.typeEdges.set(id, edges);
    }
    for (const e of edges) {
      if (e.line !== line) continue;
      const target = env.ctx.getNodeById?.(e.target) ?? env.queries.getNodeById(e.target);
      if (!target || !CLASS_KINDS.has(target.kind) || (name !== null && target.name !== name)) continue;
      if (e.metadata?.resolvedBy === 'import' || target.filePath === file) return target;
    }
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
