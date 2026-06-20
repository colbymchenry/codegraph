/**
 * Java Framework Resolver
 *
 * Handles Spring Boot and general Java patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import { JAVA_HTTP_CLIENT_REF_PREFIX, parseJavaHttpClientReference } from '../../extraction/java-http-client';

export const springResolver: FrameworkResolver = {
  name: 'spring',
  languages: ['java', 'kotlin', 'yaml', 'properties'],

  claimsReference(name: string): boolean {
    // `@ConfigurationProperties(prefix="app.cache")` emits a reference whose
    // name carries the `:prefix` sentinel — there's no declared symbol with
    // that exact spelling, so the resolver's name-existence pre-filter would
    // drop it. Opt those through.
    return name.endsWith(':prefix') || name.startsWith(JAVA_HTTP_CLIENT_REF_PREFIX);
  },

  detect(context: ResolutionContext): boolean {
    // Check for pom.xml with Spring
    const pomXml = context.readFile('pom.xml');
    if (pomXml && (pomXml.includes('spring-boot') || pomXml.includes('springframework'))) {
      return true;
    }

    // Check for build.gradle with Spring
    const buildGradle = context.readFile('build.gradle');
    if (buildGradle && (buildGradle.includes('spring-boot') || buildGradle.includes('springframework'))) {
      return true;
    }

    const buildGradleKts = context.readFile('build.gradle.kts');
    if (buildGradleKts && (buildGradleKts.includes('spring-boot') || buildGradleKts.includes('springframework'))) {
      return true;
    }

    // Check for Spring annotations in Java files
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.java')) {
        const content = context.readFile(file);
        if (content && (
          content.includes('@SpringBootApplication') ||
          content.includes('@RestController') ||
          content.includes('@Service') ||
          content.includes('@Repository')
        )) {
          return true;
        }
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const httpCall = parseJavaHttpClientReference(ref.referenceName);
    if (httpCall) {
      return resolveJavaHttpClientCall(ref, httpCall.method, httpCall.pathExpression, context);
    }

    // Spring config-key references — `@Value("${key}")` (single leaf) and
    // `@ConfigurationProperties(prefix="X")` (entire subtree, marked with the
    // `:prefix` suffix in extractSpringValueBindings). Lookup goes through
    // Spring's relaxed binding (kebab/camel/snake → canonical lowercase).
    if (ref.referenceName.endsWith(':prefix')) {
      const prefix = ref.referenceName.slice(0, -':prefix'.length);
      const canonPrefix = canonicalConfigKey(prefix);
      // Prefer an exact prefix match (one node = the prefix subtree). Without
      // node-level subtree representation we map to the closest matching key.
      const candidates = context.getNodesByKind('constant').filter(
        (n) => (n.language === 'yaml' || n.language === 'properties')
          && canonicalConfigKey(n.qualifiedName).startsWith(canonPrefix),
      );
      if (candidates.length === 0) return null;
      // Pick the SHORTEST canonical name — it's the closest binding point
      // (`app.cache` over `app.cache.name.user-token` for prefix=`app.cache`).
      const best = candidates.reduce((a, b) =>
        canonicalConfigKey(a.qualifiedName).length <= canonicalConfigKey(b.qualifiedName).length ? a : b,
      );
      return { original: ref, targetNodeId: best.id, confidence: 0.85, resolvedBy: 'framework' };
    }
    if (ref.referenceName.includes('.') && ref.language !== 'java' && ref.language !== 'kotlin') {
      // Spring config dotted key — only when the source language is Java/Kotlin
      // (the bindings come from `@Value`). Skip non-Spring refs that happen to
      // have dots in them.
    }
    if (
      (ref.language === 'java' || ref.language === 'kotlin') &&
      ref.referenceName.includes('.') &&
      !ref.referenceName.includes('::') &&
      // Exclude method-call style (single-dot, both sides lower-camel). Spring
      // config keys are typically 3+ segments and contain kebabs/dashes; we
      // can't filter perfectly but skipping single-dot keeps the lookup tight.
      ref.referenceName.split('.').length >= 2
    ) {
      const canonRef = canonicalConfigKey(ref.referenceName);
      const candidates = context.getNodesByKind('constant').filter(
        (n) => n.kind === 'constant'
          && (n.language === 'yaml' || n.language === 'properties')
          && canonicalConfigKey(n.qualifiedName) === canonRef,
      );
      if (candidates.length === 1) {
        return { original: ref, targetNodeId: candidates[0]!.id, confidence: 0.9, resolvedBy: 'framework' };
      }
      if (candidates.length > 1) {
        // Multiple profile-specific files (application-dev.yml +
        // application-prod.yml) can define the same key. Prefer the one with
        // the shortest profile suffix (the base `application.yml` wins over
        // profile variants when both exist), then by alphabetical path so the
        // pick is deterministic across reindexes.
        const score = (n: Node) => {
          const base = n.filePath.split('/').pop() ?? '';
          const isBase = /^(application|bootstrap)\.(yml|yaml|properties)$/i.test(base);
          return (isBase ? 0 : 1) * 1000 + base.length;
        };
        const best = candidates.reduce((a, b) => (score(a) <= score(b) ? a : b));
        return { original: ref, targetNodeId: best.id, confidence: 0.75, resolvedBy: 'framework' };
      }
    }

    // Pattern 1: Service references (dependency injection)
    if (ref.referenceName.endsWith('Service')) {
      const result = resolveByNameAndKind(ref.referenceName, SERVICE_KINDS, SERVICE_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Repository references
    if (ref.referenceName.endsWith('Repository')) {
      const result = resolveByNameAndKind(ref.referenceName, SERVICE_KINDS, REPO_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Controller references
    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, CONTROLLER_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Entity/Model references
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, ENTITY_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 5: Component references
    if (ref.referenceName.endsWith('Component') || ref.referenceName.endsWith('Config')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, COMPONENT_DIRS, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    // Spring config files (application.yml / application.properties /
    // bootstrap.yml + per-profile variants) are extracted on the framework
    // path, not in the language extractor, so the keys become first-class
    // nodes a `@Value("${k}")` reference can resolve to.
    if (isSpringConfigFile(filePath)) {
      return extractSpringConfig(filePath, content);
    }
    // Spring Boot is used from both Java and Kotlin (identical @GetMapping etc.
    // annotations); the difference is method syntax — Kotlin `fun name(...)` vs
    // Java `public X name(...)` — handled in the method regex below.
    if (!filePath.endsWith('.java') && !filePath.endsWith('.kt')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const lang: 'java' | 'kotlin' = filePath.endsWith('.kt') ? 'kotlin' : 'java';
    const safe = stripCommentsForRegex(content, 'java');

    // Class-level @RequestMapping prefix (an @RequestMapping whose tail leads to a
    // `class`). Joined onto each method's path — and, crucially, NOT treated as a
    // route itself (the old regex did, creating one bogus class route and missing
    // every BARE method mapping like `@PostMapping` with the path on the class).
    let classPrefix = '';
    const cls = /@RequestMapping\s*\(([^)]*)\)\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:public\s+|final\s+|abstract\s+|open\s+|data\s+|sealed\s+)*class\b/.exec(safe);
    if (cls) classPrefix = parseMappingPath(cls[1]!);

    const VERB: Record<string, string> = {
      GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', PatchMapping: 'PATCH', DeleteMapping: 'DELETE',
    };
    // Verb-specific method mappings — always method-level, BARE or with a path.
    const mappingRegex = /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b\s*(\([^)]*\))?/g;
    let match: RegExpExecArray | null;
    while ((match = mappingRegex.exec(safe)) !== null) {
      const method = VERB[match[1]!]!;
      const sub = parseMappingPath((match[2] || '').replace(/^\(|\)$/g, ''));
      const routePath = joinPath(classPrefix, sub);
      const line = safe.slice(0, match.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: lang,
        updatedAt: now,
      };
      nodes.push(routeNode);

      // Method it decorates: first declared method after (skip stacked annotations;
      // Java puts the return type before the name). Bounded so we don't grab a far one.
      const tail = safe.slice(match.index + match[0].length, match.index + match[0].length + 600);
      const methodMatch = tail.match(/\bfun\s+(\w+)\s*\(|\b(?:public|private|protected)\s+[^;{=]*?\s+(\w+)\s*\(/);
      if (methodMatch) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: (methodMatch[1] ?? methodMatch[2])!,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: lang,
        });
      }
    }

    // Method-level @RequestMapping (older style: `@RequestMapping(value="/x",
    // method=RequestMethod.GET)` on a method). The class-level @RequestMapping is
    // the prefix (handled above) — skip it here so it isn't double-counted.
    const reqRe = /@RequestMapping\b\s*(\([^)]*\))?/g;
    while ((match = reqRe.exec(safe)) !== null) {
      const args = (match[1] || '').replace(/^\(|\)$/g, '');
      const after = safe.slice(match.index + match[0].length, match.index + match[0].length + 600);
      if (/^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:public\s+|final\s+|abstract\s+|open\s+|data\s+|sealed\s+)*class\b/.test(after)) continue; // class-level prefix
      const methodMatch = after.match(/\bfun\s+(\w+)\s*\(|\b(?:public|private|protected)\s+[^;{=]*?\s+(\w+)\s*\(/);
      if (!methodMatch) continue;
      const verbM = args.match(/method\s*=\s*(?:RequestMethod\.)?(\w+)/);
      const method = verbM ? verbM[1]!.toUpperCase() : 'ANY';
      const routePath = joinPath(classPrefix, parseMappingPath(args));
      const line = safe.slice(0, match.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath, startLine: line, endLine: line, startColumn: 0, endColumn: match[0].length, language: lang, updatedAt: now,
      };
      nodes.push(routeNode);
      references.push({
        fromNodeId: routeNode.id,
        referenceName: (methodMatch[1] ?? methodMatch[2])!,
        referenceKind: 'references',
        line, column: 0, filePath, language: lang,
      });
    }

    // @Value("${key}") and @ConfigurationProperties(prefix="...") — bind
    // Spring config-key references in Java/Kotlin source. The reference target
    // is the corresponding YAML/properties leaf-key node emitted by
    // extractSpringConfig; springResolver.resolve looks it up with relaxed
    // binding (kebab/camel/snake collapse).
    extractSpringValueBindings(filePath, safe, lang, now, nodes, references);

    return { nodes, references };
  },
};

/** Spring config file patterns: application(-profile)?.{yml,yaml,properties} +
 * bootstrap variants. Matches the basename, not the path, so a project that
 * vendors `application.yml` under `src/main/resources` and one under `src/test/
 * resources` are both picked up. */
