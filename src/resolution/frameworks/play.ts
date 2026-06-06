/**
 * Play Framework (Scala/Java) resolver.
 *
 * Play declares HTTP routes in a dedicated `conf/routes` file (and included
 * `conf/*.routes`), Rails-style:
 *
 *   GET   /computers        controllers.Application.list(p: Int ?= 0)
 *   POST  /computers        controllers.Application.save
 *   GET   /assets/*file     controllers.Assets.versioned(path = "/public", file: Asset)
 *
 * The file is extensionless, so the file walk only indexes it because
 * `isPlayRoutesFile` (grammars.ts) opts it in; it's processed through the
 * no-grammar path and this resolver extracts the routes. Each route references
 * its handler as `Controller.method` (the package prefix is dropped), resolved
 * to the action method in the controller class.
 */

import { Node } from '../../types';
import { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';
import { isPlayRoutesFile } from '../../extraction/grammars';

const ROUTE_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s+(.+)$/;
const METHOD_KINDS = new Set(['method', 'function']);
const CLASS_KINDS = new Set(['class']);

export const playResolver: FrameworkResolver = {
  name: 'play',
  // `yaml` so this resolver runs on conf/routes (detectLanguage maps it to yaml);
  // `scala`/`java` so it's active in Play projects of either language.
  languages: ['scala', 'java', 'yaml'],

  detect(context: ResolutionContext): boolean {
    const buildSbt = context.readFile('build.sbt');
    if (buildSbt && /playframework|"play"|sbt-plugin|PlayScala|PlayJava/i.test(buildSbt)) return true;
    if (context.fileExists('conf/routes')) return true;
    if (context.fileExists('conf/application.conf')) return true;
    return false;
  },

  // The handler is `Controller.method` (a class-qualified action), which names no
  // bare declared symbol, so resolveOne's pre-filter could drop it — claim it.
  claimsReference(name: string): boolean {
    return /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(name);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const m = ref.referenceName.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
    if (!m) return null;
    const [, className, methodName] = m;
    const classNodes = context.getNodesByName(className!).filter((n) => CLASS_KINDS.has(n.kind));
    for (const cls of classNodes) {
      const method = context
        .getNodesInFile(cls.filePath)
        .find((n) => METHOD_KINDS.has(n.kind) && n.name === methodName);
      if (method) {
        return { original: ref, targetNodeId: method.id, confidence: 0.9, resolvedBy: 'framework' };
      }
    }
    return null;
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    if (!isPlayRoutesFile(filePath)) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      // Skip comments and `->` route includes (a sub-router mount, not an action).
      if (!line || line.startsWith('#') || line.startsWith('->')) continue;
      const m = line.match(ROUTE_LINE);
      if (!m) continue;
      const [, method, routePath, action] = m;

      // action: `controllers.Application.list(p: Int ?= 0)` → drop args, keep the
      // last `Controller.method` segment (package prefix is irrelevant for lookup).
      const fqn = action!.split('(')[0]!.trim();
      const parts = fqn.split('.').filter(Boolean);
      if (parts.length < 2) continue;
      const handlerRef = parts.slice(-2).join('.'); // Application.list

      const lineNum = i + 1;
      const routeNode: Node = {
        id: `route:${filePath}:${lineNum}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::${method}:${routePath}`,
        filePath,
        startLine: lineNum,
        endLine: lineNum,
        startColumn: 0,
        endColumn: 0,
        language: 'scala',
        updatedAt: now,
      };
      nodes.push(routeNode);
      references.push({
        fromNodeId: routeNode.id,
        referenceName: handlerRef,
        referenceKind: 'references',
        line: lineNum,
        column: 0,
        filePath,
        language: 'scala',
      });
    }

    return { nodes, references };
  },
};
