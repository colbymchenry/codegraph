/**
 * Micronaut Framework Resolver
 *
 * Handles Micronaut HTTP route extraction and DI resolution.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

export const micronautResolver: FrameworkResolver = {
  name: 'micronaut',
  languages: ['java', 'kotlin'],

  detect(context: ResolutionContext): boolean {
    const pomXml = context.readFile('pom.xml');
    if (pomXml && pomXml.includes('io.micronaut')) {
      return true;
    }

    const buildGradle = context.readFile('build.gradle');
    if (buildGradle && buildGradle.includes('io.micronaut')) {
      return true;
    }

    const buildGradleKts = context.readFile('build.gradle.kts');
    if (buildGradleKts && buildGradleKts.includes('io.micronaut')) {
      return true;
    }

    // Multi-module: check settings.gradle for micronaut plugin
    const settingsGradle = context.readFile('settings.gradle');
    if (settingsGradle && settingsGradle.includes('micronaut')) {
      return true;
    }

    const settingsGradleKts = context.readFile('settings.gradle.kts');
    if (settingsGradleKts && settingsGradleKts.includes('micronaut')) {
      return true;
    }

    // Check for Micronaut annotations in Java/Kotlin files
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.java') || file.endsWith('.kt')) {
        const content = context.readFile(file);
        if (content && (
          content.includes('io.micronaut.http.annotation') ||
          content.includes('@MicronautApplication') ||
          content.includes('@Controller')
        )) {
          return true;
        }
      }
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Service/Bean references (DI)
    if (ref.referenceName.endsWith('Service')) {
      const result = resolveByNameAndKind(ref.referenceName, INJECTABLE_KINDS, SERVICE_DIRS, context);
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.85, resolvedBy: 'framework' };
      }
    }

    // Pattern 2: Repository references
    if (ref.referenceName.endsWith('Repository')) {
      const result = resolveByNameAndKind(ref.referenceName, INJECTABLE_KINDS, REPO_DIRS, context);
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.85, resolvedBy: 'framework' };
      }
    }

    // Pattern 3: Controller references
    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, CONTROLLER_DIRS, context);
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.85, resolvedBy: 'framework' };
      }
    }

    // Pattern 4: Client references (@Client interfaces)
    if (ref.referenceName.endsWith('Client')) {
      const result = resolveByNameAndKind(ref.referenceName, INJECTABLE_KINDS, CLIENT_DIRS, context);
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
      }
    }

    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.java') && !filePath.endsWith('.kt')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const lang: 'java' | 'kotlin' = filePath.endsWith('.kt') ? 'kotlin' : 'java';
    const safe = stripCommentsForRegex(content, 'java');

    // Class-level @Controller prefix
    let classPrefix = '';
    const controllerMatch = /@Controller\s*\(\s*([^)]*)\s*\)/.exec(safe);
    if (controllerMatch) {
      classPrefix = parseMicronautPath(controllerMatch[1]!);
    }

    // Also check @Client for declarative HTTP clients (same route extraction logic)
    if (!controllerMatch) {
      const clientMatch = /@Client\s*\(\s*([^)]*)\s*\)/.exec(safe);
      if (clientMatch) {
        classPrefix = parseMicronautPath(clientMatch[1]!);
      }
    }

    const VERB: Record<string, string> = {
      Get: 'GET',
      Post: 'POST',
      Put: 'PUT',
      Delete: 'DELETE',
      Patch: 'PATCH',
      Head: 'HEAD',
      Options: 'OPTIONS',
      Trace: 'TRACE',
    };

    // Match @Get, @Post, @Put, @Delete, @Patch, @Head, @Options, @Trace
    // Handles: @Get("/path"), @Get(uri="/path"), @Get(value="/path"), @Get (bare)
    const verbRegex = /@(Get|Post|Put|Delete|Patch|Head|Options|Trace)\b\s*(\([^)]*\))?/g;
    let match: RegExpExecArray | null;
    while ((match = verbRegex.exec(safe)) !== null) {
      const method = VERB[match[1]!]!;
      const args = (match[2] || '').replace(/^\(|\)$/g, '');
      const sub = parseMicronautPath(args);
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

      // Find the handler method following the annotation.
      // Handles: Kotlin `fun x(`, Java with modifiers `public X x(`, and
      // interface methods without modifiers `ReturnType name(`.
      const tail = safe.slice(match.index + match[0].length, match.index + match[0].length + 600);
      const methodMatch = tail.match(
        /\bfun\s+(\w+)\s*\(|\b(?:public|private|protected|internal)\s+[^;{=]*?\s+(\w+)\s*\(|^\s*\w[\w<>,?\s]*\s+(\w+)\s*\(/m,
      );
      if (methodMatch) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: (methodMatch[1] ?? methodMatch[2] ?? methodMatch[3])!,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: lang,
        });
      }
    }

    // Micronaut also supports @HttpMethodMapping for custom verbs
    const customVerbRegex = /@HttpMethodMapping\s*\(\s*([^)]*)\s*\)/g;
    while ((match = customVerbRegex.exec(safe)) !== null) {
      const args = match[1]!;
      const sub = parseMicronautPath(args);
      const routePath = joinPath(classPrefix, sub);
      const line = safe.slice(0, match.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:ANY:${routePath}`,
        kind: 'route',
        name: `ANY ${routePath}`,
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

      const tail = safe.slice(match.index + match[0].length, match.index + match[0].length + 600);
      const methodMatch = tail.match(
        /\bfun\s+(\w+)\s*\(|\b(?:public|private|protected|internal)\s+[^;{=]*?\s+(\w+)\s*\(|^\s*\w[\w<>,?\s]*\s+(\w+)\s*\(/m,
      );
      if (methodMatch) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: (methodMatch[1] ?? methodMatch[2] ?? methodMatch[3])!,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: lang,
        });
      }
    }

    return { nodes, references };
  },
};

// Directory patterns for Micronaut conventions
const SERVICE_DIRS = ['/service/', '/services/'];
const REPO_DIRS = ['/repository/', '/repositories/'];
const CONTROLLER_DIRS = ['/controller/', '/controllers/'];
const CLIENT_DIRS = ['/client/', '/clients/'];

const CLASS_KINDS = new Set(['class']);
const INJECTABLE_KINDS = new Set(['class', 'interface']);

/**
 * Parse a path from Micronaut annotation arguments.
 * Handles: "/path", uri="/path", uri = "/path", value="/path", bare empty
 */
function parseMicronautPath(args: string): string {
  if (!args.trim()) return '';
  // uri = "/path" or value = "/path"
  const namedParam = args.match(/(?:uri|value)\s*=\s*["']([^"']*)["']/);
  if (namedParam) return namedParam[1]!;
  // bare string: "/path"
  const bareString = args.match(/["']([^"']*)["']/);
  if (bareString) return bareString[1]!;
  return '';
}

/** Join a class-level prefix and a method sub-path into one normalized /path. */
function joinPath(prefix: string, sub: string): string {
  const parts = [prefix, sub].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return '/' + parts.join('/');
}

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

  const preferred = kindFiltered.filter((n) =>
    preferredDirPatterns.some((d) => n.filePath.includes(d)),
  );

  if (preferred.length > 0) return preferred[0]!.id;
  return kindFiltered[0]!.id;
}
