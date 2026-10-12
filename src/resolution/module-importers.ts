/**
 * The references an import statement makes through a module that appears or
 * goes away.
 *
 * `from shop import Order` reaches `shop/models.py` through `shop/__init__.py`,
 * which re-exports `Order`; `import { Button } from './components'` reaches
 * `components/Button.ts` through `components/index.ts`. When the re-exporting
 * file goes away, their edges point into files that stay, so the cascade keeps
 * them; when it comes back, the edges a name lookup made in its absence stay.
 * Nothing else revisits either: the importers did not change. A fresh index
 * binds them through the module when it is there, and another way (by name)
 * or not at all when it is not.
 *
 * A Python module that re-exports another one (`from .shop import *`, or a
 * package's `__init__.py` importing names from it) is the way in for its own
 * importers, so theirs are followed too, as deep as the resolver chases a
 * name through such modules. An ES module's `export … from` leaves no import
 * edge or node to find it by, so an `index.ts` re-exporting another is not
 * followed.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { QueryBuilder } from '../db/queries';
import type { Language, UnresolvedReference } from '../types';
import type { ImportMapping } from './types';
import { extractImportMappings, pythonModulePath } from './import-resolver';
import { resurrectRefFromDroppedEdge } from './resurrect-ref';

/**
 * Languages whose import bindings name what their references are written as:
 * Python's `from x import Y` and the ES-module family's `import { Y } from`.
 * An `#include` or a Go package import binds no reference name of its own.
 */
const BINDING_LANGUAGES = new Set<Language>([
  'python', 'typescript', 'tsx', 'javascript', 'jsx', 'arkts', 'vue', 'svelte', 'astro',
]);

/**
 * How many re-exporting Python modules deep the importers of a file are
 * followed: as deep as the resolver chases a name through star imports and
 * re-exports (`pythonModuleSymbol`).
 */
const PYTHON_REEXPORT_DEPTH = 3;

/** A Python star import, read the way the resolver reads one. */
const PYTHON_STAR_IMPORT = /^\s*from\s+([\w.]+)\s+import\s+\*/gm;

/**
 * A file this sync adds or removes, or a module re-exporting from one, with
 * the names it passes on from them (null: whatever it has).
 */
interface Module {
  path: string;
  language: Language;
  passes: Set<string> | null;
}

/**
 * Each importer's language and, per module specifier of a statement naming
 * one of the modules, which of its bindings go through it: all of them
 * (null), or those importing one of these names — what a re-exporting module
 * passes on, or the module the package around a file imports as a name
 * (`from django.db import models`, whose `models` is the file's module).
 */
type Importers = Map<string, { language: Language; sources: Map<string, Set<string> | null> }>;

/** A statement naming a module: whole, or as `onlyName` of the package around it. */
type AddImporter = (importer: string, language: Language, source: string, module: Module, onlyName?: string) => void;

/** What a file's import statements say, each file read once per sync. */
export interface ImportReader {
  /** Its import mappings. */
  mappings(file: string, language: Language): ImportMapping[];
  /** The modules a Python file star-imports, which have no import mapping. */
  starImports(file: string, language: Language): string[];
}

export function createImportReader(rootDir: string): ImportReader {
  const memo = new Map<string, { mappings: ImportMapping[]; starImports: string[] }>();
  const read = (file: string, language: Language) => {
    let entry = memo.get(file);
    if (!entry) {
      let content = '';
      try {
        content = fs.readFileSync(path.join(rootDir, file), 'utf8');
      } catch {
        // Gone or unreadable: it imports nothing.
      }
      entry = {
        mappings: content ? extractImportMappings(file, content, language) : [],
        starImports: language === 'python' ? [...content.matchAll(PYTHON_STAR_IMPORT)].map((m) => m[1]!) : [],
      };
      memo.set(file, entry);
    }
    return entry;
  };
  return {
    mappings: (file, language) => read(file, language).mappings,
    starImports: (file, language) => read(file, language).starImports,
  };
}

