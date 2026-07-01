import type { Node } from '../../../types';
import type { ResolutionContext } from '../../types';

export interface QtCppMethodFact {
  name: string;
  qualifiedName?: string;
  invokable: boolean;
  publicSlot: boolean;
  privateOrProtectedSlot?: boolean;
  signal?: boolean;
  visibility?: 'public' | 'private' | 'protected';
  signature?: string;
  arity?: number;
  parameterTypes: string[];
  nodeId?: string;
}

export interface QtCppPropertyFact {
  name: string;
  read?: string;
  notify?: string;
}

export interface QtCppClassFacts {
  name: string;
  qualifiedName?: string;
  classNodeId?: string;
  baseClassNames: string[];
  methodsByName: Map<string, QtCppMethodFact[]>;
  properties: Map<string, QtCppPropertyFact>;
  signals: Set<string>;
  hasQmlExposureEvidence: boolean;
  hasWidgetsEvidence: boolean;
}

export interface QtCppMetaRegistry {
  classes: Map<string, QtCppClassFacts>;
  classesByQualifiedName: Map<string, QtCppClassFacts>;
  classesBySimpleName: Map<string, QtCppClassFacts[]>;
}

export interface QtCppMethodLookup {
  name: string;
  parameterTypes?: string[];
}

interface QtCppMetaRegistryCacheEntry {
  key: string;
  registry: QtCppMetaRegistry;
}

interface QtCppSourceCacheEntry {
  versionKey: string;
  key: string;
  sources: Array<readonly [string, string | null]>;
}

type QtCppSectionVisibility = 'public' | 'private' | 'protected';

interface QtCppSectionInfo {
  visibility: QtCppSectionVisibility;
  slot: boolean;
  signal: boolean;
}

interface QtCppMethodDeclaration {
  name: string;
  signature?: string;
  parameterTypes: string[];
  arity: number;
  constMember: boolean;
}

const qtCppSourceCache = new WeakMap<ResolutionContext, QtCppSourceCacheEntry>();
const qtCppMetaRegistryCache = new WeakMap<ResolutionContext, QtCppMetaRegistryCacheEntry>();

export function clearQtCppMetaCaches(context: ResolutionContext): void {
  qtCppSourceCache.delete(context);
  qtCppMetaRegistryCache.delete(context);
}

export function isCppBridgeFile(filePath: string): boolean {
  return /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(filePath);
}

export function cppBridgeFiles(context: ResolutionContext): string[] {
  return context.getAllFiles().filter(isCppBridgeFile).sort();
}

export function cppBridgeVersionKey(context: ResolutionContext): string {
  return cppBridgeFiles(context)
    .map((filePath) => {
      const newestNodeUpdate = context
        .getNodesInFile(filePath)
        .reduce((max, node) => Math.max(max, node.updatedAt), 0);
      return `${filePath}:${newestNodeUpdate}`;
    })
    .join('\0');
}

export function getQtCppSources(context: ResolutionContext): QtCppSourceCacheEntry {
  const cached = qtCppSourceCache.get(context);
  if (cached) return cached;

  const versionKey = cppBridgeVersionKey(context);
  const sources = cppBridgeFiles(context).map(
    (filePath) => [filePath, context.readFile(filePath)] as const
  );
  const key = sources.map(([filePath, source]) => `${filePath}\0${source ?? ''}`).join('\0');
  const entry = { versionKey, key, sources };
  qtCppSourceCache.set(context, entry);
  return entry;
}

export function simpleCppTypeName(typeName: string): string {
  const parts = typeName.trim().split('::').filter(Boolean);
  return parts[parts.length - 1] ?? typeName.trim();
}

export function normalizeCppType(typeName: string): string {
  return typeName
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\b(?:const|volatile|mutable|typename|class|struct|enum)\b/g, ' ')
    .replace(/\s*([&*]+)\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const cppTypeWords = new Set([
  'bool',
  'char',
  'char8_t',
  'char16_t',
  'char32_t',
  'double',
  'float',
  'int',
  'long',
  'short',
  'signed',
  'unsigned',
  'void',
  'wchar_t',
]);

function parameterTypeText(parameter: string): string {
  const withoutDefault = parameter.replace(/=.*/, '').replace(/\s+/g, ' ').trim();
  const named = /^(.+[\s*&])([A-Za-z_][A-Za-z0-9_]*)$/.exec(withoutDefault);
  if (!named) return withoutDefault;

  const typePart = named[1]!.trim();
  const maybeName = named[2]!;
  const typeLastWord = typePart.split(/\s+/).pop() ?? '';
  const looksLikeUnnamedCompoundType = cppTypeWords.has(typeLastWord) && cppTypeWords.has(maybeName);
  if (looksLikeUnnamedCompoundType) return withoutDefault;
  if (!cppTypeWords.has(maybeName)) return typePart;

  if (
    /[&*>)]$/.test(typePart) ||
    /::/.test(typePart) ||
    /\b(?:const|volatile|mutable|typename|class|struct|enum|unsigned|signed|short|long)\b/.test(typePart) ||
    /^[A-Z_]/.test(typePart)
  ) {
    return typePart;
  }

  return withoutDefault;
}

