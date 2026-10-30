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
 * A module that re-exports another one (`export * from './components'` in an
 * `index.ts`, `from .shop import *` or a package's `__init__.py` importing
 * names from it) is the way in for its own importers, so theirs are followed
 * too, as deep as the resolver chases a name through such modules.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { QueryBuilder } from '../db/queries';
import type { Edge, Language, UnresolvedReference } from '../types';
import type { ImportMapping, ReExport } from './types';
import { extractImportMappings, extractReExports, pythonModulePath, REEXPORT_MAX_DEPTH } from './import-resolver';
import { resurrectRefFromDroppedEdge } from './resurrect-ref';
import { defaultExportBinding, extractLocalExportAliases } from './alias-binding';
import { isDeclarationFile, scanAmbientModules } from './ambient-modules';
import { moduleReferenceKeys } from '../db/reference-tail';

/**
 * Languages whose import bindings name what their references are written as:
 * Python's `from x import Y` and the ES-module family's `import { Y } from`.
 * An `#include` or a Go package import binds no reference name of its own.
 */
const BINDING_LANGUAGES = new Set<Language>([
  'python', 'typescript', 'tsx', 'javascript', 'jsx', 'arkts', 'vue', 'svelte', 'astro',
]);

/**
 * How many re-exporting modules deep the importers of a file are followed: as
 * deep as the resolver chases a name through them, three for Python's star
 * imports and re-exports (`pythonModuleSymbol`), `REEXPORT_MAX_DEPTH` for
 * ES-module `export … from`.
 */
const reExportDepth = (language: Language): number => (language === 'python' ? 3 : REEXPORT_MAX_DEPTH);

/** An export clause, a default export, or CommonJS exports: a module that can hand over a binding it imports. */
const EXPORTS_A_BINDING = /\bexport\s*\{|\bexport\s+default\s|\bexports\b/;

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
  /** Its ES-module `export … from` statements, which have no import mapping. */
  reExports(file: string, language: Language): ReExport[];
  /** The modules a Python file star-imports, which have no import mapping. */
  starImports(file: string, language: Language): string[];
  /**
   * The bindings an ES module's own exports hand over as they are, each with
   * the names it is exported as: each local an export clause names (`export {
   * Page }`, `export { Card as AppCard }`), and its default export when that
   * is a binding (`export default Page;`, exported as `default`).
   */
  exportedAs(file: string, language: Language): ReadonlyMap<string, readonly string[]>;
}