function isSpringConfigFile(filePath: string): boolean {
  const base = filePath.split('/').pop() ?? '';
  return /^(application|bootstrap)(-[\w.-]+)?\.(yml|yaml|properties)$/i.test(base);
}

/**
 * Parse a Spring config file (YAML or .properties) and emit one `constant`
 * node per LEAF key, with `qualifiedName` = the dotted path. Leaf keys are
 * what `@Value("${k}")` references hit; intermediate keys aren't bound by
 * Spring's `@Value` (a `@ConfigurationProperties` class binds a SUBTREE, and
 * those references are resolved at lookup time by prefix-suffix matching).
 */
function extractSpringConfig(
  filePath: string,
  content: string,
): { nodes: Node[]; references: UnresolvedRef[] } {
  const nodes: Node[] = [];
  const isProperties = /\.properties$/i.test(filePath);
  const lang = isProperties ? 'properties' : 'yaml';
  const now = Date.now();

  const emitLeaf = (dottedKey: string, line: number, valueText: string) => {
    if (!dottedKey) return;
    nodes.push({
      id: `spring-config:${filePath}:${line}:${dottedKey}`,
      kind: 'constant',
      name: dottedKey.split('.').pop() ?? dottedKey,
      qualifiedName: dottedKey,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: valueText.length,
      language: lang,
      signature: dottedKey,
      // SECURITY (#383): store the KEY only, never the value. Config files
      // routinely hold secrets (DB passwords, API keys, JDBC URLs with embedded
      // credentials), and surfacing the value here pushes it into agent context
      // unbidden (it lands in codegraph_node/explore output via the docstring).
      // The key is all `@Value`/`@ConfigurationProperties` resolution needs; an
      // agent that genuinely needs a value can read the file directly.
      updatedAt: now,
    });
  };

  if (isProperties) {
    // Properties format: `k1.k2.k3 = value` (or `:` separator, or no value).
    // Lines starting with `#`/`!` are comments. Backslash continuations are
    // valid but rare; we don't try to join them (a continued value is still
    // a value of the same key).
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? '';
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
      const sep = (() => {
        for (let j = 0; j < raw.length; j++) {
          const ch = raw[j];
          if (ch === '=' || ch === ':') return j;
          if (ch === '\\' && raw[j + 1]) { j++; continue; }
        }
        return -1;
      })();
      if (sep < 0) continue;
      const key = raw.slice(0, sep).trim();
      const val = raw.slice(sep + 1).trim();
      emitLeaf(key, i + 1, val);
    }
    return { nodes, references: [] };
  }

  // YAML: indent-based. We track a stack of (indent, key) so the dotted path
  // is built by joining ancestor keys with `.`. A leaf is a line with a value
  // on the same line (after `:`). List items, flow-style scalars, and `---`
  // separators are ignored — they don't bind to `@Value` anyway.
  const stack: Array<{ indent: number; key: string }> = [];
  const yamlLines = content.split(/\r?\n/);
  for (let i = 0; i < yamlLines.length; i++) {
    const raw = yamlLines[i] ?? '';
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed === '---' || trimmed.startsWith('- ')) continue;
    const indent = raw.length - raw.replace(/^[\t ]+/, '').length;
    const colonIdx = (() => {
      let inStr: string | null = null;
      for (let j = 0; j < raw.length; j++) {
        const ch = raw[j];
        if (inStr) { if (ch === inStr && raw[j - 1] !== '\\') inStr = null; continue; }
        if (ch === '"' || ch === "'") { inStr = ch; continue; }
        if (ch === ':') return j;
      }
      return -1;
    })();
    if (colonIdx < 0) continue;
    const key = raw.slice(indent, colonIdx).trim();
    if (!key) continue;
    const after = raw.slice(colonIdx + 1).trim();
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const dotted = [...stack.map((s) => s.key), key].join('.');
    if (after === '' || after.startsWith('#')) {
      stack.push({ indent, key });
    } else {
      // A leaf with an inline value (or a flow-mapping like `{ a: 1 }` — we
      // emit it as a leaf, not as a subtree; precision is fine for `@Value`).
      const valStripped = after.replace(/^["']|["']$/g, '');
      emitLeaf(dotted, i + 1, valStripped);
    }
  }
  return { nodes, references: [] };
}

