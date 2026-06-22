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

const moduleCache = new WeakMap<ResolutionContext, QmlDirModuleCacheEntry>();
const importCache = new WeakMap<ResolutionContext, Map<string, QmlModuleImportCacheEntry>>();

function hasQmlFiles(context: ResolutionContext): boolean {
  return context.getAllFiles().some((filePath) => isQmlFile(filePath));
}

function dirname(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(0, slash) : '';
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
    const targetPath = path.posix.normalize(dir ? `${dir}/${qmlFile}` : qmlFile);
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
  return (
    context
      .getNodesInFile(component.filePath)
      .find(
        (node) =>
          node.language === 'qml' &&
          node.kind === 'component' &&
          node.filePath.replace(/\\/g, '/') === component.filePath &&
          node.qualifiedName === node.name
      ) ?? null
  );
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
  claimsReference(name: string): boolean {
    return (
      /^[A-Za-z_][A-Za-z0-9_]*\.[A-Z][A-Za-z0-9_]*$/.test(name) ||
      /^[A-Z][A-Za-z0-9_]*$/.test(name)
    );
  },
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    return resolveQmlModuleComponent(ref, context);
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
