/**
 * NestJS Framework Resolver
 *
 * Handles NestJS decorator-based routing across its transport layers:
 *   - HTTP:          @Controller(prefix) + @Get/@Post/@Put/@Patch/@Delete/@Head/@Options/@All
 *   - GraphQL:       @Resolver + @Query/@Mutation/@Subscription
 *   - Microservices: @MessagePattern / @EventPattern
 *   - WebSockets:    @WebSocketGateway(namespace) + @SubscribeMessage(event)
 *
 * Like the other framework extractors this is regex-over-source (comment-
 * stripped), not AST traversal. NestJS differs from Spring/ASP.NET in two ways
 * that this resolver has to account for:
 *
 *   1. An HTTP route's path is split across TWO decorators — the class-level
 *      `@Controller` prefix and the method-level `@Get`/`@Post` path — and both
 *      are frequently empty (`@Controller()`, `@Get()`). We pair each method
 *      decorator with its enclosing class and join the two paths.
 *
 *   2. `@Query()` is overloaded: it's a GraphQL *method* decorator (from
 *      `@nestjs/graphql`) AND a REST *parameter* decorator (from
 *      `@nestjs/common`). We only treat it as GraphQL when it sits inside an
 *      `@Resolver` class, which is what disambiguates the two.
 */

import { Node } from '../../types';
import {
  FrameworkResolver,
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
} from '../types';
import { stripCommentsForRegex } from '../strip-comments';

type JsLang = 'typescript' | 'javascript';

const HTTP_METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All'];
const GQL_OPS = ['Query', 'Mutation', 'Subscription'];

