import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { initGrammars, loadAllGrammars, detectLanguage } from '../src/extraction/grammars';

// The Dataform `.sqlx` extractor. A model's dependencies are named by `ref()` /
// `resolve()` calls inside `${ … }` spans and by the config `dependencies`
// list — never by the SQL tree — so every case below is about the scanner
// finding (or deliberately NOT finding) a call in one of those spans.

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const extract = (sqlx: string, file = 'models/orders.sqlx') => extractFromSource(file, sqlx);

const model = (sqlx: string, file?: string) =>
  extract(sqlx, file).nodes.find((n) => n.kind === 'class');

const refs = (sqlx: string, file?: string) =>
  extract(sqlx, file).unresolvedReferences.map((r) => r.referenceName);

describe('Dataform .sqlx — wiring', () => {
  it('detects a .sqlx file as sql', () => {
    expect(detectLanguage('models/orders.sqlx')).toBe('sql');
  });

  it('emits a file node and exactly one model node', () => {
    const nodes = extract('config { type: "table" }\nSELECT 1\n').nodes;
    expect(nodes.filter((n) => n.kind === 'file')).toHaveLength(1);
    expect(nodes.filter((n) => n.kind === 'class')).toHaveLength(1);
  });
});

describe('Dataform .sqlx — the model node', () => {
  it('names the model after the config name, qualified by the schema', () => {
    const m = model('config { type: "table", schema: "analytics", name: "daily_orders" }\nSELECT 1\n');
    expect(m?.name).toBe('daily_orders');
    expect(m?.qualifiedName).toBe('analytics.daily_orders');
    expect(m?.signature).toBe('table');
  });

  it('falls back to the file stem when config names nothing', () => {
    const m = model('config { type: "view" }\nSELECT 1\n');
    expect(m?.name).toBe('orders');
    expect(m?.qualifiedName).toBe('orders');
  });

  it('handles a file with no config block at all', () => {
    const m = model('SELECT 1\n');
    expect(m?.name).toBe('orders');
    expect(m?.qualifiedName).toBe('orders');
    expect(m?.signature).toBeUndefined();
  });

  it('ignores a name nested inside another config key', () => {
    const m = model(
      'config {\n  schema: "analytics",\n  columns: { name: "the customer name", id: "pk" }\n}\nSELECT 1\n'
    );
    // `columns.name` is a column description, not the model's name.
    expect(m?.name).toBe('orders');
    expect(m?.qualifiedName).toBe('analytics.orders');
  });
});

describe('Dataform .sqlx — ref() forms', () => {
  it('reads ref("name")', () => {
    expect(refs('config { type: "table" }\nSELECT * FROM ${ref("customers")}\n')).toEqual([
      'customers',
    ]);
  });

  it('reads ref("schema", "name") as a dotted qualified name', () => {
    expect(refs('SELECT * FROM ${ref("staging", "customers")}\n')).toEqual(['staging.customers']);
  });

  it('reads ref("database", "schema", "name"), keying on schema and name', () => {
    expect(refs('SELECT * FROM ${ref("my-gcp-project", "staging", "customers")}\n')).toEqual([
      'staging.customers',
    ]);
  });

  it('reads the object form ref({ schema, name })', () => {
    expect(refs('SELECT * FROM ${ref({ schema: "staging", name: "customers" })}\n')).toEqual([
      'staging.customers',
    ]);
  });

  it('reads resolve() the same way as ref()', () => {
    expect(refs('SELECT * FROM ${resolve("customers")}\n')).toEqual(['customers']);
  });

  it('reads several refs across a join, one per distinct target', () => {
    const sqlx =
      'SELECT *\nFROM ${ref("customers")} c\nJOIN ${ref("payments")} p USING (id)\n' +
      'WHERE c.id IN (SELECT id FROM ${ref("customers")})\n';
    expect(refs(sqlx)).toEqual(['customers', 'payments']);
  });

  it('does not treat self() as a reference', () => {
    expect(refs('config { type: "incremental" }\nSELECT * FROM ${self()} WHERE 1=1\n')).toEqual([]);
  });

  it('drops a ref whose argument is not a literal', () => {
    expect(refs('SELECT * FROM ${ref(sourceName)}\n')).toEqual([]);
  });

  it('reads a ref() from a pre_operations / post_operations block', () => {
    const sqlx =
      'config { type: "table" }\n' +
      'pre_operations {\n  DELETE FROM ${self()} WHERE id IN (SELECT id FROM ${ref("purges")})\n}\n' +
      'SELECT 1\n' +
      'post_operations {\n  GRANT SELECT ON ${self()} TO ${ref("readers")}\n}\n';
    expect(refs(sqlx)).toEqual(['purges', 'readers']);
  });

  it('reads a ref() inside a backtick-quoted BigQuery identifier', () => {
    // A backtick quotes an IDENTIFIER in BigQuery, so what it holds is still
    // interpolated — unlike a single- or double-quoted string.
    expect(refs('SELECT * FROM `${ref("staging", "customers")}`\n')).toEqual([
      'staging.customers',
    ]);
  });
});

