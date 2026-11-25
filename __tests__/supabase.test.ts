/**
 * Supabase end to end: migrations become SQL nodes, and the TypeScript that
 * calls into them by name — `supabase.rpc('x')`, `supabase.from('t')` — gets an
 * edge to them. Without this the TypeScript extractor records those calls but
 * can bind them to nothing: the target is a string.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';

describe('a Supabase project', () => {
  let dir: string;
  let cg: CodeGraph;
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  const node = (name: string, kind: string) => {
    const found = cg.getNodesByName(name).filter((n) => n.kind === kind);
    expect(found, `${kind} ${name}`).toHaveLength(1);
    return found[0]!;
  };
  const targets = (from: string, fromKind: string, edgeKind: string) =>
    cg.getOutgoingEdges(node(from, fromKind).id)
      .filter((e) => e.kind === edgeKind)
      .map((e) => cg.getNode(e.target)!)
      .filter((n) => n.language === 'sql')
      .map((n) => n.name)
      .sort();

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-supabase-'));
    write('package.json', JSON.stringify({ name: 'shop', dependencies: { '@supabase/supabase-js': '^2' } }));
    write('supabase/migrations/20260101000000_schema.sql', `CREATE TABLE public.products (id int, name text);
CREATE TABLE public.invoices (id int);
CREATE FUNCTION public.search(q text) RETURNS SETOF products LANGUAGE sql AS $$
  SELECT * FROM products WHERE name = q
$$;
`);
    write('supabase/migrations/20260102000000_search_v2.sql', `CREATE OR REPLACE FUNCTION public.search(q text) RETURNS SETOF products LANGUAGE sql AS $$
  SELECT p.* FROM public.products p WHERE p.name ILIKE q
$$;
CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO public.invoices (id) VALUES (1); RETURN NEW; END $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
CREATE POLICY "read products" ON public.products FOR SELECT USING (true);
CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE POLICY "admins write" ON public.products FOR ALL USING (public.is_admin());
CREATE MATERIALIZED VIEW public.product_counts AS SELECT count(*) AS n FROM public.products;
CREATE FUNCTION public.counts() RETURNS bigint LANGUAGE sql AS $$ SELECT n FROM public.product_counts $$;
`);
    write('src/catalog.ts', `declare const supabase: any;
declare const admin: any;

export async function searchProducts(q: string) {
  return supabase.rpc('search', { q });
}

export async function loadProducts() {
  return admin
    .from('products')
    .select('*');
}

export async function downloadInvoice() {
  return supabase.storage.from('invoices').download('a.pdf');
}

export function listLetters() {
  return Array.from('products');
}
`);
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('makes the last definition of a function a node, and only that one', () => {
    const search = node('search', 'function');
    expect(search.language).toBe('sql');
    expect(search.filePath).toBe('supabase/migrations/20260102000000_search_v2.sql');
    expect([search.startLine, search.endLine]).toEqual([1, 3]);
  });

  it('makes tables nodes, and gives a Supabase-owned table a stand-in', () => {
    expect(node('products', 'struct').language).toBe('sql');
    expect(node('auth.users', 'struct').signature).toBe('TABLE (Supabase)');
  });

  it('binds supabase.rpc(name) to the SQL function', () => {
    expect(targets('searchProducts', 'function', 'calls')).toEqual(['search']);
  });

  it('binds .from(name) to the table, even with the call broken over lines', () => {
    expect(targets('loadProducts', 'function', 'references')).toEqual(['products']);
  });

  it('never binds a storage bucket to a same-named table', () => {
    const all = cg.getOutgoingEdges(node('downloadInvoice', 'function').id).map((e) => cg.getNode(e.target)!);
    expect(all.filter((n) => n.language === 'sql')).toEqual([]);
  });

  it('never binds Array.from to a table, though the string names one', () => {
    const all = cg.getOutgoingEdges(node('listLetters', 'function').id).map((e) => cg.getNode(e.target)!);
    expect(all.filter((n) => n.language === 'sql')).toEqual([]);
  });

  it('links a body to the tables it reads and writes, with which', () => {
    const reads = cg.getOutgoingEdges(node('search', 'function').id).filter((e) => e.kind === 'references');
    expect(reads.map((e) => [cg.getNode(e.target)!.name, (e.metadata as { access?: string } | undefined)?.access])).toEqual([
      ['products', 'read'],
    ]);
    expect(targets('handle_new_user', 'function', 'references')).toEqual(['invoices']);
  });

  it('links a trigger to its table and its function, and a policy to its table', () => {
    expect(targets('on_auth_user_created', 'property', 'references')).toEqual(['auth.users']);
    expect(targets('on_auth_user_created', 'property', 'calls')).toEqual(['handle_new_user']);
    expect(targets('read products', 'property', 'references')).toEqual(['products']);
  });

  it('links a policy to the functions its expression calls', () => {
    expect(targets('admins write', 'property', 'calls')).toEqual(['is_admin']);
  });

  it('carries a chain through a materialized view: function → view → table', () => {
    expect(targets('counts', 'function', 'references')).toEqual(['product_counts']);
    expect(targets('product_counts', 'struct', 'references')).toEqual(['products']);
  });

  it('shows who calls a SQL function, across the language boundary', () => {
    const callers = cg.getIncomingEdges(node('search', 'function').id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.source)!.name);
    expect(callers).toEqual(['searchProducts']);
  });
});

/**
 * A monorepo of examples, each its own Supabase project with its own
 * `supabase/migrations`. The same table and function names recur in each; one
 * project's code must bind to its own, and one project's migrations must not
 * retire another's definitions.
 */
