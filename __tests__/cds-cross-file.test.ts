/**
 * CDS (SAP CAP) across a whole project.
 *
 * A CAP model is deliberately spread over layers: `db/` declares the domain,
 * `srv/` projects it into services, `app/` annotates and extends what the
 * service exposes. Every graph fact that matters is therefore cross-file, and
 * each of extraction, import resolution and name resolution can look right on
 * its own while the model still comes out disconnected. This indexes a small
 * but complete project with the real pipeline and pins the connections end to
 * end: the `using` file edges (including a directory resolving to its
 * index.cds and one written with its `.cds` extension), the projection and
 * query sources, the aspect include, the associations and compositions, the
 * extend and annotate targets, a definition declared with a DOTTED name
 * (`entity sap.common.Criticality`, what OData import tooling emits), and the
 * namespace a `using ... as` alias names. What is left unresolved is pinned
 * too, since the value of the CDS branch is that it stays silent rather than
 * guessing: only the reuse artifacts from `@sap/cds/common` remain.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

interface NodeRow {
  kind: string;
  name: string;
  qn: string;
  fp: string;
  exported: number;
  decorators: string | null;
  docstring: string | null;
}
interface EdgeRow {
  kind: string;
  srcQn: string;
  srcFp: string;
  tgtQn: string;
  tgtFp: string;
  same: number;
}

const FILES: Record<string, string> = {
  'db/common/index.cds': `namespace sap.capire.common;

/** Everything an auditor needs to see. */
aspect Auditable {
  createdBy : String;
  createdAt : Timestamp;
}
`,
  'db/codelists.cds': `entity sap.common.Criticality {
  key code : Integer;
  name     : String;
}
`,
  'db/schema.cds': `namespace sap.capire.bookshop;

using { sap.capire.common.Auditable } from './common';
using { sap.common.Criticality } from './codelists.cds';
using { ZPDCDS_SRV.SEPMRA_I_Product_E } from '../srv/external/ZPDCDS_SRV.csn';
using { managed, cuid, Currency } from '@sap/cds/common';

/** A book in the catalog. */
@title: 'Books'
entity Books : cuid, managed, Auditable {
  key ID   : Integer;
  title    : localized String(111) @mandatory;
  author   : Association to Authors;
  genre    : Association to Genres;
  currency : Currency;
  price    : Decimal(9,2);
  criticality : Association to sap.common.Criticality;
  items    : Composition of many OrderItems on items.book = $self;
  status   : String enum { draft; published = 'P'; };
}

entity Authors : cuid {
  name  : String;
  books : Association to many Books on books.author = $self;
}

entity Genres {
  key ID : Integer;
  name   : String;
  books  : Association to many Books on books.genre = $self;
}

entity OrderItems {
  key ID : UUID;
  book   : Association to Books;
  amount : Integer;
}
`,
  'srv/cat-service.cds': `using { sap.capire.bookshop as my } from '../db/schema';

service CatalogService @(path: '/browse') {

  @readonly
  @(UI.HeaderInfo: { TypeName: 'Book' })
  entity ListOfBooks as projection on my.Books excluding { price };

  entity Sales as select from my.Books as b
    join my.Authors as a on b.author.ID = a.ID
    { b.ID as id, a.name as author };

  entity Orders as projection on my.OrderItems actions {
    action cancel();
    function total() returns Decimal;
  }

  action submitOrder(book : my.Books:ID, quantity : Integer) returns { stock : Integer };

  event OrderedBook : { book : UUID; quantity : Integer; }
}
`,
  'app/annotations.cds': `using { CatalogService } from '../srv/cat-service';
using { sap.capire.bookshop as my } from '../db/schema';

annotate CatalogService.ListOfBooks with @UI.HeaderInfo: { TypeName: 'Book' } {
  title @title: 'Title';
};

extend my.Books with { isbn : String; }