/** Append `@Value("${k}")` and `@ConfigurationProperties(prefix=...)`
 * references discovered in `safe` (comments stripped) into the caller's
 * `nodes`/`references` arrays. */
function extractSpringValueBindings(
  filePath: string,
  safe: string,
  lang: 'java' | 'kotlin',
  now: number,
  nodes: Node[],
  references: UnresolvedRef[],
): void {
  const valueRe = /@Value\s*\(\s*["']\$\{([^}:]+)(?::[^}]*)?\}["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = valueRe.exec(safe)) !== null) {
    const key = m[1]!.trim();
    if (!key) continue;
    const line = safe.slice(0, m.index).split('\n').length;
    const bindNode: Node = {
      id: `spring-value:${filePath}:${line}:${key}`,
      kind: 'constant',
      name: key,
      qualifiedName: `${filePath}::@Value:${key}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: m[0].length,
      language: lang,
      signature: `@Value("${key}")`,
      updatedAt: now,
    };
    nodes.push(bindNode);
    references.push({
      fromNodeId: bindNode.id,
      referenceName: key,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: lang,
    });
  }

  const cpRe = /@ConfigurationProperties\s*\(\s*(?:prefix\s*=\s*)?["']([^"']+)["']/g;
  while ((m = cpRe.exec(safe)) !== null) {
    const prefix = m[1]!.trim();
    if (!prefix) continue;
    const line = safe.slice(0, m.index).split('\n').length;
    const bindNode: Node = {
      id: `spring-cp:${filePath}:${line}:${prefix}`,
      kind: 'constant',
      name: prefix,
      qualifiedName: `${filePath}::@ConfigurationProperties:${prefix}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: m[0].length,
      language: lang,
      signature: `@ConfigurationProperties("${prefix}")`,
      updatedAt: now,
    };
    nodes.push(bindNode);
    references.push({
      fromNodeId: bindNode.id,
      // Mark the reference with a `:prefix` suffix so springResolver.resolve
      // knows to expand it into the SUBTREE rather than a single key.
      referenceName: `${prefix}:prefix`,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: lang,
    });
  }
}