export function createImportReader(rootDir: string): ImportReader {
  const memo = new Map<string, { content: string; mappings: ImportMapping[]; reExports: ReExport[]; starImports: string[]; exported?: Map<string, string[]> }>();
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
        content,
        mappings: content ? extractImportMappings(file, content, language) : [],
        reExports: content ? extractReExports(content, language) : [],
        starImports: language === 'python' ? [...content.matchAll(PYTHON_STAR_IMPORT)].map((m) => m[1]!) : [],
      };
      memo.set(file, entry);
    }
    return entry;
  };
  const exportsOf = (file: string, language: Language): Map<string, string[]> => {
    const entry = read(file, language);
    if (!entry.exported) {
      // Most importers export nothing they import; a commented-out clause
      // read as one only costs a key lookup.
      const exported = new Map<string, string[]>();
      const add = (local: string, as: string): void => {
        const names = exported.get(local);
        if (names) names.push(as);
        else exported.set(local, [as]);
      };
      if (EXPORTS_A_BINDING.test(entry.content)) {
        for (const alias of extractLocalExportAliases(entry.content)) add(alias.localName, alias.exportedName);
        const binding = defaultExportBinding(entry.content);
        if (binding) add(binding, 'default');
      }
      entry.exported = exported;
    }
    return entry.exported;
  };
  return {
    mappings: (file, language) => read(file, language).mappings,
    reExports: (file, language) => read(file, language).reExports,
    starImports: (file, language) => read(file, language).starImports,
    exportedAs: (file, language) => exportsOf(file, language),
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

/** Resolves a module specifier written in `fromFile` as its import does: the project file it names, or null. */
export type ModuleResolver = (specifier: string, fromFile: string, language: Language) => string | null;

/** The folder of the project's own package (a workspace member, a path dependency) `file` is in, or null. */
export type PackageDirOf = (file: string) => string | null;

/**
 * The other half: after a sync's retries, re-open the references the files
 * importing any of `added` make through those imports — the edges a name
 * lookup made while a module was missing (only those up to
 * `resolvedUpToEdgeId`: later ones were just resolved with the modules there)
 * and the references that failed, the import of the module itself among
 * them. (The failed-import retry looks those up by the module's name, and
 * skips a name as common as `models` or `test`.) With `resolveModule`, also an
 * import that resolved to a file beside an added one that now outranks it
 * (`./button` to `button.vue` while `button.ts` was missing), or, with
 * `packageDirOf`, to another file of the package an added file is in (see
 * outrankedImports), and what that statement binds. Returns the number
 * re-opened.
 */
export function reopenReferencesThroughAddedFiles(
  queries: QueryBuilder,
  reader: ImportReader,
  added: ReadonlyArray<{ path: string; language: Language }>,
  resolvedUpToEdgeId: number,
  resolveModule?: ModuleResolver,
  packageDirOf?: PackageDirOf,
): number {
  const outranked = resolveModule ? outrankedImports(queries, added, resolveModule, packageDirOf) : [];
  const bindings = bindingsOf(importersOf(queries, added, reader, outranked), reader);
  const failed = [...bindings].flatMap(([file, { modules, names }]) => queries.getFailedReferencesThrough(file, modules, names));
  return reopenModuleEdges(queries, outranked) +
    reopenEdges(queries, bindings, (e) => e.edgeId <= resolvedUpToEdgeId) + queries.reopenFailedReferences(failed);
}

/**
 * The way in for the files importing a package that a declaration file this
 * sync adds or edits declares itself: `declare module 'mammoth' { … }` in
 * `typings/mammoth/index.d.ts` (see ./ambient-modules). They import the
 * package by its name, which no import edge into the file records, so the
 * pass over an added file's importers never finds them, and an aliased,
 * default or namespace binding waits under a name the file never declares.
 * What each importer reaches through those bindings goes back to pending for
 * the sweep: the references that failed, and the edges bound before this sync
 * resolved anything (up to `resolvedUpToEdgeId`), which a name match may have
 * made while nothing declared the package. A removed declaration needs
 * nothing of its own: the edges into its declarations are resurrected with
 * them. Returns the number re-opened.
 */
export function reopenReferencesThroughDeclaredPackages(
  queries: QueryBuilder,
  reader: ImportReader,
  rootDir: string,
  changed: readonly string[],
  resolvedUpToEdgeId: number,
): number {
  const specifiers = new Set<string>();
  for (const file of changed) {
    if (!isDeclarationFile(file)) continue;
    let content = '';
    try {
      content = fs.readFileSync(path.join(rootDir, file), 'utf8');
    } catch {
      continue;
    }
    if (!content.includes('declare')) continue;
    for (const block of scanAmbientModules(content).blocks) if (!block.pattern) specifiers.add(block.specifier);
  }
  if (specifiers.size === 0) return 0;
  const changedFiles = new Set(changed);
  const importers: Importers = new Map();
  for (const specifier of specifiers) {
    // An import statement's node is named by the specifier it imports.
    for (const node of queries.getNodesByName(specifier)) {
      if (node.kind !== 'import' || !BINDING_LANGUAGES.has(node.language) || changedFiles.has(node.filePath)) continue;
      const entry = importers.get(node.filePath) ?? { language: node.language, sources: new Map<string, Set<string> | null>() };
      entry.sources.set(specifier, null);
      importers.set(node.filePath, entry);
    }
  }
  const bindings = bindingsOf(importers, reader);
  const failed = [...bindings].flatMap(([file, { modules, names }]) => queries.getFailedReferencesThrough(file, modules, names));
  return reopenEdges(queries, bindings, (e) => e.edgeId <= resolvedUpToEdgeId) + queries.reopenFailedReferences(failed);
}

/**
 * Re-open, for the sync's sweep, what reads the default of any of `files`
 * when it moved: an edit made `export default A` into `export default B`, or
 * took the default away, while `A` stayed declared (`was`, see
 * ReferenceResolver.changedDefaultExports). `new Y()` after `import Y from
 * './x'` kept `A`, the node that replaced its old target. The edges bound
 * before this sync resolved anything (up to `resolvedUpToEdgeId`) go back:
 * - those through every binding that reads the default: a default import,
 *   `{ default as Y }`, `require('./x').default`, the names a module passes it
 *   on as (`export { default as Y } from './x'`), and a route rendering one
 *   as its layout (`layout:Y`). A named import reads what it did, and a
 *   default import's own edge links the module's file, which stays;
 * - those into the members `A` declares, wherever they are written: a value
 *   typed by the binding reaches them by their own name (`document.delete()`
 *   with `document: Document`, a subclass's `this.add`). `A` itself is reached
 *   through a binding, the default's or a named import's, which reads it still.
 * Returns the number re-opened.
 */
export function reopenReferencesThroughChangedDefaults(
  queries: QueryBuilder,
  reader: ImportReader,
  files: ReadonlyArray<{ path: string; language: Language; was: readonly string[] }>,
  resolvedUpToEdgeId: number,
): number {
  const stays = (e: Edge & { edgeId: number }): boolean => e.edgeId <= resolvedUpToEdgeId && !e.target.startsWith('file:');
  const bindings = bindingsOf(importersOf(queries, files, reader, [], new Set(['default'])), reader);
  // React, Vue and Angular routers write a layout a route renders as `layout:<name>`.
  for (const entry of bindings.values()) entry.names.push(...entry.names.map((name) => `layout:${name}`));
  const reopened = reopenEdges(queries, bindings, stays);
  const was = [...new Set(files.flatMap((file) => file.was))];
  const members = was.length === 0 ? [] : queries.getOutgoingEdgesFrom(was, ['contains']).map((edge) => edge.target);
  if (members.length === 0) return reopened;
  return reopened + reopenEdgeList(queries, queries.getResolutionEdgesInto(members).filter(stays));
}

/**
 * Re-open, for the sync's sweep, the imports of `files` that a name match
 * took instead of the import, when the binding now resolves another way.
 * `import { EmptyState } from './layouts/shared'`, linked by name to a
 * namesake while the barrel did not pass `EmptyState` on, kept the namesake
 * after an edit gave the barrel `export { EmptyState } from './EmptyState'`:
 * that edit declares nothing, so neither the rebind nor the walk below a
 * barrel sees it, and a fresh index links the binding through the module. A
 * name match into the module itself (`import { Card } from './card'` where
 * `card.ts` exports `Card` only as its default) can come undone the same way.
 * Each importer's edges bound before this sync resolved anything (up to
 * `resolvedUpToEdgeId`) go back: those through the name, and those into the
 * members of what the name match took, which a value typed by the binding
 * reached (`w.run()` with `w: Widget`). Only the importers' bindings that
 * resolved some other way than their import are read, an indexed range per
 * importer, then only those importers' import statements, and `resolveNow`
 * says what each binding of `files` resolves to against the graph as it is:
 * one that resolves as it did, such as a name match a fresh index makes too,
 * stays. Returns the number re-opened.
 */
export function reopenNameMatchedImports(
  queries: QueryBuilder,
  reader: ImportReader,
  files: ReadonlyArray<{ path: string; language: Language }>,
  resolvedUpToEdgeId: number,
  resolveModule: ModuleResolver,
  resolveNow: (ref: UnresolvedReference) => { targetNodeId: string; resolvedBy: string } | null,
): number {
  const bindings = new Map<string, { names: string[] }>();
  // What each importer's name matches took, whose members a typed value reached.
  const took = new Set<string>();
  for (const file of files) {
    if (!BARREL_LANGUAGES.has(file.language)) continue;
    const importers = new Set<string>();
    for (const i of queries.getImportsInto(`file:${file.path}`, file.path)) {
      if (i.language !== 'python' && BINDING_LANGUAGES.has(i.language)) importers.add(i.filePath);
    }
    if (importers.size === 0) continue;
    for (const edge of queries.getImportBindingsResolvedElsewhere([...importers])) {
      const name = edge.metadata?.refName;
      if (typeof name !== 'string' || edge.edgeId > resolvedUpToEdgeId) continue;
      const binding = reader.mappings(edge.sourceFilePath, edge.sourceLanguage).find((m) => m.localName === name);
      if (!binding || binding.isNamespace) continue;
      if (resolveModule(binding.source, edge.sourceFilePath, edge.sourceLanguage) !== file.path) continue;
      const ref = resurrectRefFromDroppedEdge(edge);
      const now = ref ? resolveNow(ref) : null;
      if (!ref || (now && now.targetNodeId === edge.target && now.resolvedBy === edge.metadata?.resolvedBy)) continue;
      const entry = bindings.get(edge.sourceFilePath) ?? { names: [] };
      if (!entry.names.includes(name)) entry.names.push(name);
      bindings.set(edge.sourceFilePath, entry);
      took.add(edge.target);
    }
  }
  const stays = (e: { edgeId: number }): boolean => e.edgeId <= resolvedUpToEdgeId;
  const reopened = reopenEdges(queries, bindings, stays);
  if (took.size === 0) return reopened;
  const members = queries.getOutgoingEdgesFrom([...took], ['contains']).map((edge) => edge.target);
  if (members.length === 0) return reopened;
  return reopened + reopenEdgeList(queries, queries.getResolutionEdgesInto(members).filter((e) => bindings.has(e.sourceFilePath) && stays(e)));
}

/** The languages a barrel a lazy route reads through is written in: the ES-module family. */
const BARREL_LANGUAGES = new Set<Language>(['typescript', 'tsx', 'javascript', 'jsx']);

/**
 * Re-open, for the sync's sweep, the references that reach a module through a
 * barrel when a file below the barrel appears or gains a definition. React
 * Router's `import:@/pages#HomePage` waits under the key of the module it
 * names, `module:pages`. When `pages/index.ts` passes on
 * `pages/Home/index.tsx`, that file is what the reference waits for, but its
 * own keys name its folder and stem (`module:Home`), never the barrel's.
 *
 * The barrels are the modules that pass one of `files` on, through `export …
 * from` or an import they export again (`import { HomePage } from './Home';
 * export { HomePage }`), followed up as deep as the resolver chases a name
 * ({@link passedOn}). What waits under their keys goes back, and so does what
 * their importers reach through a name they pass the file on as: matx's
 * `export { default as MatxLoading } from './MatxLoading'` hands
 * `MatxLoading.jsx` to `import { MatxLoading } from 'app/components'`, a name
 * the file never declares, so neither the retry by the file's names nor the
 * rebind of the edges into them reaches it. Such an importer's failed
 * references through those names go back. So do its edges through the names
 * the files never declare, bound before this sync resolved anything (up to
 * `resolvedUpToEdgeId`): while the module lacked the binding, a name match
 * could take the name elsewhere (vben's `alert`, which the barrel passes on
 * from `vbenAlert`, to the `alert.vue` component). A name a file declares is
 * the rebind's, which caps a common one, and a chain of `export *` hands over
 * only those. Call after the failed-ref retry: an added file's importers
 * reach it through the import edges it made. Returns the number re-opened.
 */
export function reopenReferencesThroughBarrels(
  queries: QueryBuilder,
  reader: ImportReader,
  files: ReadonlyArray<{ path: string; language: Language }>,
  resolvedUpToEdgeId: number,
): number {
  let level: Module[] = files.filter((file) => BARREL_LANGUAGES.has(file.language)).map((file) => ({ ...file, passes: null }));
  if (level.length === 0) return 0;
  const waiting = new Set(queries.getFailedModuleKeys());
  const keys = new Set<string>();
  const declared = new Set(queries.getNodesByFiles(level.map((module) => module.path)).map((node) => node.name));
  // The importers below a barrel, with the names it passes the files on as,
  // and with those of them the files never declare.
  const importers: Importers = new Map();
  const renamed: Importers = new Map();
  const record = (into: Importers, importer: string, language: Language, source: string, names: string[]): void => {
    if (names.length === 0) return;
    const entry = into.get(importer) ?? { language, sources: new Map<string, Set<string> | null>() };
    entry.sources.set(source, new Set([...(entry.sources.get(source) ?? []), ...names]));
    into.set(importer, entry);
  };
  const seen = new Set(level.map((module) => module.path));
  for (let depth = 1; level.length > 0; depth++) {
    // Per importer of this level, its statements naming each module of it.
    const naming = new Map<string, { language: Language; statements: Array<{ source: string; module: Module }> }>();
    for (const module of level) {
      for (const i of queries.getImportsInto(`file:${module.path}`, module.path)) {
        if (i.refName === null || seen.has(i.filePath)) continue;
        if (module.passes !== null && i.language !== 'python' && BINDING_LANGUAGES.has(i.language)) {
          record(importers, i.filePath, i.language, i.refName, [...module.passes]);
          record(renamed, i.filePath, i.language, i.refName, [...module.passes].filter((name) => !declared.has(name)));
        }
        if (depth > REEXPORT_MAX_DEPTH || !BARREL_LANGUAGES.has(i.language)) continue;
        const found = naming.get(i.filePath) ?? { language: i.language, statements: [] };
        found.statements.push({ source: i.refName, module });
        naming.set(i.filePath, found);
      }
    }
    const next: Module[] = [];
    for (const [importer, { language, statements }] of naming) {
      const passes = passedOn(importer, language, statements, reader);
      if (passes === undefined) continue;
      seen.add(importer);
      for (const key of moduleReferenceKeys(importer)) if (waiting.has(key)) keys.add(key);
      next.push({ path: importer, language, passes });
    }
    level = next;
  }
  const failed = new Set([...bindingsOf(importers, reader)].flatMap(([file, { names }]) => queries.getFailedReferencesThrough(file, [], names)));
  if (keys.size > 0) {
    for (const ref of queries.getRetryableFailedReferences([...keys])) if (ref.rowId !== undefined) failed.add(ref.rowId);
  }
  return reopenEdges(queries, bindingsOf(renamed, reader), (e) => e.edgeId <= resolvedUpToEdgeId) +
    queries.reopenFailedReferences([...failed]);
}

/**
 * Re-open, for the sync's sweep, what the files importing any of `modules`
 * bind through them, after a module's `export … from` clauses changed what
 * they point at (#2978): `export { foo } from './a'` made `'./b'`, an `export
 * *` moved the same way, a re-export taken away. The importers did not change
 * and the module declares nothing of what it passes on, so no definition
 * delta, added file or failed reference names their bindings, and they stay
 * on the module the clause used to name. Each importer's edges through the
 * names it binds from the module go back, up through the modules that pass
 * them on in turn, with the failures parked under them. Returns the number
 * re-opened.
 */
export function reopenReferencesThroughRetargetedModules(
  queries: QueryBuilder,
  reader: ImportReader,
  modules: ReadonlyArray<{ path: string; language: Language }>,
): number {
  const barrels = modules.filter((module) => BARREL_LANGUAGES.has(module.language));
  if (barrels.length === 0) return 0;
  const bindings = bindingsOf(importersOf(queries, barrels, reader), reader);
  const failed = [...bindings].flatMap(([file, { modules: named, names }]) => queries.getFailedReferencesThrough(file, named, names));
  // What the bindings pointed at: a value typed by a binding reached the
  // members of that (`w.run()` with `w: Widget`), by their own names, and
  // those edges follow the binding to its new target.
  const bound = new Set<string>();
  for (const [file, { names }] of bindings) {
    if (names.length === 0) continue;
    for (const e of queries.getResolutionEdgesThrough(file, names)) if (!e.target.startsWith('file:')) bound.add(e.target);
  }
  let reopened = reopenEdges(queries, bindings, () => true) + queries.reopenFailedReferences(failed);
  if (bound.size === 0) return reopened;
  const members = queries.getOutgoingEdgesFrom([...bound], ['contains']).map((edge) => edge.target);
  if (members.length === 0) return reopened;
  reopened += reopenEdgeList(queries, queries.getResolutionEdgesInto(members).filter((e) => bindings.has(e.sourceFilePath)));
  return reopened;
}

/** An import's module edge into a file that an added file now outranks. */
interface OutrankedImport {
  edge: Edge & { edgeId: number; sourceFilePath: string; sourceLanguage: Language };
  specifier: string;
  added: string;
}

/**
 * The module edges an import resolved into a file beside one of `added` —
 * another extension of its name, or its folder's own entry — when the
 * import's specifier now names the added file: `./button` resolved to
 * `button.vue` while `button.ts` was missing, and `button.ts` comes first.
 * With `packageDirOf`, also the imports of a package by its name into any
 * file of the package an added file is in: the entry its manifest declares
 * (`./src/index.ts`, or the source of `./dist/index.js`), or the source of a
 * path into its build output, outranks the file an import fell back to while
 * it was missing, such as the folder's own index (#2502).
 */
function outrankedImports(
  queries: QueryBuilder,
  added: ReadonlyArray<{ path: string; language: Language }>,
  resolveModule: ModuleResolver,
  packageDirOf?: PackageDirOf,
): OutrankedImport[] {
  const out: OutrankedImport[] = [];
  const packageImports = new Map<string, ReturnType<QueryBuilder['getModuleImportsUnder']>>();
  for (const file of added) {
    if (!BINDING_LANGUAGES.has(file.language)) continue;
    const { dir, name } = importedName(file.path);
    const edges = queries.getModuleImportsNamed(dir, name);
    const packageDir = packageDirOf?.(file.path);
    if (packageDir) {
      let imports = packageImports.get(packageDir);
      if (!imports) {
        imports = queries.getModuleImportsUnder(packageDir).filter((edge) => {
          const specifier = edge.metadata?.refName;
          return typeof specifier === 'string' && !specifier.startsWith('.') && !specifier.startsWith('/');
        });
        packageImports.set(packageDir, imports);
      }
      const seen = new Set(edges.map((edge) => edge.edgeId));
      for (const edge of imports) if (!seen.has(edge.edgeId)) edges.push(edge);
    }
    for (const edge of edges) {
      const specifier = edge.metadata?.refName;
      if (edge.targetFilePath === file.path || typeof specifier !== 'string') continue;
      if (resolveModule(specifier, edge.sourceFilePath, edge.sourceLanguage) === file.path) {
        out.push({ edge, specifier, added: file.path });
      }
    }
  }
  return out;
}

/** The folder and name an import finds a file by: `a/b.ts` → `a`, `b`; a folder's own entry `a/b/index.ts` → `a`, `b`. */
function importedName(filePath: string): { dir: string; name: string } {
  const slash = filePath.lastIndexOf('/');
  const base = filePath.slice(slash + 1);
  const dir = slash < 0 ? '' : filePath.slice(0, slash);
  if (base.startsWith('index.') || base === '__init__.py') {
    const up = dir.lastIndexOf('/');
    return { dir: up < 0 ? '' : dir.slice(0, up), name: dir.slice(up + 1) };
  }
  const dot = base.indexOf('.', 1);
  return { dir, name: dot < 0 ? base : base.slice(0, dot) };
}

/** Swap the outranked module edges for their references, for the sweep. Returns how many. */
function reopenModuleEdges(queries: QueryBuilder, outranked: readonly OutrankedImport[]): number {
  const edgeIds: number[] = [];
  const refs: UnresolvedReference[] = [];
  for (const { edge } of outranked) {
    const ref = resurrectRefFromDroppedEdge(edge);
    if (!ref || edgeIds.includes(edge.edgeId)) continue;
    edgeIds.push(edge.edgeId);
    refs.push(ref);
  }
  if (refs.length > 0) queries.replaceResolutionEdgesWithUnresolvedRefs(edgeIds, refs);
  return refs.length;
}

/**
 * The files with an import statement naming one of `files`, or one of the
 * modules re-exporting from them, other than `files` themselves (going away,
 * or just resolved with the others in place); `outranked` imports name the
 * added file they now resolve to. `names` limits what of `files` counts: all
 * of it (null), or what they export under these names.
 */
function importersOf(
  queries: QueryBuilder,
  files: ReadonlyArray<{ path: string; language: Language }>,
  reader: ImportReader,
  outranked: readonly OutrankedImport[] = [],
  names: Set<string> | null = null,
): Importers {
  const importers: Importers = new Map();
  const changed = new Set(files.map((file) => file.path));
  const seen = new Set(changed);
  let level: Module[] = files.filter((file) => BINDING_LANGUAGES.has(file.language)).map((file) => ({ ...file, passes: names }));
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
      if (depth > 1) continue;
      for (const o of outranked) {
        if (o.added === module.path) add(o.edge.sourceFilePath, o.edge.sourceLanguage, o.specifier, module);
      }
    }
    const python = level.filter((module) => module.language === 'python');
    if (python.length > 0) addPythonImporters(queries, python, reader, add);
    // The next level: the importers that pass on what they import from these.
    const next: Module[] = [];
    for (const [importer, { language, statements }] of naming) {
      if (seen.has(importer) || depth > reExportDepth(language)) continue;
      const passes = passedOn(importer, language, statements, reader);
      if (passes === undefined) continue;
      seen.add(importer);
      next.push({ path: importer, language, passes });
    }
    level = next;
  }
  return importers;
}