extend service CatalogService with {
  entity Extra as projection on my.Authors;
}
`,
};

describe('CDS across a CAP project', () => {
  let dir: string;
  let nodes: NodeRow[];
  let edges: EdgeRow[];
  let unresolved: string[];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cross-file-'));
    for (const [rel, code] of Object.entries(FILES)) {
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), code);
    }
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    nodes = db
      .prepare(
        `SELECT kind, name, qualified_name qn, file_path fp, is_exported exported,
                decorators, docstring
         FROM nodes ORDER BY file_path, start_line`
      )
      .all() as NodeRow[];
    edges = db
      .prepare(
        `SELECT e.kind, s.qualified_name srcQn, s.file_path srcFp,
                t.qualified_name tgtQn, t.file_path tgtFp,
                CASE WHEN e.source = e.target THEN 1 ELSE 0 END same
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         ORDER BY e.kind, srcQn, tgtQn`
      )
      .all() as EdgeRow[];
    unresolved = (
      db.prepare('SELECT DISTINCT reference_name n FROM unresolved_refs ORDER BY n').all() as {
        n: string;
      }[]
    ).map((r) => r.n);
    cg.destroy();
  }, 60000);

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const nodeOf = (qn: string): NodeRow | undefined => nodes.find((n) => n.qn === qn);
  const targetsOf = (srcQn: string, kind: string): string[] =>
    edges.filter((e) => e.kind === kind && e.srcQn === srcQn).map((e) => e.tgtQn).sort();

  it('links every relative `using` to the model file it names', () => {
    // Specifiers are extensionless by convention, `./common` is a DIRECTORY
    // that has to land on its index.cds, and `./codelists.cds` spells the
    // extension out. All three shapes come from a file that opens with a bare
    // `namespace X;`, where the `using` hangs off the namespace node rather
    // than off the file node.
    const fileImports = edges
      .filter((e) => e.kind === 'imports')
      .map((e) => `${e.srcFp} -> ${e.tgtFp}`)
      .sort();
    expect(fileImports).toEqual([
      'app/annotations.cds -> db/schema.cds',
      'app/annotations.cds -> srv/cat-service.cds',
      'db/schema.cds -> db/codelists.cds',
      'db/schema.cds -> db/common/index.cds',
      'srv/cat-service.cds -> db/schema.cds',
    ]);
    expect(
      edges.some((e) => e.kind === 'imports' && e.srcQn === 'sap.capire.bookshop')
    ).toBe(true);
  });

  it('links a dotted entity declared in another file', () => {
    // `entity sap.common.Criticality` is NAMED `Criticality` and qualified
    // `sap.common::Criticality`, which is what makes the association from a
    // namespaced file find it.
    const criticality = nodeOf('sap.common::Criticality');
    expect(criticality?.kind).toBe('class');
    expect(criticality?.name).toBe('Criticality');
    expect(criticality?.fp).toBe('db/codelists.cds');
    expect(nodeOf('sap.common::Criticality::code')?.kind).toBe('field');
    expect(targetsOf('sap.capire.bookshop::Books::criticality', 'references')).toEqual([
      'sap.common::Criticality',
    ]);
  });

  it('links a projection and a joined select to the db entities they read', () => {
    expect(targetsOf('CatalogService::ListOfBooks', 'references')).toEqual([
      'sap.capire.bookshop::Books',
    ]);
    expect(targetsOf('CatalogService::Sales', 'references')).toEqual([
      'sap.capire.bookshop::Authors',
      'sap.capire.bookshop::Books',
    ]);
    expect(targetsOf('CatalogService::Orders', 'references')).toEqual([
      'sap.capire.bookshop::OrderItems',
    ]);
  });

  it('links an aspect include to the aspect', () => {
    // The extractor emits `extends`; resolution promotes it to `implements`
    // because an aspect is an `interface` node and the entity including it is a
    // `class` (see createEdges in src/resolution/index.ts).
    expect(targetsOf('sap.capire.bookshop::Books', 'implements')).toEqual([
      'sap.capire.common::Auditable',
    ]);
  });

  it('links associations and compositions from the element that declares them', () => {
    expect(targetsOf('sap.capire.bookshop::Books::author', 'references')).toEqual([
      'sap.capire.bookshop::Authors',
    ]);
    expect(targetsOf('sap.capire.bookshop::Books::genre', 'references')).toEqual([
      'sap.capire.bookshop::Genres',
    ]);
    expect(targetsOf('sap.capire.bookshop::Books::items', 'references')).toEqual([
      'sap.capire.bookshop::OrderItems',
    ]);
    expect(targetsOf('sap.capire.bookshop::Authors::books', 'references')).toEqual([
      'sap.capire.bookshop::Books',
    ]);
    expect(targetsOf('sap.capire.bookshop::OrderItems::book', 'references')).toEqual([
      'sap.capire.bookshop::Books',
    ]);
  });

  it('links an action to the entity its parameter type names', () => {
    expect(targetsOf('CatalogService::submitOrder', 'references')).toEqual([
      'sap.capire.bookshop::Books',
    ]);
  });

  it('roots an element added by extend at the extended entity', () => {
    const isbn = nodeOf('sap.capire.bookshop::Books::isbn');
    expect(isbn?.kind).toBe('field');
    // The element is declared in the app layer but belongs to the db entity.
    expect(isbn?.fp).toBe('app/annotations.cds');
  });

  it('exposes an entity added by extend service and links its source', () => {
    const extra = nodeOf('CatalogService::Extra');
    expect(extra?.kind).toBe('class');
    expect(extra?.fp).toBe('app/annotations.cds');
    expect(extra?.exported).toBe(1);
    expect(targetsOf('CatalogService::Extra', 'references')).toEqual([
      'sap.capire.bookshop::Authors',
    ]);
  });

  it('links an annotate directive to the artifact it annotates', () => {
    // `annotate` declares no symbol, so the dependency hangs off the file.
    const fromFile = targetsOf('app/annotations.cds', 'references');
    expect(fromFile).toContain('CatalogService::ListOfBooks');
    expect(fromFile).toContain('CatalogService');
  });

  it('links a `using ... as` namespace alias to the namespace node', () => {
    // `using { sap.capire.bookshop as my }` names the namespace itself, which
    // is one dotted node name rather than a `::` scope step.
    expect(targetsOf('srv/cat-service.cds', 'references')).toContain('sap.capire.bookshop');
    expect(targetsOf('app/annotations.cds', 'references')).toContain('sap.capire.bookshop');
    expect(nodeOf('sap.capire.bookshop')?.kind).toBe('namespace');
  });

  it('keeps annotations, keys, enums and doc comments through the pipeline', () => {
    expect(nodeOf('CatalogService')?.decorators).toBe(JSON.stringify(['@path']));
    expect(nodeOf('CatalogService::ListOfBooks')?.decorators).toBe(
      JSON.stringify(['@readonly', '@UI.HeaderInfo'])
    );
    expect(nodeOf('sap.capire.bookshop::Books::ID')?.decorators).toBe(JSON.stringify(['key']));
    expect(nodeOf('sap.capire.bookshop::Books::status::draft')?.kind).toBe('enum_member');
    expect(nodeOf('sap.capire.bookshop::Books')?.docstring).toBe('A book in the catalog.');
  });

  it('never points an edge at its own source', () => {
    const loops = edges.filter((e) => e.same === 1).map((e) => `${e.kind} ${e.srcQn}`);
    expect(loops).toEqual([]);
  });

  it('leaves only the out-of-repo reuse artifacts unresolved', () => {
    // `@sap/cds/common` is a package, not a project file, so it and the three
    // aspects it contributes have nothing in the index to point at. A `.csn`
    // model is a compiled artifact that is not indexed as source, so the
    // specifier and the artifact it imports stay unresolved rather than
    // landing on a same-named node elsewhere. Anything else appearing here is
    // a model fact the pipeline stopped connecting.
    expect(unresolved, `unresolved: ${unresolved.join(', ')}`).toEqual([
      '../srv/external/ZPDCDS_SRV.csn',
      '@sap/cds/common',
      'Currency',
      'ZPDCDS_SRV::SEPMRA_I_Product_E',
      'cuid',
      'managed',
    ]);
  });
});
