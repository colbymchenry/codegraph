import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { createResolver, type ReferenceResolver } from '../src/resolution';
import { matchMethodCall } from '../src/resolution/name-matcher';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';

/**
 * #2829: a JS/TS call of a member that no node in the index is named — a
 * library's `list.push()`, `fs.writeFileSync()`, a test framework's matcher —
 * can't be linked by any strategy in matchMethodCall that looks the member up
 * by its own name, so the matcher no longer reads the calling file to work
 * out the receiver's type for it. The one exception is the object-literal
 * reader, which follows a member to the binding the literal gives it. These
 * tests count the work the skip saves, pin every way a call reaches a symbol
 * of another name, and check a whole index against one made without the skip.
 */

/** A context holding no nodes, which counts every read of the calling file. */
function countingContext(reads: { n: number }, isAbsentName?: (name: string) => boolean): ResolutionContext {
  const source = ['const svc = createService();', 'svc.absent();'];
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    fileExists: () => false,
    getProjectRoot: () => '/',
    getAllFiles: () => [],
    readFile: () => {
      reads.n++;
      return source.join('\n');
    },
    getFileLines: () => {
      reads.n++;
      return source;
    },
    ...(isAbsentName ? { isAbsentName } : {}),
  };
}

const absentCall: UnresolvedRef = {
  fromNodeId: 'function:caller',
  referenceName: 'svc.absent',
  referenceKind: 'calls',
  line: 2,
  column: 0,
  filePath: 'caller.ts',
  language: 'typescript',
};