export function parseQtParameterTypes(parameters: string): string[] {
  const trimmed = parameters.trim();
  if (!trimmed || trimmed === 'void') return [];
  return splitCppParameterList(trimmed)
    .map((parameter) => {
      return normalizeCppType(parameterTypeText(parameter));
    })
    .filter(Boolean);
}

export function normalizeQtSignature(signature: string): { name: string; parameterTypes: string[] } | null {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_:~]*)\s*\(([\s\S]*)\)\s*$/.exec(signature.trim());
  if (!match) return null;
  const name = simpleCppTypeName(match[1]!);
  const parameterTypes = parseQtParameterTypes(match[2] ?? '');
  return { name, parameterTypes };
}

export function canonicalQtSignature(signature: string): string {
  const normalized = normalizeQtSignature(signature);
  return normalized
    ? `${normalized.name}(${normalized.parameterTypes.join(',')})`
    : signature.replace(/\s+/g, '');
}

export function findQtCppMethodFacts(
  classFacts: QtCppClassFacts | undefined,
  lookup: string | QtCppMethodLookup
): QtCppMethodFact[] {
  if (!classFacts) return [];
  const name = typeof lookup === 'string' ? lookup : lookup.name;
  let methods = classFacts.methodsByName.get(name) ?? [];
  if (typeof lookup !== 'string' && lookup.parameterTypes) {
    methods = methods.filter((method) => sameParameterTypes(method.parameterTypes, lookup.parameterTypes!));
  }
  return methods;
}

export function findUniqueQtCppMethodFact(
  classFacts: QtCppClassFacts | undefined,
  lookup: string | QtCppMethodLookup
): QtCppMethodFact | undefined {
  const methods = findQtCppMethodFacts(classFacts, lookup);
  return methods.length === 1 ? methods[0] : undefined;
}

function sameParameterTypes(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((typeName, index) => typeName === right[index]);
}

const qtCppSectionPattern =
  /(^|\n)\s*(public\s+slots|protected\s+slots|private\s+slots|public\s+Q_SLOTS|protected\s+Q_SLOTS|private\s+Q_SLOTS|public|protected|private|signals|Q_SIGNALS)\s*:/gi;

function createClassFacts(className: string, baseClassNames: string[]): QtCppClassFacts {
  return {
    name: simpleCppTypeName(className),
    qualifiedName: className,
    baseClassNames,
    methodsByName: new Map(),
    properties: new Map(),
    signals: new Set(),
    hasQmlExposureEvidence: false,
    hasWidgetsEvidence: false,
  };
}

function addClassFacts(registry: QtCppMetaRegistry, facts: QtCppClassFacts): void {
  const qualifiedName = facts.qualifiedName ?? facts.name;
  registry.classesByQualifiedName.set(qualifiedName, facts);

  const simpleEntries = registry.classesBySimpleName.get(facts.name) ?? [];
  if (!simpleEntries.includes(facts)) {
    simpleEntries.push(facts);
    registry.classesBySimpleName.set(facts.name, simpleEntries);
  }

  if (simpleEntries.length === 1) {
    registry.classes.set(facts.name, facts);
  } else {
    registry.classes.delete(facts.name);
  }
  registry.classes.set(qualifiedName, facts);
}

function getOrCreateClassFacts(
  registry: QtCppMetaRegistry,
  className: string,
  baseClassNames: string[] = []
): QtCppClassFacts {
  const existing = registry.classesByQualifiedName.get(className);
  if (existing) {
    existing.baseClassNames = mergeUnique(existing.baseClassNames, baseClassNames);
    return existing;
  }

  const facts = createClassFacts(className, baseClassNames);
  addClassFacts(registry, facts);
  return facts;
}

function mergeUnique<T>(left: T[], right: T[]): T[] {
  return [...new Set([...left, ...right])];
}

