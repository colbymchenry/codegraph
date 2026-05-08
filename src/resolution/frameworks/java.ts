/**
 * Java Framework Resolver
 *
 * Handles Spring Boot and general Java patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const springResolver: FrameworkResolver = {
  name: 'spring',

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

  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();

    // Extract REST endpoints
    // @GetMapping("/path"), @PostMapping("/path"), etc.
    const mappingPatterns = [
      /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g,
      /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:path\s*=\s*)?["']([^"']+)["']/g,
    ];

    for (const pattern of mappingPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const [, mappingType, path] = match;
        const line = content.slice(0, match.index).split('\n').length;

        const method = mappingType === 'Request' ? 'ANY' : mappingType!.toUpperCase();

        nodes.push({
          id: `route:${filePath}:${method}:${path}:${line}`,
          kind: 'route',
          name: `${method} ${path}`,
          qualifiedName: `${filePath}::${method}:${path}`,
          filePath,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'java',
          updatedAt: now,
        });
      }
    }

    // Extract class-level @RequestMapping for base path
    const baseMappingMatch = content.match(/@RequestMapping\s*\(\s*["']([^"']+)["']\s*\)/);
    if (baseMappingMatch) {
      const [, basePath] = baseMappingMatch;
      const line = content.slice(0, baseMappingMatch.index).split('\n').length;

      nodes.push({
        id: `route:${filePath}:BASE:${basePath}:${line}`,
        kind: 'route',
        name: `BASE ${basePath}`,
        qualifiedName: `${filePath}::BASE:${basePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: baseMappingMatch[0].length,
        language: 'java',
        updatedAt: now,
      });
    }

    return nodes;
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