describe('A call of a member no node is named (#2829)', () => {
  const dirs: string[] = [];
  const graphs: CodeGraph[] = [];

  afterEach(() => {
    for (const cg of graphs.splice(0)) cg.close();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-absent-member-'));
    dirs.push(dir);
    return dir;
  }

  it('reads nothing of the calling file when no node has the member\'s name', () => {
    const reads = { n: 0 };
    expect(matchMethodCall(absentCall, countingContext(reads, () => true))).toBeNull();
    expect(reads.n).toBe(0);
  });

  it('still reads it when a node has the name, or nothing says whether one does', () => {
    // The same call, with the name known: the receiver is read as before, so
    // the count above is the skip's doing.
    const known = { n: 0 };
    expect(matchMethodCall(absentCall, countingContext(known, () => false))).toBeNull();
    expect(known.n).toBeGreaterThan(0);
    // A context that can't answer never skips.
    const unknown = { n: 0 };
    expect(matchMethodCall(absentCall, countingContext(unknown))).toBeNull();
    expect(unknown.n).toBeGreaterThan(0);
  });

  it('answers absence only from a loaded set of names', () => {
    const dir = tempDir();
    const db = DatabaseConnection.initialize(path.join(dir, 'names.db'));
    try {
      const queries = new QueryBuilder(db.getDb());
      const node: Node = {
        id: 'method:Service::known', kind: 'method', name: 'known', qualifiedName: 'Service::known',
        filePath: 'service.ts', language: 'typescript', startLine: 1, endLine: 2, startColumn: 0, endColumn: 0,
        updatedAt: Date.now(),
      };
      queries.insertNodes([node]);
      const resolver = createResolver(dir, queries);
      const context = resolver.getResolutionContext();

      // Not loaded yet: no name is absent, so no caller skips on a guess.
      expect(context.isAbsentName?.('absent')).toBe(false);
      resolver.warmCaches();
      expect(context.isAbsentName?.('known')).toBe(false);
      expect(context.isAbsentName?.('absent')).toBe(true);
      // The name set is exact: case and a qualified name are other names.
      expect(context.isAbsentName?.('Known')).toBe(true);
      expect(context.isAbsentName?.('Service::known')).toBe(true);
      // Dropped with the other caches, as nodes may change after.
      resolver.clearCaches();
      expect(context.isAbsentName?.('absent')).toBe(false);
    } finally {
      db.close();
    }
  });

  /**
   * Calls whose member no node is named, beside calls whose member is known:
   * a literal's member bound to another function (#1932), a shorthand member
   * bound to a renamed import, an `as const` literal, a literal typed
   * `Record<…>` (whose answer the type decides before the literal is read),
   * a literal imported from another file, a renamed re-export read through a
   * namespace import, and library calls through a parameter, a field and a
   * global.
   */
  function writeFixture(dir: string): void {
    const files: Record<string, string> = {
      'a.ts': [
        "import { fetchUser as getUser } from './users';",
        "import * as ns from './barrel';",
        "import { holder } from './holder';",
        'function renamed() { return 4; }',
        'function renamedConst() { return 3; }',
        'export const api = { alias: renamed, getUser };',
        'const constApi = { aliasC: renamedConst } as const;',
        'const typedApi: Record<string, () => number> = { aliasT: renamedConst };',
        'export function sameFileCaller(list: number[]) {',
        '  list.push(1);',
        '  return [api.alias(), api.getUser(), constApi.aliasC(), typedApi.aliasT(), ns.run(), holder.aliasH()];',
        '}',
        '',
      ].join('\n'),
      'users.ts': 'export function fetchUser() { return 1; }\n',
      'impl.ts': 'export function implementation() { return 2; }\n',
      'barrel.ts': "export { implementation as run } from './impl';\n",
      'holder.ts': 'function renamedHolder() { return 2; }\nexport const holder = { aliasH: renamedHolder };\n',
      'service.ts': [
        'export class Store { save(): number { return 1; } }',
        'export class Service {',
        '  private store = new Store();',
        '  private items: string[] = [];',
        '  work(): number {',
        "    this.items.push('x');",
        '    return this.store.save();',
        '  }',
        '}',
        'export function useService(s: Service, store: Store) {',
        '  store.save();',
        '  s.missing();',
        "  console.log('x');",
        '  return s.work();',
        '}',
        '',
      ].join('\n'),
      'local.js': [
        'function impl() { return 5; }',
        'const local = { start: impl };',
        'function useLocal() { return [local.start(), local.stop(), Math.max(1, 2)]; }',
        'module.exports = { useLocal };',
        '',
      ].join('\n'),
    };
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
  }

  /** Index the fixture; `isAbsentName` replaces the resolver's own answer when given. */
  async function indexFixture(isAbsentName?: (original: ResolutionContext['isAbsentName']) => ResolutionContext['isAbsentName']) {
    const dir = tempDir();
    writeFixture(dir);
    const cg = CodeGraph.initSync(dir);
    graphs.push(cg);
    const context = (cg as unknown as { resolver: ReferenceResolver }).resolver.getResolutionContext();
    if (isAbsentName) context.isAbsentName = isAbsentName(context.isAbsentName);
    await cg.indexAll();
    return { cg, dir };
  }

  const callers = (cg: CodeGraph, name: string): string[] => {
    const target = cg.getNodesByName(name).find((n) => n.kind === 'function');
    expect(target, name).toBeDefined();
    return cg.getIncomingEdges(target!.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.source)!.name)
      .sort();
  };

  it('keeps every way a call reaches a symbol of another name', async () => {
    const { cg } = await indexFixture();
    // Each call below names a member no node is named, so the skip sees it.
    for (const member of ['alias', 'getUser', 'aliasC', 'aliasT', 'run', 'aliasH', 'start', 'stop', 'push', 'missing']) {
      expect(cg.getNodesByName(member), member).toEqual([]);
    }
    // The literal reader: `{ alias: renamed }`, `{ getUser }` bound to a
    // renamed import, an `as const` literal, a holder in its own file.
    expect(callers(cg, 'renamed')).toEqual(['sameFileCaller']);
    expect(callers(cg, 'fetchUser')).toEqual(['sameFileCaller']);
    expect(callers(cg, 'renamedConst')).toEqual(['sameFileCaller']);
    expect(callers(cg, 'impl')).toEqual(['useLocal']);
    // The import resolver: an imported literal's member, and a re-export
    // renamed in a barrel read through a namespace import.
    expect(callers(cg, 'renamedHolder')).toEqual(['sameFileCaller']);
    expect(callers(cg, 'implementation')).toEqual(['sameFileCaller']);
  }, 60_000);

  it('sees a method that a file indexed after a resolution pass declares', async () => {
    // indexAll leaves the resolver's name set loaded; indexFiles then adds a
    // method a new call names. The call is resolved against the new names,
    // as it is without the skip.
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'store.ts'), 'export class Store { save(): number { return 1; } }\n');
    fs.writeFileSync(path.join(dir, 'main.ts'), "import { Store } from './store';\nexport function useStore(store: Store) { return store.save(); }\n");
    const cg = CodeGraph.initSync(dir);
    graphs.push(cg);
    await cg.indexAll();
    fs.writeFileSync(path.join(dir, 'store.ts'), 'export class Store {\n  save(): number { return 1; }\n  restock(): number { return 2; }\n}\n');
    fs.writeFileSync(path.join(dir, 'caller.ts'), "import { Store } from './store';\nexport function useRestock(store: Store) { return store.restock(); }\n");
    await cg.indexFiles(['store.ts', 'caller.ts']);
    cg.resolveReferences();
    const restock = cg.getNodesByName('restock').find((n) => n.kind === 'method');
    expect(restock).toBeDefined();
    expect(cg.getIncomingEdges(restock!.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.source)!.name))
      .toEqual(['useRestock']);
  }, 60_000);

  it('indexes the fixture exactly as it does without the skip', async () => {
    let absent = 0;
    const withSkip = await indexFixture((original) => (name) => {
      const answer = original?.(name) ?? false;
      if (answer) absent++;
      return answer;
    });
    const withoutSkip = await indexFixture(() => undefined);
    // The skip was asked about the calls above and answered for some of them.
    expect(absent).toBeGreaterThan(0);
    expect(dumpGraph(withSkip.dir)).toEqual(dumpGraph(withoutSkip.dir));
  }, 60_000);
});

/** Edges and parked references by natural keys, sorted, as scripts/dump-graph.mjs dumps them. */
function dumpGraph(dir: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, '.codegraph', 'codegraph.db'), { readOnly: true });
  try {
    const rows = [
      ...db.prepare(`SELECT s.qualified_name AS source, t.qualified_name AS target, e.kind, e.line, e.col, e.metadata
        FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target`).all(),
      ...db.prepare(`SELECT from_node_id, reference_name, reference_kind, line, col, status FROM unresolved_refs`).all(),
    ];
    return rows.map((r) => JSON.stringify(r)).sort();
  } finally {
    db.close();
  }
}