function sectionInfo(label: string): QtCppSectionInfo {
  const normalized = label.toLowerCase();
  if (normalized === 'signals' || normalized === 'q_signals') {
    return { visibility: 'protected', slot: false, signal: true };
  }
  if (normalized.startsWith('private')) {
    return { visibility: 'private', slot: normalized.includes('slots') || normalized.includes('q_slots'), signal: false };
  }
  if (normalized.startsWith('protected')) {
    return { visibility: 'protected', slot: normalized.includes('slots') || normalized.includes('q_slots'), signal: false };
  }
  return { visibility: 'public', slot: normalized.includes('slots') || normalized.includes('q_slots'), signal: false };
}

function addMethodFact(
  classFacts: QtCppClassFacts,
  declaration: QtCppMethodDeclaration,
  flags: {
    invokable?: boolean;
    publicSlot?: boolean;
    privateOrProtectedSlot?: boolean;
    signal?: boolean;
    visibility?: QtCppSectionVisibility;
  }
): void {
  const methods = classFacts.methodsByName.get(declaration.name) ?? [];
  const signature = declaration.signature
    ? `${canonicalQtSignature(declaration.signature)}${declaration.constMember ? ' const' : ''}`
    : `${declaration.name}(${declaration.parameterTypes.join(',')})${declaration.constMember ? ' const' : ''}`;
  const existing = methods.find((method) => method.signature === signature);

  if (existing) {
    existing.invokable = existing.invokable || Boolean(flags.invokable);
    existing.publicSlot = existing.publicSlot || Boolean(flags.publicSlot);
    existing.privateOrProtectedSlot =
      existing.privateOrProtectedSlot || Boolean(flags.privateOrProtectedSlot);
    existing.signal = existing.signal || Boolean(flags.signal);
    existing.visibility = existing.visibility ?? flags.visibility;
    return;
  }

  methods.push({
    name: declaration.name,
    qualifiedName: classFacts.qualifiedName
      ? `${classFacts.qualifiedName}::${declaration.name}`
      : undefined,
    invokable: Boolean(flags.invokable),
    publicSlot: Boolean(flags.publicSlot),
    privateOrProtectedSlot: Boolean(flags.privateOrProtectedSlot),
    signal: Boolean(flags.signal),
    visibility: flags.visibility,
    signature,
    arity: declaration.arity,
    parameterTypes: declaration.parameterTypes,
  });
  classFacts.methodsByName.set(declaration.name, methods);
}

