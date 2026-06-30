import type { Node } from '../../../types';
import type { ResolutionContext } from '../../types';

export interface QtCppMethodFact {
  name: string;
  invokable: boolean;
  publicSlot: boolean;
  privateOrProtectedSlot?: boolean;
  signature?: string;
  arity?: number;
}

export interface QtCppPropertyFact {
  name: string;
  read?: string;
  notify?: string;
}

export interface QtCppClassFacts {
  name: string;
  classNodeId?: string;
  methods: Map<string, QtCppMethodFact>;
  properties: Map<string, QtCppPropertyFact>;
  signals: Set<string>;
  hasQmlExposureEvidence: boolean;
}

export interface QtCppMetaRegistry {
  classes: Map<string, QtCppClassFacts>;
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

const qtCppSourceCache = new WeakMap<ResolutionContext, QtCppSourceCacheEntry>();
const qtCppMetaRegistryCache = new WeakMap<ResolutionContext, QtCppMetaRegistryCacheEntry>();

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
  const versionKey = cppBridgeVersionKey(context);
  const cached = qtCppSourceCache.get(context);
  if (cached?.versionKey === versionKey) return cached;

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

function getOrCreateClassFacts(
  registry: QtCppMetaRegistry,
  className: string
): QtCppClassFacts {
  const simpleName = simpleCppTypeName(className);
  let facts = registry.classes.get(simpleName);
  if (!facts) {
    facts = {
      name: simpleName,
      methods: new Map(),
      properties: new Map(),
      signals: new Set(),
      hasQmlExposureEvidence: false,
    };
    registry.classes.set(simpleName, facts);
  }
  return facts;
}

function addMethodFact(
  classFacts: QtCppClassFacts,
  name: string,
  flags: { invokable?: boolean; publicSlot?: boolean }
): void {
  const existing = classFacts.methods.get(name);
  classFacts.methods.set(name, {
    name,
    invokable: Boolean(existing?.invokable || flags.invokable),
    publicSlot: Boolean(existing?.publicSlot || flags.publicSlot),
  });
}

function methodNamesFromCppDeclarations(source: string): string[] {
  const names: string[] = [];
  const methodPattern =
    /(?:^|[;\n])\s*(?:virtual\s+)?(?:[\w:<>~*&\s]+?\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:;|\{)/gm;

  for (const match of source.matchAll(methodPattern)) {
    const name = match[1];
    if (!name || ['if', 'for', 'while', 'switch', 'return'].includes(name)) continue;
    names.push(name);
  }
  return names;
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

function parseQtCppSignals(classFacts: QtCppClassFacts, classBody: string): void {
  const sectionPattern =
    /(^|\n)\s*(public\s+slots|public\s+Q_SLOTS|public|protected|private|signals|Q_SIGNALS)\s*:/gi;
  const sections = [...classBody.matchAll(sectionPattern)];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const label = section[2]?.toLowerCase() ?? '';
    if (label !== 'signals' && label !== 'q_signals') continue;
    const start = section.index! + section[0].length;
    const end = sections[i + 1]?.index ?? classBody.length;
    for (const name of methodNamesFromCppDeclarations(classBody.slice(start, end))) {
      classFacts.signals.add(name);
    }
  }
}

function parseQtCppMethods(classFacts: QtCppClassFacts, classBody: string): void {
  const invokablePattern =
    /Q_INVOKABLE\s+(?:[\w:<>~*&\s]+?\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  for (const match of classBody.matchAll(invokablePattern)) {
    const name = match[1];
    if (name) addMethodFact(classFacts, name, { invokable: true });
  }

  const sectionPattern =
    /(^|\n)\s*(public\s+slots|public\s+Q_SLOTS|public|protected|private|signals|Q_SIGNALS)\s*:/gi;
  const sections = [...classBody.matchAll(sectionPattern)];
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const label = section[2]?.toLowerCase() ?? '';
    if (label !== 'public slots' && label !== 'public q_slots') continue;
    const start = section.index! + section[0].length;
    const end = sections[i + 1]?.index ?? classBody.length;
    for (const name of methodNamesFromCppDeclarations(classBody.slice(start, end))) {
      addMethodFact(classFacts, name, { publicSlot: true });
    }
  }
}

function parseQtCppClasses(registry: QtCppMetaRegistry, source: string): void {
  const classPattern = /\b(?:class|struct)\s+([A-Za-z_][A-Za-z0-9_:]*)\b[^{;]*\{([\s\S]*?)\s*\};/g;
  for (const match of source.matchAll(classPattern)) {
    const className = match[1];
    const classBody = match[2];
    if (!className || !classBody) continue;

    const facts = getOrCreateClassFacts(registry, className);
    if (/\bQ_OBJECT\b|\bQ_GADGET\b|\bQ_PROPERTY\s*\(|\bQ_INVOKABLE\b|\bsignals\s*:|\bQ_SIGNALS\s*:/.test(classBody)) {
      facts.hasQmlExposureEvidence = true;
    }
    parseQtCppProperties(facts, classBody);
    parseQtCppSignals(facts, classBody);
    parseQtCppMethods(facts, classBody);
  }
}

function attachQtCppNodes(context: ResolutionContext, registry: QtCppMetaRegistry): void {
  for (const node of context.getNodesByKind('class')) {
    attachQtCppNode(node, registry);
  }
  for (const node of context.getNodesByKind('struct')) {
    attachQtCppNode(node, registry);
  }
}

function attachQtCppNode(node: Node, registry: QtCppMetaRegistry): void {
  if (node.language !== 'cpp') return;
  const facts = registry.classes.get(node.name);
  if (facts) facts.classNodeId = node.id;
}

export function getQtCppMetaRegistry(context: ResolutionContext): QtCppMetaRegistry {
  const { key, sources } = getQtCppSources(context);
  const cached = qtCppMetaRegistryCache.get(context);
  if (cached?.key === key) return cached.registry;

  const registry: QtCppMetaRegistry = {
    classes: new Map(),
  };
  for (const [, source] of sources) {
    if (!source) continue;
    parseQtCppClasses(registry, source);
  }
  attachQtCppNodes(context, registry);
  qtCppMetaRegistryCache.set(context, { key, registry });
  return registry;
}