/**
 * Re-open, as pending references for the sync's sweep, the references the
 * files importing any of `removed` make through those imports. The sweep binds
 * them against the post-sync graph, or parks them where a sync that brings a
 * file back finds them. Called before the files' rows are deleted, for all of
 * them at once, so an importer of several is visited once; an edge into a
 * removed file is left to the resurrection its removal does. Returns the
 * number of references re-opened.
 */
export function reopenReferencesThroughRemovedFiles(
  queries: QueryBuilder,
  reader: ImportReader,
  removed: ReadonlyArray<{ path: string; language: Language }>,
): number {
  const gone = new Set(removed.map((file) => file.path));
  const bindings = bindingsOf(importersOf(queries, removed, reader), reader);
  return reopenEdges(queries, bindings, (e) => !gone.has(e.targetFilePath));
}

/**
 * The other half: after a sync's retries, re-open the references the files
 * importing any of `added` make through those imports — the edges a name
 * lookup made while a module was missing (only those up to
 * `resolvedUpToEdgeId`: later ones were just resolved with the modules there)
 * and the references that failed, the import of the module itself among
 * them. (The failed-import retry looks those up by the module's name, and
 * skips a name as common as `models` or `test`.) Returns the number re-opened.
 */
export function reopenReferencesThroughAddedFiles(
  queries: QueryBuilder,
  reader: ImportReader,
  added: ReadonlyArray<{ path: string; language: Language }>,
  resolvedUpToEdgeId: number,
): number {
  const bindings = bindingsOf(importersOf(queries, added, reader), reader);
  const failed = [...bindings].flatMap(([file, { modules, names }]) => queries.getFailedReferencesThrough(file, modules, names));
  return reopenEdges(queries, bindings, (e) => e.edgeId <= resolvedUpToEdgeId) + queries.reopenFailedReferences(failed);
}

/**
 * The files with an import statement naming one of `files`, or one of the
 * modules re-exporting from them, other than `files` themselves (going away,
 * or just resolved with the others in place).
 */
function importersOf(
  queries: QueryBuilder,
  files: ReadonlyArray<{ path: string; language: Language }>,
  reader: ImportReader,
): Importers {
  const importers: Importers = new Map();
  const changed = new Set(files.map((file) => file.path));
  const seen = new Set(changed);
  let level: Module[] = files.filter((file) => BINDING_LANGUAGES.has(file.language)).map((file) => ({ ...file, passes: null }));
  for (let depth = 1; level.length > 0; depth++) {
    // Per importer found here, its statements naming each module of the level.
    const naming = new Map<string, { language: Language; statements: Array<{ source: string; module: Module; onlyName?: string }> }>();
    const add: AddImporter = (importer, language, source, module, onlyName) => {
      if (!BINDING_LANGUAGES.has(language) || changed.has(importer)) return;
      const only = onlyName !== undefined ? new Set([onlyName]) : module.passes;
      const entry = importers.get(importer) ?? { language, sources: new Map<string, Set<string> | null>() };
      const names = entry.sources.get(source);
      entry.sources.set(source, names === null || only === null ? null : new Set([...(names ?? []), ...only]));
      importers.set(importer, entry);
      const found = naming.get(importer) ?? { language, statements: [] };
      found.statements.push({ source, module, onlyName });
      naming.set(importer, found);
    };
    for (const module of level) {
      // A module-path import that resolved to the module: an ES module
      // specifier, a dotted Python import.
      for (const i of queries.getImportsInto(`file:${module.path}`, module.path)) {
        if (i.refName !== null) add(i.filePath, i.language, i.refName, module);
      }
    }
    const python = level.filter((module) => module.language === 'python');
    if (python.length > 0) addPythonImporters(queries, python, reader, add);
    // The next level: the Python importers that pass on what they import from these.
    if (depth > PYTHON_REEXPORT_DEPTH) break;
    const next: Module[] = [];
    for (const [importer, { language, statements }] of naming) {
      if (language !== 'python' || seen.has(importer)) continue;
      const passes = pythonPassedOn(importer, statements, reader);
      if (passes === undefined) continue;
      seen.add(importer);
      next.push({ path: importer, language, passes });
    }
    level = next;
  }
  return importers;
}

