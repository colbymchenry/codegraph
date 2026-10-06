import { Node } from '../../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../../types';
import { stripCommentsForRegex } from '../../strip-comments';
import { extractPath, extractMethods, extractName, extractDefaults, extractRequirements, extractHost, extractSchemes } from './attributes';
import { parseControllerServiceRef, resolveControllerMethod } from './controller';
import { isContainerFilePath } from './di';
import { extractYamlRoutes } from './yaml';
import { extractDoctrineEntities, extractDoctrineRepositories } from './doctrine';
import { extractEventSubscribers } from './events';
import { extractConsoleCommands } from './commands';
import { extractTwigReferences } from './twig';
import { extractContainerRoutes } from './container-routes';

export const symfonyResolver: FrameworkResolver = {
  name: 'symfony',
  languages: ['php', 'yaml'],

  detect(context: ResolutionContext): boolean {
    const composer = context.readFile('composer.json');
    if (composer) {
      try {
        const json = JSON.parse(composer) as {
          require?: Record<string, string>;
          'require-dev'?: Record<string, string>;
        };
        const deps = { ...json.require, ...(json['require-dev'] ?? {}) };
        if (Object.keys(deps).some(k => k === 'symfony/framework-bundle' || k === 'symfony/symfony')) {
          return true;
        }
        if (Object.keys(deps).some(k => k.startsWith('symfony/') && k !== 'symfony/polyfill-*')) {
          const hasConsole = context.fileExists('bin/console');
          const hasConfig = context.fileExists('config/');
          if (hasConsole && hasConfig) return true;
        }
      } catch {
      }
    }
    return context.fileExists('bin/console') && context.fileExists('config/');
  },

  claimsReference(name: string): boolean {
    return name.includes('::') || name.includes('\\') || name.endsWith('Controller');
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const parsed = parseControllerServiceRef(ref.referenceName);
    if (parsed) {
      const result = resolveControllerMethod(parsed.class, parsed.method, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.9,
          resolvedBy: 'framework',
        };
      }
    }
    return null;
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    // ── PHP ──────────────────────────────────────────────────────────────────
    if (filePath.endsWith('.php')) {
      const safe = stripCommentsForRegex(content, 'php');

      // Class-level #[Route] prefix
      let classPrefix = '';
      const classAttrMatch = safe.match(
        /#\[\s*Route\s*\(([^)]*)\)\s*\](?:\s*\n\s*)*\b(?:final\s+)?(?:readonly\s+)?class\b/
      );
      if (classAttrMatch) {
        const path = extractPath(classAttrMatch[1]!);
        if (path) classPrefix = path;
      }

      // Method-level #[Route] — `[^)]*` stops at first `)`, can't bleed into next attribute
      const methodRouteRegex =
        /#\[\s*Route\s*\(([^)]*)\)\s*\](?:\s*\n\s*(?:#\[(?!\s*Route\s*\()[\s\S]*?\]\s*\n\s*)*)?(?:public|private|protected)\s+function\s+(\w+)\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = methodRouteRegex.exec(safe)) !== null) {
        const args = match[1]!.trim();
        const methodName = match[2]!;
        const line = safe.slice(0, match.index).split('\n').length;
        const path = extractPath(args);
        const routeMethods = extractMethods(args);
        const routeName = extractName(args);

        if (!path) continue;

        const fullPath = classPrefix ? classPrefix + path : path;
        const httpMethods = routeMethods.length > 0 ? routeMethods : ['ANY'];

        for (const httpMethod of httpMethods) {
          const routeNode: Node = {
            id: `route:${filePath}:${line}:${httpMethod}:${fullPath}`,
            kind: 'route',
            name: `${httpMethod} ${fullPath}`,
            qualifiedName: routeName ? `${filePath}::${routeName}` : `${filePath}::route:${fullPath}`,
            filePath,
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: match[0].length,
            language: 'php',
            updatedAt: now,
          };

          const defaults = extractDefaults(args);
          const requirements = extractRequirements(args);
          const host = extractHost(args);
          const schemes = extractSchemes(args);
          if (defaults || requirements || host || schemes) {
            const meta: Record<string, unknown> = {};
            if (defaults) meta.defaults = defaults;
            if (requirements) meta.requirements = requirements;
            if (host) meta.host = host;
            if (schemes) meta.schemes = schemes;
            routeNode.signature = JSON.stringify(meta);
          }

          nodes.push(routeNode);

          references.push({
            fromNodeId: routeNode.id,
            referenceName: methodName,
            referenceKind: 'references',
            line,
            column: 0,
            filePath,
            language: 'php',
          });
        }
      }

      // ── Compiled DI container ─────────────────────────────────────────
      if (isContainerFilePath(filePath, content)) {
        const svcRegex = /protected\s+function\s+get(\w+)Service\s*\(\s*\)\s*:\s*(\\?[\w\\]+)/g;
        let svcMatch: RegExpExecArray | null;
        while ((svcMatch = svcRegex.exec(content)) !== null) {
          const svcName = svcMatch[1]!;
          const fqcn = svcMatch[2]!;
          const svcLine = content.slice(0, svcMatch.index).split('\n').length;

          nodes.push({
            id: `service:${filePath}:${svcLine}:${svcName}`,
            kind: 'variable',
            name: svcName,
            qualifiedName: fqcn,
            filePath,
            startLine: svcLine,
            endLine: svcLine,
            startColumn: 0,
            endColumn: svcMatch[0].length,
            language: 'php',
            updatedAt: now,
          });

          references.push({
            fromNodeId: `service:${filePath}:${svcLine}:${svcName}`,
            referenceName: fqcn,
            referenceKind: 'references',
            line: svcLine,
            column: 0,
            filePath,
            language: 'php',
          });
        }

        // Compiled route definitions from container (tree-sitter AST)
        const containerRoutes = extractContainerRoutes(filePath, content, now);
        nodes.push(...containerRoutes.nodes);
        references.push(...containerRoutes.references);
      }

      // ── Doctrine entities & repositories ──────────────────────────────
      const entityResult = extractDoctrineEntities(content, filePath, now);
      nodes.push(...entityResult.nodes);
      references.push(...entityResult.references);

      const repoResult = extractDoctrineRepositories(content, filePath, now);
      nodes.push(...repoResult.nodes);
      references.push(...repoResult.references);

      // ── Event subscribers ─────────────────────────────────────────────
      const eventResult = extractEventSubscribers(content, filePath, now);
      nodes.push(...eventResult.nodes);
      references.push(...eventResult.references);

      // ── Console commands ──────────────────────────────────────────────
      const cmdResult = extractConsoleCommands(content, filePath, now);
      nodes.push(...cmdResult.nodes);
      references.push(...cmdResult.references);

      // ── Twig template references ──────────────────────────────────────
      const twigResult = extractTwigReferences(content, filePath, now);
      nodes.push(...twigResult.nodes);
      references.push(...twigResult.references);
    }

    // ── YAML ──────────────────────────────────────────────────────────────────
    if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      const yamlResult = extractYamlRoutes(filePath, content, now);
      nodes.push(...yamlResult.nodes);
      references.push(...yamlResult.references);
    }

    return { nodes, references };
  },
};
