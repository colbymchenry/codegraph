import * as path from 'path';
import type { Node } from '../../../types';
import { isQmlDirFile, isQmlFile } from '../../../extraction/grammars';
import type { FrameworkExtractionResult, ResolutionContext, ResolvedRef, UnresolvedRef } from '../../types';
import {
  getQtCppMetaRegistry,
  getQtCppSources,
  findUniqueQtCppMethodFact,
  parseQtMethodParameterTypes,
  simpleCppTypeName,
  type QtCppMetaRegistry,
  type QtCppMethodFact,
  type QtCppClassFacts,
} from './cpp-meta';

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

type QmlCppRegistrationKind = 'type' | 'singleton' | 'uncreatable' | 'anonymous';

interface QmlCppRegistration {
  kind: QmlCppRegistrationKind;
  cppType: string;
  uri: string;
  version?: string;
  qmlName: string;
  classNodeId?: string;
}

interface QmlCppContextProperty {
  name: string;
  cppType: string;
  classNodeId?: string;
}

interface QmlCppBridgeRegistry {
  classes: Map<string, QtCppClassFacts>;
  classesByQualifiedName: Map<string, QtCppClassFacts>;
  classesBySimpleName: Map<string, QtCppClassFacts[]>;
  registrations: QmlCppRegistration[];
  contextProperties: Map<string, QmlCppContextProperty>;
}

interface QmlCppBridgeRegistryCacheEntry {
  key: string;
  registry: QmlCppBridgeRegistry;
}

interface QmlCppBridgeNameIndex {
  contextProperties: Set<string>;
  creatableTypes: Set<string>;
  singletonTypes: Set<string>;
  uncreatableTypes: Set<string>;
}

interface QmlCppBridgeNameIndexCacheEntry {
  key: string;
  index: QmlCppBridgeNameIndex;
}

interface QmlCppMethodNodeIndex {
  byId: Map<string, Node>;
  byName: Map<string, Node[]>;
}

interface QmlCppMethodNodeIndexCacheEntry {
  key: string;
  index: QmlCppMethodNodeIndex;
}

interface QmlShadowScopeCacheEntry {
  source: string | null;
  ranges: QmlObjectRange[];
  shadowNodesByName: Map<string, Node[]>;
}