describe('Dataform .sqlx — config dependencies', () => {
  it('reads each entry of the dependencies array', () => {
    const sqlx =
      'config {\n  type: "table",\n  dependencies: ["customers", "staging.payments"]\n}\nSELECT 1\n';
    expect(refs(sqlx)).toEqual(['customers', 'staging.payments']);
  });

  it('merges dependencies with refs without duplicating a target', () => {
    const sqlx =
      'config { type: "table", dependencies: ["customers", "audit_log"] }\n' +
      'SELECT * FROM ${ref("customers")}\n';
    expect(refs(sqlx)).toEqual(['customers', 'audit_log']);
  });
});

describe('Dataform .sqlx — the js block', () => {
  it('reads a ref() from a js block', () => {
    const sqlx =
      'js {\n  const source = ref("customers");\n}\nSELECT * FROM ${source}\n';
    expect(refs(sqlx)).toEqual(['customers']);
  });

  it('reads a ref() from inside a template literal in a js block', () => {
    const sqlx =
      'js {\n  function pick() { return `SELECT * FROM ${ref("payments")}`; }\n}\nSELECT 1\n';
    expect(refs(sqlx)).toEqual(['payments']);
  });

  it('reads ctx.ref() the same as a bare ref()', () => {
    expect(refs('SELECT * FROM ${ctx.ref("customers")}\n')).toEqual(['customers']);
  });
});

describe('Dataform .sqlx — comments and strings produce nothing', () => {
  it('ignores a ref() behind a -- comment', () => {
    expect(refs('SELECT 1\n-- old: SELECT * FROM ${ref("customers")}\n')).toEqual([]);
  });

  it('ignores a ref() behind a // comment inside a js block', () => {
    expect(refs('js {\n  // const old = ref("customers");\n}\nSELECT 1\n')).toEqual([]);
  });

  it('ignores a ref() inside a /* */ comment', () => {
    expect(refs('SELECT 1\n/* was ${ref("customers")} */\n')).toEqual([]);
  });

  it('ignores a ref() inside a string literal', () => {
    expect(refs(`SELECT 'ref("customers")' AS note FROM t\n`)).toEqual(['t']);
  });

  it('does not let a config comment hide the real config keys', () => {
    const m = model(
      'config {\n  // name: "wrong",\n  type: "view",\n  name: "right"\n}\nSELECT 1\n'
    );
    expect(m?.name).toBe('right');
    expect(m?.signature).toBe('view');
  });
});

describe('Dataform .sqlx — the SQL body', () => {
  it('still references a literal source table a FROM names', () => {
    const sqlx = 'config { type: "table" }\nSELECT * FROM raw_events\n';
    expect(refs(sqlx)).toContain('raw_events');
  });
});

describe('Dataform .sqlx — end to end', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('creates a references edge from one model to the model it refs', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sqlx-'));
    fs.mkdirSync(path.join(tmpDir, 'models'));
    fs.writeFileSync(
      path.join(tmpDir, 'models/customers.sqlx'),
      'config { type: "table", schema: "analytics" }\nSELECT id, email FROM raw_customers\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'models/orders.sqlx'),
      'config { type: "table", schema: "analytics" }\n' +
        'SELECT o.id, c.email\nFROM raw_orders o\nJOIN ${ref("customers")} c ON c.id = o.customer_id\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const models = cg.getNodesByKind('class');
    const orders = models.find((n) => n.name === 'orders');
    const customers = models.find((n) => n.name === 'customers');
    expect(orders).toBeDefined();
    expect(customers).toBeDefined();
    expect(customers!.qualifiedName).toBe('analytics.customers');

    const edge = cg.getOutgoingEdges(orders!.id).find((e) => e.target === customers!.id);
    expect(edge).toBeDefined();
    expect(edge!.kind).toBe('references');

    cg.close();
  });
});