/**
 * What `importer` passes on of what its `statements` import, under the names
 * its own importers use, or undefined when the resolver reads no name through
 * it: an ES module what it `export … from`s and the imports it exports again
 * (`import Card from './Card'; export { Card as AppCard }`); a Python module
 * what it star-imports, and a package's `__init__.py` the names it imports
 * too.
 */
function passedOn(
  importer: string,
  language: Language,
  statements: ReadonlyArray<{ source: string; module: Module; onlyName?: string }>,
  reader: ImportReader,
): Set<string> | null | undefined {
  let passes: Set<string> | null | undefined;
  const pass = (names: Set<string> | null): void => {
    passes = passes === null || names === null ? null : new Set([...(passes ?? []), ...names]);
  };
  const passing = (module: Module, name: string): boolean => module.passes === null || module.passes.has(name);
  if (language !== 'python') {
    for (const rex of reader.reExports(importer, language)) {
      for (const { source, module } of statements) {
        if (source !== rex.source) continue;
        if (rex.kind === 'wildcard') pass(module.passes);
        else if (rex.kind === 'namespace') pass(new Set([rex.exportedName]));
        else if (passing(module, rex.originalName)) pass(new Set([rex.exportedName]));
      }
    }
    const exportedAs = reader.exportedAs(importer, language);
    if (exportedAs.size > 0) {
      for (const m of reader.mappings(importer, language)) {
        const names = m.isNamespace ? undefined : exportedAs.get(m.localName);
        if (!names) continue;
        for (const { source, module } of statements) {
          if (source === m.source && passing(module, m.isDefault ? 'default' : m.exportedName)) pass(new Set(names));
        }
      }
    }
    return passes;
  }
  const stars = new Set(reader.starImports(importer, language));
  const isPackage = importer === '__init__.py' || importer.endsWith('/__init__.py');
  for (const { source, module, onlyName } of statements) {
    if (onlyName === undefined && stars.has(source)) pass(module.passes);
    if (!isPackage) continue;
    const names = reader.mappings(importer, language)
      .filter((m) => m.source === source && (onlyName !== undefined ? m.exportedName === onlyName : passing(module, m.exportedName)))
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
 * named whole (not the package around one), and the local names bound. An ES
 * namespace import (`import * as z`) reads whatever its module passes on, and
 * an ES `export { A } from './x'` names `A`, which it resolves through `./x`
 * as an import binds it.
 */
function bindingsOf(importers: Importers, reader: ImportReader): Map<string, { modules: string[]; names: string[] }> {
  const bindings = new Map<string, { modules: string[]; names: string[] }>();
  for (const [file, { language, sources }] of importers) {
    const names = new Set(
      reader.mappings(file, language)
        .filter((m) => {
          const only = sources.get(m.source);
          if (only === null) return true;
          if (only === undefined) return false;
          return only.has(m.exportedName) || (m.isNamespace && language !== 'python' && only.size > 0);
        })
        .map((m) => m.localName)
    );
    for (const rex of reader.reExports(file, language)) {
      if (rex.kind !== 'named') continue;
      const only = sources.get(rex.source);
      if (only === null || only?.has(rex.originalName)) names.add(rex.originalName);
    }
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
  keep: (e: Edge & { edgeId: number; targetFilePath: string }) => boolean,
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

/**
 * Swap `edges` for their references, one per reference: a conditional's arms
 * are edges of one call. Returns how many references went back.
 */
function reopenEdgeList(queries: QueryBuilder, edges: ReadonlyArray<Edge & { edgeId: number; sourceFilePath: string; sourceLanguage: Language }>): number {
  const edgeIds: number[] = [];
  const refs: UnresolvedReference[] = [];
  const sites = new Set<string>();
  for (const edge of edges) {
    const ref = resurrectRefFromDroppedEdge(edge);
    if (!ref) continue;
    edgeIds.push(edge.edgeId);
    const site = `${ref.fromNodeId}\0${ref.referenceName}\0${ref.line}\0${ref.column}`;
    if (sites.has(site)) continue;
    sites.add(site);
    refs.push(ref);
  }
  if (edgeIds.length > 0) queries.replaceResolutionEdgesWithUnresolvedRefs(edgeIds, refs);
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