const moduleCache = new WeakMap<ResolutionContext, QmlDirModuleCacheEntry>();
const importCache = new WeakMap<ResolutionContext, Map<string, QmlModuleImportCacheEntry>>();
const bridgeNameIndexCache = new WeakMap<ResolutionContext, QmlCppBridgeNameIndexCacheEntry>();
const bridgeRegistryCache = new WeakMap<ResolutionContext, QmlCppBridgeRegistryCacheEntry>();
const cppMethodNodeIndexCache = new WeakMap<ResolutionContext, QmlCppMethodNodeIndexCacheEntry>();
const qmlShadowScopeCache = new WeakMap<ResolutionContext, Map<string, QmlShadowScopeCacheEntry>>();
const QML_CPP_STRING_DECLARATION_RE =
  /\b(?:const\s+)?(?:(?:char\s*(?:const\s*)?\*)|QString|QByteArray|std::string)\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(['"])([^'"]+)\2/g;
const QML_CPP_SET_PROPERTY_RE =
  /\b[A-Za-z_][A-Za-z0-9_]*\s*(?:->|\.)setProperty\s*\(\s*([^,]+)\s*,\s*([\s\S]*?)\s*\)\s*;/g;

function hasQmlFiles(context: ResolutionContext): boolean {
  return context.getAllFiles().some((filePath) => isQmlFile(filePath));
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

function matchingParenOffset(source: string, openParenOffset: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = openParenOffset; index < source.length; index++) {
    const char = source[index];
    const previous = source[index - 1];
    if (quote) {
      if (char === quote && previous !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
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
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const previous = source[index - 1];
    if (quote) {
      if (char === quote && previous !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
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

function getOrCreateQmlCppClassFacts(
  registry: QmlCppBridgeRegistry,
  className: string
): QtCppClassFacts {
  let facts = findQmlCppClassFacts(registry, className);
  if (facts) {
    facts = {
      ...facts,
      methodsByName: new Map(
        [...facts.methodsByName.entries()].map(([name, methods]) => [name, [...methods]])
      ),
      properties: new Map(facts.properties),
      signals: new Set(facts.signals),
      baseClassNames: [...facts.baseClassNames],
    };
  } else {
    facts = {
      name: simpleCppTypeName(className),
      qualifiedName: className,
      baseClassNames: [],
      methodsByName: new Map(),
      properties: new Map(),
      signals: new Set(),
      hasQmlExposureEvidence: false,
      hasWidgetsEvidence: false,
    };
  }
  upsertQmlCppClassFacts(registry, facts);
  return facts;
}

function cloneQtCppClassFacts(facts: QtCppClassFacts): QtCppClassFacts {
  return {
    ...facts,
    baseClassNames: [...facts.baseClassNames],
    methodsByName: new Map(
      [...facts.methodsByName.entries()].map(([name, methods]) => [name, [...methods]])
    ),
    properties: new Map(facts.properties),
    signals: new Set(facts.signals),
  };
}

function upsertQmlCppClassFacts(
  registry: QmlCppBridgeRegistry,
  facts: QtCppClassFacts
): void {
  const qualifiedName = facts.qualifiedName ?? facts.name;
  registry.classesByQualifiedName.set(qualifiedName, facts);

  const simpleEntries = registry.classesBySimpleName.get(facts.name) ?? [];
  const existingIndex = simpleEntries.findIndex(
    (entry) => (entry.qualifiedName ?? entry.name) === qualifiedName
  );
  if (existingIndex >= 0) simpleEntries[existingIndex] = facts;
  else simpleEntries.push(facts);
  registry.classesBySimpleName.set(facts.name, simpleEntries);

  registry.classes.set(qualifiedName, facts);
  if (simpleEntries.length === 1) registry.classes.set(facts.name, facts);
  else registry.classes.delete(facts.name);
}

function findQmlCppClassFacts(
  registry: QmlCppBridgeRegistry,
  className: string
): QtCppClassFacts | undefined {
  const qualified = registry.classesByQualifiedName.get(className);
  if (qualified) return qualified;

  const suffixMatches = [...registry.classesByQualifiedName.entries()]
    .filter(([qualifiedName]) => className.endsWith(`::${qualifiedName}`))
    .map(([, facts]) => facts);
  if (suffixMatches.length === 1) return suffixMatches[0];

  const simpleName = simpleCppTypeName(className);
  const simpleMatches = registry.classesBySimpleName.get(simpleName) ?? [];
  return simpleMatches.length === 1 ? simpleMatches[0] : undefined;
}

function cloneQtCppMetaRegistry(meta: QtCppMetaRegistry): {
  classes: Map<string, QtCppClassFacts>;
  classesByQualifiedName: Map<string, QtCppClassFacts>;
  classesBySimpleName: Map<string, QtCppClassFacts[]>;
} {
  const clonesByQualifiedName = new Map<string, QtCppClassFacts>();
  for (const [qualifiedName, facts] of meta.classesByQualifiedName) {
    clonesByQualifiedName.set(qualifiedName, cloneQtCppClassFacts(facts));
  }

  const clonedClasses = new Map<string, QtCppClassFacts>();
  for (const [key, facts] of meta.classes) {
    const qualifiedName = facts.qualifiedName ?? facts.name;
    const clone = clonesByQualifiedName.get(qualifiedName) ?? cloneQtCppClassFacts(facts);
    clonedClasses.set(key, clone);
    clonesByQualifiedName.set(qualifiedName, clone);
  }

  const clonedBySimpleName = new Map<string, QtCppClassFacts[]>();
  for (const [simpleName, factsList] of meta.classesBySimpleName) {
    clonedBySimpleName.set(
      simpleName,
      factsList.map((facts) => {
        const qualifiedName = facts.qualifiedName ?? facts.name;
        const clone = clonesByQualifiedName.get(qualifiedName) ?? cloneQtCppClassFacts(facts);
        clonesByQualifiedName.set(qualifiedName, clone);
        return clone;
      })
    );
  }

  return {
    classes: clonedClasses,
    classesByQualifiedName: clonesByQualifiedName,
    classesBySimpleName: clonedBySimpleName,
  };
}

function parseQmlCppRegistrations(registry: QmlCppBridgeRegistry, source: string): void {
  const registrationPattern =
    /\b(qmlRegisterType|qmlRegisterSingletonType|qmlRegisterSingletonInstance|qmlRegisterUncreatableType)\s*<\s*([A-Za-z_][A-Za-z0-9_:]*)\s*>\s*\(\s*(['"])([^'"]+)\3\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])([^'"]+)\7/g;
  for (const match of source.matchAll(registrationPattern)) {
    const api = match[1];
    const cppType = match[2];
    const uri = match[4];
    const major = match[5];
    const minor = match[6];
    const qmlName = match[8];
    if (!api || !cppType || !uri || !major || !minor || !qmlName) continue;

    const kind: QmlCppRegistrationKind =
      api === 'qmlRegisterSingletonType' || api === 'qmlRegisterSingletonInstance'
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
    getOrCreateQmlCppClassFacts(registry, cppType).hasQmlExposureEvidence = true;
  }

  const anonymousPattern =
    /\bqmlRegisterAnonymousType\s*<\s*([A-Za-z_][A-Za-z0-9_:]*)\s*>\s*\(\s*(['"])([^'"]+)\2\s*,\s*(\d+)\s*\)/g;
  for (const match of source.matchAll(anonymousPattern)) {
    const cppType = match[1];
    const uri = match[3];
    const major = match[4];
    if (!cppType || !uri || !major) continue;
    registry.registrations.push({
      kind: 'anonymous',
      cppType,
      uri,
      version: `${major}.0`,
      qmlName: simpleCppTypeName(cppType),
    });
    getOrCreateQmlCppClassFacts(registry, cppType).hasQmlExposureEvidence = true;
  }
}

function hasDynamicContextPropertyForwarding(source: string): boolean {
  return /\bdynamicPropertyNames\s*\(\s*\)/.test(source) &&
    /\bsetContextProperty\s*\([\s\S]*?\bproperty\s*\(/.test(source);
}

function parseQmlCppContextProperties(
  registry: QmlCppBridgeRegistry,
  source: string,
  exposeDynamicProperties: boolean
): void {
  const localTypes = new Map<string, string>();
  const stringValues = new Map<string, string>();
  const dynamicProperties = new Map<string, string>();
  const typedDeclarationPattern =
    /\b([A-Za-z_][A-Za-z0-9_:]*)\s*(?:[*&]\s*)+([A-Za-z_][A-Za-z0-9_]*)\s*(?:[;=({])/g;
  const valueDeclarationPattern =
    /\b([A-Za-z_][A-Za-z0-9_:]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:[;=({])/g;
  const autoNewPattern =
    /\bauto\s*(?:[*&]\s*)+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*new\s+([A-Za-z_][A-Za-z0-9_:]*)\b/g;
  const assignmentNewPattern =
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*new\s+([A-Za-z_][A-Za-z0-9_:]*)\b/g;
  const smartPointerPattern =
    /\b(?:std::unique_ptr|std::shared_ptr|QScopedPointer|QSharedPointer)\s*<\s*([A-Za-z_][A-Za-z0-9_:]*)\s*>\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  const methodOwners = new Map<string, string>();
  for (const match of source.matchAll(/\b([A-Za-z_][A-Za-z0-9_:]*)\s*::\s*([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*(?:const\s*)?\{/g)) {
    const owner = match[1];
    if (!owner) continue;
    const openBrace = source.indexOf('{', match.index);
    const closeBrace = openBrace >= 0 ? matchingBraceOffset(source, openBrace) : -1;
    if (openBrace >= 0 && closeBrace >= 0) {
      methodOwners.set(`${openBrace}:${closeBrace}`, owner);
    }
  }
  const addLocalType = (typeName: string | undefined, variableName: string | undefined): void => {
    if (!typeName || !variableName) return;
    if (['return', 'new', 'class', 'struct', 'public', 'private', 'protected', 'auto'].includes(typeName)) {
      return;
    }
    localTypes.set(variableName, typeName);
  };

  for (const match of source.matchAll(typedDeclarationPattern)) {
    const typeName = match[1];
    const variableName = match[2];
    addLocalType(typeName, variableName);
  }
  for (const match of source.matchAll(valueDeclarationPattern)) {
    const typeName = match[1];
    const variableName = match[2];
    addLocalType(typeName, variableName);
  }
  for (const match of source.matchAll(autoNewPattern)) {
    const variableName = match[1];
    const typeName = match[2];
    addLocalType(typeName, variableName);
  }
  for (const match of source.matchAll(assignmentNewPattern)) {
    const variableName = match[1];
    const typeName = match[2];
    addLocalType(typeName, variableName);
  }
  for (const match of source.matchAll(smartPointerPattern)) {
    const typeName = match[1];
    const variableName = match[2];
    addLocalType(typeName, variableName);
  }
  for (const match of source.matchAll(QML_CPP_STRING_DECLARATION_RE)) {
    const variableName = match[1];
    const value = match[3];
    if (variableName && value) stringValues.set(variableName, value);
  }
  const literalOrStringValue = (expression: string | undefined): string | null => {
    const trimmed = expression?.trim();
    if (!trimmed) return null;
    const literal = /^(['"])([^'"]+)\1$/.exec(trimmed)?.[2];
    if (literal) return literal;
    return stringValues.get(trimmed) ?? null;
  };
  const typeForExpression = (expression: string): string | undefined => {
    const trimmed = expression.trim();
    const newType = /\bnew\s+([A-Za-z_][A-Za-z0-9_:]*)\b/.exec(trimmed)?.[1];
    if (newType) return newType;

    const staticCastVariable = /static_cast\s*<\s*QObject\s*\*\s*>\s*\(\s*&?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/.exec(trimmed)?.[1];
    if (staticCastVariable) return localTypes.get(staticCastVariable);

    const fromValueArgument = /QVariant\s*::\s*fromValue\s*\(\s*([\s\S]*?)\s*\)\s*$/.exec(trimmed)?.[1];
    if (fromValueArgument) return typeForExpression(fromValueArgument);

    return localTypes.get(trimmed.replace(/^&/, '').replace(/\.(?:get|data)\s*\(\s*\)$/, ''));
  };
  for (const match of source.matchAll(QML_CPP_SET_PROPERTY_RE)) {
    const propertyName = literalOrStringValue(match[1]);
    const valueExpression = match[2]?.trim();
    if (!propertyName || !valueExpression) continue;
    const cppType = typeForExpression(valueExpression);
    if (cppType) dynamicProperties.set(propertyName, cppType);
  }
  if (exposeDynamicProperties) {
    for (const [name, cppType] of dynamicProperties) {
      registry.contextProperties.set(name, { name, cppType });
      getOrCreateQmlCppClassFacts(registry, cppType).hasQmlExposureEvidence = true;
    }
  }
  const propertyExpressionName = (expression: string): string | null => {
    const match = /\bproperty\s*\(\s*([^)]+)\)/.exec(expression);
    return match ? literalOrStringValue(match[1]) : null;
  };

  const contextPropertyPattern =
    /(?:[A-Za-z_][A-Za-z0-9_]*(?:\.|->)rootContext\(\)\s*(?:\.|->)|[A-Za-z_][A-Za-z0-9_]*\s*(?:\.|->))setContextProperty\s*\(/g;
  for (const match of source.matchAll(contextPropertyPattern)) {
    const openParen = (match.index ?? 0) + match[0].length - 1;
    const closeParen = openParen >= 0 ? matchingParenOffset(source, openParen) : -1;
    if (openParen < 0 || closeParen < 0) continue;
    const args = splitTopLevelArguments(source.slice(openParen + 1, closeParen));
    const name = literalOrStringValue(args[0]);
    const expression = args[1]?.trim();
    if (!name || !expression) continue;
    const cppType =
      expression === 'this'
        ? [...methodOwners.entries()]
            .find(([range]) => {
              const [start, end] = range.split(':').map(Number);
              return Number.isFinite(start) && Number.isFinite(end) && (match.index ?? -1) >= start! && (match.index ?? -1) <= end!;
            })?.[1]
        : dynamicProperties.get(propertyExpressionName(expression) ?? '') ??
          typeForExpression(expression);
    if (!cppType) continue;
    registry.contextProperties.set(name, { name, cppType });
    getOrCreateQmlCppClassFacts(registry, cppType).hasQmlExposureEvidence = true;
  }
}

function getQmlCppBridgeNameIndex(context: ResolutionContext): QmlCppBridgeNameIndex {
  const sourceEntry = getQtCppSources(context);
  const cached = bridgeNameIndexCache.get(context);
  if (cached?.key === sourceEntry.key) return cached.index;

  const index: QmlCppBridgeNameIndex = {
    contextProperties: new Set(),
    creatableTypes: new Set(),
    singletonTypes: new Set(),
    uncreatableTypes: new Set(),
  };
  const registrationPattern =
    /\b(qmlRegisterType|qmlRegisterSingletonType|qmlRegisterSingletonInstance|qmlRegisterUncreatableType)\s*<\s*[A-Za-z_][A-Za-z0-9_:]*\s*>\s*\(\s*(['"])([^'"]+)\2\s*,\s*\d+\s*,\s*\d+\s*,\s*(['"])([^'"]+)\4/g;
  const anonymousRegistrationPattern =
    /\bqmlRegisterAnonymousType\s*<\s*([A-Za-z_][A-Za-z0-9_:]*)\s*>\s*\(\s*(['"])([^'"]+)\2\s*,\s*\d+\s*\)/g;
  for (const [, source] of sourceEntry.sources) {
    if (!source) continue;
    for (const match of source.matchAll(registrationPattern)) {
      const api = match[1];
      const qmlName = match[5];
      if (!api || !qmlName) continue;
      if (api === 'qmlRegisterSingletonType' || api === 'qmlRegisterSingletonInstance') index.singletonTypes.add(qmlName);
      else if (api === 'qmlRegisterUncreatableType') index.uncreatableTypes.add(qmlName);
      else index.creatableTypes.add(qmlName);
    }
    for (const match of source.matchAll(anonymousRegistrationPattern)) {
      if (match[1]) index.uncreatableTypes.add(simpleCppTypeName(match[1]));
    }
  }

  const registry = getQmlCppBridgeRegistry(context);
  for (const contextProperty of registry.contextProperties.values()) {
    index.contextProperties.add(contextProperty.name);
  }

  bridgeNameIndexCache.set(context, { key: sourceEntry.key, index });
  return index;
}

function attachQmlCppBridgeNodes(registry: QmlCppBridgeRegistry): void {
  for (const registration of registry.registrations) {
    const facts = findQmlCppClassFacts(registry, registration.cppType);
    registration.classNodeId = facts?.classNodeId;
  }
  for (const contextProperty of registry.contextProperties.values()) {
    const facts = findQmlCppClassFacts(registry, contextProperty.cppType);
    contextProperty.classNodeId = facts?.classNodeId;
  }
}

function getQmlCppBridgeRegistry(context: ResolutionContext): QmlCppBridgeRegistry {
  const { key, sources } = getQtCppSources(context);
  const cached = bridgeRegistryCache.get(context);
  if (cached?.key === key) return cached.registry;

  const meta = getQtCppMetaRegistry(context);
  const classes = cloneQtCppMetaRegistry(meta);
  const registry: QmlCppBridgeRegistry = {
    classes: classes.classes,
    classesByQualifiedName: classes.classesByQualifiedName,
    classesBySimpleName: classes.classesBySimpleName,
    registrations: [],
    contextProperties: new Map(),
  };
  const exposeDynamicProperties = sources.some(([, source]) =>
    source ? hasDynamicContextPropertyForwarding(source) : false
  );
  for (const [, source] of sources) {
    if (!source) continue;
    parseQmlCppRegistrations(registry, source);
    parseQmlCppContextProperties(registry, source, exposeDynamicProperties);
  }
  attachQmlCppBridgeNodes(registry);
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

function qmlVisibleMethodFact(
  classFacts: QtCppClassFacts | undefined,
  methodName: string
): QtCppMethodFact | undefined {
  if (!classFacts) return undefined;
  const visibleMethods = (classFacts.methodsByName.get(methodName) ?? []).filter(
    (method) => method.invokable || (method.publicSlot && classFacts.hasQmlExposureEvidence)
  );
  return visibleMethods.length === 1 ? visibleMethods[0] : undefined;
}

function uniqueQtCppSignalFact(
  classFacts: QtCppClassFacts | undefined,
  signalName: string
): QtCppMethodFact | undefined {
  const signalMethods = (classFacts?.methodsByName.get(signalName) ?? []).filter(
    (method) => method.signal
  );
  return signalMethods.length === 1 ? signalMethods[0] : undefined;
}

function getQmlCppMethodNodeIndex(context: ResolutionContext): QmlCppMethodNodeIndex {
  const sourceEntry = getQtCppSources(context);
  const cached = cppMethodNodeIndexCache.get(context);
  if (cached?.key === sourceEntry.key) return cached.index;

  const byId = new Map<string, Node>();
  const byName = new Map<string, Node[]>();
  for (const node of context.getNodesByKind('method')) {
    if (node.language !== 'cpp') continue;
    byId.set(node.id, node);
    const nodes = byName.get(node.name) ?? [];
    nodes.push(node);
    byName.set(node.name, nodes);
  }

  const index = { byId, byName };
  cppMethodNodeIndexCache.set(context, { key: sourceEntry.key, index });
  return index;
}

function findCppMethodNodeByFact(
  context: ResolutionContext,
  classFacts: QtCppClassFacts | undefined,
  method: QtCppMethodFact
): Node | null {
  const nodeIndex = getQmlCppMethodNodeIndex(context);
  if (method.nodeId) {
    return nodeIndex.byId.get(method.nodeId) ?? null;
  }

  const qualifiedName = method.qualifiedName;
  if (!qualifiedName) return null;
  const namedNodes = nodeIndex.byName.get(method.name) ?? [];
  const sourceMatches = namedNodes.filter(
    (node) =>
      node.qualifiedName === qualifiedName || node.qualifiedName.endsWith(`::${qualifiedName}`)
  );

  if (sourceMatches.length === 1) return sourceMatches[0]!;

  if (sourceMatches.length === 0 && classFacts?.name) {
    const simpleOwnerMatches = namedNodes.filter((node) =>
      node.qualifiedName.endsWith(`${classFacts.name}::${method.name}`)
    );
    if (simpleOwnerMatches.length === 1) return simpleOwnerMatches[0]!;
    return null;
  }

  const signatureMatches = sourceMatches.filter((node) => {
    const source = context.readFile(node.filePath);
    const nodeSource = source
      ?.split('\n')
      .slice(node.startLine - 1, node.endLine ?? node.startLine)
      .join('\n');
    const parameterTypes = nodeSource
      ? parseQtMethodParameterTypes(nodeSource) ?? parseMethodParameterTypesFromSnippet(nodeSource, method.name)
      : null;
    return parameterTypes ? sameParameterTypes(parameterTypes, method.parameterTypes) : false;
  });
  if (signatureMatches.length === 1) return signatureMatches[0]!;

  if (classFacts?.classNodeId) {
    const classNode =
      context.getNodeById?.(classFacts.classNodeId) ??
      context.getNodesByName(classFacts.name).find((node) => node.id === classFacts.classNodeId);
    const ownerScopedMatches = classNode
      ? sourceMatches.filter((node) => node.filePath === classNode.filePath)
      : [];
    if (ownerScopedMatches.length === 1) return ownerScopedMatches[0]!;
  }

  return null;
}

function sameParameterTypes(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((typeName, index) => typeName === right[index]);
}

function parseMethodParameterTypesFromSnippet(source: string, methodName: string): string[] | null {
  const escapedName = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|::|\\b)${escapedName}\\s*\\(([^)]*)\\)`).exec(source);
  if (!match) return null;
  return parseQtMethodParameterTypes(`${methodName}(${match[1] ?? ''})`);
}

function resolveQmlCppMethod(
  ref: UnresolvedRef,
  context: ResolutionContext,
  classFacts: QtCppClassFacts | undefined,
  cppType: string,
  methodName: string
): ResolvedRef | null {
  void context;
  void cppType;
  const method = qmlVisibleMethodFact(classFacts, methodName);
  if (!method) return null;
  const target = findCppMethodNodeByFact(context, classFacts, method);
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

  const methodName = parts[parts.length - 1]!;
  const registry = getQmlCppBridgeRegistry(context);
  const resolveContextPropertyMethod = (receiver: string, respectQmlShadowing: boolean): ResolvedRef | null => {
    if (respectQmlShadowing && isShadowedQmlContextProperty(context, ref, receiver)) return null;
    if (!getQmlCppBridgeNameIndex(context).contextProperties.has(receiver)) return null;
    const contextProperty = registry.contextProperties.get(receiver);
    if (!contextProperty) return null;
    const classFacts = findQmlCppClassFacts(registry, contextProperty.cppType);
    return resolveQmlCppMethod(ref, context, classFacts, contextProperty.cppType, methodName);
  };

  if (parts.length === 2) {
    const receiver = parts[0]!;
    const bridgeNames = getQmlCppBridgeNameIndex(context);
    if (!bridgeNames.contextProperties.has(receiver) && !bridgeNames.singletonTypes.has(receiver)) {
      return null;
    }

    const contextPropertyResult = resolveContextPropertyMethod(receiver, true);
    if (contextPropertyResult) return contextPropertyResult;

    const registration = importedBridgeRegistration(
      context,
      registry,
      ref.filePath,
      receiver,
      new Set<QmlCppRegistrationKind>(['singleton'])
    );
    if (registration) {
      const classFacts = findQmlCppClassFacts(registry, registration.cppType);
      return resolveQmlCppMethod(ref, context, classFacts, registration.cppType, methodName);
    }
    return null;
  }

  const nestedContextPropertyReceiver = parts[parts.length - 2]!;
  const nestedContextPropertyResult = resolveContextPropertyMethod(nestedContextPropertyReceiver, false);
  if (nestedContextPropertyResult) return nestedContextPropertyResult;

  if (parts.length === 3) {
    const alias = parts[0]!;
    const qmlName = parts[1]!;
    if (!getQmlCppBridgeNameIndex(context).singletonTypes.has(qmlName)) return null;

    const registry = getQmlCppBridgeRegistry(context);
    const registration = importedBridgeRegistration(
      context,
      registry,
      ref.filePath,
      qmlName,
      new Set<QmlCppRegistrationKind>(['singleton']),
      alias
    );
    if (!registration) return null;
    const classFacts = findQmlCppClassFacts(registry, registration.cppType);
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
  if (isShadowedQmlContextProperty(context, ref, parts[0]!)) return null;
  if (!getQmlCppBridgeNameIndex(context).contextProperties.has(parts[0]!)) return null;

  const registry = getQmlCppBridgeRegistry(context);
  const contextProperty = registry.contextProperties.get(parts[0]!);
  if (!contextProperty) return null;

  const classFacts = findQmlCppClassFacts(registry, contextProperty.cppType);
  const property = classFacts?.properties.get(parts[1]!);
  if (!property?.read) return null;

  const method = findUniqueQtCppMethodFact(classFacts, {
    name: property.read,
    parameterTypes: [],
  });
  if (!method) return null;
  const target = findCppMethodNodeByFact(context, classFacts, method);
  if (!target) return null;
  return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'framework' };
}

function findRefSourceNode(ref: UnresolvedRef, context: ResolutionContext): Node | undefined {
  return context.getNodesInFile(ref.filePath).find((node) => node.id === ref.fromNodeId);
}

function isConnectionsComponentNode(node: Node | undefined): boolean {
  return node?.language === 'qml' && node.kind === 'component' && node.signature === 'Connections';
}

function isShadowingQmlNode(node: Node, name: string): boolean {
  return (
    node.language === 'qml' &&
    node.name === name &&
    (node.kind === 'variable' ||
      node.kind === 'property' ||
      node.kind === 'function' ||
      node.kind === 'method' ||
      node.kind === 'component' ||
      node.kind === 'enum')
  );
}

interface QmlObjectRange {
  openBrace: number;
  closeBrace: number;
}

function qmlObjectRanges(source: string): QmlObjectRange[] {
  const ranges: QmlObjectRange[] = [];
  const objectPattern = /(^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_.]*)\s*\{/g;
  for (const match of source.matchAll(objectPattern)) {
    const openBrace = source.indexOf('{', match.index);
    if (openBrace < 0) continue;
    const closeBrace = matchingBraceOffset(source, openBrace);
    if (closeBrace < 0) continue;
    ranges.push({ openBrace, closeBrace });
  }
  return ranges;
}

function innermostQmlObjectRange(
  ranges: QmlObjectRange[],
  offset: number
): QmlObjectRange | null {
  return (
    ranges
      .filter((range) => range.openBrace <= offset && offset <= range.closeBrace)
      .sort(
        (left, right) =>
          left.closeBrace - left.openBrace - (right.closeBrace - right.openBrace)
      )[0] ?? null
  );
}

function getQmlShadowScopeCache(
  context: ResolutionContext,
  filePath: string,
  source: string | null
): QmlShadowScopeCacheEntry {
  let perContext = qmlShadowScopeCache.get(context);
  if (!perContext) {
    perContext = new Map();
    qmlShadowScopeCache.set(context, perContext);
  }

  const cached = perContext.get(filePath);
  if (cached?.source === source) return cached;

  const shadowNodesByName = new Map<string, Node[]>();
  for (const node of context.getNodesInFile(filePath)) {
    if (!isShadowingQmlNode(node, node.name)) continue;
    const nodes = shadowNodesByName.get(node.name) ?? [];
    nodes.push(node);
    shadowNodesByName.set(node.name, nodes);
  }

  const entry = {
    source,
    ranges: source ? qmlObjectRanges(source) : [],
    shadowNodesByName,
  };
  perContext.set(filePath, entry);
  return entry;
}

function isShadowedQmlContextProperty(
  context: ResolutionContext,
  ref: UnresolvedRef,
  name: string
): boolean {
  const source = context.readFile(ref.filePath);
  if (!source) return false;

  const scopeCache = getQmlShadowScopeCache(context, ref.filePath, source);
  const refOffset = offsetFromLineColumn(source, ref.line, ref.column);
  return (scopeCache.shadowNodesByName.get(name) ?? []).some((node) => {
    const declarationOffset = offsetFromLineColumn(source, node.startLine, node.startColumn);
    const declarationScope = innermostQmlObjectRange(scopeCache.ranges, declarationOffset);
    return (
      declarationScope != null &&
      declarationScope.openBrace <= refOffset &&
      refOffset <= declarationScope.closeBrace
    );
  });
}

function resolveQmlCppContextPropertyRef(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.language !== 'qml' || ref.referenceKind !== 'references') return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.referenceName)) return null;
  if (!isConnectionsComponentNode(findRefSourceNode(ref, context))) return null;
  if (isShadowedQmlContextProperty(context, ref, ref.referenceName)) return null;
  if (!getQmlCppBridgeNameIndex(context).contextProperties.has(ref.referenceName)) return null;

  const registry = getQmlCppBridgeRegistry(context);
  const contextProperty = registry.contextProperties.get(ref.referenceName);
  if (!contextProperty?.classNodeId) return null;
  return {
    original: ref,
    targetNodeId: contextProperty.classNodeId,
    confidence: 0.95,
    resolvedBy: 'framework',
  };
}

function offsetFromLineColumn(source: string, line: number, column: number): number {
  let offset = 0;
  for (let currentLine = 1; currentLine < line; currentLine++) {
    const next = source.indexOf('\n', offset);
    if (next < 0) return source.length;
    offset = next + 1;
  }
  return Math.min(source.length, offset + column);
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

function topLevelQmlIdentifierBinding(
  block: string,
  bindingName: string
): string | null {
  let depth = 0;
  let lineStart = 0;
  for (let index = 0; index <= block.length; index++) {
    const char = block[index];
    if (char === '{') depth++;
    if (char === '}') depth = Math.max(0, depth - 1);

    if (char === '\n' || index === block.length) {
      if (depth === 0) {
        const line = block.slice(lineStart, index);
        const match = new RegExp(
          `^\\s*${bindingName}\\s*:\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*$`
        ).exec(line);
        if (match?.[1]) return match[1];
      }
      lineStart = index + 1;
    }
  }
  return null;
}

function qmlConnectionsTargetForOffset(source: string, offset: number): string | null {
  let nearest: { openBrace: number; closeBrace: number; targetName: string } | null = null;
  for (const match of source.matchAll(/\bConnections\s*\{/g)) {
    const openBrace = source.indexOf('{', match.index);
    if (openBrace < 0) continue;
    const closeBrace = matchingBraceOffset(source, openBrace);
    if (closeBrace < 0 || offset < openBrace || offset > closeBrace) continue;

    const block = source.slice(openBrace + 1, closeBrace);
    const targetName = topLevelQmlIdentifierBinding(block, 'target');
    if (!targetName) continue;
    if (!nearest || openBrace > nearest.openBrace) {
      nearest = { openBrace, closeBrace, targetName };
    }
  }
  return nearest?.targetName ?? null;
}

function qmlSignalNameFromHandler(handlerName: string): string | null {
  const match = /^on([A-Z][A-Za-z0-9_]*)$/.exec(handlerName);
  if (!match?.[1]) return null;
  return `${match[1][0]!.toLowerCase()}${match[1].slice(1)}`;
}

function resolveQmlCppSignalHandler(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.language !== 'qml' || ref.referenceKind !== 'references') return null;

  const signalName = qmlSignalNameFromHandler(ref.referenceName);
  if (!signalName) return null;

  const source = context.readFile(ref.filePath);
  if (!source) return null;
  const targetName = qmlConnectionsTargetForOffset(
    source,
    offsetFromLineColumn(source, ref.line, ref.column)
  );
  if (!targetName) return null;
  if (isShadowedQmlContextProperty(context, ref, targetName)) return null;
  if (!getQmlCppBridgeNameIndex(context).contextProperties.has(targetName)) return null;

  const registry = getQmlCppBridgeRegistry(context);
  const contextProperty = registry.contextProperties.get(targetName);
  if (!contextProperty) return null;

  const classFacts = findQmlCppClassFacts(registry, contextProperty.cppType);
  if (!classFacts?.signals.has(signalName)) return null;

  const method = uniqueQtCppSignalFact(classFacts, signalName);
  if (!method) return null;
  const target = findCppMethodNodeByFact(context, classFacts, method);
  if (!target) return null;
  return { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'framework' };
}

function isExplicitQmlPropertyTypeRef(
  ref: UnresolvedRef,
  context: ResolutionContext,
  typeName: string
): boolean {
  const sourceNode = findRefSourceNode(ref, context);
  return (
    sourceNode?.language === 'qml' &&
    sourceNode.kind === 'property' &&
    new RegExp(`^property\\s+${typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`).test(
      sourceNode.signature ?? ''
    )
  );
}

function resolveQmlCppRegisteredTypeReference(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.language !== 'qml' || ref.referenceKind !== 'references') return null;

  const componentName = componentTypeName(ref.referenceName);
  if (!componentName || !isExplicitQmlPropertyTypeRef(ref, context, ref.referenceName)) {
    return null;
  }
  const bridgeNames = getQmlCppBridgeNameIndex(context);
  if (
    !bridgeNames.creatableTypes.has(componentName) &&
    !bridgeNames.uncreatableTypes.has(componentName)
  ) {
    return null;
  }

  const parts = ref.referenceName.split('.');
  const alias = parts.length > 1 ? parts[0] : undefined;
  const registry = getQmlCppBridgeRegistry(context);
  const registration = importedBridgeRegistration(
    context,
    registry,
    ref.filePath,
    componentName,
    new Set<QmlCppRegistrationKind>(['type', 'uncreatable', 'anonymous']),
    alias
  );
  if (!registration?.classNodeId) return null;
  return {
    original: ref,
    targetNodeId: registration.classNodeId,
    confidence: 0.9,
    resolvedBy: 'framework',
  };
}

function resolveQmlCppRegisteredComponent(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.language !== 'qml' || ref.referenceKind !== 'references') return null;

  const componentName = componentTypeName(ref.referenceName);
  if (!componentName) return null;
  if (!getQmlCppBridgeNameIndex(context).creatableTypes.has(componentName)) return null;

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

export function detectQmlQt(context: ResolutionContext): boolean {
  return hasQmlFiles(context);
}

export function claimsQmlQtReference(name: string, ref?: UnresolvedRef): boolean {
  if (ref && ref.language !== 'qml') return false;
  return (
    /\.qml$/i.test(name) ||
    /^[A-Za-z_][A-Za-z0-9_]*\.[A-Z][A-Za-z0-9_]*$/.test(name) ||
    /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(name) ||
    (ref?.referenceKind === 'references' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
    /^[A-Z][A-Za-z0-9_]*$/.test(name)
  );
}

export function resolveQmlQt(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  return (
    resolveLiteralQmlUrl(ref, context) ??
    resolveQmlCppBridgeCall(ref, context) ??
    resolveQmlCppSignalHandler(ref, context) ??
    resolveQmlCppPropertyRead(ref, context) ??
    resolveQmlCppContextPropertyRef(ref, context) ??
    resolveQmlCppRegisteredTypeReference(ref, context) ??
    resolveQmlCppRegisteredComponent(ref, context) ??
    resolveQmlModuleComponent(ref, context)
  );
}

export function extractQmlQt(filePath: string, content: string): FrameworkExtractionResult {
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
}
