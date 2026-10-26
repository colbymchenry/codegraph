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
import { isJavaOutsideImport, retargetSelfOverload } from '../name-matcher';

const ROUTE_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s+(.+)$/;
const METHOD_KINDS = new Set(['method', 'function']);
/** A route's controller: a class, or a Scala `object` (a companion shares its class's qualified name). */
const CONTROLLER_KINDS = new Set(['class', 'module']);
/** What a call in code names: those, or a Java interface or enum, which hold static members of their own. */
const OWNER_KINDS = new Set([...CONTROLLER_KINDS, 'interface', 'enum']);

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
    // A repository of Play projects (playframework/play-samples) keeps each
    // one's `conf/routes` in its own directory.
    return context.getAllFiles().some((f) => isPlayRoutesFile(f));
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
    const route = isPlayRoutesFile(ref.filePath);
    // `import org.apache.logging.log4j.core.config.Configurator` makes a Java
    // file's `Configurator` that library's, never a project type of the name.
    if (!route && ref.language === 'java' && isJavaOutsideImport(className!, ref, context)) return null;
    // A call's own language comes first: Play's `RequestAuthority` is both a
    // Scala case class and a Java record, and each language's callers mean
    // their own; the other language's types follow, since Play's Java API
    // calls its Scala classes. A route file has no language of its own.
    const kinds = route ? CONTROLLER_KINDS : OWNER_KINDS;
    const owners = context.getNodesByName(className!).filter((n) => kinds.has(n.kind));
    const groups = route
      ? [owners]
      : [owners.filter((n) => n.language === ref.language), owners.filter((n) => n.language !== ref.language)];
    for (const group of groups) {
      // Only a member of THAT type counts: a file can hold many classes (Java
      // nested classes, a Scala class + its companion + siblings), and the
      // first same-named method in the file is usually another class's. A
      // Scala object, a companion included, holds its own members.
      const members = new Map<string, Node>();
      for (const cls of group) {
        const memberQn = `${cls.qualifiedName}::${methodName}`;
        for (const n of context.getNodesInFile(cls.filePath)) {
          if (METHOD_KINDS.has(n.kind) && n.name === methodName && n.qualifiedName === memberQn) members.set(n.id, n);
        }
      }
      if (members.size === 0) continue;
      const found = [...members.values()];
      // Same-named types in several packages (Scala names carry no package):
      // the one in the caller's own file comes first.
      const pick = (!route && found.find((n) => n.filePath === ref.filePath)) || found[0]!;
      const result: ResolvedRef = { original: ref, targetNodeId: pick.id, confidence: 0.9, resolvedBy: 'framework' };
      // Overloads: the one the call's arguments fit, as the generic resolver picks it.
      return route ? result : retargetSelfOverload(result, ref, context);
    }
    // An inherited member isn't looked up here: the generic resolver finds it
    // through the class's declared supertypes.
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