/** Spring's relaxed binding (`cache-list` ↔ `cacheList` ↔ `cache_list` ↔
 * `CACHE_LIST`) collapses on lowercase + dash/underscore removal. We compare
 * candidate keys to a reference in this canonical form. */
function canonicalConfigKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

// Directory patterns
const SERVICE_DIRS = ['/service/', '/services/'];
const REPO_DIRS = ['/repository/', '/repositories/'];
const CONTROLLER_DIRS = ['/controller/', '/controllers/'];
const ENTITY_DIRS = ['/entity/', '/entities/', '/model/', '/models/', '/domain/'];
const COMPONENT_DIRS = ['/component/', '/components/', '/config/'];

const CLASS_KINDS = new Set(['class']);
const SERVICE_KINDS = new Set(['class', 'interface']);

/** Path string from a mapping's args (`"/x"`, `value = "/x"`, `path = "/x"`); '' if bare. */
function parseMappingPath(args: string): string {
  const m = args.match(/["']([^"']*)["']/);
  return m ? m[1]! : '';
}

/** Join a class-level prefix and a method sub-path into one normalized `/path`. */
function joinPath(prefix: string, sub: string): string {
  const parts = [prefix, sub].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return '/' + parts.join('/');
}

function resolveJavaHttpClientCall(
  ref: UnresolvedRef,
  method: string,
  pathExpression: string,
  context: ResolutionContext,
): ResolvedRef | null {
  const candidatePaths = inferHttpPaths(pathExpression, ref, context);
  if (candidatePaths.length === 0) return null;

  let best: { node: Node; confidence: number } | null = null;
  const routes = context
    .getNodesByKind('route')
    .filter((n) => n.language === 'java' || n.language === 'kotlin');

  for (const candidatePath of candidatePaths) {
    for (const route of routes) {
      const confidence = scoreHttpRouteMatch(method, candidatePath, route);
      if (confidence <= 0) continue;
      if (!best || confidence > best.confidence) {
        best = { node: route, confidence };
      }
    }
  }

  if (!best) return null;
  return {
    original: ref,
    targetNodeId: best.node.id,
    confidence: best.confidence,
    resolvedBy: 'framework',
  };
}

