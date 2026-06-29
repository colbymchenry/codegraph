/**
 * GraphQL Framework Resolver
 *
 * Handles Strawberry, Graphene, and Ariadne patterns (Python).
 * Creates route nodes for Query/Mutation/Subscription fields so
 * CodeGraph's graph traversal connects GraphQL operations to their
 * downstream service/DB calls.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

type RootKind = 'QUERY' | 'MUTATION' | 'SUBSCRIPTION';

interface TypeBlock {
  kind: RootKind;
  className: string;
  startLine: number;
  endLine: number;
}

const RESOLVER_DIRS = ['/graphql/', '/resolvers/', '/schema/', '/api/'];
const FUNCTION_KINDS = new Set(['function', 'method']);

export const strawberryResolver: FrameworkResolver = {
  name: 'strawberry-graphql',
  languages: ['python'],

  detect(context) {
    for (const f of ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py']) {
      const c = context.readFile(f);
      if (c && /\bstrawberry(?:-graphql)?\b/i.test(c)) return true;
    }
    const files = context.getAllFiles().filter((f) => /\bgraphql\b/.test(f) && f.endsWith('.py')).slice(0, 20);
    for (const f of files) {
      const c = context.readFile(f);
      if (c && /\bimport\s+strawberry\b|\bfrom\s+strawberry\b/.test(c)) return true;
    }
    return false;
  },

  resolve(ref, context) {
    if (ref.metadata?.graphqlResolver) {
      const name = String(ref.metadata.graphqlResolver);
      const candidates = context.getNodesByName(name);
      const match = candidates.find((n) => FUNCTION_KINDS.has(n.kind));
      if (match) {
        return { original: ref, targetNodeId: match.id, confidence: 0.85, resolvedBy: 'framework' };
      }
      const dotted = name.split('.');
      if (dotted.length > 1) {
        const funcName = dotted[dotted.length - 1]!;
        const funcCandidates = context.getNodesByName(funcName);
        const preferred = funcCandidates.find(
          (n) => FUNCTION_KINDS.has(n.kind) && RESOLVER_DIRS.some((d) => n.filePath.includes(d))
        );
        if (preferred) return { original: ref, targetNodeId: preferred.id, confidence: 0.8, resolvedBy: 'framework' };
        const any = funcCandidates.find((n) => FUNCTION_KINDS.has(n.kind));
        if (any) return { original: ref, targetNodeId: any.id, confidence: 0.7, resolvedBy: 'framework' };
      }
    }
    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.py')) return { nodes: [], references: [] };
    if (!/\bstrawberry\b/.test(content)) return { nodes: [], references: [] };

    const safe = stripCommentsForRegex(content, 'python');
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    const rootBlocks = findRootTypeBlocks(safe);
    if (rootBlocks.length === 0) return { nodes: [], references: [] };

    for (const block of rootBlocks) {
      extractDecoratedMethods(filePath, safe, block, nodes, references, now);
      extractFieldAssignments(filePath, safe, block, nodes, references, now);
    }

    return { nodes, references };
  },
};

export const grapheneResolver: FrameworkResolver = {
  name: 'graphene',
  languages: ['python'],

  detect(context) {
    for (const f of ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py']) {
      const c = context.readFile(f);
      if (c && /\bgraphene\b/i.test(c)) return true;
    }
    return false;
  },

  resolve() {
    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.py')) return { nodes: [], references: [] };
    if (!/\bgraphene\b/.test(content)) return { nodes: [], references: [] };

    const safe = stripCommentsForRegex(content, 'python');
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    const classRegex = /^class\s+(\w+)\s*\(\s*(?:graphene\.)?ObjectType\s*\)/gm;
    let cm: RegExpExecArray | null;
    while ((cm = classRegex.exec(safe)) !== null) {
      const className = cm[1]!;
      const kind = classifyRootType(className);
      if (!kind) continue;

      const startLine = safe.slice(0, cm.index).split('\n').length;
      const endLine = findClassEnd(safe, cm.index);
      const classBody = safe.slice(cm.index, endLineOffset(safe, endLine));

      const resolverRegex = /^\s+(?:async\s+)?def\s+(resolve_(\w+))\s*\(/gm;
      let rm: RegExpExecArray | null;
      while ((rm = resolverRegex.exec(classBody)) !== null) {
        const methodName = rm[1]!;
        const fieldName = rm[2]!;
        const line = startLine + classBody.slice(0, rm.index).split('\n').length - 1;
        const routeNode = makeRouteNode(filePath, line, kind, fieldName, now);
        nodes.push(routeNode);
        references.push({
          fromNodeId: routeNode.id,
          referenceName: methodName,
          referenceKind: 'references',
          line, column: 0, filePath, language: 'python',
        });
      }
    }

    return { nodes, references };
  },
};

function findRootTypeBlocks(content: string): TypeBlock[] {
  const blocks: TypeBlock[] = [];
  const lines = content.split('\n');

  const classRegex = /^class\s+(\w+)\s*(?:\([^)]*\))?\s*:/;
  let currentClass: { name: string; startLine: number; indent: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const classMatch = line.match(classRegex);
    if (classMatch) {
      if (currentClass) {
        finalizeBlock(content, lines, currentClass, i, blocks);
      }
      const hasStrawberryType = lookBackForDecorator(lines, i, /@strawberry\.type\b/);
      if (hasStrawberryType) {
        currentClass = {
          name: classMatch[1]!,
          startLine: i + 1,
          indent: line.search(/\S/),
        };
      } else {
        currentClass = null;
      }
    }
  }
  if (currentClass) {
    finalizeBlock(content, lines, currentClass, lines.length, blocks);
  }

  return blocks;
}

function finalizeBlock(
  _content: string,
  lines: string[],
  cls: { name: string; startLine: number; indent: number },
  nextClassLine: number,
  blocks: TypeBlock[]
) {
  let endLine = nextClassLine;
  for (let j = nextClassLine - 1; j > cls.startLine; j--) {
    if (lines[j]!.trim().length > 0) {
      endLine = j + 1;
      break;
    }
  }
  const kind = classifyRootType(cls.name);
  if (kind) {
    blocks.push({ kind, className: cls.name, startLine: cls.startLine, endLine });
  }
}

function classifyRootType(name: string): RootKind | null {
  const lower = name.toLowerCase();
  if (lower === 'query' || lower.endsWith('query') || lower.endsWith('queries')) return 'QUERY';
  if (lower === 'mutation' || lower.endsWith('mutation') || lower.endsWith('mutations')) return 'MUTATION';
  if (lower === 'subscription' || lower.endsWith('subscription') || lower.endsWith('subscriptions')) return 'SUBSCRIPTION';
  return null;
}

function lookBackForDecorator(lines: string[], classLine: number, pattern: RegExp): boolean {
  for (let i = classLine - 1; i >= Math.max(0, classLine - 5); i--) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    if (pattern.test(line)) return true;
    if (line.startsWith('@')) continue;
    break;
  }
  return false;
}

function extractDecoratedMethods(
  filePath: string,
  content: string,
  block: TypeBlock,
  nodes: Node[],
  references: UnresolvedRef[],
  now: number,
) {
  const lines = content.split('\n');
  const blockLines = lines.slice(block.startLine - 1, block.endLine);
  const blockText = blockLines.join('\n');

  const decoratorRegex = /@strawberry\.field\b[^\n]*/g;
  let dm: RegExpExecArray | null;
  while ((dm = decoratorRegex.exec(blockText)) !== null) {
    const decoratorOffset = dm.index;
    const tail = blockText.slice(decoratorOffset + dm[0].length);
    const defMatch = tail.match(/\n\s*(?:async\s+)?def\s+(\w+)/);
    if (!defMatch) continue;

    const fieldName = defMatch[1]!;
    if (fieldName === '__init__' || fieldName.startsWith('_')) continue;

    const lineInBlock = blockText.slice(0, decoratorOffset).split('\n').length;
    const line = block.startLine + lineInBlock - 1;

    const routeNode = makeRouteNode(filePath, line, block.kind, fieldName, now);
    nodes.push(routeNode);
    references.push({
      fromNodeId: routeNode.id,
      referenceName: fieldName,
      referenceKind: 'references',
      line, column: 0, filePath, language: 'python',
    });
  }
}

