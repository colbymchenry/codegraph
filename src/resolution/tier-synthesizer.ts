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
 * it is exact. Test suites and generated files are never sources: a supertest
 * call is the test's story, and forty of them would make the route a hub.
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
  nodes: Node[];
  lineOf: (idx: number) => number;
  /** The 0-based column of an index on its line — where the site reader looks for the call. */
  columnOf: (idx: number) => number;
  /** Lines a framework resolver made a route node on — registrations, never client calls. */
  routeLines: Set<number>;
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
  const nodes = ctx.getNodesInFile(file);
  const routeLines = new Set<number>();
  for (const n of nodes) if (n.kind === 'route') routeLines.add(n.startLine);
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
    nodes,
    lineOf: makeLineAt(safe, 1),
    columnOf: (idx: number) => idx - (safe.lastIndexOf('\n', idx - 1) + 1),
    routeLines,
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
const BARE_CLIENT_CALL = new RegExp(String.raw`(?:(?:window|globalThis|global)\s*\.\s*)?\b(fetch|\$fetch|ofetch|axios|ky|got|useFetch|useSWR)\s*${GENERIC}\s*\(`, 'g');
const MEMBER_CLIENT_CALL = new RegExp(
  String.raw`((?:this\s*\.\s*)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*(get|post|put|patch|delete|head|options|request|\$get|\$post|\$put|\$patch|\$delete)\s*${GENERIC}\s*\(`,
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

function matchHttp(site: HttpSite, routes: readonly HttpRoute[]): HttpRoute | null {
  let best: HttpRoute | null = null;
  let bestScore = -1;
  let tied = false;
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
      tied = false;
    } else if (score === bestScore) tied = true;
  }
  return tied ? null : best;
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
): { baseURL: string | null } | null {
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
  if (SERVER_NAMES.test(last) || SERVER_NAMES.test(head)) return null;
  if (CLIENT_NAMES.test(last)) return { baseURL: null };
  return null;
}

function collectHttpSites(ctx: ResolutionContext, facts: FileFacts, sites: HttpSite[], cache: Map<string, FileFacts | null>): void {
  const { safe, nodes, lineOf } = facts;
  const add = (index: number, open: number, verb: string | null, baseURL: string | null): void => {
    const line = lineOf(index);
    const callee = safe.slice(index, open).replace(/\s+/g, '').replace(/<.*>$/, '');
    if (facts.routeLines.has(line)) return; // a registration the resolver already read
    const fn = enclosingFn(nodes, line);
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
    sites.push({ fn, file: facts.file, line, column: facts.columnOf(index), callee, method, segs: path.segs, suffix: path.suffix, display: path.display });
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
    add(m.index, m.index + m[0].length - 1, verb === 'REQUEST' ? null : verb, client.baseURL);
  }
}

// =============================================================================
// 2. Queue job → consumer
// =============================================================================

const QUEUE_ADD = /((?:this\s*\.\s*)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*add\s*\(\s*(['"`])([^'"`]+)\2/g;
const QUEUE_SHAPED = /queue|jobs?$|worker|bull|flow|producer/i;
const NEW_WORKER = /\bnew\s+Worker\s*(?:<[^>]*>)?\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*/g;
const QUEUE_PROCESS = /((?:this\s*\.\s*)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*process\s*\(\s*(?:(['"`])([^'"`]+)\2\s*,\s*)?(?:\d+\s*,\s*)?/g;
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
  const { safe, nodes, lineOf } = facts;
  let m: RegExpExecArray | null;
  QUEUE_ADD.lastIndex = 0;
  while ((m = QUEUE_ADD.exec(safe)) !== null) {
    const receiver = m[1]!;
    const queue = queueFor(ctx, facts, receiver, cache);
    const last = receiver.replace(/\s+/g, '').split('.').pop()!;
    if (queue === null && !QUEUE_SHAPED.test(last)) continue;
    const line = lineOf(m.index);
    const fn = enclosingFn(nodes, line);
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
      const process = nodes.find((n) => n.kind === 'method' && n.name === 'process' && n.startLine >= cls.startLine && n.endLine <= cls.endLine);
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
    if (candidates.length === 0 || candidates.length > EVENT_FANOUT_CAP) continue;
    for (const c of candidates) {
      if (c.node.id === p.fn.id) continue;
      const key = `${p.fn.id}>${c.node.id}`;
      if (seen.has(key)) continue;
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
        },
      });
    }
  }
}

// =============================================================================
// 3. Events: a bus, and sockets both ways
// =============================================================================

const EMIT = /((?:[\w$]+(?:\([^()]*\))?\s*\.\s*)*[\w$]+)\s*\.\s*(emit|emitAsync)\s*\(\s*(['"`])([^'"`\n]+)\3/g;
const SOCKET_ON = /((?:[\w$]+(?:\([^()]*\))?\s*\.\s*)*[\w$]+)\s*\.\s*(?:on|once)\s*\(\s*(['"`])([^'"`\n]+)\2\s*,\s*/g;
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
  const { safe, nodes, lineOf } = facts;
  const side: 'server' | 'client' = facts.socketServer ? 'server' : 'client';
  let m: RegExpExecArray | null;
  EMIT.lastIndex = 0;
  while ((m = EMIT.exec(safe)) !== null) {
    const shape = shapeOf(m[1]!);
    if (!shape || GENERIC_EVENT.test(m[4]!)) continue;
    const line = lineOf(m.index);
    const fn = enclosingFn(nodes, line);
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
  for (const [, group] of dispatchesByEvent) {
    if (group.length > EVENT_FANOUT_CAP) continue;
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
      if (matched.length === 0 || matched.length > EVENT_FANOUT_CAP) continue;
      for (const h of matched) {
        if (h.node.id === d.fn.id) continue;
        const key = `${d.fn.id}>${h.node.id}`;
        if (seen.has(key)) continue;
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
          },
        });
      }
    }
  }
}

// =============================================================================
// The pass
// =============================================================================

const HTTP_GATE = /\b(?:fetch|\$fetch|ofetch|axios|ky|got|useFetch|useSWR)\b|\.\s*(?:get|post|put|patch|delete|head|options|request|\$get|\$post)\s*[<(]/;
const QUEUE_GATE = /\.\s*add\s*\(|@Processor\s*\(|\bnew\s+Worker\s*[<(]|\.\s*process\s*\(/;
const EVENT_GATE = /\.\s*(?:emit|emitAsync|on|once)\s*\(|@OnEvent\s*\(|@SubscribeMessage\s*\(/;

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
      },
    });
  }
  await onYield();
  pairQueue(producers, consumers, edges, seen);
  pairEvents(dispatches, handlers, edges, seen);
  return edges;
}