function inferHttpPaths(
  expression: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  seen = new Set<string>(),
): string[] {
  const key = `${ref.filePath}:${expression}`;
  if (seen.has(key) || seen.size > 8) return [];
  seen.add(key);

  const direct = pathsFromStringLiterals(expression);
  if (direct.length > 0) return direct;

  const variableName = expression.match(/^[A-Za-z_]\w*$/)?.[0];
  if (variableName) {
    const assigned = findAssignedExpression(variableName, ref, context);
    if (assigned) return inferHttpPaths(assigned, ref, context, seen);
  }

  const methodName = extractTerminalMethodName(expression);
  if (methodName) {
    const paths: string[] = [];
    for (const methodNode of context.getNodesByName(methodName)) {
      if (methodNode.kind !== 'method' && methodNode.kind !== 'function') continue;
      if (methodNode.language !== 'java' && methodNode.language !== 'kotlin') continue;
      const body = sliceNodeText(methodNode, context);
      if (!body) continue;
      for (const returned of extractReturnExpressions(body, methodNode.language)) {
        paths.push(...inferHttpPaths(returned, { ...ref, filePath: methodNode.filePath }, context, seen));
      }
    }
    return unique(paths);
  }

  return [];
}

function pathsFromStringLiterals(expression: string): string[] {
  const literals = collectStringLiterals(expression);
  if (literals.length === 0) return [];

  const direct = literals
    .map(stringToHttpPath)
    .filter((p): p is string => !!p);
  if (direct.length > 0) return unique(direct);

  const joined = literals.join('');
  const joinedPath = stringToHttpPath(joined);
  return joinedPath ? [joinedPath] : [];
}

