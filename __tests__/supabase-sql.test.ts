/**
 * Supabase migrations: what a project's SQL defines, read from
 * `supabase/migrations/*.sql` in file order, so that the last definition wins.
 *
 * Each case is a shape real migrations take: a function redefined many times
 * over, a DROP that retires one, a body that names a CTE the way it names a
 * table, an overload dropped by its argument types.
 */

import { describe, expect, it } from 'vitest';
import { scanMigrations } from '../src/resolution/frameworks/supabase-sql';

const m = (name: string, content: string) => ({ path: `supabase/migrations/${name}`, content });

describe('scanMigrations', () => {
  it('keeps the last definition of a function, by file order', () => {
    const model = scanMigrations([
      m('20260102_b.sql', `CREATE OR REPLACE FUNCTION public.search(q text) RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;`),
      m('20260101_a.sql', `CREATE FUNCTION public.search(q text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`),
    ]);
    expect(model.functions.map((f) => [f.name, f.filePath, f.line])).toEqual([
      ['search', 'supabase/migrations/20260102_b.sql', 1],
    ]);
  });

  it('retires a function a later DROP removes, but not one the same file creates again', () => {
    const model = scanMigrations([
      m('1_a.sql', `CREATE FUNCTION gone() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
CREATE FUNCTION kept() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`),
      m('2_b.sql', `DROP FUNCTION IF EXISTS gone();
DROP FUNCTION IF EXISTS kept(int);
CREATE FUNCTION kept(n int) RETURNS int LANGUAGE sql AS $$ SELECT n $$;`),
    ]);
    expect(model.functions.map((f) => [f.name, f.filePath])).toEqual([['kept', 'supabase/migrations/2_b.sql']]);
  });

  it('reads which tables a body reads and writes, against the tables that exist', () => {
    const model = scanMigrations([
      m('1.sql', `CREATE TABLE public.products (id int);
CREATE TABLE public.inventory (id int);
CREATE TABLE audit_log (id int);
CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  -- a comment naming products must not count
  WITH words AS (SELECT 1)
  SELECT * FROM public.products p JOIN inventory s ON true, words;
  INSERT INTO audit_log VALUES (1);
  RAISE NOTICE 'inventory in a string must not count';
END
$fn$;`),
    ]);
    const f = model.functions[0]!;
    expect(f.reads).toEqual(['inventory', 'products']);
    expect(f.writes).toEqual(['audit_log']);
  });

  it('reads the functions a body calls, including one used as a table in FROM', () => {
    const model = scanMigrations([
      m('1.sql', `CREATE FUNCTION subtree_ids(root int) RETURNS SETOF int LANGUAGE sql AS $$ SELECT 1 $$;
CREATE FUNCTION unaccent_text(t text) RETURNS text LANGUAGE sql AS $$ SELECT t $$;
CREATE FUNCTION search(q text) RETURNS int LANGUAGE sql AS $$
  SELECT count(*) FROM subtree_ids(1) c WHERE unaccent_text(q) <> ''
$$;`),
    ]);
    const search = model.functions.find((f) => f.name === 'search')!;
    expect(search.calls).toEqual(['subtree_ids', 'unaccent_text']);
    expect(model.functions.find((f) => f.name === 'unaccent_text')!.calls).toEqual([]);
  });

  it('does not take a CREATE TABLE inside a function body for a table', () => {
    const model = scanMigrations([
      m('1.sql', `CREATE FUNCTION mk() RETURNS void LANGUAGE plpgsql AS $$
BEGIN EXECUTE 'CREATE TABLE shadow (id int)'; CREATE TEMP TABLE scratch (id int); END $$;`),
    ]);
    expect(model.tables.map((t) => t.name)).toEqual([]);
  });

  it('gives Supabase-owned tables a stand-in, with what reads them', () => {
    const model = scanMigrations([
      m('1.sql', `CREATE FUNCTION account_state(e text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', u.id) FROM auth.users u WHERE u.email = e
$$;`),
    ]);
    expect(model.functions[0]!.reads).toEqual(['auth.users']);
    expect(model.externalTables).toEqual(['auth.users']);
  });

  it('links a trigger to its table and its function, and a policy to its table', () => {
    const model = scanMigrations([
      m('1.sql', `CREATE TABLE public.profiles (id uuid);
CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO public.profiles (id) VALUES (NEW.id); RETURN NEW; END $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
CREATE POLICY "own profile" ON public.profiles FOR SELECT USING (auth.uid() = id);`),
    ]);
    expect(model.triggers.map((t) => [t.name, t.table, t.function])).toEqual([
      ['on_auth_user_created', 'auth.users', 'handle_new_user'],
    ]);
    expect(model.policies.map((p) => [p.name, p.table])).toEqual([['own profile', 'profiles']]);
    expect(model.functions[0]!.writes).toEqual(['profiles']);
    expect(model.externalTables).toEqual(['auth.users']);
  });

  it('counts materialized views among what a body can read', () => {
    const model = scanMigrations([
      m('1.sql', `CREATE MATERIALIZED VIEW public.brand_mv AS SELECT 1 AS x;
CREATE FUNCTION brands() RETURNS SETOF int LANGUAGE sql AS $$ SELECT x FROM public.brand_mv $$;`),
    ]);
    expect(model.views.map((v) => [v.name, v.materialized])).toEqual([['brand_mv', true]]);
    expect(model.functions[0]!.reads).toEqual(['brand_mv']);
  });

  it('reports the line a definition starts on and where its body ends', () => {
    const model = scanMigrations([
      m('1.sql', `-- header

CREATE FUNCTION f() RETURNS int
LANGUAGE sql
AS $$
  SELECT 1
$$;`),
    ]);
    expect([model.functions[0]!.line, model.functions[0]!.endLine]).toEqual([3, 7]);
  });

  it('reads what a view selects from, so a chain through a materialized view holds', () => {
    const model = scanMigrations([
      m('1.sql', `CREATE TABLE products (id int, brand_id int);
CREATE TABLE brands (id int);
CREATE FUNCTION slugify(t text) RETURNS text LANGUAGE sql AS $$ SELECT t $$;
CREATE MATERIALIZED VIEW public.brand_counts AS
  SELECT slugify(b.id::text), count(*) FROM public.brands b JOIN products p ON p.brand_id = b.id
  -- a comment naming orders must not count
  GROUP BY b.id;
CREATE VIEW top_brands AS SELECT * FROM brand_counts LIMIT 10;`),
    ]);
    const byName = Object.fromEntries(model.views.map((v) => [v.name, v]));
    expect(byName.brand_counts!.reads).toEqual(['brands', 'products']);
    expect(byName.brand_counts!.calls).toEqual(['slugify']);
    expect(byName.top_brands!.reads).toEqual(['brand_counts']);
  });

  it('reads the functions and tables a policy expression uses', () => {
    const model = scanMigrations([
      m('1.sql', `CREATE TABLE products (id int);
CREATE TABLE profiles (id uuid, role text);
CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE POLICY "admins write" ON products FOR ALL
  USING (public.is_admin())
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()));`),
    ]);
    expect(model.policies[0]!.calls).toEqual(['is_admin']);
    expect(model.policies[0]!.reads).toEqual(['profiles']);
  });

  it('drops one overload by its argument types and keeps the other', () => {
    const model = scanMigrations([
      m('1.sql', `CREATE FUNCTION f(a int) RETURNS int LANGUAGE sql AS $$ SELECT a $$;
CREATE FUNCTION f(a text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`),
      m('2.sql', `DROP FUNCTION IF EXISTS f(INTEGER);`),
    ]);
    expect(model.functions.map((f) => [f.name, f.signature])).toEqual([
      ['f', 'CREATE FUNCTION f(a text) RETURNS int LANGUAGE sql AS'],
    ]);
  });

  it('takes int and integer, and an argument name, for the same signature', () => {
    const model = scanMigrations([
      m('1.sql', `CREATE FUNCTION g(n INT, s VARCHAR DEFAULT 'x') RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`),
      m('2.sql', `CREATE OR REPLACE FUNCTION g(count integer, label character varying) RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;`),
      m('3.sql', `DROP FUNCTION g(int4, varchar);`),
    ]);
    expect(model.functions).toEqual([]);
  });

  it('reports where a table, a view, a policy and a trigger statement ends', () => {
    const model = scanMigrations([
      m('1.sql', `CREATE TABLE products (
  id int,
  name text
);
CREATE VIEW v AS
  SELECT 1;
CREATE POLICY "p" ON products
  FOR SELECT USING (true);
CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER t AFTER INSERT ON products
  FOR EACH ROW EXECUTE FUNCTION f();`),
    ]);
    expect([model.tables[0]!.line, model.tables[0]!.endLine]).toEqual([1, 4]);
    expect([model.views[0]!.line, model.views[0]!.endLine]).toEqual([5, 6]);
    expect([model.policies[0]!.line, model.policies[0]!.endLine]).toEqual([7, 8]);
    expect([model.triggers[0]!.line, model.triggers[0]!.endLine]).toEqual([10, 11]);
  });
});
