import type { QueryBuilder } from '../db/queries';
import type { Edge, Node } from '../types';
import type { ResolutionContext } from './types';
import { stripCommentsForRegex } from './strip-comments';
import {
  findQtCppMethodFacts,
  getQtCppMetaRegistry,
  normalizeQtSignature,
  parseQtMethodParameterTypes,
  parseQtParameterTypes,
  simpleCppTypeName,
  type QtCppClassFacts,
  type QtCppMethodFact,
} from './frameworks/qt/cpp-meta';

interface QtMethodPointer {
  className: string;
  methodName: string;
  parameterTypes?: string[];
}

interface QtConnectCall {
  text: string;
  line: number;
}

const QT_CPP_FILE_RE = /\.(?:cc|cpp|cxx|h|hh|hpp|hxx|mm)$/i;
const QT_CONNECT_RE = /\b(?:QObject\s*::\s*)?connect\s*\(/g;
const QT_EVIDENCE_RE = /\b(Q_OBJECT|Q_GADGET|QApplication|QWidget|QMainWindow|QDialog|QPushButton|QObject::connect|#\s*include\s*<Q[A-Za-z0-9_]+>)/;
const METHOD_POINTER_RE = /&\s*([A-Za-z_][A-Za-z0-9_:]*)\s*::\s*([A-Za-z_~][A-Za-z0-9_~]*)/;

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function matchingParenOffset(source: string, openParenOffset: number): number {
  let depth = 0;
  for (let index = openParenOffset; index < source.length; index++) {
    const char = source[index];
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevelArguments(source: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let angleDepth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
    else if (char === '<') angleDepth++;
    else if (char === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (char === ',' && depth === 0 && angleDepth === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(source.slice(start).trim());
  return args.filter(Boolean);
}

function qtConnectCalls(source: string): QtConnectCall[] {
  const safe = stripCommentsForRegex(source, 'cpp');
  const calls: QtConnectCall[] = [];
  QT_CONNECT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QT_CONNECT_RE.exec(safe))) {
    const openParen = safe.indexOf('(', match.index);
    const closeParen = matchingParenOffset(safe, openParen);
    if (openParen < 0 || closeParen < 0) continue;
    calls.push({
      text: source.slice(openParen + 1, closeParen),
      line: lineOf(source, match.index),
    });
    QT_CONNECT_RE.lastIndex = closeParen + 1;
  }
  return calls;
}

function unwrapQtMethodPointer(argument: string): QtMethodPointer | null {
  const barePointer = parseBareMethodPointer(argument);
  const staticCast = /^static_cast\s*<\s*[^()<>]*\(\s*([A-Za-z_][A-Za-z0-9_:]*)\s*::\s*\*\s*\)\s*\(([\s\S]*?)\)\s*>\s*\(\s*(&[\s\S]+)\s*\)\s*$/.exec(argument);
  if (staticCast) {
    const pointer = barePointer ?? parseBareMethodPointer(staticCast[3]!);
    if (!pointer) return null;
    return {
      ...pointer,
      className: pointer.className || staticCast[1]!,
      parameterTypes: parseQtParameterTypes(staticCast[2] ?? ''),
    };
  }

  const qOverload = /^(?:qOverload|QOverload)\s*<\s*([\s\S]*?)\s*>\s*(?:::of)?\s*\(\s*(&[\s\S]+)\s*\)\s*$/.exec(argument);
  if (qOverload) {
    const pointer = barePointer ?? parseBareMethodPointer(qOverload[2]!);
    if (!pointer) return null;
    return {
      ...pointer,
      parameterTypes: parseQtParameterTypes(qOverload[1] ?? ''),
    };
  }

  if (barePointer) {
    const overloadTypes = /(?:qOverload|QOverload)\s*<\s*([\s\S]*?)\s*>/.exec(argument);
    if (overloadTypes) {
      return {
        ...barePointer,
        parameterTypes: parseQtParameterTypes(overloadTypes[1] ?? ''),
      };
    }
    const castTypes = /static_cast\s*<\s*[^()<>]*\(\s*([A-Za-z_][A-Za-z0-9_:]*)\s*::\s*\*\s*\)\s*\(([\s\S]*?)\)\s*>/.exec(argument);
    if (castTypes) {
      return {
        ...barePointer,
        className: barePointer.className || castTypes[1]!,
        parameterTypes: parseQtParameterTypes(castTypes[2] ?? ''),
      };
    }
  }

  return barePointer;
}

function parseBareMethodPointer(argument: string): QtMethodPointer | null {
  const match = METHOD_POINTER_RE.exec(argument);
  if (!match) return null;
  return {
    className: match[1]!,
    methodName: match[2]!,
  };
}

function classFactsForPointer(
  registry: ReturnType<typeof getQtCppMetaRegistry>,
  className: string
): QtCppClassFacts | undefined {
  const qualified = registry.classesByQualifiedName.get(className);
  if (qualified) return qualified;

  const suffixMatches = [...registry.classesByQualifiedName.entries()]
    .filter(([qualifiedName]) => className.endsWith(`::${qualifiedName}`))
    .map(([, facts]) => facts);
  if (suffixMatches.length === 1) return suffixMatches[0];

  const simpleMatches = registry.classesBySimpleName.get(simpleCppTypeName(className)) ?? [];
  return simpleMatches.length === 1 ? simpleMatches[0] : undefined;
}

function methodFactForPointer(
  registry: ReturnType<typeof getQtCppMetaRegistry>,
  pointer: QtMethodPointer
): { classFacts: QtCppClassFacts; method: QtCppMethodFact } | null {
  const classFacts = classFactsForPointer(registry, pointer.className);
  if (!classFacts) return null;
  const methods = findQtCppMethodFacts(
    classFacts,
    pointer.parameterTypes
      ? { name: pointer.methodName, parameterTypes: pointer.parameterTypes }
      : pointer.methodName
  );
  if (methods.length !== 1) return null;
  return { classFacts, method: methods[0]! };
}

function ownerQualifiedClassName(node: Node): string | null {
  if (node.kind !== 'method') return null;
  const owner = node.qualifiedName.split('::').slice(0, -1).join('::');
  return owner || null;
}

function qualifyThisReceiverPointer(pointer: QtMethodPointer, receiverArg: string, fromNode: Node): QtMethodPointer {
  if (receiverArg.trim() !== 'this' || pointer.className.includes('::')) return pointer;
  const owner = ownerQualifiedClassName(fromNode);
  if (!owner || simpleCppTypeName(owner) !== pointer.className) return pointer;
  return { ...pointer, className: owner };
}

function hasQtEvidence(source: string, fromNode: Node, slotClassFacts: QtCppClassFacts): boolean {
  void fromNode;
  if (slotClassFacts.hasWidgetsEvidence || slotClassFacts.hasQmlExposureEvidence) return true;
  return QT_EVIDENCE_RE.test(source);
}

function methodNodeByFact(
  context: ResolutionContext,
  classFacts: QtCppClassFacts,
  method: QtCppMethodFact
): Node | null {
  if (method.nodeId) {
    const nodeById = context.getNodeById?.(method.nodeId);
    if (nodeById) return nodeById;
    const nodeByName = context.getNodesByName(method.name).find((node) => node.id === method.nodeId);
    if (nodeByName) return nodeByName;
  }
  const qualifiedName = method.qualifiedName;
  if (!qualifiedName) return null;

  const candidates = context
    .getNodesByName(method.name)
    .filter(
      (node) =>
        node.kind === 'method' &&
        node.language === 'cpp' &&
        (node.qualifiedName === qualifiedName || node.qualifiedName.endsWith(`::${qualifiedName}`))
    );
  if (candidates.length === 1) return candidates[0]!;

  const signature = method.signature ? normalizeQtSignature(method.signature) : null;
  if (signature) {
    const byParameterTypes = candidates.filter((node) => {
      const source = context.readFile(node.filePath);
      const nodeSource = source
        ?.split('\n')
        .slice(node.startLine - 1, node.endLine ?? node.startLine)
        .join('\n');
      const parameterTypes = nodeSource
        ? parseQtMethodParameterTypes(nodeSource) ?? normalizeQtSignature(node.signature ?? '')?.parameterTypes
        : normalizeQtSignature(node.signature ?? '')?.parameterTypes;
      return parameterTypes
        ? parameterTypes.length === method.parameterTypes.length &&
            parameterTypes.every((typeName, index) => typeName === method.parameterTypes[index])
        : false;
    });
    if (byParameterTypes.length === 1) return byParameterTypes[0]!;
  }

  if (classFacts.classNodeId) {
    const classNode = context.getNodeById?.(classFacts.classNodeId);
    const sameFile = classNode ? candidates.filter((node) => node.filePath === classNode.filePath) : [];
    if (sameFile.length === 1) return sameFile[0]!;
  }
  return null;
}

function enclosingQtFunction(nodesInFile: Node[], line: number): Node | null {
  let best: Node | null = null;
  for (const node of nodesInFile) {
    if (node.kind !== 'method' && node.kind !== 'function') continue;
    const end = node.endLine ?? node.startLine;
    if (node.startLine <= line && end >= line) {
      if (!best || node.startLine >= best.startLine) best = node;
    }
  }
  return best;
}

export function qtWidgetsConnectEdges(queries: QueryBuilder, context: ResolutionContext): Edge[] {
  const registry = getQtCppMetaRegistry(context);
  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const filePath of context.getAllFiles()) {
    if (!QT_CPP_FILE_RE.test(filePath)) continue;
    const source = context.readFile(filePath);
    if (!source || !source.includes('connect')) continue;
    const nodesInFile = context.getNodesInFile(filePath);

    for (const call of qtConnectCalls(source)) {
      const args = splitTopLevelArguments(call.text);
      if (args.length < 4) continue;
      const signalPointer = unwrapQtMethodPointer(args[1]!);
      let slotPointer = unwrapQtMethodPointer(args[3]!);
      if (!signalPointer || !slotPointer) continue;

      const fromNode = enclosingQtFunction(nodesInFile, call.line);
      if (!fromNode) continue;
      slotPointer = qualifyThisReceiverPointer(slotPointer, args[2]!, fromNode);
      const slotFact = methodFactForPointer(registry, slotPointer);
      if (!slotFact) continue;
      if (!hasQtEvidence(source, fromNode, slotFact.classFacts)) continue;

      const slotNode = methodNodeByFact(context, slotFact.classFacts, slotFact.method);
      if (!slotNode || slotNode.id === fromNode.id) continue;
      const key = `${fromNode.id}>${slotNode.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: fromNode.id,
        target: slotNode.id,
        kind: 'calls',
        line: call.line,
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'qt-widgets-connect',
          signal: `${signalPointer.className}::${signalPointer.methodName}`,
          slot: `${slotPointer.className}::${slotPointer.methodName}`,
          registeredAt: `${filePath}:${call.line}`,
        },
      });
    }
  }

  void queries;
  return edges;
}
