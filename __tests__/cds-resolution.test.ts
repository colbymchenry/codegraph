/**
 * CDS (SAP CAP) reference resolution.
 *
 * CDS name resolution is lexical and the names are ordinary words (`Books`,
 * `Currency`, `Status`), so the matcher has to be exact or silent: a service's
 * own projection shadows a same-named db entity, a namespace-qualified name
 * means that one artifact and no other, and a projection on a same-named
 * entity must never resolve to itself. Everything below pins those rules plus
 * the `using ... from` file lookup, on synthetic nodes so the suite does not
 * depend on the CDS grammar being loadable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Node, UnresolvedReference } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import { matchReference } from '../src/resolution/name-matcher';
import { resolveImportPath } from '../src/resolution/import-resolver';
import { matchesSymbol } from '../src/graph/named-symbol-flow';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { createResolver } from '../src/resolution';

function node(
  kind: Node['kind'],
  name: string,
  qualifiedName: string,
  filePath: string,
  language: Node['language'] = 'cds',
  startLine = 1
): Node {
  return {
    id: `${kind}:${filePath}:${qualifiedName}:${startLine}`,
    kind,
    name,
    qualifiedName,
    filePath,
    language,
    startLine,
    endLine: startLine + 3,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

function contextOf(nodes: Node[]): ResolutionContext {
  return {
    getNodesInFile: (filePath) => nodes.filter((n) => n.filePath === filePath),
    getNodesByName: (name) => nodes.filter((n) => n.name === name),
    getNodesByQualifiedName: (qn) => nodes.filter((n) => n.qualifiedName === qn),
    getNodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
    getNodesByLowerName: (lower) => nodes.filter((n) => n.name.toLowerCase() === lower),
    getNodeById: (id) => nodes.find((n) => n.id === id) ?? null,
    fileExists: () => false,
    readFile: () => null,
    getProjectRoot: () => '/proj',
    getAllFiles: () => [...new Set(nodes.map((n) => n.filePath))],
    getImportMappings: () => [],
  };
}

function cdsRef(
  fromNodeId: string,
  referenceName: string,
  filePath: string,
  referenceKind: UnresolvedRef['referenceKind'] = 'references'
): UnresolvedRef {
  return {
    fromNodeId,
    referenceName,
    referenceKind,
    line: 4,
    column: 2,
    filePath,
    language: 'cds',
  };
}

// A two-file CAP model:
//
//   db/schema.cds        namespace sap.capire.bookshop;
//                        entity Books { ... }  entity Authors { ... }
//   srv/cat-service.cds  using { sap.capire.bookshop as my } from '../db/schema';
//                        service CatalogService {
//                          entity Books as projection on my.Books;
//                          entity ListOfBooks as projection on Books;
//                        }
const DB_FILE = 'db/schema.cds';
const SRV_FILE = 'srv/cat-service.cds';
const dbNamespace = node('namespace', 'sap.capire.bookshop', 'sap.capire.bookshop', DB_FILE);
const dbBooks = node('class', 'Books', 'sap.capire.bookshop::Books', DB_FILE, 'cds', 3);
const dbAuthors = node('class', 'Authors', 'sap.capire.bookshop::Authors', DB_FILE, 'cds', 12);
const srvService = node('module', 'CatalogService', 'CatalogService', SRV_FILE, 'cds', 3);
const srvBooks = node('class', 'Books', 'CatalogService::Books', SRV_FILE, 'cds', 4);
const srvListOfBooks = node('class', 'ListOfBooks', 'CatalogService::ListOfBooks', SRV_FILE, 'cds', 5);
const MODEL = [dbNamespace, dbBooks, dbAuthors, srvService, srvBooks, srvListOfBooks];

describe('CDS name resolution', () => {
  it('resolves a bare name to the enclosing service before the db entity', () => {
    // `entity ListOfBooks as projection on Books` inside CatalogService means
    // the service's own projection, not the namespaced db entity of the same
    // name. The scope chain walks CatalogService::ListOfBooks -> CatalogService
    // and finds CatalogService::Books there.
    const result = matchReference(
      cdsRef(srvListOfBooks.id, 'Books', SRV_FILE),
      contextOf(MODEL)
    );
    expect(result?.targetNodeId).toBe(srvBooks.id);
    expect(result?.confidence).toBe(0.95);
    expect(result?.resolvedBy).toBe('qualified-name');
  });

  it('resolves an alias-expanded namespace-qualified name across files', () => {
    // `projection on my.Books` with `using { sap.capire.bookshop as my }`
    // reaches the matcher already expanded, as `sap.capire.bookshop::Books`.
    const result = matchReference(
      cdsRef(srvBooks.id, 'sap.capire.bookshop::Books', SRV_FILE),
      contextOf(MODEL)
    );
    expect(result?.targetNodeId).toBe(dbBooks.id);
    expect(result?.confidence).toBe(0.95);
  });

  it('resolves a namespace-alias using to the namespace it names', () => {
    // `using { sap.capire.bookshop as my }` references the NAMESPACE, and the
    // reference format splits the last dot off: `sap.capire::bookshop`. The
    // namespace node carries the whole path as one name, so the lookup only
    // finds it by the full dotted spelling.
    const result = matchReference(
      cdsRef(srvBooks.id, 'sap.capire::bookshop', SRV_FILE),
      contextOf(MODEL)
    );
    expect(result?.targetNodeId).toBe(dbNamespace.id);
    expect(result?.confidence).toBe(0.95);
    expect(result?.resolvedBy).toBe('qualified-name');
  });

  it('returns null when two other files declare the same namespace', () => {
    // A namespace split across model files is ordinary CDS; with no signal to
    // pick one, the using stays unresolved rather than naming an arbitrary half.
    const twin = node('namespace', 'sap.capire.bookshop', 'sap.capire.bookshop', 'db/more.cds');
    const result = matchReference(
      cdsRef(srvBooks.id, 'sap.capire::bookshop', SRV_FILE),
      contextOf([...MODEL, twin])
    );
    expect(result).toBeNull();
  });

  it('prefers the call-site file when it declares one of the two namespaces', () => {
    const localHalf = node('namespace', 'sap.capire.bookshop', 'sap.capire.bookshop', SRV_FILE, 'cds', 9);
    const result = matchReference(
      cdsRef(srvBooks.id, 'sap.capire::bookshop', SRV_FILE),
      contextOf([...MODEL, localHalf])
    );
    expect(result?.targetNodeId).toBe(localHalf.id);
  });

  it('never resolves a projection named after its own source to itself', () => {
    // `entity Books as projection on Books` inside a service: the FROM node is
    // dropped from the candidate set, so the only Books left is the db one.
    const result = matchReference(cdsRef(srvBooks.id, 'Books', SRV_FILE), contextOf(MODEL));
    expect(result?.targetNodeId).toBe(dbBooks.id);
    expect(result?.confidence).toBe(0.8);
  });

  it('resolves an annotate target that names an action', () => {
    // `annotate srv.criticalAction with @(...)` targets an ACTION. An action is
    // an ordinary CDS definition reference target, so the candidate kinds have
    // to include the function and method nodes actions become.
    const service = node('module', 'LROPODataService', 'LROPODataService', SRV_FILE, 'cds', 3);
    const action = node('function', 'criticalAction', 'LROPODataService::criticalAction', SRV_FILE, 'cds', 20);
    const annotations = node('file', 'annotations.cds', 'app/annotations.cds', 'app/annotations.cds');
    const result = matchReference(
      cdsRef(annotations.id, 'LROPODataService::criticalAction', 'app/annotations.cds'),
      contextOf([service, action, annotations])
    );
    expect(result?.targetNodeId).toBe(action.id);
    expect(result?.confidence).toBe(0.95);
  });

  it('prefers an entity in the caller scope over a same-named action elsewhere', () => {
    // Adding actions to the candidate kinds must not loosen the scope rule: the
    // service's own entity still shadows an action of the same name elsewhere.
    const otherAction = node('function', 'Report', 'OtherService::Report', 'srv/other.cds', 'cds', 7);
    const scopedEntity = node('class', 'Report', 'CatalogService::Report', SRV_FILE, 'cds', 8);
    const result = matchReference(
      cdsRef(srvBooks.id, 'Report', SRV_FILE),
      contextOf([...MODEL, otherAction, scopedEntity])
    );
    expect(result?.targetNodeId).toBe(scopedEntity.id);
  });

  it('returns null when an entity and an action share one qualified name', () => {
    const entity = node('class', 'Report', 'analytics::Report', 'db/reports.cds');
    const action = node('function', 'Report', 'analytics::Report', 'srv/reports.cds');
    const caller = node('class', 'Orders', 'analytics::Orders', 'db/orders.cds');
    const result = matchReference(
      cdsRef(caller.id, 'Report', 'db/orders.cds'),
      contextOf([entity, action, caller])
    );
    expect(result).toBeNull();
  });

  it('resolves an extends ref to an aspect through the same scope chain', () => {
    const managed = node('interface', 'managed', 'sap.common::managed', 'db/common.cds');
    const result = matchReference(
      cdsRef(dbBooks.id, 'sap.common::managed', DB_FILE, 'extends'),
      contextOf([...MODEL, managed])
    );
    expect(result?.targetNodeId).toBe(managed.id);
  });

  it('returns null when two same-named artifacts are equally plausible', () => {
    const bookshopCurrency = node('type_alias', 'Currency', 'sap.capire.bookshop::Currency', DB_FILE);
    const reviewsCurrency = node('type_alias', 'Currency', 'sap.capire.reviews::Currency', 'db/reviews.cds');
    const caller = node('class', 'Orders', 'sap.capire.orders::Orders', 'db/orders.cds');
    const result = matchReference(
      cdsRef(caller.id, 'Currency', 'db/orders.cds'),
      contextOf([caller, bookshopCurrency, reviewsCurrency])
    );
    expect(result).toBeNull();
  });

  it('prefers the call-site file when several same-named artifacts exist', () => {
    const localStatus = node('type_alias', 'Status', 'local::Status', 'db/orders.cds');
    const remoteStatus = node('type_alias', 'Status', 'other::Status', 'db/other.cds');
    const caller = node('class', 'Orders', 'orders::Orders', 'db/orders.cds', 'cds', 9);
    const result = matchReference(
      cdsRef(caller.id, 'Status', 'db/orders.cds'),
      contextOf([caller, localStatus, remoteStatus])
    );
    expect(result?.targetNodeId).toBe(localStatus.id);
    expect(result?.confidence).toBe(0.85);
  });

  it('returns null for an unknown name and for a dotted name with no exact FQN', () => {
    const ctx = contextOf(MODEL);
    expect(matchReference(cdsRef(srvBooks.id, 'Genres', SRV_FILE), ctx)).toBeNull();
    // The artifact exists but under another namespace: an FQN either matches
    // exactly or the model means something out of repo (`sap.common::CodeList`).
    expect(matchReference(cdsRef(srvBooks.id, 'sap.capire.reviews::Books', SRV_FILE), ctx)).toBeNull();
    expect(matchReference(cdsRef(srvBooks.id, 'sap.common::CodeList', SRV_FILE), ctx)).toBeNull();
  });

  it('never resolves a CDS reference to a same-named node in another language', () => {
    const tsBooks = node('class', 'Books', 'Books', 'src/models/Books.ts', 'typescript');
    const tsAspect = node('class', 'managed', 'managed', 'src/models/managed.ts', 'typescript');
    const caller = node('class', 'Orders', 'orders::Orders', 'db/orders.cds');
    const ctx = contextOf([caller, tsBooks, tsAspect]);
    expect(matchReference(cdsRef(caller.id, 'Books', 'db/orders.cds'), ctx)).toBeNull();
    // `extends` is not language-gated by the resolver, so the branch itself
    // has to hold the line.
    expect(matchReference(cdsRef(caller.id, 'managed', 'db/orders.cds', 'extends'), ctx)).toBeNull();
  });

  it('never resolves a CDS reference to an element of a same-named entity', () => {
    // A `field` node named `Books` (a column called Books) is not an artifact.
    const field = node('field', 'Books', 'sap.capire.orders::Order::Books', 'db/orders.cds');
    const caller = node('class', 'Orders', 'sap.capire.orders::Order', 'db/orders.cds');
    const result = matchReference(cdsRef(caller.id, 'Books', 'db/orders.cds'), contextOf([caller, field]));
    expect(result).toBeNull();
  });
});

describe('CDS using-from path resolution', () => {
  function pathContext(files: string[]): ResolutionContext {
    const ctx = contextOf([]);
    return { ...ctx, fileExists: (f) => files.includes(f), getAllFiles: () => files };
  }

  it('resolves an extensionless relative specifier to the .cds file', () => {
    const ctx = pathContext(['db/schema.cds', 'srv/cat-service.cds']);
    expect(resolveImportPath('../db/schema', SRV_FILE, 'cds', ctx)).toBe('db/schema.cds');
  });

  it('resolves a directory specifier to its index.cds', () => {
    const ctx = pathContext(['srv/common/index.cds', SRV_FILE]);
    expect(resolveImportPath('./common', SRV_FILE, 'cds', ctx)).toBe('srv/common/index.cds');
  });

  it('resolves a specifier that already carries the .cds extension', () => {
    const ctx = pathContext(['db/schema.cds', SRV_FILE]);
    expect(resolveImportPath('../db/schema.cds', SRV_FILE, 'cds', ctx)).toBe('db/schema.cds');
  });

  it('treats reuse packages as external instead of guessing a project file', () => {
    // A CAP project has a `common.cds` of its own more often than not; a
    // `@sap/cds/common` import must not land on it.
    const ctx = pathContext(['common.cds', 'srv/cat-service.cds', 'db/common/index.cds']);
    expect(resolveImportPath('@sap/cds/common', SRV_FILE, 'cds', ctx)).toBeNull();
    expect(resolveImportPath('some-reuse-package', SRV_FILE, 'cds', ctx)).toBeNull();
  });

  it('resolves only .cds and index.cds, never a .csn or .json model', () => {
    // A `cds import`ed external service lands as `srv/external/X.csn` next to
    // the model, and CAP's own `using ... from './external/X'` would find it.
    // codegraph indexes CDS sources only, so the extension list stops at
    // `.cds` / `/index.cds` and an extensionless specifier that could only
    // land on a compiled model resolves to nothing at all.
    const ctx = pathContext([
      'db/schema.cds',
      'srv/external/ZPDCDS_SRV.csn',
      'srv/external/other.json',
    ]);
    expect(resolveImportPath('../srv/external/ZPDCDS_SRV', DB_FILE, 'cds', ctx)).toBeNull();
    expect(resolveImportPath('../srv/external/other', DB_FILE, 'cds', ctx)).toBeNull();
    expect(resolveImportPath('./schema', DB_FILE, 'cds', ctx)).toBe('db/schema.cds');
  });

  it('keeps a bare specifier external even when a project file would absorb it', () => {
    // The reuse-package rule has to hold BEFORE any probing: here the project
    // carries a `some-reuse-package.cds` the direct-path probe would hit and a
    // `paths` alias whose `src/*` rewrite would hit `src/...` for both
    // specifiers. `using ... from` takes a relative path or a node module
    // specifier and nothing else, so neither may be resolved by shape alone.
    const files = [
      'app.cds',
      SRV_FILE,
      'some-reuse-package.cds',
      'src/some-reuse-package/index.cds',
      'src/@sap/cds/common.cds',
    ];
    const ctx: ResolutionContext = {
      ...pathContext(files),
      getProjectAliases: () => ({
        baseUrl: '/proj',
        patterns: [{ prefix: '', suffix: '', hasWildcard: true, replacements: ['src/*'] }],
      }),
    };
    expect(resolveImportPath('some-reuse-package', 'app.cds', 'cds', ctx)).toBeNull();
    expect(resolveImportPath('@sap/cds/common', 'app.cds', 'cds', ctx)).toBeNull();
    // The same name written relative IS a model file, and still resolves.
    expect(resolveImportPath('./some-reuse-package', 'app.cds', 'cds', ctx)).toBe(
      'some-reuse-package.cds'
    );
  });
});

describe('CDS refs through the resolver pipeline', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cds-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
    fs.mkdirSync(path.join(dir, 'db'));
    fs.mkdirSync(path.join(dir, 'srv'));
    fs.writeFileSync(path.join(dir, DB_FILE), 'namespace sap.capire.bookshop;\nentity Books { key ID : UUID; }\n');
    fs.writeFileSync(
      path.join(dir, SRV_FILE),
      "using { sap.capire.bookshop as my } from '../db/schema';\nservice CatalogService { entity Books as projection on my.Books; }\n"
    );
    for (const n of MODEL) q.insertNode(n);
    q.insertNode(node('file', 'schema.cds', DB_FILE, DB_FILE));
    q.insertNode(node('file', 'cat-service.cds', SRV_FILE, SRV_FILE));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function persist(refs: UnresolvedRef[]): ReturnType<ReturnType<typeof createResolver>['resolveAndPersist']> {
    const resolver = createResolver(dir, q);
    return resolver.resolveAndPersist(refs as UnresolvedReference[]);
  }

  it('carries an A.B::C reference past the existence pre-filter', () => {
    // The pre-filter keys a `::` name on its last segment; without that,
    // `sap.capire.bookshop::Books` never reaches the CDS branch at all.
    const result = persist([cdsRef(srvBooks.id, 'sap.capire.bookshop::Books', SRV_FILE)]);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]?.targetNodeId).toBe(dbBooks.id);
  });

  it('carries a namespace reference past the existence pre-filter', () => {
    // `sap.capire::bookshop` has no segment named `bookshop`; only the full
    // dotted form matches the namespace node's one-segment name, so the
    // pre-filter has to try that spelling or the ref never reaches the matcher.
    const result = persist([cdsRef(srvBooks.id, 'sap.capire::bookshop', SRV_FILE)]);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]?.targetNodeId).toBe(dbNamespace.id);
  });

  it('resolves a using-from specifier to the imported model file', () => {
    const result = persist([cdsRef(srvBooks.id, '../db/schema', SRV_FILE, 'imports')]);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]?.targetNodeId).toBe(`file:${DB_FILE}:${DB_FILE}:1`);
  });

  it('leaves a reuse-package using unresolved rather than name-matching it', () => {
    const result = persist([cdsRef(srvBooks.id, '@sap/cds/common', SRV_FILE, 'imports')]);
    expect(result.resolved).toHaveLength(0);
  });

  it('keeps a CDS reference off a same-named node in another language', () => {
    q.insertNode(node('class', 'Genres', 'Genres', 'src/Genres.ts', 'typescript'));
    const result = persist([cdsRef(srvBooks.id, 'Genres', SRV_FILE)]);
    expect(result.resolved).toHaveLength(0);
  });

  it('keeps a TypeScript call off a same-named CDS action', () => {
    // The reverse direction of the guard above. A CAP handler reaches an
    // action through `srv.on('submitOrder', ...)`, a string the graph never
    // name-matches; a TS function CALLED `submitOrder` is some other function,
    // so the CDS action must not become its target. Name matching on its own
    // takes that exact-name match (at 0.5), so the rule has to hold in the
    // resolver, which is why this goes through the real pipeline.
    const action = node('function', 'submitOrder', 'CatalogService::submitOrder', SRV_FILE, 'cds', 6);
    const handler = node('function', 'run', 'run', 'srv/handler.ts', 'typescript', 2);
    q.insertNode(action);
    q.insertNode(handler);
    q.insertNode(node('file', 'handler.ts', 'srv/handler.ts', 'srv/handler.ts', 'typescript'));
    const tsCall: UnresolvedRef = {
      fromNodeId: handler.id,
      referenceName: 'submitOrder',
      referenceKind: 'calls',
      line: 3,
      column: 9,
      filePath: 'srv/handler.ts',
      language: 'typescript',
    };
    expect(persist([tsCall]).resolved).toHaveLength(0);
    // Controls: the action IS reachable, from a CDS reference naming it, and
    // ordinary CDS name resolution is unaffected.
    const fromCds = persist([cdsRef(srvBooks.id, 'CatalogService::submitOrder', SRV_FILE)]);
    expect(fromCds.resolved[0]?.targetNodeId).toBe(action.id);
    const books = persist([cdsRef(srvBooks.id, 'Books', SRV_FILE)]);
    expect(books.resolved).toHaveLength(1);
    expect(books.resolved[0]?.targetNodeId).toBe(dbBooks.id);
  });

  it('leaves a using that names a compiled .csn model unresolved', () => {
    // `cds import` writes `srv/external/<service>.csn`, so the file really is
    // on disk next to the model; it is not a CDS SOURCE file, so nothing
    // indexes it and the using has no file node to point at.
    fs.mkdirSync(path.join(dir, 'srv', 'external'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'srv/external/ZPDCDS_SRV.csn'), '{"definitions":{}}\n');
    const result = persist([
      cdsRef(srvBooks.id, '../srv/external/ZPDCDS_SRV.csn', DB_FILE, 'imports'),
    ]);
    expect(result.resolved).toHaveLength(0);
  });
});

describe('named-symbol lookup over CDS qualified names', () => {
  it('matches a namespace-dotted CDS FQN against its :: qualified name', () => {
    expect(matchesSymbol(dbBooks, 'sap.capire.bookshop.Books')).toBe(true);
    expect(matchesSymbol(dbBooks, 'Books')).toBe(true);
    // A different namespace with the same leaf must not match.
    expect(matchesSymbol(dbBooks, 'sap.capire.reviews.Books')).toBe(false);
  });

  it('matches a service-scoped and an element-scoped CDS name', () => {
    expect(matchesSymbol(srvBooks, 'CatalogService.Books')).toBe(true);
    const title = node('field', 'title', 'sap.capire.bookshop::Books::title', DB_FILE);
    expect(matchesSymbol(title, 'Books.title')).toBe(true);
  });
});
