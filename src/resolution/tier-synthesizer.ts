/**
 * Cross-tier channels — the web's equivalent of the React Native bridge.
 *
 * A web app is two programs that talk over a wire the graph cannot see: the
 * page calls `fetch('/api/users', { method: 'POST' })` and the API's
 * `app.post('/api/users', createUser)` answers; a service puts `'welcome'` on
 * the `email` queue and a `@Process('welcome')` method picks it up; a
 * gateway's `this.server.emit('message')` lands in the component that wrote
 * `socket.on('message', …)`. Each hop is a string on both sides, which is the
 * evidence that lets a synthesizer close it — exactly as the RN event channel
 * pairs `sendEvent(withName: "x")` with `addListener('x')`.
 *
 * Three channels, one scan:
 *
 *  1. **`http-client`** — a literal path in a client call (`fetch`, `axios.post`,
 *     `ky`, `got`, `$fetch`, `useFetch`, `useSWR`, or a project instance made by
 *     `axios.create(…)` / `ky.extend(…)`) → the ONE route node `METHOD path` it
 *     denotes. Template holes match a `:param`; a hole in front of the path
 *     (`${API_URL}/users`) matches a route by its tail; a variable url, a path
 *     no route serves, or a path two routes serve alike produce nothing.
 *     Edge: enclosing function → route, `tier: 'client→server'`.
 *  2. **`queue-job`** — `queue.add('job', …)` where the queue is named (`new
 *     Queue('email')`, `@InjectQueue('email')`) → the `@Process('job')` method
 *     of the `@Processor('email')` class, a WorkerHost's `process`, a
 *     `new Worker('email', handler)`, or Bull's `queue.process('job', handler)`.
 *  3. **`event-bus`** — `eventEmitter.emit('user.created')` → `@OnEvent('user.created')`
 *     (globs honoured); and sockets in both directions: a client's
 *     `socket.emit('x')` → the server's `@SubscribeMessage('x')` / `socket.on('x')`
 *     (`tier: 'client→server'`), the server's `server.emit('x')` → the client's
 *     `socket.on('x', …)` (`tier: 'server→client'`). The in-process
 *     `.on('x', fn)` ↔ `.emit('x')` pairing stays the emitter pass's.
 *
 * Every edge is `kind: 'calls'`, `provenance: 'heuristic'`, and carries
 * `synthesizedBy`, `channel` (`http` | `queue` | `event` | `socket`), the
 * `tier` when the direction is known, the `event` / `queue` / `method` /
 * `href` it was paired on, and `registeredAt` — the route registration, the
 * decorator, the `.on` — so a reader can check the pairing. Fan-out is capped
 * per event as the emitter pass caps it; an HTTP pairing needs no cap because
 * it is exact. Test suites and generated files are never sources of these
 * passes: a supertest call is the test's story, and forty of them would make
 * the route a hub. The one exception is section 4, a Spring / Laravel test's
 * request onto its route, whose edges are kept out of fan-in for that reason.
 */

import type { Edge, Language, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { stripCommentsForRegex } from './strip-comments';
import { resolveImportPath } from './import-resolver';
import { isGeneratedFile } from '../extraction/generated-detection';
import { isTestPath } from '../search/query-utils';
import { HOLE, readStringAt } from './frameworks/expo-router';
import { enclosingFn, enclosingValue, makeLineAt } from './synth-utils';
import { atSite, b2Asker, deciding, toCand } from '../decision/record';

const JS_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** Events with more handlers or dispatchers than this are too generic to pair without type information. */
const EVENT_FANOUT_CAP = 6;

const HTTP_VERBS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ALL', 'ANY']);

export const TIER_CLIENT_TO_SERVER = 'client→server';
export const TIER_SERVER_TO_CLIENT = 'server→client';

// =============================================================================
// Source reading
// =============================================================================

/** Index just past the `)` that closes the `(` at `open`, skipping strings; -1 if unbalanced. */
function closeParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '`') {
      i = templateEnd(s, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the backtick closing the template opening at `open`. */
function templateEnd(s: string, open: number): number {
  let i = open + 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i;
    if (ch === '$' && s[i + 1] === '{') {
      let depth = 0;
      for (i = i + 1; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}') {
          depth--;
          if (depth === 0) break;
        } else if (s[i] === '`') i = templateEnd(s, i);
      }
    }
    i++;
  }
  return s.length;
}