function extractFieldAssignments(
  filePath: string,
  content: string,
  block: TypeBlock,
  nodes: Node[],
  references: UnresolvedRef[],
  now: number,
) {
  const lines = content.split('\n');
  const blockLines = lines.slice(block.startLine - 1, block.endLine);
  const blockText = blockLines.join('\n');

  const assignRegex = /(\w+)\s*:[^=\n]*=\s*strawberry\.field\s*\(\s*[^)]*resolver\s*=\s*([\w.]+)/g;
  let am: RegExpExecArray | null;
  while ((am = assignRegex.exec(blockText)) !== null) {
    const fieldName = am[1]!;
    const resolverRef = am[2]!;

    const lineInBlock = blockText.slice(0, am.index).split('\n').length;
    const line = block.startLine + lineInBlock - 1;

    const routeNode = makeRouteNode(filePath, line, block.kind, fieldName, now);
    nodes.push(routeNode);

    const resolverName = resolverRef.split('.').pop()!;
    references.push({
      fromNodeId: routeNode.id,
      referenceName: resolverName,
      referenceKind: 'references',
      line, column: 0, filePath, language: 'python',
      metadata: { graphqlResolver: resolverRef },
    });
  }
}

function makeRouteNode(filePath: string, line: number, kind: RootKind, fieldName: string, now: number): Node {
  return {
    id: `route:${filePath}:${line}:${kind}:${fieldName}`,
    kind: 'route',
    name: `${kind} ${fieldName}`,
    qualifiedName: `${filePath}::${kind}:${fieldName}`,
    filePath,
    startLine: line,
    endLine: line,
    startColumn: 0,
    endColumn: 0,
    language: 'python',
    updatedAt: now,
  };
}

function findClassEnd(content: string, classStart: number): number {
  const lines = content.split('\n');
  const startLine = content.slice(0, classStart).split('\n').length;
  const classIndent = lines[startLine - 1]!.search(/\S/);
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    if (line.search(/\S/) <= classIndent && !/^\s*@/.test(line)) {
      return i;
    }
  }
  return lines.length;
}

function endLineOffset(content: string, lineNumber: number): number {
  let pos = 0;
  let count = 1;
  while (count < lineNumber && pos < content.length) {
    if (content[pos] === '\n') count++;
    pos++;
  }
  const nextNewline = content.indexOf('\n', pos);
  return nextNewline === -1 ? content.length : nextNewline;
}