export const nestjsResolver: FrameworkResolver = {
  name: 'nestjs',
  languages: ['typescript', 'javascript'],

  detect(context: ResolutionContext): boolean {
    // Primary, fast path: any @nestjs/* dependency in package.json.
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (Object.keys(deps).some((k) => k.startsWith('@nestjs/'))) {
          return true;
        }
      } catch {
        // Invalid JSON — fall through to the source scan.
      }
    }

    // Fallback: NestJS-specific decorators in conventionally named files.
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (
        file.endsWith('.controller.ts') ||
        file.endsWith('.controller.js') ||
        file.endsWith('.module.ts') ||
        file.endsWith('.resolver.ts') ||
        file.endsWith('.gateway.ts')
      ) {
        const content = context.readFile(file);
        if (
          content &&
          (content.includes('@nestjs/') ||
            content.includes('@Controller') ||
            content.includes('@Module(') ||
            content.includes('@Resolver(') ||
            content.includes('@WebSocketGateway('))
        ) {
          return true;
        }
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Resolve provider/controller references (e.g. constructor-injected
    // `UsersService`) to their class, preferring the Nest file-name
    // convention (`*.service.ts`, `*.controller.ts`, …).
    for (const [suffix, convention] of PROVIDER_CONVENTIONS) {
      if (!suffix.test(ref.referenceName)) continue;
      const candidates = context
        .getNodesByName(ref.referenceName)
        .filter((n) => n.kind === 'class');
      if (candidates.length === 0) return null;
      const preferred = candidates.find((n) => n.filePath.includes(convention));
      const target = preferred ?? candidates[0]!;
      return {
        original: ref,
        targetNodeId: target.id,
        confidence: preferred ? 0.85 : 0.7,
        resolvedBy: 'framework',
      };
    }
    return null;
  },

  extract(filePath, content) {
    if (!/\.(m?js|tsx?|cjs)$/.test(filePath)) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const lang = detectLanguage(filePath);
    const safe = stripCommentsForRegex(content, lang);

    const addRoute = (
      index: number,
      method: string,
      path: string,
      length: number,
      handler: string | null
    ): void => {
      const line = lineAt(safe, index);
      const node: Node = {
        id: `route:${filePath}:${line}:${method}:${path}`,
        kind: 'route',
        name: `${method} ${path}`,
        qualifiedName: `${filePath}::${method}:${path}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: length,
        language: lang,
        updatedAt: now,
      };
      nodes.push(node);
      if (handler) {
        references.push({
          fromNodeId: node.id,
          referenceName: handler,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: lang,
        });
      }
    };

    const scopes = buildClassScopes(safe);

    // HTTP routes: method decorator path joined onto the enclosing controller's prefix.
    for (const hit of findDecorators(safe, HTTP_METHODS)) {
      const scope = scopeFor(scopes, hit.index);
      const prefix = scope && scope.kind === 'controller' ? scope.prefix : '';
      const path = joinHttpPath(prefix, parseStringArg(hit.args));
      addRoute(hit.index, hit.name.toUpperCase(), path, hit.length, methodNameAfter(safe, hit.end));
    }

    // GraphQL operations: only inside an @Resolver class (disambiguates the
    // REST `@Query()` parameter decorator, which lives inside @Controller classes).
    for (const hit of findDecorators(safe, GQL_OPS)) {
      const scope = scopeFor(scopes, hit.index);
      if (!scope || scope.kind !== 'resolver') continue;
      const handler = methodNameAfter(safe, hit.end);
      const name = parseGraphqlName(hit.args, handler);
      addRoute(hit.index, hit.name.toUpperCase(), name, hit.length, handler);
    }

    // Microservice message/event handlers.
    for (const hit of findDecorators(safe, ['MessagePattern', 'EventPattern'])) {
      const verb = hit.name === 'EventPattern' ? 'EVENT' : 'MESSAGE';
      const handler = methodNameAfter(safe, hit.end);
      addRoute(hit.index, verb, parseStringArg(hit.args) || handler || '', hit.length, handler);
    }

    // WebSocket message handlers, prefixed with the gateway namespace when present.
    for (const hit of findDecorators(safe, ['SubscribeMessage'])) {
      const scope = scopeFor(scopes, hit.index);
      const namespace = scope && scope.kind === 'gateway' ? scope.prefix : '';
      const handler = methodNameAfter(safe, hit.end);
      const event = parseStringArg(hit.args) || handler || '';
      addRoute(hit.index, 'WS', namespace ? `${namespace}:${event}` : event, hit.length, handler);
    }

    return { nodes, references };
  },
};

// ---------------------------------------------------------------------------
// Provider resolution conventions
// ---------------------------------------------------------------------------

const PROVIDER_CONVENTIONS: Array<[RegExp, string]> = [
  [/Service$/, '.service.'],
  [/Controller$/, '.controller.'],
  [/Resolver$/, '.resolver.'],
  [/Gateway$/, '.gateway.'],
  [/Repository$/, '.repository.'],
  [/Guard$/, '.guard.'],
  [/Interceptor$/, '.interceptor.'],
  [/Pipe$/, '.pipe.'],
  [/Module$/, '.module.'],
];

// ---------------------------------------------------------------------------
// Decorator scanning
// ---------------------------------------------------------------------------

interface DecoratorHit {
  /** Decorator name without the leading `@` (e.g. `Get`). */
  name: string;
  /** Raw text between the decorator's parentheses. */
  args: string;
  /** Index of the leading `@` in the (comment-stripped) source. */
  index: number;
  /** Index just past the decorator's closing `)`. */
  end: number;
  /** Character length of the whole `@Name(...)` decorator. */
  length: number;
}

/**
 * Find every `@Name(...)` decorator whose name is in `names`. Uses a
 * string-aware balanced-paren reader for the argument list so type thunks
 * like `@Query(() => [User])` are captured whole rather than truncated at the
 * inner `()`.
 */
function findDecorators(safe: string, names: string[]): DecoratorHit[] {
  const hits: DecoratorHit[] = [];
  const re = new RegExp(`@(${names.join('|')})\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(safe)) !== null) {
    const openIndex = m.index + m[0].length - 1; // position of '('
    const parsed = readArgs(safe, openIndex);
    if (!parsed) continue;
    hits.push({
      name: m[1]!,
      args: parsed.args,
      index: m.index,
      end: parsed.end,
      length: parsed.end - m.index,
    });
    re.lastIndex = parsed.end; // resume past the args so nested text isn't re-scanned
  }
  return hits;
}

/**
 * Read a balanced `(...)` starting at `openIndex` (which must point at `(`).
 * String-aware, so parens inside string literals don't unbalance the count.
 * Returns the inner text and the index just past the closing `)`.
 */
