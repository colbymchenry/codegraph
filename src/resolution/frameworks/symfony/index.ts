import { Node } from '../../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../../types';
import { findControllerClasses, parseControllerServiceRef, resolveControllerMethod } from './controller';
import { isContainerFilePath } from './di';
import { extractYamlRoutes } from './yaml';
import { extractTwigReferences } from './twig';
import { extractContainerRoutes } from './container-routes';
import { extractAttributeRoutes } from './attribute-routes';

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
        // Shopware 6 is a Symfony application; its plugins require only shopware/core
        if (Object.keys(deps).some(k => k === 'symfony/framework-bundle' || k === 'symfony/symfony' || k === 'shopware/core')) {
          return true;
        }
        if (Object.keys(deps).some(k => k.startsWith('symfony/') && !k.startsWith('symfony/polyfill-'))) {
          const hasConsole = context.fileExists('bin/console');
          const hasConfig = context.fileExists('config/');
          if (hasConsole && hasConfig) return true;
        }
      } catch {
      }
    }
    return context.fileExists('bin/console') && context.fileExists('config/');
  },

  // A route's `App\Controller\X::method` and a service's FQCN name no node
  // themselves; everything else resolves by the normal strategies.
  claimsReference(name: string): boolean {
    return name.includes('\\');
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const parsed = parseControllerServiceRef(ref.referenceName);
    if (!parsed) return null;
    // A route names its action; a service definition names its class.
    const targetNodeId = ref.fromNodeId.startsWith('route:')
      ? resolveControllerMethod(parsed.class, parsed.method, context)
      : parsed.method === '__invoke'
        ? (findControllerClasses(parsed.class, context)[0]?.id ?? null)
        : null;
    return targetNodeId ? { original: ref, targetNodeId, confidence: 0.9, resolvedBy: 'framework' } : null;
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    // ── PHP ──────────────────────────────────────────────────────────────────
    if (filePath.endsWith('.php')) {
      const attrRoutes = extractAttributeRoutes(filePath, content, now);
      nodes.push(...attrRoutes.nodes);
      references.push(...attrRoutes.references);

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
