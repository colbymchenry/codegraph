/**
 * Java Framework Resolver
 *
 * Handles Spring Boot and general Java patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

export const springResolver: FrameworkResolver = {
  name: 'spring',
  languages: ['java', 'kotlin'],

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

    return { nodes, references };
  },
};

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
