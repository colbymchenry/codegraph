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
  qualified: boolean;
}

interface QtSignalDescriptor {
  className?: string;
  signalName: string;
  displayName: string;
}

interface QtSignalRegistration {
  signal: QtSignalDescriptor;
  slotNode: Node;
  slotName: string;
  registeredAt: string;
  line: number;
}

interface UiWidgetInfo {
  name: string;
  className: string;
}

interface UiClassCandidate {
  className: string;
  filePath: string;
  widgets: Map<string, UiWidgetInfo>;
}

const QT_CPP_FILE_RE = /\.(?:cc|cpp|cxx|h|hh|hpp|hxx|mm)$/i;
const QT_CONNECT_RE = /\b(?:(QObject)\s*::\s*)?connect\s*\(/g;
const QT_TIMER_SINGLE_SHOT_RE = /\bQTimer\s*::\s*singleShot\s*\(/g;
const QT_INVOKE_METHOD_RE = /\bQMetaObject\s*::\s*invokeMethod\s*\(/g;
const QT_EMIT_RE = /\b(?:emit|Q_EMIT)\s+(?:this\s*(?:->|\.)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const QT_AUTO_CONNECT_RE = /\b(?:QMetaObject\s*::\s*)?connectSlotsByName\s*\(\s*this\s*\)|\b(?:[A-Za-z_][A-Za-z0-9_]*\s*(?:->|\.)\s*)?setupUi\s*\(\s*this\s*\)/g;
const QT_EVIDENCE_RE = /\b(Q_OBJECT|Q_GADGET|QApplication|QObject|QWidget|QFrame|QMainWindow|QDialog|QPushButton|QObject::connect|#\s*include\s*<Q[A-Za-z0-9_]+>)/;
const METHOD_POINTER_RE = /&\s*([A-Za-z_][A-Za-z0-9_:]*)\s*::\s*([A-Za-z_~][A-Za-z0-9_~]*)/;
const QT_AUTO_CONNECT_SIGNALS = new Map<string, ReadonlySet<string>>([
  ['QPushButton', new Set(['clicked', 'pressed', 'released', 'toggled'])],
  ['QToolButton', new Set(['clicked', 'pressed', 'released', 'toggled'])],
  ['QRadioButton', new Set(['clicked', 'pressed', 'released', 'toggled'])],
  ['QCheckBox', new Set(['clicked', 'pressed', 'released', 'toggled'])],
  ['QLineEdit', new Set(['textChanged', 'textEdited', 'returnPressed', 'editingFinished'])],
  ['QComboBox', new Set(['currentIndexChanged', 'currentTextChanged', 'activated'])],
  ['QSpinBox', new Set(['valueChanged'])],
  ['QDoubleSpinBox', new Set(['valueChanged'])],
  ['QSlider', new Set(['valueChanged'])],
  ['QTabWidget', new Set(['currentChanged', 'tabCloseRequested'])],
  ['QListWidget', new Set(['itemClicked', 'itemDoubleClicked', 'currentItemChanged', 'currentRowChanged', 'currentTextChanged'])],
  ['QTreeWidget', new Set(['itemClicked', 'itemDoubleClicked', 'currentItemChanged'])],
  ['QTableWidget', new Set(['itemClicked', 'itemDoubleClicked', 'currentItemChanged'])],
  ['QAction', new Set(['triggered', 'toggled', 'hovered'])],
]);

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
  return qtCallExpressions(source, QT_CONNECT_RE, (match) => Boolean(match[1]));
}

function qtCallExpressions(
  source: string,
  pattern: RegExp,
  qualified: (match: RegExpExecArray) => boolean = () => true
): QtConnectCall[] {
  const safe = stripCommentsForRegex(source, 'cpp');
  const calls: QtConnectCall[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(safe))) {
    const openParen = safe.indexOf('(', match.index);
    const closeParen = matchingParenOffset(safe, openParen);
    if (openParen < 0 || closeParen < 0) continue;
    calls.push({
      text: source.slice(openParen + 1, closeParen),
      line: lineOf(source, match.index),
      qualified: qualified(match),
    });
    pattern.lastIndex = closeParen + 1;
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

function receiverClassName(receiverArg: string, fromNode: Node, localTypes: Map<string, string>): string | null {
  const normalized = receiverArg
    .trim()
    .replace(/^\(([\s\S]+)\)$/, '$1')
    .replace(/^&/, '')
    .replace(/^this\s*(?:->|\.)\s*/, '');
  if (normalized === 'this') return ownerQualifiedClassName(fromNode);
  return localTypes.get(normalized) ?? null;
}

function unwrapLegacyQtMethod(
  argument: string,
  receiverArg: string,
  fromNode: Node,
  localTypes: Map<string, string>
): QtMethodPointer | null {
  const match = /^\s*SLOT\s*\(\s*([A-Za-z_~][A-Za-z0-9_~]*)\s*\(([\s\S]*?)\)\s*\)\s*$/.exec(argument);
  if (!match) return null;
  const methodName = match[1];
  if (!methodName) return null;
  const owner = receiverClassName(receiverArg, fromNode, localTypes);
  if (!owner) return null;
  return {
    className: owner,
    methodName,
    parameterTypes: parseQtParameterTypes(match[2] ?? ''),
  };
}

function legacySignalName(argument: string): string | null {
  return /^\s*SIGNAL\s*\(\s*([A-Za-z_~][A-Za-z0-9_~]*)\s*\(/.exec(argument)?.[1] ?? null;
}

function canonicalQtClassName(
  registry: ReturnType<typeof getQtCppMetaRegistry>,
  className: string
): string {
  const facts = classFactsForPointer(registry, className);
  return facts?.qualifiedName ?? facts?.name ?? className;
}

function qtSignalDescriptor(
  registry: ReturnType<typeof getQtCppMetaRegistry>,
  senderArg: string,
  signalArg: string,
  fromNode: Node,
  localTypes: Map<string, string>
): QtSignalDescriptor | null {
  const signalPointer = unwrapQtMethodPointer(signalArg);
  if (signalPointer) {
    const className = canonicalQtClassName(registry, signalPointer.className);
    return {
      className,
      signalName: signalPointer.methodName,
      displayName: `${className}::${signalPointer.methodName}`,
    };
  }

  const legacyName = legacySignalName(signalArg);
  if (!legacyName) return null;
  const senderClass = receiverClassName(senderArg, fromNode, localTypes);
  if (!senderClass) {
    return {
      signalName: legacyName,
      displayName: legacyName,
    };
  }
  const className = canonicalQtClassName(registry, senderClass);
  return {
    className,
    signalName: legacyName,
    displayName: `${className}::${legacyName}`,
  };
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
  if (slotClassFacts.hasWidgetsEvidence) return true;
  return QT_EVIDENCE_RE.test(source);
}

function hasLocalConnectDeclaration(nodesInFile: Node[]): boolean {
  return nodesInFile.some(
    (node) => (node.kind === 'function' || node.kind === 'method') && node.name === 'connect'
  );
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

function localCppVariableTypes(source: string): Map<string, string> {
  const types = new Map<string, string>();
  const declarationPatterns = [
    /\b([A-Za-z_][A-Za-z0-9_:]*)\s*(?:[*&]\s*)+([A-Za-z_][A-Za-z0-9_]*)\s*(?:[;=({])/g,
    /\b([A-Za-z_][A-Za-z0-9_:]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:[;=({])/g,
  ];
  for (const pattern of declarationPatterns) {
    for (const match of source.matchAll(pattern)) {
      const typeName = match[1];
      const variableName = match[2];
      if (!typeName || !variableName) continue;
      if (['return', 'new', 'class', 'struct', 'public', 'private', 'protected', 'auto'].includes(typeName)) continue;
      types.set(variableName, typeName);
    }
  }
  return types;
}

function lambdaBody(argument: string): string | null {
  const captureEnd = argument.indexOf(']');
  const openBrace = argument.indexOf('{', captureEnd + 1);
  if (captureEnd < 0 || openBrace < 0) return null;
  const closeBrace = matchingParenOffset(argument.replaceAll('{', '(').replaceAll('}', ')'), openBrace);
  if (closeBrace < 0) return null;
  return argument.slice(openBrace + 1, closeBrace);
}

function resolveOwnerMethodCall(
  context: ResolutionContext,
  registry: ReturnType<typeof getQtCppMetaRegistry>,
  owner: string,
  methodName: string
): { classFacts: QtCppClassFacts; method: QtCppMethodFact; node: Node } | null {
  const classFacts = classFactsForPointer(registry, owner);
  if (!classFacts) return null;
  const methods = findQtCppMethodFacts(classFacts, methodName);
  if (methods.length !== 1) return null;
  const node = methodNodeByFact(context, classFacts, methods[0]!);
  return node ? { classFacts, method: methods[0]!, node } : null;
}

function lambdaTargetNodes(
  context: ResolutionContext,
  registry: ReturnType<typeof getQtCppMetaRegistry>,
  lambdaArg: string,
  fromNode: Node
): Node[] {
  const body = lambdaBody(lambdaArg);
  const owner = ownerQualifiedClassName(fromNode);
  if (!body || !owner) return [];
  const targets: Node[] = [];
  for (const match of body.matchAll(/(?:this\s*(?:->|\.)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const methodName = match[1];
    if (!methodName || ['if', 'for', 'while', 'switch', 'return', 'connect', 'emit'].includes(methodName)) continue;
    const target = resolveOwnerMethodCall(context, registry, owner, methodName)?.node;
    if (target) targets.push(target);
  }
  const uniqueById = new Map(targets.map((node) => [node.id, node]));
  return [...uniqueById.values()];
}

function functorTargetNode(
  context: ResolutionContext,
  registry: ReturnType<typeof getQtCppMetaRegistry>,
  localTypes: Map<string, string>,
  argument: string
): Node | null {
  const variableName = argument.trim().replace(/^[*&]+/, '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variableName)) return null;
  const className = localTypes.get(variableName);
  if (!className) return null;
  const registryTarget = resolveOwnerMethodCall(context, registry, className, 'operator()')?.node;
  if (registryTarget) return registryTarget;

  const classFacts = classFactsForPointer(registry, className);
  const ownerName = classFacts?.qualifiedName ?? className;
  const candidates = context
    .getNodesByName('operator()')
    .filter(
      (node) =>
        node.kind === 'method' &&
        node.language === 'cpp' &&
        (node.qualifiedName === `${ownerName}::operator()` ||
          node.qualifiedName.endsWith(`::${ownerName}::operator()`))
  );
  return candidates.length === 1 ? candidates[0]! : null;
}

function synthesizedQtSlotEdge(
  context: ResolutionContext,
  registry: ReturnType<typeof getQtCppMetaRegistry>,
  source: string,
  fromNode: Node,
  slotPointer: QtMethodPointer,
  signalName: string,
  filePath: string,
  line: number
): Edge | null {
  const slotFact = methodFactForPointer(registry, slotPointer);
  const slotNode = slotFact
    ? methodNodeByFact(context, slotFact.classFacts, slotFact.method)
    : fallbackQtMethodNode(context, registry, slotPointer);
  if (slotFact && !hasQtEvidence(source, fromNode, slotFact.classFacts)) return null;
  if (!slotFact && !hasQtEvidenceForFallback(source, fromNode, registry, slotPointer.className)) return null;
  if (!slotNode || slotNode.id === fromNode.id) return null;
  return {
    source: fromNode.id,
    target: slotNode.id,
    kind: 'calls',
    line,
    provenance: 'heuristic',
    metadata: {
      synthesizedBy: 'qt-widgets-connect',
      signal: signalName,
      slot: `${slotPointer.className}::${slotPointer.methodName}`,
      registeredAt: `${filePath}:${line}`,
    },
  };
}

function fallbackQtMethodNode(
  context: ResolutionContext,
  registry: ReturnType<typeof getQtCppMetaRegistry>,
  pointer: QtMethodPointer
): Node | null {
  const className = canonicalQtClassName(registry, pointer.className);
  const simpleClassName = simpleCppTypeName(className);
  const candidates = context
    .getNodesByName(pointer.methodName)
    .filter((node) => {
      if (node.kind !== 'method' || node.language !== 'cpp') return false;
      return (
        node.qualifiedName === `${className}::${pointer.methodName}` ||
        node.qualifiedName.endsWith(`::${className}::${pointer.methodName}`) ||
        node.qualifiedName === `${simpleClassName}::${pointer.methodName}` ||
        node.qualifiedName.endsWith(`::${simpleClassName}::${pointer.methodName}`)
      );
    });

  if (pointer.parameterTypes && pointer.parameterTypes.length > 0) {
    const byParameters = candidates.filter((node) => {
      const source = context.readFile(node.filePath);
      const nodeSource = source
        ?.split('\n')
        .slice(node.startLine - 1, node.endLine ?? node.startLine)
        .join('\n');
      const parameterTypes = nodeSource
        ? parseQtMethodParameterTypes(nodeSource) ?? normalizeQtSignature(node.signature ?? '')?.parameterTypes
        : normalizeQtSignature(node.signature ?? '')?.parameterTypes;
      return parameterTypes
        ? parameterTypes.length === pointer.parameterTypes!.length &&
            parameterTypes.every((typeName, index) => typeName === pointer.parameterTypes![index])
        : false;
    });
    const implementation = uniqueQtImplementationCandidate(byParameters);
    if (implementation) return implementation;
    if (byParameters.length === 1) return byParameters[0]!;
  }

  const implementation = uniqueQtImplementationCandidate(candidates);
  if (implementation) return implementation;
  return candidates.length === 1 ? candidates[0]! : null;
}

function uniqueQtImplementationCandidate(candidates: Node[]): Node | null {
  const implementations = candidates.filter((node) => {
    const endLine = node.endLine ?? node.startLine;
    return /\.(?:cc|cpp|cxx|mm)$/i.test(node.filePath) && endLine > node.startLine;
  });
  return implementations.length === 1 ? implementations[0]! : null;
}

function hasQtEvidenceForFallback(
  source: string,
  fromNode: Node,
  registry: ReturnType<typeof getQtCppMetaRegistry>,
  className: string
): boolean {
  const ownerFacts = classFactsForPointer(registry, ownerQualifiedClassName(fromNode) ?? '');
  const targetFacts = classFactsForPointer(registry, className);
  if (ownerFacts?.hasWidgetsEvidence || targetFacts?.hasWidgetsEvidence) return true;
  if (ownerFacts?.hasQmlExposureEvidence || targetFacts?.hasQmlExposureEvidence) return true;
  return QT_EVIDENCE_RE.test(source);
}

function uiClassCandidates(context: ResolutionContext): UiClassCandidate[] {
  const candidates: UiClassCandidate[] = [];
  for (const filePath of context.getAllFiles()) {
    if (!/\.ui$/i.test(filePath)) continue;
    const source = context.readFile(filePath);
    if (!source) continue;

    const className = /<class>\s*([^<\s]+)\s*<\/class>/i.exec(source)?.[1];
    if (!className) continue;

    const widgets = new Map<string, UiWidgetInfo>();
  for (const match of source.matchAll(/<widget\b[^>]*\bclass\s*=\s*"([^"]+)"[^>]*\bname\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)"/gi)) {
      const widgetClass = match[1];
      const widgetName = match[2];
      if (widgetClass && widgetName) widgets.set(widgetName, { name: widgetName, className: widgetClass });
    }
    for (const match of source.matchAll(/<action\b[^>]*\bname\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)"/gi)) {
      const actionName = match[1];
      if (actionName) widgets.set(actionName, { name: actionName, className: 'QAction' });
    }
    if (widgets.size === 0) continue;

    candidates.push({ className, filePath, widgets });
  }
  return candidates;
}

function qtAutoConnectCallLines(source: string): number[] {
  const safe = stripCommentsForRegex(source, 'cpp');
  const lines: number[] = [];
  QT_AUTO_CONNECT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QT_AUTO_CONNECT_RE.exec(safe))) {
    lines.push(lineOf(source, match.index));
  }
  return lines;
}

function emittedQtSignals(source: string): Array<{ signalName: string; line: number }> {
  const safe = stripCommentsForRegex(source, 'cpp');
  const emitted: Array<{ signalName: string; line: number }> = [];
  QT_EMIT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QT_EMIT_RE.exec(safe))) {
    const signalName = match[1];
    if (!signalName) continue;
    emitted.push({ signalName, line: lineOf(source, match.index) });
  }
  return emitted;
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

function addSynthesizedEdge(
  edges: Edge[],
  seen: Set<string>,
  edge: Edge
): void {
  const key = `${edge.source}>${edge.target}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push(edge);
}

function addQtSignalRegistration(
  registrations: QtSignalRegistration[],
  signal: QtSignalDescriptor | null,
  slotNode: Node,
  slotName: string,
  registeredAt: string,
  line: number
): void {
  if (!signal) return;
  registrations.push({ signal, slotNode, slotName, registeredAt, line });
}

function qtSignalRegistrationMatchesEmitter(
  registry: ReturnType<typeof getQtCppMetaRegistry>,
  registration: QtSignalRegistration,
  emitterOwner: string,
  signalName: string
): boolean {
  if (registration.signal.signalName !== signalName) return false;
  if (!registration.signal.className) return false;
  const ownerClass = canonicalQtClassName(registry, emitterOwner);
  const registeredClass = canonicalQtClassName(registry, registration.signal.className);
  return ownerClass === registeredClass;
}

function basenameNoExt(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;
  return basename.replace(/\.[^.]*$/, '');
}

function dirname(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(0, slash) : '';
}

function hasLocalUiInclude(source: string, uiFilePath: string): boolean {
  const base = basenameNoExt(uiFilePath);
  const includePattern = new RegExp(`#\\s*include\\s*["<]ui_${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.h[">]`);
  return includePattern.test(source);
}

function candidateMatchesOwner(candidate: UiClassCandidate, owner: string): boolean {
  const simpleOwner = simpleCppTypeName(owner);
  return candidate.className === simpleOwner || candidate.className === owner || owner.endsWith(`::${candidate.className}`);
}

function uiCandidateForOwner(
  candidates: UiClassCandidate[],
  owner: string,
  cppFilePath: string,
  source: string
): UiClassCandidate | null {
  const ownerCandidates = candidates.filter((candidate) => candidateMatchesOwner(candidate, owner));
  if (ownerCandidates.length === 0) return null;
  const includeEvidence = ownerCandidates.filter((candidate) => hasLocalUiInclude(source, candidate.filePath));
  if (includeEvidence.length === 1) return includeEvidence[0]!;
  const localEvidence = ownerCandidates.filter((candidate) => dirname(cppFilePath) === dirname(candidate.filePath));
  if (localEvidence.length === 1) return localEvidence[0]!;
  if (ownerCandidates.length === 1) return ownerCandidates[0]!;
  const basenameEvidence = ownerCandidates.filter((candidate) => basenameNoExt(cppFilePath) === basenameNoExt(candidate.filePath));
  if (basenameEvidence.length === 1) return basenameEvidence[0]!;
  return null;
}

function isKnownAutoConnectSignal(widget: UiWidgetInfo | undefined, signalName: string): boolean {
  if (!widget) return false;
  return QT_AUTO_CONNECT_SIGNALS.get(widget.className)?.has(signalName) ?? false;
}

export function qtWidgetsConnectEdges(
  queries: QueryBuilder,
  context: ResolutionContext,
  onProgress?: () => void
): Edge[] {
  const registry = getQtCppMetaRegistry(context);
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const signalRegistrations: QtSignalRegistration[] = [];
  const files = context.getAllFiles();
  const hasUiFiles = files.some((filePath) => /\.ui$/i.test(filePath));
  const cppFiles = files.filter((filePath) => QT_CPP_FILE_RE.test(filePath));
  const cppSources = new Map<string, string>();
  for (const filePath of cppFiles) {
    const source = context.readFile(filePath);
    if (source) cppSources.set(filePath, source);
  }
  if (
    !hasUiFiles &&
    ![...cppSources.values()].some(
      (source) =>
        source.includes('connect') ||
        source.includes('singleShot') ||
        source.includes('invokeMethod') ||
        source.includes('emit') ||
        source.includes('Q_EMIT')
    )
  ) {
    return [];
  }
  const uiCandidates = hasUiFiles ? uiClassCandidates(context) : [];
  for (let i = 0; i < files.length; i++) {
    if (i % 100 === 0) onProgress?.();
    const filePath = files[i]!;
    if (!QT_CPP_FILE_RE.test(filePath)) continue;
    const source = cppSources.get(filePath);
    if (
      !source ||
      (!source.includes('connect') &&
        !source.includes('singleShot') &&
        !source.includes('invokeMethod') &&
        !QT_AUTO_CONNECT_RE.test(stripCommentsForRegex(source, 'cpp')))
    ) continue;
    QT_AUTO_CONNECT_RE.lastIndex = 0;
    const nodesInFile = context.getNodesInFile(filePath);
    const hasLocalConnect = hasLocalConnectDeclaration(nodesInFile);
    const localTypes = localCppVariableTypes(source);

    for (const call of qtConnectCalls(source)) {
      // If a file declares its own bare `connect`, prefer a missed Qt edge over
      // fabricating a slot call through a project-local helper. Qualified
      // QObject::connect calls remain safe because they name the Qt API.
      if (!call.qualified && hasLocalConnect) continue;
      const args = splitTopLevelArguments(call.text);
      if (args.length < 3) continue;
      const fromNode = enclosingQtFunction(nodesInFile, call.line);
      if (!fromNode) continue;
      const slotArg = args.length >= 4 ? args[3]! : args[2]!;
      let slotPointer =
        args.length >= 4
          ? unwrapQtMethodPointer(slotArg) ?? unwrapLegacyQtMethod(slotArg, args[2]!, fromNode, localTypes)
          : null;
      const signal = qtSignalDescriptor(registry, args[0]!, args[1]!, fromNode, localTypes);
      const signalName = signal?.displayName ?? args[1]!;

      const lambdaTargets = lambdaTargetNodes(context, registry, slotArg, fromNode);
      for (const target of lambdaTargets) {
        if (target.id === fromNode.id || !hasQtEvidence(source, fromNode, classFactsForPointer(registry, ownerQualifiedClassName(fromNode) ?? '') ?? {
          name: '',
          baseClassNames: [],
          methodsByName: new Map(),
          properties: new Map(),
          signals: new Set(),
          hasQmlExposureEvidence: false,
          hasWidgetsEvidence: false,
        })) continue;
        addSynthesizedEdge(edges, seen, {
          source: fromNode.id,
          target: target.id,
          kind: 'calls',
          line: call.line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'qt-widgets-connect',
            signal: signalName,
            slot: target.qualifiedName,
            registeredAt: `${filePath}:${call.line}`,
          },
        });
        addQtSignalRegistration(
          signalRegistrations,
          signal,
          target,
          target.qualifiedName,
          `${filePath}:${call.line}`,
          call.line
        );
      }
      if (lambdaTargets.length > 0) continue;

      const functorTarget = args.length === 3 ? functorTargetNode(context, registry, localTypes, args[2]!) : null;
      if (functorTarget) {
        addSynthesizedEdge(edges, seen, {
          source: fromNode.id,
          target: functorTarget.id,
          kind: 'calls',
          line: call.line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'qt-widgets-connect',
            signal: signalName,
            slot: functorTarget.qualifiedName,
            registeredAt: `${filePath}:${call.line}`,
          },
        });
        addQtSignalRegistration(
          signalRegistrations,
          signal,
          functorTarget,
          functorTarget.qualifiedName,
          `${filePath}:${call.line}`,
          call.line
        );
        continue;
      }

      if (!slotPointer) continue;
      if (args.length >= 4) slotPointer = qualifyThisReceiverPointer(slotPointer, args[2]!, fromNode);
      const edge = synthesizedQtSlotEdge(context, registry, source, fromNode, slotPointer, signalName, filePath, call.line);
      if (edge) {
        addSynthesizedEdge(edges, seen, edge);
        const slotNode = context.getNodeById?.(edge.target);
        if (slotNode) {
          addQtSignalRegistration(
            signalRegistrations,
            signal,
            slotNode,
            `${slotPointer.className}::${slotPointer.methodName}`,
            `${filePath}:${call.line}`,
            call.line
          );
        }
      }
    }

    for (const call of qtCallExpressions(source, QT_TIMER_SINGLE_SHOT_RE)) {
      const args = splitTopLevelArguments(call.text);
      if (args.length < 3) continue;
      const fromNode = enclosingQtFunction(nodesInFile, call.line);
      if (!fromNode) continue;
      const callbackArg = args[args.length - 1]!;
      const lambdaTargets = lambdaTargetNodes(context, registry, callbackArg, fromNode);
      for (const target of lambdaTargets) {
        if (target.id === fromNode.id) continue;
        addSynthesizedEdge(edges, seen, {
          source: fromNode.id,
          target: target.id,
          kind: 'calls',
          line: call.line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'qt-widgets-connect',
            signal: 'QTimer::singleShot',
            slot: target.qualifiedName,
            registeredAt: `${filePath}:${call.line}`,
          },
        });
      }
      if (lambdaTargets.length > 0) continue;

      const functorTarget = functorTargetNode(context, registry, localTypes, callbackArg);
      if (functorTarget) {
        addSynthesizedEdge(edges, seen, {
          source: fromNode.id,
          target: functorTarget.id,
          kind: 'calls',
          line: call.line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'qt-widgets-connect',
            signal: 'QTimer::singleShot',
            slot: functorTarget.qualifiedName,
            registeredAt: `${filePath}:${call.line}`,
          },
        });
        continue;
      }

      const slotPointer = unwrapLegacyQtMethod(args[2]!, args[1]!, fromNode, localTypes);
      if (!slotPointer) continue;
      const edge = synthesizedQtSlotEdge(context, registry, source, fromNode, slotPointer, 'QTimer::singleShot', filePath, call.line);
      if (edge) addSynthesizedEdge(edges, seen, edge);
    }

    for (const call of qtCallExpressions(source, QT_INVOKE_METHOD_RE)) {
      const args = splitTopLevelArguments(call.text);
      if (args.length < 2) continue;
      const fromNode = enclosingQtFunction(nodesInFile, call.line);
      if (!fromNode) continue;
      const typedPointer = unwrapQtMethodPointer(args[1]!);
      if (typedPointer) {
        const edge = synthesizedQtSlotEdge(
          context,
          registry,
          source,
          fromNode,
          typedPointer,
          'QMetaObject::invokeMethod',
          filePath,
          call.line
        );
        if (edge) addSynthesizedEdge(edges, seen, edge);
        continue;
      }

      const methodName = /^(['"])([A-Za-z_~][A-Za-z0-9_~]*)\1$/.exec(args[1]!.trim())?.[2];
      const className = receiverClassName(args[0]!, fromNode, localTypes);
      if (!methodName || !className) continue;
      const edge = synthesizedQtSlotEdge(
        context,
        registry,
        source,
        fromNode,
        { className, methodName },
        'QMetaObject::invokeMethod',
        filePath,
        call.line
      );
      if (edge) addSynthesizedEdge(edges, seen, edge);
    }

    for (const line of qtAutoConnectCallLines(source)) {
      const fromNode = enclosingQtFunction(nodesInFile, line);
      const owner = fromNode ? ownerQualifiedClassName(fromNode) : null;
      if (!fromNode || !owner) continue;

      const uiCandidate = uiCandidateForOwner(uiCandidates, owner, filePath, source);
      if (!uiCandidate || uiCandidate.widgets.size === 0) continue;

      const ownerSlotPrefix = `${owner}::on_`;
      for (const slotNode of nodesInFile) {
        if (slotNode.kind !== 'method') continue;
        if (!slotNode.qualifiedName.startsWith(ownerSlotPrefix) && !slotNode.qualifiedName.endsWith(`::${ownerSlotPrefix}`)) continue;
        const match = /^on_([A-Za-z_][A-Za-z0-9_]*)_([A-Za-z_][A-Za-z0-9_]*)$/.exec(slotNode.name);
        if (!match || !isKnownAutoConnectSignal(uiCandidate.widgets.get(match[1]!), match[2]!)) continue;
        addSynthesizedEdge(edges, seen, {
          source: fromNode.id,
          target: slotNode.id,
          kind: 'calls',
          line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'qt-widgets-autoconnect',
            widget: match[1]!,
            signal: match[2]!,
            registeredAt: `${filePath}:${line}`,
          },
        });
      }
    }
  }

  for (const filePath of cppFiles) {
    const source = cppSources.get(filePath);
    if (!source || !(source.includes('emit') || source.includes('Q_EMIT'))) continue;
    const nodesInFile = context.getNodesInFile(filePath);
    for (const emitted of emittedQtSignals(source)) {
      const fromNode = enclosingQtFunction(nodesInFile, emitted.line);
      const owner = fromNode ? ownerQualifiedClassName(fromNode) : null;
      if (!fromNode || !owner) continue;
      const ownerFacts = classFactsForPointer(registry, owner);
      const matchingRegistrations = signalRegistrations.filter((registration) =>
        qtSignalRegistrationMatchesEmitter(registry, registration, owner, emitted.signalName)
      );
      if (matchingRegistrations.length === 0) continue;
      if (!ownerFacts?.signals.has(emitted.signalName) && !matchingRegistrations.some((registration) => registration.signal.className)) continue;
      for (const registration of matchingRegistrations) {
        if (registration.slotNode.id === fromNode.id) continue;
        addSynthesizedEdge(edges, seen, {
          source: fromNode.id,
          target: registration.slotNode.id,
          kind: 'calls',
          line: emitted.line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'qt-widgets-connect',
            signal: registration.signal.displayName,
            slot: registration.slotName,
            emittedAt: `${filePath}:${emitted.line}`,
            registeredAt: registration.registeredAt,
          },
        });
      }
    }
  }

  onProgress?.();
  void queries;
  return edges;
}