/**
 * What the Python module `importer` passes on of what its `statements`
 * import, or undefined when the resolver reads no name through it: what it
 * star-imports, and for a package's `__init__.py`, the names it imports too.
 */
function pythonPassedOn(
  importer: string,
  statements: ReadonlyArray<{ source: string; module: Module; onlyName?: string }>,
  reader: ImportReader,
): Set<string> | null | undefined {
  let passes: Set<string> | null | undefined;
  const pass = (names: Set<string> | null): void => {
    passes = passes === null || names === null ? null : new Set([...(passes ?? []), ...names]);
  };
  const stars = new Set(reader.starImports(importer, 'python'));
  const isPackage = importer === '__init__.py' || importer.endsWith('/__init__.py');
  for (const { source, module, onlyName } of statements) {
    if (onlyName === undefined && stars.has(source)) pass(module.passes);
    if (!isPackage) continue;
    const names = reader.mappings(importer, 'python')
      .filter((m) => m.source === source && (onlyName !== undefined
        ? m.exportedName === onlyName
        : module.passes === null || module.passes.has(m.exportedName)))
      .map((m) => m.localName);
    if (names.length > 0) pass(new Set(names));
  }
  return passes;
}

/**
 * Python's other ways to name the modules: an import node whose module path
 * denotes one, relative to the importer's own package or absolutely (`from .
 * import Order`, `from .. import Order`, `from shop import Order`), which
 * never resolve to a file, or the package around one with its module among
 * the names imported (`from django.db import models`). An import inside a
 * function has no import node, so a file that reaches what the modules pass
 * on — the targets of their own import edges — counts too when its imports
 * name one.
 */
function addPythonImporters(
  queries: QueryBuilder,
  modules: readonly Module[],
  reader: ImportReader,
  add: AddImporter,
): void {
  // What a module path a statement names stands for: a module whole, or a
  // package with the module of `onlyName` among the names imported.
  type Naming = { module: Module; onlyName?: string };
  const byPath = new Map<string, Naming[]>();
  const bySuffix = new Map<string, Naming[]>();
  const importNames = new Set<string>();
  const push = (map: Map<string, Naming[]>, key: string, naming: Naming): void => {
    const list = map.get(key);
    if (list) list.push(naming);
    else map.set(key, [naming]);
  };
  const index = (modulePath: string, naming: Naming): void => {
    push(byPath, modulePath, naming);
    const segments = modulePath.split('/');
    for (let i = 0; i < segments.length; i++) push(bySuffix, segments.slice(i).join('/'), naming);
    for (const name of pythonImportNamesFor(modulePath)) importNames.add(name);
  };
  for (const module of modules) {
    const modulePath = pythonModuleOfFile(module.path);
    if (!modulePath) continue;
    index(modulePath, { module });
    const slash = modulePath.lastIndexOf('/');
    if (slash > 0) index(modulePath.slice(0, slash), { module, onlyName: modulePath.slice(slash + 1) });
  }
  if (importNames.size === 0) return;
  // A relative import names a module by where the importer sits, an absolute
  // one by the tail of its path (the project's import root is not known).
  const named = (source: string, importer: string): Naming[] =>
    source.startsWith('.')
      ? byPath.get(pythonModulePath(source, importer)?.replace(/\/+$/, '') ?? '') ?? []
      : bySuffix.get(source.replace(/\./g, '/')) ?? [];

  for (const node of queries.getImportNodesByNames([...importNames])) {
    if (node.language !== 'python') continue;
    for (const { module, onlyName } of named(node.name, node.filePath)) add(node.filePath, 'python', node.name, module, onlyName);
  }
  const paths = new Set(modules.map((module) => module.path));
  const passedOnTargets = new Set([...paths].flatMap((filePath) => queries.getImportTargetsFromFile(filePath)));
  if (passedOnTargets.size === 0) return;
  for (const candidate of queries.getFilesWithEdgesInto([...passedOnTargets])) {
    if (!candidate.endsWith('.py') || paths.has(candidate)) continue;
    for (const m of reader.mappings(candidate, 'python')) {
      for (const { module, onlyName } of named(m.source, candidate)) {
        if (onlyName === undefined || onlyName === m.exportedName) add(candidate, 'python', m.source, module, onlyName);
      }
    }
  }
}