function readArgs(s: string, openIndex: number): { args: string; end: number } | null {
  if (s[openIndex] !== '(') return null;
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIndex; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { args: s.slice(openIndex + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * Starting just after a method decorator's `)`, return the name of the method
 * it decorates. Skips any further stacked decorators (`@UseGuards(...)`,
 * `@HttpCode(204)`, …) and access/async modifiers in between.
 */
function methodNameAfter(safe: string, start: number): string | null {
  let i = start;
  const ws = /\s*/y;
  const decoName = /@[\w.]+/y;
  const modifier = /(?:public|private|protected|async|static)\b/y;
  const ident = /([A-Za-z_$][\w$]*)\s*\(/y;

  const eatWs = (): void => {
    ws.lastIndex = i;
    if (ws.exec(safe)) i = ws.lastIndex;
  };

  // Skip stacked decorators.
  for (;;) {
    eatWs();
    if (safe[i] !== '@') break;
    decoName.lastIndex = i;
    if (!decoName.exec(safe)) break;
    i = decoName.lastIndex;
    eatWs();
    if (safe[i] === '(') {
      const parsed = readArgs(safe, i);
      if (!parsed) return null;
      i = parsed.end;
    }
  }

  // Skip access/async/static modifiers.
  for (;;) {
    eatWs();
    modifier.lastIndex = i;
    if (modifier.exec(safe) && modifier.lastIndex > i) {
      i = modifier.lastIndex;
      continue;
    }
    break;
  }

  eatWs();
  ident.lastIndex = i;
  const m = ident.exec(safe);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// Class scopes (controller / resolver / gateway boundaries)
// ---------------------------------------------------------------------------

type ClassKind = 'controller' | 'resolver' | 'gateway' | 'other';

interface ClassScope {
  kind: ClassKind;
  /** HTTP prefix (controller) or WS namespace (gateway); '' otherwise. */
  prefix: string;
  start: number;
  end: number;
}

/**
 * Build the list of class-level decorator scopes, sorted by position. Each
 * scope runs from its decorator up to the next class decorator (of any kind),
 * which lets a method decorator find its enclosing class regardless of how
 * many classes share a file.
 */
function buildClassScopes(safe: string): ClassScope[] {
  const defs: Array<{ kind: ClassKind; name: string; prefixOf: (a: string) => string }> = [
    { kind: 'controller', name: 'Controller', prefixOf: parseControllerPrefix },
    { kind: 'resolver', name: 'Resolver', prefixOf: () => '' },
    { kind: 'gateway', name: 'WebSocketGateway', prefixOf: parseGatewayNamespace },
    { kind: 'other', name: 'Injectable', prefixOf: () => '' },
    { kind: 'other', name: 'Module', prefixOf: () => '' },
    { kind: 'other', name: 'Catch', prefixOf: () => '' },
  ];

  const raw: Array<{ kind: ClassKind; prefix: string; index: number }> = [];
  for (const def of defs) {
    for (const hit of findDecorators(safe, [def.name])) {
      raw.push({ kind: def.kind, prefix: def.prefixOf(hit.args), index: hit.index });
    }
  }
  raw.sort((a, b) => a.index - b.index);

  return raw.map((r, i) => ({
    kind: r.kind,
    prefix: r.prefix,
    start: r.index,
    end: i + 1 < raw.length ? raw[i + 1]!.index : safe.length,
  }));
}

function scopeFor(scopes: ClassScope[], index: number): ClassScope | null {
  for (const s of scopes) {
    if (index >= s.start && index < s.end) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** First string literal anywhere in the args, or '' (covers `'x'`, `{ k: 'x' }`). */
function parseStringArg(args: string): string {
  const m = args.match(/['"`]([^'"`]*)['"`]/);
  return m ? m[1]! : '';
}

/** `@Controller('users')` | `@Controller({ path: 'users', host })` | `@Controller(['a','b'])` | `@Controller()`. */
function parseControllerPrefix(args: string): string {
  const obj = args.match(/path\s*:\s*['"`]([^'"`]*)['"`]/);
  if (obj) return obj[1]!;
  return parseStringArg(args);
}

/** `@WebSocketGateway({ namespace: 'chat' })` | `@WebSocketGateway(81, { namespace: '/chat' })` | `@WebSocketGateway()`. */
function parseGatewayNamespace(args: string): string {
  const m = args.match(/namespace\s*:\s*['"`]([^'"`]*)['"`]/);
  return m ? m[1]! : '';
}

/**
 * GraphQL operation name. Prefers an explicit `{ name: 'x' }` or a leading
 * string literal (`@Query('users')`); otherwise the field name defaults to the
 * handler method name. Avoids mistaking a `description` string for the name.
 */
function parseGraphqlName(args: string, handler: string | null): string {
  const named = args.match(/name\s*:\s*['"`]([^'"`]*)['"`]/);
  if (named) return named[1]!;
  const lead = args.match(/^\s*['"`]([^'"`]*)['"`]/);
  if (lead) return lead[1]!;
  return handler ?? '';
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Join a controller prefix and method path into a single normalised `/path`. */
function joinHttpPath(prefix: string, sub: string): string {
  const parts = [prefix, sub]
    .map((p) => p.trim().replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0);
  return '/' + parts.join('/');
}

function lineAt(safe: string, index: number): number {
  return safe.slice(0, index).split('\n').length;
}

function detectLanguage(filePath: string): JsLang {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return 'typescript';
  return 'javascript';
}
