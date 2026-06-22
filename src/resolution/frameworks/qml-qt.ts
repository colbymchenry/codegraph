import * as path from 'path';
import type { Node } from '../../types';
import { isQmlDirFile, isQmlFile } from '../../extraction/grammars';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';

interface QmlDirComponent {
  name: string;
  version?: string;
  filePath: string;
  internal: boolean;
}

interface QmlDirDependency {
  uri: string;
  version?: string;
}

interface QmlDirModule {
  uri: string;
  dir: string;
  components: QmlDirComponent[];
  imports: QmlDirDependency[];
}

interface QmlModuleImport {
  uri: string;
  version?: string;
  alias?: string;
}

interface QmlDirModuleCacheEntry {
  key: string;
  modules: QmlDirModule[];
}

interface QmlModuleImportCacheEntry {
  source: string | null;
  imports: QmlModuleImport[];
}

type QmlCppRegistrationKind = 'type' | 'singleton' | 'uncreatable';

interface QmlCppRegistration {
  kind: QmlCppRegistrationKind;
  cppType: string;
  uri: string;
  version?: string;
  qmlName: string;
  classNodeId?: string;
}

interface QmlCppMethodFact {
  name: string;
  invokable: boolean;
  publicSlot: boolean;
}

interface QmlCppPropertyFact {
  name: string;
  read?: string;
  notify?: string;
}

interface QmlCppClassFacts {
  name: string;
  classNodeId?: string;
  methods: Map<string, QmlCppMethodFact>;
  properties: Map<string, QmlCppPropertyFact>;
  signals: Set<string>;
  hasQmlExposureEvidence: boolean;
}

interface QmlCppContextProperty {
  name: string;
  cppType: string;
  classNodeId?: string;
}

interface QmlCppBridgeRegistry {
  classes: Map<string, QmlCppClassFacts>;
  registrations: QmlCppRegistration[];
  contextProperties: Map<string, QmlCppContextProperty>;
}

interface QmlCppBridgeRegistryCacheEntry {
  key: string;
  registry: QmlCppBridgeRegistry;
}

const moduleCache = new WeakMap<ResolutionContext, QmlDirModuleCacheEntry>();
const importCache = new WeakMap<ResolutionContext, Map<string, QmlModuleImportCacheEntry>>();
const bridgeRegistryCache = new WeakMap<ResolutionContext, QmlCppBridgeRegistryCacheEntry>();

function hasQmlFiles(context: ResolutionContext): boolean {
  return context.getAllFiles().some((filePath) => isQmlFile(filePath));
}

function isCppBridgeFile(filePath: string): boolean {
  return /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(filePath);
}

function dirname(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(0, slash) : '';
}

function normalizeProjectPath(filePath: string): string {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, '/'));
  return normalized === '.' ? '' : normalized.replace(/^\.\//, '');
}

function joinProjectPath(dir: string, relativePath: string): string {
  return normalizeProjectPath(dir ? `${dir}/${relativePath}` : relativePath);
}

function parseQmlImports(context: ResolutionContext, filePath: string): QmlModuleImport[] {
  let perContext = importCache.get(context);
  if (!perContext) {
    perContext = new Map();
    importCache.set(context, perContext);
  }

  const source = context.readFile(filePath);
  const cached = perContext.get(filePath);
  if (cached && cached.source === source) return cached.imports;

  if (!source) {
    perContext.set(filePath, { source, imports: [] });
    return [];
  }

  const imports: QmlModuleImport[] = [];
  const importPattern =
    /^\s*import\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*(\d+(?:\.\d+)?)?\s*(?:as\s+([A-Za-z_][A-Za-z0-9_]*))?/gm;
  for (const match of source.matchAll(importPattern)) {
    const uri = match[1];
    if (!uri) continue;
    imports.push({ uri, version: match[2], alias: match[3] });
  }

  perContext.set(filePath, { source, imports });
  return imports;
}