function splitCppParameterList(parameters: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < parameters.length; index++) {
    const char = parameters[index];
    if (char === '<' || char === '(' || char === '[') depth++;
    if (char === '>' || char === ')' || char === ']') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(parameters.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(parameters.slice(start).trim());
  return parts.filter(Boolean);
}

function parseMethodDeclaration(rawDeclaration: string): QtCppMethodDeclaration | null {
  const declaration = rawDeclaration
    .replace(/\b(?:override|final)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const match =
    /(?:^|\s)(?:operator\s*[^\s(]+|~?(?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*)\)\s*(const\b)?/.exec(
      declaration
    );
  if (!match) return null;

  const openParen = declaration.indexOf('(', match.index);
  const namePart = declaration.slice(0, openParen).trim().split(/\s+/).pop();
  const name = namePart?.replace(/^.*::/, '');
  if (!name || ['if', 'for', 'while', 'switch', 'return', 'connect'].includes(name)) return null;

  const parameterTypes = parseQtParameterTypes(match[1] ?? '');
  return {
    name,
    signature: `${name}(${parameterTypes.join(',')})`,
    parameterTypes,
    arity: parameterTypes.length,
    constMember: Boolean(match[2]),
  };
}

export function parseQtMethodParameterTypes(source: string): string[] | null {
  return parseMethodDeclaration(source)?.parameterTypes ?? null;
}

function methodDeclarationsFromCppDeclarations(source: string): QtCppMethodDeclaration[] {
  const declarations: QtCppMethodDeclaration[] = [];
  const methodPattern =
    /(?:^|[;\n])\s*((?:Q_INVOKABLE\s+)?(?:virtual\s+)?(?:[\w:<>~*&,\s]+\s+)?[A-Za-z_~][A-Za-z0-9_~]*\s*\([^;{}]*\)\s*(?:const\s*)?(?:override\s*)?(?:final\s*)?)(?:;|\{)/gm;

  for (const match of source.matchAll(methodPattern)) {
    const rawDeclaration = match[1];
    if (!rawDeclaration) continue;
    const declaration = parseMethodDeclaration(rawDeclaration);
    if (declaration) declarations.push(declaration);
  }
  return declarations;
}

function parseQtCppProperties(classFacts: QtCppClassFacts, classBody: string): void {
  const propertyPattern = /Q_PROPERTY\s*\(\s*[^\s()]+\s+([A-Za-z_][A-Za-z0-9_]*)\b([^)]*)\)/g;
  for (const match of classBody.matchAll(propertyPattern)) {
    const name = match[1];
    if (!name) continue;
    const tail = match[2] ?? '';
    const read = /\bREAD\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(tail)?.[1];
    const notify = /\bNOTIFY\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(tail)?.[1];
    classFacts.properties.set(name, { name, read, notify });
    if (notify) classFacts.signals.add(notify);
  }
}

function parseQtCppMethods(classFacts: QtCppClassFacts, classBody: string): void {
  const invokablePattern =
    /Q_INVOKABLE\s+((?:[\w:<>~*&,\s]+?\s+)?[A-Za-z_~][A-Za-z0-9_~]*\s*\([^;{}]*\)\s*(?:const\b)?)/g;
  for (const match of classBody.matchAll(invokablePattern)) {
    const declaration = match[1] ? parseMethodDeclaration(match[1]) : null;
    if (declaration) addMethodFact(classFacts, declaration, { invokable: true, visibility: 'public' });
  }

  const sections = [...classBody.matchAll(qtCppSectionPattern)];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const label = section[2] ?? '';
    const info = sectionInfo(label);
    const start = section.index! + section[0].length;
    const end = sections[i + 1]?.index ?? classBody.length;
    for (const declaration of methodDeclarationsFromCppDeclarations(classBody.slice(start, end))) {
      if (info.signal) classFacts.signals.add(declaration.name);
      addMethodFact(classFacts, declaration, {
        publicSlot: info.slot && info.visibility === 'public',
        privateOrProtectedSlot: info.slot && info.visibility !== 'public',
        signal: info.signal,
        visibility: info.visibility,
      });
    }
  }
}

function parseBaseClassNames(classHeader: string): string[] {
  const colon = classHeader.indexOf(':');
  if (colon < 0) return [];
  return classHeader
    .slice(colon + 1)
    .split(',')
    .map((base) =>
      base
        .replace(/\b(?:public|private|protected|virtual|final)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean);
}

function namespaceRanges(source: string): Array<{ name: string; openBrace: number; closeBrace: number }> {
  const ranges: Array<{ name: string; openBrace: number; closeBrace: number }> = [];
  const namespacePattern = /\bnamespace\s+([A-Za-z_][A-Za-z0-9_:]*)\s*\{/g;
  for (const match of source.matchAll(namespacePattern)) {
    const name = match[1];
    if (!name) continue;
    const openBrace = source.indexOf('{', match.index);
    const closeBrace = matchingBraceOffset(source, openBrace);
    if (openBrace >= 0 && closeBrace >= 0) ranges.push({ name, openBrace, closeBrace });
  }
  return ranges;
}

function namespaceForOffset(
  ranges: Array<{ name: string; openBrace: number; closeBrace: number }>,
  offset: number
): string | undefined {
  const containing = ranges
    .filter((range) => range.openBrace <= offset && offset <= range.closeBrace)
    .sort((left, right) => left.openBrace - right.openBrace);
  return containing.length > 0
    ? containing.map((range) => range.name).join('::')
    : undefined;
}

function matchingBraceOffset(source: string, openBraceOffset: number): number {
  let depth = 0;
  for (let index = openBraceOffset; index < source.length; index++) {
    const char = source[index];
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseQtCppClasses(registry: QtCppMetaRegistry, source: string): void {
  const ranges = namespaceRanges(source);
  const classPattern = /\b(?:class|struct)\s+(?:(?:[A-Z][A-Z0-9_]*_EXPORT|[A-Z][A-Z0-9_]*_API)\s+)?([A-Za-z_][A-Za-z0-9_:]*)\b([^{;]*)\{([\s\S]*?)\s*\};/g;
  for (const match of source.matchAll(classPattern)) {
    const className = match[1];
    const classHeader = match[0].slice(0, match[0].indexOf('{'));
    const classTail = match[2] ?? '';
    const classBody = match[3];
    if (!className || !classBody) continue;

    const namespaceName = className.includes('::')
      ? undefined
      : namespaceForOffset(ranges, match.index ?? 0);
    const qualifiedName = namespaceName ? `${namespaceName}::${className}` : className;
    const facts = getOrCreateClassFacts(
      registry,
      qualifiedName,
      parseBaseClassNames(`${classHeader}${classTail}`)
    );
    if (/\bQ_OBJECT\b|\bQ_GADGET\b|\bQ_PROPERTY\s*\(|\bQ_INVOKABLE\b|\bsignals\s*:|\bQ_SIGNALS\s*:/.test(classBody)) {
      facts.hasQmlExposureEvidence = true;
    }
    if (/\bQObject\b|\bQWidget\b|\bQFrame\b|\bQMainWindow\b|\bQDialog\b|\bQPushButton\b|\bQApplication\b/.test(`${classHeader}${classTail}${classBody}`)) {
      facts.hasWidgetsEvidence = true;
    }
    parseQtCppProperties(facts, classBody);
    parseQtCppMethods(facts, classBody);
  }
}

function attachQtCppNodes(context: ResolutionContext, registry: QtCppMetaRegistry): void {
  for (const node of context.getNodesByKind('class')) {
    attachQtCppClassNode(node, registry);
  }
  for (const node of context.getNodesByKind('struct')) {
    attachQtCppClassNode(node, registry);
  }
  for (const node of context.getNodesByKind('method')) {
    attachQtCppMethodNode(context, node, registry);
  }
}

function matchingClassFacts(node: Node, registry: QtCppMetaRegistry): QtCppClassFacts | undefined {
  const byQualifiedName = registry.classesByQualifiedName.get(node.qualifiedName);
  if (byQualifiedName) return byQualifiedName;

  const suffixMatches = [...registry.classesByQualifiedName.entries()]
    .filter(([qualifiedName]) => node.qualifiedName.endsWith(`::${qualifiedName}`))
    .map(([, facts]) => facts);
  if (suffixMatches.length === 1) return suffixMatches[0];

  const simpleMatches = registry.classesBySimpleName.get(node.name) ?? [];
  return simpleMatches.length === 1 ? simpleMatches[0] : undefined;
}

function attachQtCppClassNode(node: Node, registry: QtCppMetaRegistry): void {
  if (node.language !== 'cpp') return;
  const facts = matchingClassFacts(node, registry);
  if (facts) facts.classNodeId = node.id;
}

function attachQtCppMethodNode(
  context: ResolutionContext,
  node: Node,
  registry: QtCppMetaRegistry
): void {
  if (node.language !== 'cpp') return;
  const ownerQualifiedName = node.qualifiedName.split('::').slice(0, -1).join('::');
  const ownerSimpleName = ownerQualifiedName.split('::').pop();
  const exactOwnerFacts = registry.classesByQualifiedName.get(ownerQualifiedName);
  const suffixMatches = [...registry.classesByQualifiedName.entries()]
    .filter(([qualifiedName]) => ownerQualifiedName.endsWith(`::${qualifiedName}`))
    .map(([, facts]) => facts);
  const simpleMatches = ownerSimpleName ? registry.classesBySimpleName.get(ownerSimpleName) ?? [] : [];
  const candidateFacts =
    exactOwnerFacts ??
    (suffixMatches.length === 1 ? suffixMatches[0] : undefined) ??
    (simpleMatches.length === 1 ? simpleMatches[0] : undefined);
  if (!candidateFacts) return;

  const methods = candidateFacts.methodsByName.get(node.name) ?? [];
  const matchingByQualified = methods.filter(
    (method) =>
      method.qualifiedName === node.qualifiedName ||
      (method.qualifiedName && node.qualifiedName.endsWith(`::${method.qualifiedName}`))
  );
  let targetMethods =
    matchingByQualified.length > 0
      ? matchingByQualified
      : methods;
  if (targetMethods.length > 1) {
    const source = context.readFile(node.filePath);
    const nodeSource = source
      ?.split('\n')
      .slice(node.startLine - 1, node.endLine ?? node.startLine)
      .join('\n');
    const parameterTypes = nodeSource ? parseQtMethodParameterTypes(nodeSource) : null;
    if (parameterTypes) {
      targetMethods = targetMethods.filter((method) =>
        sameParameterTypes(method.parameterTypes, parameterTypes)
      );
    }
  }
  if (targetMethods.length === 1) {
    targetMethods[0]!.nodeId = node.id;
  }
}

export function getQtCppMetaRegistry(context: ResolutionContext): QtCppMetaRegistry {
  const { key, sources } = getQtCppSources(context);
  const cached = qtCppMetaRegistryCache.get(context);
  if (cached?.key === key) return cached.registry;

  const registry: QtCppMetaRegistry = {
    classes: new Map(),
    classesByQualifiedName: new Map(),
    classesBySimpleName: new Map(),
  };
  for (const [, source] of sources) {
    if (!source) continue;
    parseQtCppClasses(registry, source);
  }
  attachQtCppNodes(context, registry);
  qtCppMetaRegistryCache.set(context, { key, registry });
  return registry;
}