function collectStringLiterals(expression: string): string[] {
  const literals: string[] = [];
  const re = /(["'])(?:\\.|(?!\1).)*\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expression)) !== null) {
    literals.push(unescapeJavaString(m[0]!.slice(1, -1)));
  }
  return literals;
}

function stringToHttpPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '/';
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      return normalizeHttpPath(url.pathname || '/');
    }
  } catch {
    // Fall through to path-shaped handling.
  }
  if (trimmed.startsWith('/')) return normalizeHttpPath(trimmed);
  if (trimmed.includes('/')) return normalizeHttpPath('/' + trimmed.replace(/^\/+/, ''));
  return null;
}

function extractTerminalMethodName(expression: string): string | null {
  const m = expression.match(/(?:^|\.)([A-Za-z_]\w*)\s*\([^()]*\)\s*$/);
  return m ? m[1]! : null;
}

function findAssignedExpression(
  variableName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  const content = context.readFile(ref.filePath);
  if (!content) return null;
  const before = content.split(/\r?\n/).slice(0, Math.max(ref.line, 1)).join('\n');
  const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:\\b(?:String|URI|URL|var|val)\\s+)?${escaped}\\s*=\\s*([^;\\n]+)`, 'g');
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(before)) !== null) {
    last = m[1]!.trim();
  }
  return last;
}

function extractReturnExpressions(body: string, language: string): string[] {
  const expressions: string[] = [];
  const returnRe = /\breturn\s+([^;}\n]+)\s*;?/g;
  let m: RegExpExecArray | null;
  while ((m = returnRe.exec(body)) !== null) {
    expressions.push(m[1]!.trim());
  }
  if (language === 'kotlin' && expressions.length === 0) {
    const eq = body.match(/=\s*([^\n{}]+)/);
    if (eq) expressions.push(eq[1]!.trim());
  }
  return expressions;
}

function sliceNodeText(node: Node, context: ResolutionContext): string | null {
  const content = context.readFile(node.filePath);
  if (!content) return null;
  const lines = content.split(/\r?\n/);
  return lines.slice(Math.max(node.startLine - 1, 0), node.endLine).join('\n');
}

function scoreHttpRouteMatch(method: string, candidatePath: string, route: Node): number {
  const parsed = parseRouteName(route.name);
  if (!parsed) return 0;
  if (parsed.method !== method && parsed.method !== 'ANY') return 0;

  const candidate = normalizeHttpPath(candidatePath);
  const routePath = normalizeHttpPath(parsed.path);
  const anyPenalty = parsed.method === 'ANY' ? 0.05 : 0;

  if (candidate === routePath) return 0.93 - anyPenalty;
  if (routePath !== '/' && candidate.endsWith(routePath)) return 0.84 - anyPenalty;
  if (routePath !== '/' && routePath.endsWith(candidate)) return 0.8 - anyPenalty;
  if (routePatternMatches(routePath, candidate)) return 0.82 - anyPenalty;
  return 0;
}

function parseRouteName(name: string): { method: string; path: string } | null {
  const m = name.match(/^([A-Z]+)\s+(.+)$/);
  if (!m) return null;
  return { method: m[1]!, path: m[2]! };
}

function routePatternMatches(routePath: string, candidatePath: string): boolean {
  const escaped = routePath
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{[^/]+\\\}/g, '[^/]+')
    .replace(/:[A-Za-z_]\w*/g, '[^/]+');
  return new RegExp(`^${escaped}$`).test(candidatePath);
}

function normalizeHttpPath(path: string): string {
  const noQuery = path.split(/[?#]/, 1)[0] || '/';
  const withSlash = noQuery.startsWith('/') ? noQuery : '/' + noQuery;
  const collapsed = withSlash.replace(/\/+/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

function unescapeJavaString(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Resolve a symbol by name using indexed queries instead of scanning all files.
 */
function resolveByNameAndKind(
  name: string,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const kindFiltered = candidates.filter((n) => kinds.has(n.kind));
  if (kindFiltered.length === 0) return null;

  // Prefer candidates in framework-conventional directories
  const preferred = kindFiltered.filter((n) =>
    preferredDirPatterns.some((d) => n.filePath.includes(d))
  );

  if (preferred.length > 0) return preferred[0]!.id;

  // Fall back to any match
  return kindFiltered[0]!.id;
}