function simpleCppTypeName(typeName: string): string {
  const parts = typeName.trim().split('::').filter(Boolean);
  return parts[parts.length - 1] ?? typeName.trim();
}

function getOrCreateClassFacts(
  registry: QmlCppBridgeRegistry,
  className: string
): QmlCppClassFacts {
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
  classFacts: QmlCppClassFacts,
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

function parseQmlCppProperties(classFacts: QmlCppClassFacts, classBody: string): void {
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

function parseQmlCppSignals(classFacts: QmlCppClassFacts, classBody: string): void {
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

function parseQmlCppMethods(classFacts: QmlCppClassFacts, classBody: string): void {
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

function parseQmlCppClasses(registry: QmlCppBridgeRegistry, source: string): void {
  const classPattern = /\b(?:class|struct)\s+([A-Za-z_][A-Za-z0-9_:]*)\b[^{;]*\{([\s\S]*?)\s*\};/g;
  for (const match of source.matchAll(classPattern)) {
    const className = match[1];
    const classBody = match[2];
    if (!className || !classBody) continue;

    const facts = getOrCreateClassFacts(registry, className);
    if (/\bQ_OBJECT\b|\bQ_GADGET\b|\bQ_PROPERTY\s*\(|\bQ_INVOKABLE\b|\bsignals\s*:|\bQ_SIGNALS\s*:/.test(classBody)) {
      facts.hasQmlExposureEvidence = true;
    }
    parseQmlCppProperties(facts, classBody);
    parseQmlCppSignals(facts, classBody);
    parseQmlCppMethods(facts, classBody);
  }
}

function parseQmlCppRegistrations(registry: QmlCppBridgeRegistry, source: string): void {
  const registrationPattern =
    /\b(qmlRegisterType|qmlRegisterSingletonType|qmlRegisterUncreatableType)\s*<\s*([A-Za-z_][A-Za-z0-9_:]*)\s*>\s*\(\s*(['"])([^'"]+)\3\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])([^'"]+)\7/g;
  for (const match of source.matchAll(registrationPattern)) {
    const api = match[1];
    const cppType = match[2];
    const uri = match[4];
    const major = match[5];
    const minor = match[6];
    const qmlName = match[8];
    if (!api || !cppType || !uri || !major || !minor || !qmlName) continue;

    const kind: QmlCppRegistrationKind =
      api === 'qmlRegisterSingletonType'
        ? 'singleton'
        : api === 'qmlRegisterUncreatableType'
          ? 'uncreatable'
          : 'type';
    registry.registrations.push({
      kind,
      cppType,
      uri,
      version: `${major}.${minor}`,
      qmlName,
    });
    getOrCreateClassFacts(registry, cppType).hasQmlExposureEvidence = true;
  }
}

function parseQmlCppContextProperties(registry: QmlCppBridgeRegistry, source: string): void {
  const localTypes = new Map<string, string>();
  const declarationPattern =
    /\b([A-Za-z_][A-Za-z0-9_:]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:[;=({])/g;
  for (const match of source.matchAll(declarationPattern)) {
    const typeName = match[1];
    const variableName = match[2];
    if (!typeName || !variableName) continue;
    if (['return', 'new', 'class', 'struct', 'public', 'private', 'protected'].includes(typeName)) {
      continue;
    }
    localTypes.set(variableName, typeName);
  }

  const contextPropertyPattern =
    /(?:[A-Za-z_][A-Za-z0-9_]*(?:\.|->)rootContext\(\)\s*(?:\.|->)|[A-Za-z_][A-Za-z0-9_]*\s*(?:\.|->))setContextProperty\s*\(\s*(['"])([^'"]+)\1\s*,\s*&?\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of source.matchAll(contextPropertyPattern)) {
    const name = match[2];
    const variableName = match[3];
    if (!name || !variableName) continue;
    const cppType = localTypes.get(variableName);
    if (!cppType) continue;
    registry.contextProperties.set(name, { name, cppType });
    getOrCreateClassFacts(registry, cppType).hasQmlExposureEvidence = true;
  }
}

function attachQmlCppNodes(context: ResolutionContext, registry: QmlCppBridgeRegistry): void {
  for (const node of context.getNodesByKind('class')) {
    if (node.language !== 'cpp') continue;
    const facts = registry.classes.get(node.name);
    if (facts) facts.classNodeId = node.id;
  }
  for (const node of context.getNodesByKind('struct')) {
    if (node.language !== 'cpp') continue;
    const facts = registry.classes.get(node.name);
    if (facts) facts.classNodeId = node.id;
  }

  for (const registration of registry.registrations) {
    const facts = registry.classes.get(simpleCppTypeName(registration.cppType));
    registration.classNodeId = facts?.classNodeId;
  }
  for (const contextProperty of registry.contextProperties.values()) {
    const facts = registry.classes.get(simpleCppTypeName(contextProperty.cppType));
    contextProperty.classNodeId = facts?.classNodeId;
  }
}

function getQmlCppBridgeRegistry(context: ResolutionContext): QmlCppBridgeRegistry {
  const sources = context
    .getAllFiles()
    .filter(isCppBridgeFile)
    .map((filePath) => [filePath, context.readFile(filePath)] as const);
  const key = sources.map(([filePath, source]) => `${filePath}\0${source ?? ''}`).join('\0');
  const cached = bridgeRegistryCache.get(context);
  if (cached?.key === key) return cached.registry;

  const registry: QmlCppBridgeRegistry = {
    classes: new Map(),
    registrations: [],
    contextProperties: new Map(),
  };
  for (const [, source] of sources) {
    if (!source) continue;
    parseQmlCppClasses(registry, source);
    parseQmlCppRegistrations(registry, source);
    parseQmlCppContextProperties(registry, source);
  }
  attachQmlCppNodes(context, registry);
  bridgeRegistryCache.set(context, { key, registry });
  return registry;
}

function parseQmlDirDependency(tokens: string[]): QmlDirDependency | null {
  if (tokens[0] !== 'import') return null;
  const uri = tokens[1];
  if (!uri || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(uri)) return null;

  const version = tokens[2] && /^\d+(?:\.\d+)?$/.test(tokens[2]) ? tokens[2] : undefined;
  return { uri, version };
}

function parseQmlDir(filePath: string, source: string): QmlDirModule | null {
  const dir = dirname(filePath);
  let uri: string | null = null;
  const components: QmlDirComponent[] = [];
  const imports: QmlDirDependency[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;

    const tokens = line.split(/\s+/);
    if (tokens[0] === 'module' && tokens[1]) {
      uri = tokens[1];
      continue;
    }

    const dependency = parseQmlDirDependency(tokens);
    if (dependency) {
      imports.push(dependency);
      continue;
    }

    const internal = tokens[0] === 'internal';
    const singleton = tokens[0] === 'singleton';
    const nameIndex = internal || singleton ? 1 : 0;
    const name = tokens[nameIndex];
    if (!name || !/^[A-Z][A-Za-z0-9_]*$/.test(name)) continue;

    const versionToken = tokens[nameIndex + 1];
    const version = versionToken && /^\d+(?:\.\d+)?$/.test(versionToken) ? versionToken : undefined;
    const qmlFileIndex = tokens.findIndex((token) => /\.qml$/i.test(token));
    if (qmlFileIndex < 0) continue;

    const qmlFile = tokens[qmlFileIndex];
    if (!qmlFile) continue;
    const targetPath = joinProjectPath(dir, qmlFile);
    components.push({ name, version, filePath: targetPath, internal });
  }

  return uri ? { uri, dir, components, imports } : null;
}

function getQmlDirModules(context: ResolutionContext): QmlDirModule[] {
  const dirs = new Set<string>();
  for (const filePath of context.getAllFiles()) {
    if (isQmlFile(filePath)) dirs.add(dirname(filePath));
    if (filePath.replace(/\\/g, '/').split('/').pop() === 'qmldir') dirs.add(dirname(filePath));
  }

  const qmlDirSources = [...dirs].map((dir) => {
    const qmlDirPath = dir ? `${dir}/qmldir` : 'qmldir';
    return [qmlDirPath, context.readFile(qmlDirPath)] as const;
  });
  const key = qmlDirSources
    .map(([qmlDirPath, source]) => `${qmlDirPath}\0${source ?? ''}`)
    .join('\0');
  const cached = moduleCache.get(context);
  if (cached?.key === key) return cached.modules;

  const modules: QmlDirModule[] = [];
  for (const [qmlDirPath, source] of qmlDirSources) {
    if (!source) continue;

    const parsed = parseQmlDir(qmlDirPath, source);
    if (parsed) modules.push(parsed);
  }

  moduleCache.set(context, { key, modules });
  return modules;
}

function componentTypeName(referenceName: string): string | null {
  const typeName = referenceName.split('.').pop() ?? referenceName;
  return /^[A-Z][A-Za-z0-9_]*$/.test(typeName) ? typeName : null;
}

function findQmlComponentNode(context: ResolutionContext, component: QmlDirComponent): Node | null {
  return findQmlComponentNodeByPath(context, component.filePath);
}

function findQmlComponentNodeByPath(context: ResolutionContext, filePath: string): Node | null {
  return (
    context
      .getNodesInFile(filePath)
      .find(
        (node) =>
          node.language === 'qml' &&
          node.kind === 'component' &&
          node.filePath.replace(/\\/g, '/') === filePath &&
          node.qualifiedName === node.name
      ) ?? null
  );
}

function isTopLevelQmlComponentDefinition(node: Node, name?: string): boolean {
  return (
    node.language === 'qml' &&
    node.kind === 'component' &&
    (!name || node.name === name) &&
    node.qualifiedName === node.name
  );
}

function isAbsoluteOrSchemedQmlUrl(url: string): boolean {
  return (
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) ||
    url.startsWith('/') ||
    url.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(url)
  );
}

function getLocalQmlImportDirs(context: ResolutionContext, filePath: string): Set<string> {
  const fromDir = dirname(filePath);
  const dirs = new Set<string>([fromDir]);
  const source = context.readFile(filePath);
  if (!source) return dirs;

  for (const match of source.matchAll(/^\s*import\s+(?:"([^"]+)"|'([^']+)')/gm)) {
    const spec = match[1] ?? match[2];
    if (!spec || /\.js$/i.test(spec) || isAbsoluteOrSchemedQmlUrl(spec)) continue;
    dirs.add(joinProjectPath(fromDir, spec));
  }

  return dirs;
}

function isShadowedLoaderSourceReference(
  ref: UnresolvedRef,
  context: ResolutionContext
): boolean {
  const fromNode = context.getNodesInFile(ref.filePath).find((node) => node.id === ref.fromNodeId);
  const sourceTypeName = fromNode?.signature?.trim().split(/\s+/)[0];
  if (fromNode?.kind !== 'component' || sourceTypeName !== 'Loader') return false;

  const localDirs = getLocalQmlImportDirs(context, ref.filePath);
  if (context
    .getNodesByName('Loader')
    .some(
      (node) =>
        isTopLevelQmlComponentDefinition(node, 'Loader') && localDirs.has(dirname(node.filePath))
    )) {
    return true;
  }

  return parseQmlImports(context, ref.filePath).some((imported) =>
    effectiveQmlImports(context, imported).some((effectiveImport) =>
      importedComponentCandidates(context, effectiveImport, 'Loader').some((component) => {
        const target = findQmlComponentNode(context, component);
        return !!target;
      })
    )
  );
}

function resolveLiteralQmlUrl(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.language !== 'qml' || ref.referenceKind !== 'references') return null;
  if (!/\.qml$/i.test(ref.referenceName)) return null;
  if (isAbsoluteOrSchemedQmlUrl(ref.referenceName)) return null;
  if (isShadowedLoaderSourceReference(ref, context)) return null;

  const refDir = dirname(ref.filePath);
  const targetPath = joinProjectPath(refDir, ref.referenceName);
  const target = findQmlComponentNodeByPath(context, targetPath);
  if (!target) return null;

  return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'file-path' };
}

function parseVersion(version: string | undefined): { major: number; minor: number } | null {
  if (!version) return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(version);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2] ?? 0) };
}

function isCompatibleVersion(
  componentVersion: string | undefined,
  importVersion: string | undefined
): boolean {
  const component = parseVersion(componentVersion);
  const imported = parseVersion(importVersion);
  if (!component || !imported) return false;
  if (component.major !== imported.major) return false;
  return component.minor <= imported.minor;
}

function compareVersionsDesc(a: QmlDirComponent, b: QmlDirComponent): number {
  const left = parseVersion(a.version);
  const right = parseVersion(b.version);
  if (!left && !right) return a.filePath.localeCompare(b.filePath);
  if (!left) return 1;
  if (!right) return -1;
  return right.major - left.major || right.minor - left.minor || a.filePath.localeCompare(b.filePath);
}

function importedComponentCandidates(
  context: ResolutionContext,
  imported: QmlModuleImport,
  componentName: string
): QmlDirComponent[] {
  return getQmlDirModules(context)
    .filter((module) => module.uri === imported.uri)
    .flatMap((module) =>
      module.components.filter(
        (component) => !component.internal && component.name === componentName
      )
    );
}

function effectiveQmlImports(
  context: ResolutionContext,
  imported: QmlModuleImport
): QmlModuleImport[] {
  const modules = getQmlDirModules(context);
  const byUri = new Map<string, QmlDirModule[]>();
  for (const module of modules) {
    const entries = byUri.get(module.uri) ?? [];
    entries.push(module);
    byUri.set(module.uri, entries);
  }

  const imports: QmlModuleImport[] = [];
  const seen = new Set<string>();
  const visit = (next: QmlModuleImport): void => {
    const key = `${next.uri}\0${next.version ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    imports.push(next);

    for (const module of byUri.get(next.uri) ?? []) {
      for (const dependency of module.imports) {
        visit({ uri: dependency.uri, version: dependency.version });
      }
    }
  };

  visit(imported);
  return imports;
}

function pickImportedComponent(
  candidates: QmlDirComponent[],
  importVersion: string | undefined
): QmlDirComponent | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const only = candidates[0]!;
    return importVersion && only.version && !isCompatibleVersion(only.version, importVersion)
      ? null
      : only;
  }
  if (!importVersion) {
    const unversioned = candidates
      .filter((component) => !component.version)
      .sort(compareVersionsDesc)[0];
    // Versionless imports choose an explicitly unversioned export first; otherwise
    // use the newest available version so Qt 6 versionless module imports are stable.
    return unversioned ?? [...candidates].sort(compareVersionsDesc)[0] ?? null;
  }
  return (
    candidates
      .filter((component) => isCompatibleVersion(component.version, importVersion))
      .sort(compareVersionsDesc)[0] ?? null
  );
}

function compareBridgeRegistrationsDesc(
  a: QmlCppRegistration,
  b: QmlCppRegistration
): number {
  const left = parseVersion(a.version);
  const right = parseVersion(b.version);
  if (!left && !right) return a.cppType.localeCompare(b.cppType);
  if (!left) return 1;
  if (!right) return -1;
  return right.major - left.major || right.minor - left.minor || a.cppType.localeCompare(b.cppType);
}

function bridgeRegistrationCandidates(
  registry: QmlCppBridgeRegistry,
  imported: QmlModuleImport,
  qmlName: string,
  kinds: ReadonlySet<QmlCppRegistrationKind>
): QmlCppRegistration[] {
  return registry.registrations.filter(
    (registration) =>
      registration.uri === imported.uri &&
      registration.qmlName === qmlName &&
      kinds.has(registration.kind)
  );
}

function pickBridgeRegistration(
  candidates: QmlCppRegistration[],
  importVersion: string | undefined
): QmlCppRegistration | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  if (!importVersion) return [...candidates].sort(compareBridgeRegistrationsDesc)[0] ?? null;
  return (
    candidates
      .filter((candidate) => isCompatibleVersion(candidate.version, importVersion))
      .sort(compareBridgeRegistrationsDesc)[0] ?? null
  );
}

function importedBridgeRegistration(
  context: ResolutionContext,
  registry: QmlCppBridgeRegistry,
  filePath: string,
  qmlName: string,
  kinds: ReadonlySet<QmlCppRegistrationKind>,
  alias?: string
): QmlCppRegistration | null {
  for (const imported of parseQmlImports(context, filePath)) {
    if (alias && imported.alias !== alias) continue;
    if (!alias && imported.alias) continue;

    const registration = pickBridgeRegistration(
      bridgeRegistrationCandidates(registry, imported, qmlName, kinds),
      imported.version
    );
    if (registration) return registration;
  }
  return null;
}

function findCppMethodNode(
  context: ResolutionContext,
  className: string,
  methodName: string
): Node | null {
  const simpleName = simpleCppTypeName(className);
  return (
    context
      .getNodesByName(methodName)
      .find(
        (node) =>
          node.language === 'cpp' &&
          node.kind === 'method' &&
          (node.qualifiedName === `${simpleName}::${methodName}` ||
            node.qualifiedName.endsWith(`::${simpleName}::${methodName}`))
      ) ?? null
  );
}

function isQmlVisibleMethod(
  classFacts: QmlCppClassFacts | undefined,
  methodName: string
): boolean {
  const method = classFacts?.methods.get(methodName);
  if (!classFacts || !method) return false;
  return method.invokable || (method.publicSlot && classFacts.hasQmlExposureEvidence);
}

function resolveQmlCppMethod(
  ref: UnresolvedRef,
  context: ResolutionContext,
  classFacts: QmlCppClassFacts | undefined,
  cppType: string,
  methodName: string
): ResolvedRef | null {
  if (!isQmlVisibleMethod(classFacts, methodName)) return null;
  const target = findCppMethodNode(context, cppType, methodName);
  if (!target) return null;
  return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
}

function resolveQmlCppBridgeCall(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.language !== 'qml' || ref.referenceKind !== 'calls') return null;
  const parts = ref.referenceName.split('.');
  if (parts.length < 2) return null;

  const registry = getQmlCppBridgeRegistry(context);
  const methodName = parts[parts.length - 1]!;
  if (parts.length === 2) {
    const receiver = parts[0]!;
    const contextProperty = registry.contextProperties.get(receiver);
    if (contextProperty) {
      const classFacts = registry.classes.get(simpleCppTypeName(contextProperty.cppType));
      return resolveQmlCppMethod(ref, context, classFacts, contextProperty.cppType, methodName);
    }

    const registration = importedBridgeRegistration(
      context,
      registry,
      ref.filePath,
      receiver,
      new Set<QmlCppRegistrationKind>(['singleton'])
    );
    if (registration) {
      const classFacts = registry.classes.get(simpleCppTypeName(registration.cppType));
      return resolveQmlCppMethod(ref, context, classFacts, registration.cppType, methodName);
    }
    return null;
  }

  if (parts.length === 3) {
    const alias = parts[0]!;
    const qmlName = parts[1]!;
    const registration = importedBridgeRegistration(
      context,
      registry,
      ref.filePath,
      qmlName,
      new Set<QmlCppRegistrationKind>(['singleton']),
      alias
    );
    if (!registration) return null;
    const classFacts = registry.classes.get(simpleCppTypeName(registration.cppType));
    return resolveQmlCppMethod(ref, context, classFacts, registration.cppType, methodName);
  }

  return null;
}

function resolveQmlCppPropertyRead(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.language !== 'qml' || ref.referenceKind !== 'references') return null;
  const parts = ref.referenceName.split('.');
  if (parts.length !== 2) return null;

  const registry = getQmlCppBridgeRegistry(context);
  const contextProperty = registry.contextProperties.get(parts[0]!);
  if (!contextProperty) return null;

  const classFacts = registry.classes.get(simpleCppTypeName(contextProperty.cppType));
  const property = classFacts?.properties.get(parts[1]!);
  if (!property?.read) return null;

  const target = findCppMethodNode(context, contextProperty.cppType, property.read);
  if (!target) return null;
  return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'framework' };
}

function resolveQmlCppRegisteredComponent(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.language !== 'qml' || ref.referenceKind !== 'references') return null;

  const componentName = componentTypeName(ref.referenceName);
  if (!componentName) return null;

  const parts = ref.referenceName.split('.');
  const alias = parts.length > 1 ? parts[0] : undefined;
  const registry = getQmlCppBridgeRegistry(context);
  const registration = importedBridgeRegistration(
    context,
    registry,
    ref.filePath,
    componentName,
    new Set<QmlCppRegistrationKind>(['type']),
    alias
  );
  if (!registration?.classNodeId) return null;
  return {
    original: ref,
    targetNodeId: registration.classNodeId,
    confidence: 0.95,
    resolvedBy: 'framework',
  };
}

function resolveQmlModuleComponent(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.language !== 'qml' || ref.referenceKind !== 'references') return null;

  const componentName = componentTypeName(ref.referenceName);
  if (!componentName) return null;

  const parts = ref.referenceName.split('.');
  const alias = parts.length > 1 ? parts[0] : undefined;
  const imports = parseQmlImports(context, ref.filePath);

  for (const imported of imports) {
    if (alias && imported.alias !== alias) continue;
    if (!alias && imported.alias) continue;

    for (const effectiveImport of effectiveQmlImports(context, imported)) {
      const component = pickImportedComponent(
        importedComponentCandidates(context, effectiveImport, componentName),
        effectiveImport.version
      );
      if (!component) continue;

      const target = findQmlComponentNode(context, component);
      if (!target) continue;

      return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'import' };
    }
  }

  return null;
}

export const qmlQtResolver: FrameworkResolver = {
  name: 'qml-qt',
  languages: ['qml', 'yaml'],
  detect(context: ResolutionContext): boolean {
    return hasQmlFiles(context);
  },
  claimsReference(name: string, ref?: UnresolvedRef): boolean {
    if (ref && ref.language !== 'qml') return false;
    return (
      /\.qml$/i.test(name) ||
      /^[A-Za-z_][A-Za-z0-9_]*\.[A-Z][A-Za-z0-9_]*$/.test(name) ||
      /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(name) ||
      /^[A-Z][A-Za-z0-9_]*$/.test(name)
    );
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    return (
      resolveLiteralQmlUrl(ref, context) ??
      resolveQmlCppBridgeCall(ref, context) ??
      resolveQmlCppPropertyRead(ref, context) ??
      resolveQmlCppRegisteredComponent(ref, context) ??
      resolveQmlModuleComponent(ref, context)
    );
  },
  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    if (!isQmlDirFile(filePath)) return { nodes: [], references: [] };

    const parsed = parseQmlDir(filePath, content);
    if (!parsed) return { nodes: [], references: [] };

    const node: Node = {
      id: `module:qml:${filePath}:${parsed.uri}`,
      kind: 'module',
      name: parsed.uri,
      qualifiedName: parsed.uri,
      filePath,
      language: 'yaml',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      signature: `module ${parsed.uri}`,
      updatedAt: Date.now(),
    };
    const importNodes = parsed.imports.map((dependency, index): Node => ({
      id: `import:qml:${filePath}:${parsed.uri}:${dependency.uri}:${index}`,
      kind: 'import',
      name: dependency.uri,
      qualifiedName: `${parsed.uri}.import:${dependency.uri}`,
      filePath,
      language: 'yaml',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      signature: `import ${dependency.uri}${dependency.version ? ` ${dependency.version}` : ''}`,
      updatedAt: Date.now(),
    }));
    return { nodes: [node, ...importNodes], references: [] };
  },
};