/**
 * Per importer, what its statements naming the modules import: the modules
 * named whole (not the package around one), and the local names bound.
 */
function bindingsOf(importers: Importers, reader: ImportReader): Map<string, { modules: string[]; names: string[] }> {
  const bindings = new Map<string, { modules: string[]; names: string[] }>();
  for (const [file, { language, sources }] of importers) {
    const names = new Set(
      reader.mappings(file, language)
        .filter((m) => {
          const only = sources.get(m.source);
          return only === null || (only !== undefined && only.has(m.exportedName));
        })
        .map((m) => m.localName)
    );
    const modules = [...sources].filter(([, only]) => only === null).map(([source]) => source);
    if (modules.length > 0 || names.size > 0) bindings.set(file, { modules, names: [...names] });
  }
  return bindings;
}

/**
 * Swap for their references the edges of each importer's references through
 * its bound names — the binding itself or a member read through it
 * (`Order.objects`, `ns.fn`) — that pass `keep`. Returns how many.
 */
function reopenEdges(
  queries: QueryBuilder,
  bindings: Map<string, { names: string[] }>,
  keep: (e: { edgeId: number; targetFilePath: string }) => boolean,
): number {
  const edgeIds: number[] = [];
  const refs: UnresolvedReference[] = [];
  for (const [file, { names }] of bindings) {
    if (names.length === 0) continue;
    for (const e of queries.getResolutionEdgesThrough(file, names)) {
      if (!keep(e)) continue;
      const ref = resurrectRefFromDroppedEdge(e);
      if (!ref) continue;
      edgeIds.push(e.edgeId);
      refs.push(ref);
    }
  }
  if (refs.length > 0) queries.replaceResolutionEdgesWithUnresolvedRefs(edgeIds, refs);
  return refs.length;
}

/** A Python file's module as a path: `shop/models.py` → 'shop/models', `shop/__init__.py` → 'shop'. Null for a top-level `__init__.py`. */
function pythonModuleOfFile(filePath: string): string | null {
  if (!filePath.endsWith('.py') || filePath === '__init__.py') return null;
  if (filePath.endsWith('/__init__.py')) return filePath.slice(0, -'/__init__.py'.length);
  return filePath.slice(0, -'.py'.length);
}

/** Deepest relative import a lookup spells out: `from ........ import x`. */
const MAX_RELATIVE_DOTS = 8;

/**
 * The import names that can denote the module at `modulePath`: its trailing
 * dotted paths (`models`, `shop.models`), each also behind one dot or more
 * (`.models`, `..shop.models`), and the dots alone (`.`, `..`), which name a
 * package by where the importer sits.
 */
function pythonImportNamesFor(modulePath: string): string[] {
  const segments = modulePath.split('/');
  const absolute = segments.map((_, i) => segments.slice(i).join('.'));
  const names = new Set<string>(absolute);
  for (let dots = 1; dots <= MAX_RELATIVE_DOTS; dots++) {
    const prefix = '.'.repeat(dots);
    names.add(prefix);
    for (const name of absolute) names.add(prefix + name);
  }
  return [...names];
}