describe('a monorepo of Supabase projects', () => {
  let dir: string;
  let cg: CodeGraph;
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  const sqlTargetFiles = (from: string, edgeKind: string) => {
    const source = cg.getNodesByName(from).find((n) => n.kind === 'function' && n.language !== 'sql')!;
    return cg.getOutgoingEdges(source.id)
      .filter((e) => e.kind === edgeKind)
      .map((e) => cg.getNode(e.target)!)
      .filter((n) => n.language === 'sql')
      .map((n) => n.filePath);
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-supabase-mono-'));
    write('package.json', JSON.stringify({ name: 'mono', private: true }));
    for (const app of ['alpha', 'beta']) {
      write(`examples/${app}/supabase/migrations/20260101000000_init.sql`, `CREATE TABLE public.profiles (id uuid);
CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO public.profiles (id) VALUES (NEW.id); RETURN NEW; END $$;
`);
      write(`examples/${app}/src/profile.ts`, `declare const supabase: any;
export async function ${app}Profile() {
  await supabase.rpc('handle_new_user');
  return supabase.from('profiles').select('*');
}
`);
    }
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a node per project for a name both define', () => {
    const tables = cg.getNodesByName('profiles').filter((n) => n.language === 'sql' && n.kind === 'struct');
    const functions = cg.getNodesByName('handle_new_user').filter((n) => n.language === 'sql' && n.kind === 'function');
    expect(tables.map((n) => n.filePath).sort()).toEqual([
      'examples/alpha/supabase/migrations/20260101000000_init.sql',
      'examples/beta/supabase/migrations/20260101000000_init.sql',
    ]);
    expect(functions).toHaveLength(2);
  });

  it("binds each project's code to its own project's SQL", () => {
    for (const app of ['alpha', 'beta']) {
      const own = `examples/${app}/supabase/migrations/20260101000000_init.sql`;
      expect(sqlTargetFiles(`${app}Profile`, 'calls')).toEqual([own]);
      expect(sqlTargetFiles(`${app}Profile`, 'references')).toEqual([own]);
    }
  });

  it("links a body to its own project's table", () => {
    for (const app of ['alpha', 'beta']) {
      const fn = cg.getNodesByName('handle_new_user').find((n) => n.filePath.startsWith(`examples/${app}/`))!;
      const targets = cg.getOutgoingEdges(fn.id).filter((e) => e.kind === 'references').map((e) => cg.getNode(e.target)!.filePath);
      expect(targets).toEqual([`examples/${app}/supabase/migrations/20260101000000_init.sql`]);
    }
  });
});