/** The arguments of the call whose `(` is at `open`, split at depth-0 commas. */
function argumentsAt(s: string, open: number): string[] | null {
  const close = closeParen(s, open);
  if (close < 0) return null;
  const inner = s.slice(open + 1, close);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < inner.length && inner[i] !== q) {
        if (inner[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '`') {
      i = templateEnd(inner, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out.map((a) => a.trim()).filter((a, i) => a.length > 0 || i === 0);
}

/** The first string literal in `text`, holes kept; null when it opens with anything else. */
function leadingString(text: string): string | null {
  const t = text.trim().replace(/^\(\s*/, '');
  // `new URL('/x', base)` — the path is the first argument of the URL.
  const url = /^new\s+URL\s*\(/.exec(t);
  if (url) {
    const args = argumentsAt(t, url[0].length - 1);
    return args && args[0] ? leadingString(args[0]) : null;
  }
  if (t[0] === '"' || t[0] === "'" || t[0] === '`') return readStringAt(t, 0);
  return null;
}

/** `method: 'POST'` inside an options object / config, upper-cased; null when absent or computed. */
function methodIn(text: string): string | null {
  const m = /\bmethod\s*:\s*(['"`])([A-Za-z]+)\1/.exec(text);
  return m ? m[2]!.toUpperCase() : null;
}

/** The first string literal anywhere in a decorator's arguments (`'x'`, `{ name: 'x' }`). */
function firstLiteral(args: string): string | null {
  const m = /(['"`])([^'"`]+)\1/.exec(args);
  return m ? m[2]! : null;
}

/** Every string literal in a decorator's arguments, for `@OnEvent(['a', 'b'])`. */
function allLiterals(args: string): string[] {
  const out: string[] = [];
  const re = /(['"`])([^'"`]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) out.push(m[2]!);
  return out;
}

/**
 * The name of the method a decorator sits on: skip further stacked decorators
 * and modifiers after the decorator's `)`, then take the identifier before `(`.
 */
function methodNameAfter(safe: string, from: number): { name: string; index: number } | null {
  let i = from;
  const ws = /\s*/y;
  const deco = /@[\w.]+/y;
  const modifier = /(?:public|private|protected|async|static|readonly|override)\b/y;
  const ident = /([A-Za-z_$][\w$]*)\s*[<(]/y;
  const eat = (): void => {
    ws.lastIndex = i;
    if (ws.exec(safe)) i = ws.lastIndex;
  };
  for (;;) {
    eat();
    if (safe[i] !== '@') break;
    deco.lastIndex = i;
    if (!deco.exec(safe)) break;
    i = deco.lastIndex;
    eat();
    if (safe[i] === '(') {
      const close = closeParen(safe, i);
      if (close < 0) return null;
      i = close + 1;
    }
  }
  for (;;) {
    eat();
    modifier.lastIndex = i;
    if (modifier.exec(safe) && modifier.lastIndex > i) {
      i = modifier.lastIndex;
      continue;
    }
    break;
  }
  eat();
  ident.lastIndex = i;
  const m = ident.exec(safe);
  return m ? { name: m[1]!, index: i } : null;
}

/** Every `@Name(` decorator in `safe` with its arguments and where it ends. */
function decorators(safe: string, name: string): Array<{ args: string; index: number; end: number }> {
  const out: Array<{ args: string; index: number; end: number }> = [];
  const re = new RegExp(`@${name}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(safe)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = closeParen(safe, open);
    if (close < 0) continue;
    out.push({ args: safe.slice(open + 1, close), index: m.index, end: close + 1 });
    re.lastIndex = close + 1;
  }
  return out;
}

// =============================================================================
// Per-file facts, read once
// =============================================================================

interface FileFacts {
  file: string;
  safe: string;
  /** Read on first use: most files that pass a gate hold no site, and never need them. */
  readonly nodes: Node[];
  lineOf: (idx: number) => number;
  /** The 0-based column of an index on its line — where the site reader looks for the call. */
  columnOf: (idx: number) => number;
  /** Lines a framework resolver made a route node on — registrations, never client calls. */
  readonly routeLines: Set<number>;
  /** Local names bound to an HTTP client instance, with their literal base URL when written. */
  clients: Map<string, { baseURL: string | null }>;
  /** The module's default export is a client instance. */
  defaultClient: { baseURL: string | null } | null;
  /** Local names bound to a named queue (`new Queue('email')`, `@InjectQueue('email') x`). */
  queues: Map<string, string>;
  /** The file holds a socket server (a gateway, `io.on('connection')`, `new Server(…)`). */
  socketServer: boolean;
}

const CLIENT_FACTORY =
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*?)?=\s*(?:await\s+)?(?:(?:axios|ky|got|ofetch|\$fetch|wretch|redaxios)\s*\.\s*(?:create|extend)|new\s+Axios|wretch)\s*\(/g;
const DEFAULT_CLIENT_FACTORY = /\bexport\s+default\s+(?:(?:axios|ky|got|ofetch|\$fetch|wretch|redaxios)\s*\.\s*(?:create|extend)|new\s+Axios|wretch)\s*\(/;
const QUEUE_BINDING =
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*?)?=\s*(?:new\s+)?(?:Queue|Bull|BullQueue)\s*(?:<[^>]*>)?\s*\(\s*(['"`])([^'"`]+)\2/g;
const INJECT_QUEUE = /@InjectQueue\s*\(\s*(['"`])([^'"`]+)\1\s*\)\s*(?:(?:private|public|protected|readonly)\s+)*([A-Za-z_$][\w$]*)/g;
const SOCKET_SERVER_FILE = /@WebSocketGateway\s*\(|@SubscribeMessage\s*\(|@WebSocketServer\s*\(|\bnew\s+(?:Server|SocketIOServer|WebSocketServer|WebSocket\.Server|WSServer)\b|\.on\s*\(\s*['"]connection['"]/;

function baseUrlIn(safe: string, open: number): string | null {
  const args = argumentsAt(safe, open);
  const config = args?.[0] ?? '';
  const m = /\b(?:baseURL|baseUrl|prefixUrl|baseURI)\s*:\s*/.exec(config);
  if (!m) return null;
  return readStringAt(config, m.index + m[0].length);
}

function readFacts(ctx: ResolutionContext, file: string): FileFacts | null {
  const content = ctx.readFile(file);
  if (!content) return null;
  const safe = stripCommentsForRegex(content, 'typescript');
  let nodes: Node[] | null = null;
  let routeLines: Set<number> | null = null;
  const clients = new Map<string, { baseURL: string | null }>();
  CLIENT_FACTORY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLIENT_FACTORY.exec(safe)) !== null) {
    clients.set(m[1]!, { baseURL: baseUrlIn(safe, m.index + m[0].length - 1) });
  }
  const dm = DEFAULT_CLIENT_FACTORY.exec(safe);
  const defaultClient = dm ? { baseURL: baseUrlIn(safe, dm.index + dm[0].length - 1) } : null;
  const queues = new Map<string, string>();
  QUEUE_BINDING.lastIndex = 0;
  while ((m = QUEUE_BINDING.exec(safe)) !== null) queues.set(m[1]!, m[3]!);
  INJECT_QUEUE.lastIndex = 0;
  while ((m = INJECT_QUEUE.exec(safe)) !== null) queues.set(m[3]!, m[2]!);
  return {
    file,
    safe,
    get nodes() {
      return (nodes ??= ctx.getNodesInFile(file));
    },
    lineOf: makeLineAt(safe, 1),
    columnOf: (idx: number) => idx - (safe.lastIndexOf('\n', idx - 1) + 1),
    get routeLines() {
      if (!routeLines) {
        routeLines = new Set<number>();
        for (const n of this.nodes) if (n.kind === 'route') routeLines.add(n.startLine);
      }
      return routeLines;
    },
    clients,
    defaultClient,
    queues,
    socketServer: SOCKET_SERVER_FILE.test(safe),
  };
}

/** Facts for the file a local name is imported from, when the import resolves to a project file. */
function importedFacts(
  ctx: ResolutionContext,
  facts: FileFacts,
  localName: string,
  cache: Map<string, FileFacts | null>
): { facts: FileFacts; exportedName: string; isDefault: boolean } | null {
  const lang: Language = facts.file.endsWith('x') ? 'tsx' : 'typescript';
  const im = ctx.getImportMappings(facts.file, lang).find((i) => i.localName === localName);
  if (!im) return null;
  // The mappings name the module as written; the file it is comes from the
  // same resolution the import resolver uses (aliases, extensions, index files).
  const resolved = im.resolvedPath ?? resolveImportPath(im.source, facts.file, lang, ctx);
  if (!resolved) return null;
  let target = cache.get(resolved);
  if (target === undefined) {
    target = JS_FILE.test(resolved) ? readFacts(ctx, resolved) : null;
    cache.set(resolved, target);
  }
  return target ? { facts: target, exportedName: im.exportedName, isDefault: im.isDefault } : null;
}

// =============================================================================
// 1. HTTP client → route
// =============================================================================

/** A receiver that is an HTTP client by name alone. */
const CLIENT_NAMES =
  /^(?:axios|ky|got|superagent|http|https|httpClient|httpService|api|apiClient|client|restClient|request|agent|fetcher|instance|\$api|\$http|\$axios|axiosInstance|Axios|HttpClient|backend|server)$/;
/** A receiver that registers routes, never a client — unless it was made by a client factory. */
const SERVER_NAMES = /^(?:app|router|route|routes|express|fastify|koa|hono|elysia|apiRouter|v1|v2|r)$/;
/** A type argument between the callee and its `(` — `useSWR<TeamData>('/api/team')`, `ky.get<User>('/x')`. */
const GENERIC = String.raw`(?:<[^()<>]*(?:<[^()<>]*>[^()<>]*)*>)?`;
/**
 * Where a receiver chain (`this.api.client`) may begin: not after an earlier
 * identifier-start character of the same word (the second lookbehind is the
 * whole rule; the first is its one-character fast path). A match from the
 * middle of a word implies one from its first letter — the chain regexes read
 * the rest of the word either way — and each of their matches ends on a
 * non-word character, so a scan never resumes mid-word: this only skips starts
 * bound to fail. Without it every letter of every identifier re-read the
 * dotted chain behind it, which on vscode made this the slowest pass.
 */
const CHAIN_START = String.raw`(?<![A-Za-z_$])(?<![A-Za-z_$][\w$]+)`;
const BARE_CLIENT_CALL = new RegExp(String.raw`(?:(?:window|globalThis|global)\s*\.\s*)?\b(fetch|\$fetch|ofetch|axios|ky|got|useFetch|useSWR)\s*${GENERIC}\s*\(`, 'g');
const MEMBER_CLIENT_CALL = new RegExp(
  String.raw`${CHAIN_START}((?:this\s*\.\s*)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*(get|post|put|patch|delete|head|options|request|\$get|\$post|\$put|\$patch|\$delete)\s*${GENERIC}\s*\(`,
  'g'
);

interface HttpRoute {
  node: Node;
  method: string;
  segs: string[];
}

interface HttpSite {
  fn: Node;
  file: string;
  line: number;
  column: number;
  /** The call as written, `fetch` / `api.get` — what the Steps walk must not also draw as an effect. */
  callee: string;
  method: string;
  segs: string[];
  /** The path began with a hole — a base URL — and matches a route by its tail. */
  suffix: boolean;
  display: string;
  /** p of a B3 verdict that judged the receiver a client (src/decision). */
  clientP?: number;
}

/** A route a B3 tie verdict chose carries its p (src/decision). */
type MatchedRoute = HttpRoute & { decisionP?: number };

/** The edge marker of an applied B3 verdict (src/decision). */
function b3Mark(p: number | undefined): { decision: string; decisionP: number } | undefined {
  return p === undefined ? undefined : { decision: 'B3', decisionP: p };
}

function httpRoutes(ctx: ResolutionContext): HttpRoute[] {
  const out: HttpRoute[] = [];
  for (const node of ctx.getNodesByKind('route')) {
    const space = node.name.indexOf(' ');
    if (space <= 0) continue;
    const method = node.name.slice(0, space).toUpperCase();
    if (!HTTP_VERBS.has(method)) continue;
    const path = node.name.slice(space + 1).trim();
    if (!path.startsWith('/')) continue;
    out.push({ node, method, segs: path.split('/').filter((s) => s.length > 0) });
  }
  return out;
}

const PARAM_SEG = /^(?::|\{|\[|<|\*)|\?$/;
const CATCH_ALL = /^(?:\*|\[\.\.\.|\{\*|:[\w$]+\*$|\{[\w$]+:\*\}|\*[\w$]*$)/;

/** How well the client's segments match a route's; null when they do not. A literal match beats a parameter's. */
function scorePath(client: readonly string[], route: readonly string[]): number | null {
  let score = 0;
  let i = 0;
  for (let r = 0; r < route.length; r++) {
    const seg = route[r]!;
    if (CATCH_ALL.test(seg)) {
      if (i >= client.length) return null;
      score += client.length - i;
      i = client.length;
      continue;
    }
    if (i >= client.length) return null;
    const c = client[i]!;
    // A hole (`${id}`) fills a route's parameter; it never stands in for a
    // literal segment — `/api/products/${id}` is not `/api/products/top`.
    if (PARAM_SEG.test(seg)) score += 2;
    else if (c === seg) score += 3;
    else return null;
    i++;
  }
  return i === client.length ? score : null;
}

function matchHttp(site: HttpSite, routes: readonly HttpRoute[]): MatchedRoute | null {
  let best: HttpRoute | null = null;
  let bestScore = -1;
  let tied: HttpRoute[] | null = null;
  for (const r of routes) {
    if (r.method !== 'ALL' && r.method !== 'ANY' && r.method !== site.method) continue;
    let score: number | null;
    if (site.suffix) {
      // A base URL hides a prefix the route may spell out (`${API}/users` for
      // `GET /api/users`) — but a one-segment tail names half the routes in
      // an index, and a long hidden prefix is a different API. Two segments
      // of tail at least, two of prefix at most.
      if (site.segs.length < 2 || r.segs.length < site.segs.length || r.segs.length - site.segs.length > 2) continue;
      score = scorePath(site.segs, r.segs.slice(r.segs.length - site.segs.length));
    } else score = scorePath(site.segs, r.segs);
    if (score === null) continue;
    if (score > bestScore) {
      best = r;
      bestScore = score;
      tied = null;
    } else if (score === bestScore) (tied ??= []).push(r);
  }
  if (!tied || !best) return best;
  // Decision point B3 (tie): several routes match equally well — today that is "no edge".
  if (!deciding('B3')) return null;
  const all = [best, ...tied];
  const b3 = atSite('B3', `tie:${site.file}:${site.line}:${site.column}`, null, () => ({
    kind: 'tie',
    site: { method: site.method, display: site.display, filePath: site.file, line: site.line },
    routes: all.slice(0, 32).map((r) => toCand(r.node)),
  }));
  if (!b3?.pick) return null;
  const chosen = all.find((r) => r.node.id === b3.pick);
  return chosen ? { ...chosen, decisionP: b3.p } : null;
}

/**
 * The path a client call names, as segments, with `${…}` as `*`; `suffix`
 * when a base URL came first. Null when the path is not literal enough: a
 * relative path with no base, or nothing but holes.
 */
function clientPath(raw: string, baseURL: string | null): { segs: string[]; suffix: boolean; display: string } | null {
  let p = raw;
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  let suffix = false;
  const absolute = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*(\/.*)?$/i.exec(p);
  if (absolute) p = absolute[1] ?? '/';
  else if (!p.startsWith('/')) {
    if (p.startsWith(HOLE)) {
      const rest = p.slice(1);
      if (!rest.startsWith('/')) return null;
      p = rest;
      suffix = true;
    } else if (baseURL !== null) {
      const base = clientPath(baseURL, null);
      if (!base) {
        // A base that is itself a hole: match by the tail.
        if (!baseURL.includes(HOLE)) return null;
        suffix = true;
        p = '/' + p;
      } else {
        suffix = base.suffix;
        p = '/' + [...base.segs, ...p.split('/')].filter(Boolean).join('/');
      }
    } else return null;
  } else if (baseURL !== null) {
    // An instance with a literal path base: axios joins `baseURL + url`.
    const base = clientPath(baseURL, null);
    if (base && base.segs.length > 0) {
      suffix = base.suffix;
      p = '/' + [...base.segs, ...p.split('/')].filter(Boolean).join('/');
    } else if (!base && baseURL.includes(HOLE)) suffix = true;
  }
  const segs = p
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (s.includes(HOLE) ? '*' : s));
  if (segs.length > 0 && segs.every((s) => s === '*')) return null;
  return { segs, suffix, display: '/' + segs.map((s) => (s === '*' ? '${…}' : s)).join('/') };
}

/** What a member-call receiver is: a client (with its base URL), or nothing. */
function clientFor(
  ctx: ResolutionContext,
  facts: FileFacts,
  receiver: string,
  cache: Map<string, FileFacts | null>
): { baseURL: string | null; decisionP?: number } | null {
  const chain = receiver.replace(/\s+/g, '').replace(/^this\./, '').split('.');
  const head = chain[0]!;
  const last = chain[chain.length - 1]!;
  const local = facts.clients.get(head);
  if (local) return local;
  const imported = importedFacts(ctx, facts, head, cache);
  if (imported) {
    const bound = imported.isDefault ? imported.facts.defaultClient : imported.facts.clients.get(imported.exportedName) ?? null;
    if (bound) return bound;
  }
  const named = !(SERVER_NAMES.test(last) || SERVER_NAMES.test(head)) && CLIENT_NAMES.test(last);
  if (!deciding('B3')) return named ? { baseURL: null } : null;
  // Decision point B3: a receiver with no client binding is judged by name lists alone.
  const b3 = atSite('B3', `client:${facts.file}:${receiver}`, named ? 'true' : 'false', () => ({
    kind: 'client',
    call: { receiver, verb: '', filePath: facts.file, line: 0 },
  }));
  // Only a 'true' / 'false' verdict overrides; anything else keeps the name lists' answer.
  if (b3?.pick === 'true') return { baseURL: null, decisionP: b3.p };
  if (b3?.pick === 'false') return null;
  return named ? { baseURL: null } : null;
}

function collectHttpSites(ctx: ResolutionContext, facts: FileFacts, sites: HttpSite[], cache: Map<string, FileFacts | null>): void {
  const { safe, lineOf } = facts;
  const add = (index: number, open: number, verb: string | null, baseURL: string | null, clientP?: number): void => {
    const line = lineOf(index);
    const callee = safe.slice(index, open).replace(/\s+/g, '').replace(/<.*>$/, '');
    if (facts.routeLines.has(line)) return; // a registration the resolver already read
    const fn = enclosingFn(facts.nodes, line);
    if (!fn) return;
    const args = argumentsAt(safe, open);
    if (!args || !args[0]) return;
    let first = args[0];
    let method = verb;
    // `axios({ url, method })`, `.request({ url, method })`, `ky(url, { method })`.
    if (first.trimStart().startsWith('{')) {
      const url = /\burl\s*:\s*/.exec(first);
      if (!url) return;
      method = method ?? methodIn(first) ?? 'GET';
      first = first.slice(url.index + url[0].length);
    } else if (method === null) {
      method = methodIn(args.slice(1).join(',')) ?? 'GET';
    }
    const literal = leadingString(first);
    if (literal === null) return;
    const path = clientPath(literal, baseURL);
    if (!path) return;
    sites.push({ fn, file: facts.file, line, column: facts.columnOf(index), callee, method, segs: path.segs, suffix: path.suffix, display: path.display, clientP });
  };

  BARE_CLIENT_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_CLIENT_CALL.exec(safe)) !== null) {
    // `this.fetch(…)` / `repo.fetch(…)` is a project method, not the platform's.
    const before = safe[m.index - 1];
    if (before === '.' && !/^(?:window|globalThis|global)\s*\./.test(m[0])) continue;
    add(m.index, m.index + m[0].length - 1, null, null);
  }
  MEMBER_CLIENT_CALL.lastIndex = 0;
  while ((m = MEMBER_CLIENT_CALL.exec(safe)) !== null) {
    const client = clientFor(ctx, facts, m[1]!, cache);
    if (!client) continue;
    const verb = m[2]!.replace(/^\$/, '').toUpperCase();
    add(m.index, m.index + m[0].length - 1, verb === 'REQUEST' ? null : verb, client.baseURL, client.decisionP);
  }
}

// =============================================================================
// 2. Queue job → consumer
// =============================================================================

const QUEUE_ADD = new RegExp(CHAIN_START + /((?:this\s*\.\s*)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*add\s*\(\s*(['"`])([^'"`]+)\2/.source, 'g');
const QUEUE_SHAPED = /queue|jobs?$|worker|bull|flow|producer/i;
const NEW_WORKER = /\bnew\s+Worker\s*(?:<[^>]*>)?\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*/g;
const QUEUE_PROCESS = new RegExp(CHAIN_START + /((?:this\s*\.\s*)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*process\s*\(\s*(?:(['"`])([^'"`]+)\2\s*,\s*)?(?:\d+\s*,\s*)?/.source, 'g');
/** A handler argument: a named function (group 1), or an inline function. */
const HANDLER_ARG = /^(?:(?:async\s+)?([A-Za-z_$][\w$.]*)\s*(?:[,)]|$)|(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>))/;

interface QueueProducer {
  fn: Node;
  file: string;
  line: number;
  column: number;
  callee: string;
  queue: string | null;
  job: string;
}

interface QueueConsumer {
  node: Node;
  file: string;
  line: number;
  queue: string | null;
  /** Null: every job on the queue (`@Process()` with no name, a WorkerHost's `process`, `new Worker`). */
  job: string | null;
}

/** The queue a receiver is bound to, by its binding in this file or the file it is imported from. */
function queueFor(ctx: ResolutionContext, facts: FileFacts, receiver: string, cache: Map<string, FileFacts | null>): string | null {
  const chain = receiver.replace(/\s+/g, '').replace(/^this\./, '').split('.');
  const head = chain[0]!;
  const own = facts.queues.get(head);
  if (own) return own;
  const imported = importedFacts(ctx, facts, head, cache);
  if (imported) {
    const bound = imported.facts.queues.get(imported.exportedName);
    if (bound) return bound;
  }
  return null;
}

/** The function a handler argument names or encloses; null when it is neither. */
function handlerNode(ctx: ResolutionContext, facts: FileFacts, text: string, line: number, cache: Map<string, FileFacts | null>): Node | null {
  const m = HANDLER_ARG.exec(text.trimStart());
  if (!m) return null;
  if (m[1]) {
    const name = m[1].split('.').pop()!;
    const candidates = ctx.getNodesByName(name).filter((n) => n.kind === 'function' || n.kind === 'method');
    const local = candidates.filter((n) => n.filePath === facts.file);
    if (local.length === 1) return local[0]!;
    if (local.length > 1) return null;
    const imported = importedFacts(ctx, facts, m[1].split('.')[0]!, cache);
    if (imported) {
      const viaImport = candidates.filter((n) => n.filePath === imported.facts.file);
      if (viaImport.length === 1) return viaImport[0]!;
    }
    return candidates.length === 1 ? candidates[0]! : null;
  }
  return enclosingFn(facts.nodes, line) ?? enclosingValue(facts.nodes, line);
}

/** The nearest class declared at or after `index`, as its node. */
function classAfter(facts: FileFacts, index: number): Node | null {
  const m = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  m.lastIndex = index;
  const hit = m.exec(facts.safe);
  if (!hit) return null;
  const line = facts.lineOf(hit.index);
  return facts.nodes.find((n) => n.kind === 'class' && n.name === hit[1] && n.startLine >= line - 2) ?? null;
}

/** The method node a decorator at `end` sits on, inside `cls` when given. */
function decoratedMethod(facts: FileFacts, end: number, cls: Node | null): Node | null {
  const named = methodNameAfter(facts.safe, end);
  if (!named) return null;
  const line = facts.lineOf(named.index);
  return (
    facts.nodes.find(
      (n) =>
        (n.kind === 'method' || n.kind === 'function') &&
        n.name === named.name &&
        n.startLine >= line - 1 &&
        n.startLine <= line + 1 &&
        (!cls || (n.startLine >= cls.startLine && n.endLine <= cls.endLine))
    ) ?? null
  );
}

function collectQueue(ctx: ResolutionContext, facts: FileFacts, producers: QueueProducer[], consumers: QueueConsumer[], cache: Map<string, FileFacts | null>): void {
  const { safe, lineOf } = facts;
  let m: RegExpExecArray | null;
  QUEUE_ADD.lastIndex = 0;
  while ((m = QUEUE_ADD.exec(safe)) !== null) {
    const receiver = m[1]!;
    const queue = queueFor(ctx, facts, receiver, cache);
    const last = receiver.replace(/\s+/g, '').split('.').pop()!;
    if (queue === null && !QUEUE_SHAPED.test(last)) continue;
    const line = lineOf(m.index);
    const fn = enclosingFn(facts.nodes, line);
    if (!fn) continue;
    producers.push({ fn, file: facts.file, line, column: facts.columnOf(m.index), callee: `${receiver.replace(/\s+/g, '')}.add`, queue, job: m[3]! });
  }

  // Nest: `@Processor('email')` on a class; `@Process('welcome')` on its methods,
  // or a WorkerHost's `process(job)`.
  for (const proc of decorators(safe, 'Processor')) {
    const queue = firstLiteral(proc.args);
    const cls = classAfter(facts, proc.end);
    if (!cls) continue;
    let any = false;
    for (const job of decorators(safe, 'Process')) {
      const line = lineOf(job.index);
      if (line < cls.startLine || line > cls.endLine) continue;
      const method = decoratedMethod(facts, job.end, cls);
      if (!method) continue;
      any = true;
      consumers.push({ node: method, file: facts.file, line, queue, job: firstLiteral(job.args) });
    }
    if (!any) {
      const process = facts.nodes.find((n) => n.kind === 'method' && n.name === 'process' && n.startLine >= cls.startLine && n.endLine <= cls.endLine);
      if (process) consumers.push({ node: process, file: facts.file, line: process.startLine, queue, job: null });
    }
  }

  // BullMQ: `new Worker('email', handler)`.
  NEW_WORKER.lastIndex = 0;
  while ((m = NEW_WORKER.exec(safe)) !== null) {
    const line = lineOf(m.index);
    const node = handlerNode(ctx, facts, safe.slice(m.index + m[0].length, m.index + m[0].length + 200), line, cache);
    if (!node) continue;
    consumers.push({ node, file: facts.file, line, queue: m[2]!, job: null });
  }

  // Bull: `queue.process('welcome', handler)` / `queue.process(handler)`.
  QUEUE_PROCESS.lastIndex = 0;
  while ((m = QUEUE_PROCESS.exec(safe)) !== null) {
    const receiver = m[1]!;
    const queue = queueFor(ctx, facts, receiver, cache);
    const last = receiver.replace(/\s+/g, '').split('.').pop()!;
    if (queue === null && !QUEUE_SHAPED.test(last)) continue;
    const line = lineOf(m.index);
    const node = handlerNode(ctx, facts, safe.slice(m.index + m[0].length, m.index + m[0].length + 200), line, cache);
    if (!node) continue;
    consumers.push({ node, file: facts.file, line, queue, job: m[3] ?? null });
  }
}

function pairQueue(producers: readonly QueueProducer[], consumers: readonly QueueConsumer[], edges: Edge[], seen: Set<string>): void {
  const askB2 = deciding('B2');
  const link = (p: QueueProducer, c: QueueConsumer, decision?: Record<string, unknown>): void => {
    if (c.node.id === p.fn.id) return;
    const key = `${p.fn.id}>${c.node.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      source: p.fn.id,
      target: c.node.id,
      kind: 'calls',
      line: p.line,
      column: p.column,
      provenance: 'heuristic',
      metadata: {
        synthesizedBy: 'queue-job',
        channel: 'queue',
        callee: p.callee,
        event: p.job,
        ...(p.queue ?? c.queue ? { queue: p.queue ?? c.queue } : {}),
        registeredAt: `${c.file}:${c.line}`,
        ...decision,
      },
    });
  };
  for (const p of producers) {
    let candidates = consumers.filter((c) => (p.queue === null || c.queue === null || c.queue === p.queue) && (c.job === null || c.job === p.job));
    // The most specific pairing wins: the job by name on the named queue,
    // then the job by name, then the queue's default consumer.
    const exact = candidates.filter((c) => c.job === p.job && c.queue === p.queue && p.queue !== null);
    if (exact.length > 0) candidates = exact;
    else {
      const byJob = candidates.filter((c) => c.job === p.job);
      if (byJob.length > 0) candidates = byJob;
      else if (p.queue === null) continue; // an unnamed queue and no consumer naming the job: a guess
      else candidates = candidates.filter((c) => c.queue === p.queue);
    }
    if (candidates.length === 0 || candidates.length > EVENT_FANOUT_CAP) {
      // Decision point B2 (src/decision): over the cap, link only the pairs a model judged to share one queue.
      if (askB2) {
        const ask = b2Asker('queue', p.job);
        for (const c of candidates) {
          const mark = ask(p.fn.id, c.node.id, () => ({ dispatcher: { filePath: p.file, line: p.line }, handler: { filePath: c.file, line: c.line } }));
          if (mark) link(p, c, mark);
        }
      }
      continue;
    }
    for (const c of candidates) link(p, c);
  }
}

// =============================================================================
// 3. Events: a bus, and sockets both ways
// =============================================================================

// A word character opens these chains, so a word's first character is the
// only start that can match (same argument as CHAIN_START).
const EMIT = /(?<![\w$])((?:[\w$]+(?:\([^()]*\))?\s*\.\s*)*[\w$]+)\s*\.\s*(emit|emitAsync)\s*\(\s*(['"`])([^'"`\n]+)\3/g;
const SOCKET_ON = /(?<![\w$])((?:[\w$]+(?:\([^()]*\))?\s*\.\s*)*[\w$]+)\s*\.\s*(?:on|once)\s*\(\s*(['"`])([^'"`\n]+)\2\s*,\s*/g;
const SOCKET_WORDS = /^(?:socket|io|ws|wss|client|server|namespace|nsp|conn|connection|gateway|broadcast|to|in|of|except|volatile|local|sockets|socketServer|wsServer|room|channel|pusher|ably|ioClient|socketClient|sock)$/;
const BUS_WORDS = /^(?:eventEmitter|emitter|events|eventBus|bus|dispatcher|pubsub|publisher|eventPublisher|ee|hub|mediator|broker|messageBus|appEvents|domainEvents|eventsService|eventService)$/;
/** The transport's own events — every socket emits and handles them; pairing them says nothing. */
const GENERIC_EVENT =
  /^(?:error|connect|connect_error|connect_failed|connection|disconnect|disconnecting|reconnect|reconnect_attempt|reconnecting|reconnect_error|reconnect_failed|close|open|end|data|ready|drain|finish|pipe|unpipe|listening|timeout|ping|pong|upgrade|newListener|removeListener)$/;

interface Dispatch {
  fn: Node;
  file: string;
  line: number;
  column: number;
  callee: string;
  event: string;
  shape: 'bus' | 'socket';
  side: 'server' | 'client';
}

interface Handler {
  node: Node;
  file: string;
  line: number;
  /** An event name, or an `@OnEvent` glob. */
  pattern: string;
  kind: 'bus' | 'socket';
  side: 'server' | 'client';
}

function shapeOf(receiver: string): 'bus' | 'socket' | null {
  const segs = receiver.replace(/\([^()]*\)/g, '').replace(/\s+/g, '').split('.').filter((s) => s !== 'this');
  if (segs.some((s) => SOCKET_WORDS.test(s))) return 'socket';
  if (segs.some((s) => BUS_WORDS.test(s))) return 'bus';
  return null;
}

function collectEvents(ctx: ResolutionContext, facts: FileFacts, dispatches: Dispatch[], handlers: Handler[], cache: Map<string, FileFacts | null>): void {
  const { safe, lineOf } = facts;
  const side: 'server' | 'client' = facts.socketServer ? 'server' : 'client';
  let m: RegExpExecArray | null;
  EMIT.lastIndex = 0;
  while ((m = EMIT.exec(safe)) !== null) {
    const shape = shapeOf(m[1]!);
    if (!shape || GENERIC_EVENT.test(m[4]!)) continue;
    const line = lineOf(m.index);
    const fn = enclosingFn(facts.nodes, line);
    if (!fn) continue;
    dispatches.push({ fn, file: facts.file, line, column: facts.columnOf(m.index), callee: `${m[1]!.replace(/\s+/g, '')}.${m[2]!}`, event: m[4]!, shape, side });
  }
  for (const d of decorators(safe, 'OnEvent')) {
    const method = decoratedMethod(facts, d.end, null);
    if (!method) continue;
    const patterns = d.args.trimStart().startsWith('[') ? allLiterals(d.args) : [firstLiteral(d.args)].filter((x): x is string => x !== null);
    for (const pattern of patterns) handlers.push({ node: method, file: facts.file, line: lineOf(d.index), pattern, kind: 'bus', side });
  }
  for (const d of decorators(safe, 'SubscribeMessage')) {
    const method = decoratedMethod(facts, d.end, null);
    const event = firstLiteral(d.args);
    if (!method || event === null) continue;
    handlers.push({ node: method, file: facts.file, line: lineOf(d.index), pattern: event, kind: 'socket', side: 'server' });
  }
  SOCKET_ON.lastIndex = 0;
  while ((m = SOCKET_ON.exec(safe)) !== null) {
    if (shapeOf(m[1]!) !== 'socket' || GENERIC_EVENT.test(m[3]!)) continue;
    const line = lineOf(m.index);
    const node = handlerNode(ctx, facts, safe.slice(m.index + m[0].length, m.index + m[0].length + 200), line, cache);
    if (!node) continue;
    handlers.push({ node, file: facts.file, line, pattern: m[3]!, kind: 'socket', side });
  }
}

/** `user.*` matches one segment, `**` any; anything else is exact. */
function eventMatches(pattern: string, event: string): boolean {
  if (pattern === event) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp('^' + pattern.split('**').map((part) => part.split('*').map(escapeRe).join('[^.]+')).join('.*') + '$');
  return re.test(event);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pairEvents(dispatches: readonly Dispatch[], handlers: readonly Handler[], edges: Edge[], seen: Set<string>): void {
  // Fan-out is judged per event name on each side, as the emitter pass does.
  const dispatchesByEvent = new Map<string, Dispatch[]>();
  for (const d of dispatches) dispatchesByEvent.set(`${d.shape}:${d.event}`, [...(dispatchesByEvent.get(`${d.shape}:${d.event}`) ?? []), d]);
  const askB2 = deciding('B2');
  const link = (d: Dispatch, h: Handler, tier: string | null, decision?: Record<string, unknown>): void => {
    if (h.node.id === d.fn.id) return;
    const key = `${d.fn.id}>${h.node.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      source: d.fn.id,
      target: h.node.id,
      kind: 'calls',
      line: d.line,
      column: d.column,
      provenance: 'heuristic',
      metadata: {
        synthesizedBy: 'event-bus',
        channel: d.shape === 'bus' ? 'event' : 'socket',
        callee: d.callee,
        event: d.event,
        ...(tier ? { tier } : {}),
        registeredAt: `${h.file}:${h.line}`,
        ...decision,
      },
    });
  };
  for (const [, group] of dispatchesByEvent) {
    const overGroup = group.length > EVENT_FANOUT_CAP;
    if (overGroup && !askB2) continue;
    let ask: ReturnType<typeof b2Asker> | undefined; // decision point B2: one budget per event
    for (const d of group) {
      let matched: Handler[];
      let tier: string | null = null;
      if (d.shape === 'bus') matched = handlers.filter((h) => h.kind === 'bus' && eventMatches(h.pattern, d.event));
      else if (d.side === 'client') {
        matched = handlers.filter((h) => h.kind === 'socket' && h.side === 'server' && h.pattern === d.event);
        tier = TIER_CLIENT_TO_SERVER;
      } else {
        matched = handlers.filter((h) => h.kind === 'socket' && h.side === 'client' && h.pattern === d.event);
        tier = TIER_SERVER_TO_CLIENT;
      }
      if (overGroup || matched.length === 0 || matched.length > EVENT_FANOUT_CAP) {
        // Decision point B2 (src/decision): over a fan-out cap, link only the pairs a model judged to share one bus or socket.
        if (askB2) {
          ask ??= b2Asker(d.shape, d.event);
          for (const h of matched) {
            const mark = ask(d.fn.id, h.node.id, () => ({ dispatcher: { filePath: d.file, line: d.line }, handler: { filePath: h.file, line: h.line } }));
            if (mark) link(d, h, tier, mark);
          }
        }
        continue;
      }
      for (const h of matched) link(d, h, tier);
    }
  }
}

// =============================================================================
// The pass
// =============================================================================

// =============================================================================
// 4. Test request → route
// =============================================================================

/*
 * Spring and Laravel tests reach a controller by URL, never by a call:
 * MockMvc's `perform(post("/owners/new"))`, WebTestClient's `.get().uri(…)`,
 * TestRestTemplate, RestAssured, and Laravel's `$this->postJson('api/me')`.
 * Without an edge every controller those suites exercise reads as untested —
 * the viewer's "No test reaches this" and explore's `tests:` line both walk
 * callers. One edge per (test, route), from the test method (the file, for a
 * Pest closure) to the route; the route's own edge reaches the handler.
 *
 * These are the one kind of edge whose source is a test. They don't count
 * toward a route's fan-in (countIncomingEdges), so a well-tested endpoint
 * never becomes a hub the Steps walk refuses to enter.
 */

const TEST_REQUEST_FILE = /\.(?:java|kt|kts|php)$/;
const TEST_VERBS = 'get|post|put|patch|delete|head|options';
/** A bare `get("/x")` is MockMvc's only where the file imports its builders. */
const MOCKMVC_BUILDERS = /\bMockMvcRequestBuilders\b/;
const MOCKMVC_BUILDER = new RegExp(String.raw`(?<![\w$.])(?:MockMvcRequestBuilders\s*\.\s*)?(${TEST_VERBS}|multipart)\s*\(`, 'g');
const MOCKMVC_REQUEST = /(?<![\w$.])(?:MockMvcRequestBuilders\s*\.\s*)?request\s*\(\s*HttpMethod\s*\.\s*([A-Z]+)\s*,/g;
const KOTLIN_MOCKMVC = new RegExp(String.raw`\b\w*[mM]ockMvc\s*\.\s*(${TEST_VERBS})\s*\(`, 'g');
const WEB_TEST_CLIENT = new RegExp(String.raw`\.\s*(${TEST_VERBS})\s*\(\s*\)\s*\.\s*uri\s*\(`, 'g');
const REST_TEMPLATE = /\b\w*[Rr]estTemplate\s*\.\s*(getForEntity|getForObject|postForEntity|postForObject|postForLocation|put|delete|patchForObject|exchange)\s*\(/g;
const REST_ASSURED = new RegExp(String.raw`(?:\.\s*when\s*\(\s*\)\s*|\bRestAssured\s*)\.\s*(${TEST_VERBS})\s*\(`, 'g');
const LARAVEL_REQUEST = new RegExp(String.raw`->\s*(${TEST_VERBS})(Json)?\s*\(`, 'g');
const LARAVEL_JSON_CALL = /->\s*(?:json|call)\s*\(\s*(['"])([A-Za-z]+)\1\s*,/g;
/** A project's own request helper, named for its verb: koel's `getAs($url, $user)`, `postAsAdmin(…)`. */
const LARAVEL_HELPER = new RegExp(String.raw`->\s*((${TEST_VERBS})[A-Z]\w*)\s*\(`, 'g');
const LARAVEL_BUILTIN_JSON = new RegExp(String.raw`^(?:${TEST_VERBS})Json$`);
/** A Laravel request made in a method body: the call a request helper must end in. */
const LARAVEL_REQUEST_IN_BODY = new RegExp(String.raw`->\s*(?:(?:${TEST_VERBS})(?:Json)?|json|call)\s*\(`);
/** Pest's `get('/x')` / `postJson(…)` helpers, where the file imports them. */
const PEST_HELPERS = /Pest\\Laravel/;
const PEST_REQUEST = new RegExp(String.raw`(?<![\w$>:\\])(${TEST_VERBS})(Json)?\s*\(`, 'g');
const TEST_REQUEST_GATE = /[mM]ockMvc|[wW]ebTestClient\b|[rR]estTemplate\b|\bRestAssured\b|\.\s*when\s*\(\s*\)|\$this\s*->|Pest\\Laravel/;

export function hasTestRequestPattern(filePath: string, content: string): boolean {
  return TEST_REQUEST_FILE.test(filePath) && isTestPath(filePath) && TEST_REQUEST_GATE.test(content);
}

interface TestSite {
  from: Node;
  line: number;
  column: number;
  callee: string;
  method: string;
  segs: string[];
  display: string;
}

/**
 * The string a request's path argument builds, starting at `i`: literals
 * verbatim, each computed piece (a concatenated operand, an interpolation, a
 * Spring `{var}` template) as one HOLE. Null unless it starts with a literal —
 * `route('songs.index')` or `$url` names no path this pass can read.
 */
function readRequestPath(s: string, i: number, lang: 'java' | 'kotlin' | 'php'): string | null {
  const concat = lang === 'php' ? '.' : '+';
  let out = '';
  let literal = false;
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      const interpolates = q === '"' && lang !== 'java';
      for (i++; i < s.length && s[i] !== q; i++) {
        const c = s[i]!;
        if (c === '\\') { out += s[++i] ?? ''; continue; }
        if (interpolates && c === '$' && /[{\w]/.test(s[i + 1] ?? '')) {
          // `${expr}`, `$name`, PHP's `$user->id` / `$row['k']`
          if (s[i + 1] === '{') i = closeBrace(s, i + 1);
          else {
            while (/\w/.test(s[i + 1] ?? '')) i++;
            if (lang === 'php') {
              while (s.startsWith('->', i + 1) && /\w/.test(s[i + 3] ?? '')) for (i += 2; /\w/.test(s[i + 1] ?? ''); i++);
            }
          }
          out += HOLE;
          continue;
        }
        if (interpolates && lang === 'php' && c === '{' && s[i + 1] === '$') {
          i = closeBrace(s, i);
          out += HOLE;
          continue;
        }
        out += c;
      }
      if (i >= s.length) return null;
      i++;
      literal = true;
    } else {
      if (!literal) return null;
      const end = operandEnd(s, i, concat);
      if (end === i) break;
      out += HOLE;
      i = end;
    }
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s[i] === concat && !(concat === '.' && /\d/.test(s[i + 1] ?? ''))) { i++; continue; }
    break;
  }
  if (!literal) return null;
  // Spring's URI templates: `get("/owners/{ownerId}", id)`.
  return lang === 'php' ? out : out.replace(/\{[^{}/]*\}/g, HOLE);
}

/** Index of the `}` closing the `{` at `open` (or the end of `s`). */
function closeBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return s.length - 1;
}

/** End of a concatenated operand starting at `i`: the next top-level operator, `,` or `)`. */
function operandEnd(s: string, i: number, concat: string): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' || c === "'") {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && (c === ',' || c === ';' || (c === concat && !(concat === '.' && /\d/.test(s[i + 1] ?? ''))))) return i;
    // `$user->id`: an arrow is part of the operand, not a concatenation.
    if (c === '-' && s[i + 1] === '>') i++;
  }
  return i;
}

/** A test URL as route segments: app-relative, holes as `*`; null when nothing literal is left. */
function testRequestPath(raw: string): { segs: string[]; display: string } | null {
  let p = raw;
  const cut = p.search(/[?#]/);
  if (cut >= 0) p = p.slice(0, cut);
  const absolute = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*(\/.*)?$/i.exec(p);
  if (absolute) p = absolute[1] ?? '/';
  const segs = p
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (s.includes(HOLE) ? '*' : s));
  if (segs.some((s) => s !== '*') === false && segs.length > 0) return null;
  return { segs, display: '/' + segs.map((s) => (s === '*' ? '${…}' : s)).join('/') };
}

/**
 * Whether `name` is a request helper in the project's tests: a PHP method
 * defined in a test file whose body makes a Laravel request, directly or
 * through one more `$this->helper(…)` (koel's `getAs` → `jsonAs` →
 * `$this->json($method, $uri)`). The name alone never decides it.
 */
function isRequestHelper(ctx: ResolutionContext, name: string, memo: Map<string, boolean>, depth = 0): boolean {
  const known = memo.get(name);
  if (known !== undefined) return known;
  memo.set(name, false); // cycle guard
  let ok = false;
  for (const n of ctx.getNodesByName(name)) {
    if (n.kind !== 'method' || n.language !== 'php' || !isTestPath(n.filePath)) continue;
    const lines = ctx.getFileLines?.(n.filePath) ?? ctx.readFile(n.filePath)?.split(/\r?\n/) ?? null;
    if (!lines) continue;
    const body = lines.slice(n.startLine - 1, n.endLine).join('\n');
    if (LARAVEL_REQUEST_IN_BODY.test(body)) ok = true;
    else if (depth === 0) {
      for (const call of body.matchAll(/\$this\s*->\s*(\w+)\s*\(/g)) {
        if (call[1] !== name && isRequestHelper(ctx, call[1]!, memo, depth + 1)) { ok = true; break; }
      }
    }
    if (ok) break;
  }
  // A depth-limited "no" is not final; only remember it at the top level.
  if (ok || depth === 0) memo.set(name, ok);
  else memo.delete(name);
  return ok;
}

/**
 * Whether the `->` at `arrow` ends a chain rooted at `$this` that only CALLS
 * methods — `$this->actingAs($u)->withHeaders([…])->` — so `$this->app->get(
 * 'config')` (a container lookup through a property) is never a request.
 */
function thisRootedCalls(s: string, arrow: number): boolean {
  let from = arrow;
  for (let tries = 0; tries < 4; tries++) {
    const root = s.lastIndexOf('$this', from - 1);
    if (root < 0) return false;
    let i = root + '$this'.length;
    for (;;) {
      while (/\s/.test(s[i] ?? '')) i++;
      if (i === arrow) return true;
      if (!s.startsWith('->', i)) break;
      i += 2;
      while (/\s/.test(s[i] ?? '')) i++;
      const ident = /^\w+/.exec(s.slice(i, i + 64));
      if (!ident) break;
      i += ident[0].length;
      while (/\s/.test(s[i] ?? '')) i++;
      if (s[i] !== '(') break;
      const close = closeParen(s, i);
      if (close < 0) break;
      i = close + 1;
    }
    from = root;
  }
  return false;
}

function collectTestRequests(ctx: ResolutionContext, file: string, sites: TestSite[], helpers: Map<string, boolean>): void {
  const content = ctx.readFile(file);
  if (!content || !TEST_REQUEST_GATE.test(content)) return;
  const lang: 'java' | 'kotlin' | 'php' = file.endsWith('.php') ? 'php' : /\.kts?$/.test(file) ? 'kotlin' : 'java';
  const safe = stripCommentsForRegex(content, lang === 'php' ? 'php' : 'java');
  const lineOf = makeLineAt(safe, 1);
  let nodes: Node[] | null = null;
  const add = (index: number, argAt: number, method: string, callee: string): void => {
    const raw = readRequestPath(safe, argAt, lang);
    if (raw === null) return;
    const path = testRequestPath(raw);
    if (!path) return;
    const line = lineOf(index);
    nodes ??= ctx.getNodesInFile(file);
    const from = enclosingFn(nodes, line) ?? nodes.find((n) => n.kind === 'file');
    if (!from) return;
    const column = index - (safe.lastIndexOf('\n', index - 1) + 1);
    sites.push({ from, line, column, callee, method: method.toUpperCase(), segs: path.segs, display: path.display });
  };
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void): void => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(safe)) !== null) fn(m);
  };
  const openOf = (m: RegExpExecArray) => m.index + m[0].length;

  if (lang === 'php') {
    each(LARAVEL_REQUEST, (m) => {
      if (thisRootedCalls(safe, m.index)) add(m.index, openOf(m), m[1]!, `$this->${m[1]}${m[2] ?? ''}`);
    });
    each(LARAVEL_JSON_CALL, (m) => {
      if (thisRootedCalls(safe, m.index)) add(m.index, openOf(m), m[2]!, '$this->json');
    });
    each(LARAVEL_HELPER, (m) => {
      const name = m[1]!;
      if (LARAVEL_BUILTIN_JSON.test(name)) return; // getJson / postJson, read above
      if (thisRootedCalls(safe, m.index) && isRequestHelper(ctx, name, helpers)) add(m.index, openOf(m), m[2]!, `$this->${name}`);
    });
    if (PEST_HELPERS.test(safe)) each(PEST_REQUEST, (m) => add(m.index, openOf(m), m[1]!, `${m[1]}${m[2] ?? ''}`));
    return;
  }
  if (MOCKMVC_BUILDERS.test(safe)) {
    each(MOCKMVC_BUILDER, (m) => add(m.index, openOf(m), m[1] === 'multipart' ? 'post' : m[1]!, m[1]!));
    each(MOCKMVC_REQUEST, (m) => add(m.index, openOf(m), m[1]!, 'request'));
  }
  each(KOTLIN_MOCKMVC, (m) => add(m.index, openOf(m), m[1]!, `mockMvc.${m[1]}`));
  each(WEB_TEST_CLIENT, (m) => add(m.index, openOf(m), m[1]!, `${m[1]}().uri`));
  each(REST_ASSURED, (m) => add(m.index, openOf(m), m[1]!, m[1]!));
  each(REST_TEMPLATE, (m) => {
    const name = m[1]!;
    let method: string | null = name.startsWith('get') ? 'GET' : name.startsWith('post') ? 'POST'
      : name === 'put' ? 'PUT' : name === 'delete' ? 'DELETE' : name.startsWith('patch') ? 'PATCH' : null;
    if (name === 'exchange') {
      const args = argumentsAt(safe, openOf(m) - 1);
      method = /HttpMethod\s*\.\s*([A-Z]+)/.exec(args?.[1] ?? '')?.[1] ?? null;
    }
    if (method) add(m.index, openOf(m), method, `restTemplate.${name}`);
  });
}

/** Edges from a test's request to the route it reaches. */
export async function testRequestEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const routes = httpRoutes(ctx);
  if (routes.length === 0) return [];
  const sites: TestSite[] = [];
  const helpers = new Map<string, boolean>();
  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if (!TEST_REQUEST_FILE.test(file) || !isTestPath(file)) continue;
    if ((++scanned & 63) === 0) await onYield();
    collectTestRequests(ctx, file, sites, helpers);
  }
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const site of sites) {
    const route = matchHttp({ fn: site.from, file: site.from.filePath, line: site.line, column: site.column, callee: site.callee,
      method: site.method, segs: site.segs, suffix: false, display: site.display }, routes);
    if (!route) continue;
    const key = `${site.from.id}>${route.node.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      source: site.from.id,
      target: route.node.id,
      kind: 'calls',
      line: site.line,
      column: site.column,
      provenance: 'heuristic',
      metadata: {
        synthesizedBy: 'test-request',
        channel: 'http',
        callee: site.callee,
        method: site.method,
        href: site.display,
        registeredAt: `${route.node.filePath}:${route.node.startLine}`,
        ...b3Mark(route.decisionP),
      },
    });
  }
  return edges;
}

const HTTP_GATE = /\b(?:fetch|\$fetch|ofetch|axios|ky|got|useFetch|useSWR)\b|\.\s*(?:get|post|put|patch|delete|head|options|request|\$get|\$post)\s*[<(]/;
const QUEUE_GATE = /\.\s*add\s*\(|@Processor\s*\(|\bnew\s+Worker\s*[<(]|\.\s*process\s*\(/;
const EVENT_GATE = /\.\s*(?:emit|emitAsync|on|once)\s*\(|@OnEvent\s*\(|@SubscribeMessage\s*\(/;

export function hasCrossTierPattern(content: string): boolean {
  return HTTP_GATE.test(content) || QUEUE_GATE.test(content) || EVENT_GATE.test(content);
}

export async function crossTierEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const routes = httpRoutes(ctx);
  const httpSites: HttpSite[] = [];
  const producers: QueueProducer[] = [];
  const consumers: QueueConsumer[] = [];
  const dispatches: Dispatch[] = [];
  const handlers: Handler[] = [];
  const cache = new Map<string, FileFacts | null>();

  let scanned = 0;
  for (const file of ctx.getAllFiles()) {
    if (!JS_FILE.test(file) || isTestPath(file) || isGeneratedFile(file)) continue;
    if ((++scanned & 63) === 0) await onYield();
    const content = ctx.readFile(file);
    if (!content) continue;
    const wantsHttp = routes.length > 0 && HTTP_GATE.test(content);
    const wantsQueue = QUEUE_GATE.test(content);
    const wantsEvents = EVENT_GATE.test(content);
    if (!wantsHttp && !wantsQueue && !wantsEvents) continue;
    let facts = cache.get(file);
    if (facts === undefined) {
      facts = readFacts(ctx, file);
      cache.set(file, facts);
    }
    if (!facts) continue;
    if (wantsHttp) collectHttpSites(ctx, facts, httpSites, cache);
    if (wantsQueue) collectQueue(ctx, facts, producers, consumers, cache);
    if (wantsEvents) collectEvents(ctx, facts, dispatches, handlers, cache);
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const site of httpSites) {
    const route = matchHttp(site, routes);
    if (!route || route.node.id === site.fn.id) continue;
    const key = `${site.fn.id}>${route.node.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      source: site.fn.id,
      target: route.node.id,
      kind: 'calls',
      line: site.line,
      column: site.column,
      provenance: 'heuristic',
      metadata: {
        synthesizedBy: 'http-client',
        channel: 'http',
        callee: site.callee,
        tier: TIER_CLIENT_TO_SERVER,
        method: site.method,
        href: site.display,
        registeredAt: `${route.node.filePath}:${route.node.startLine}`,
        ...b3Mark(route.decisionP ?? site.clientP), // the tie's verdict names the route; else the client verdict made the site
      },
    });
  }
  await onYield();
  pairQueue(producers, consumers, edges, seen);
  pairEvents(dispatches, handlers, edges, seen);
  return edges;
}
