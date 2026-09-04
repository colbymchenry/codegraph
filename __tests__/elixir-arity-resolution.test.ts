/**
 * Elixir arity-aware resolution.
 *
 * Arity is part of a function's identity: `f/1` and `f/2` are unrelated
 * definitions. Extraction gives each arity its own node (`Mod::f/1`) and
 * stamps refs with the call-site arity; resolution must land each ref on the
 * def of exactly that arity — except default-args (`def foo(a, b \\ 1)`),
 * which index as the max arity and accept a shorter call when that file
 * defines exactly one function of the name.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('elixir arity-aware resolution', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elixir-arity-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  async function callEdges(d: string): Promise<Array<{ sq: string; tq: string }>> {
    const cg = await CodeGraph.init(d, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT s.qualified_name sq, t.qualified_name tq
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind IN ('calls','references') AND s.kind = 'function'`
      )
      .all();
    cg.destroy();
    return rows;
  }

  it('resolves the f/N -> f/N+1 delegation to a real edge, not a self-loop', async () => {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'lib', 'deleg.ex'),
      `defmodule Deleg do
  def header(name, req) do
    header(name, req, nil)
  end

  def header(name, headers, default) do
    Map.get(headers, name, default)
  end
end
`
    );
    const edges = await callEdges(dir);
    expect(edges).toContainEqual({ sq: 'Deleg::header/2', tq: 'Deleg::header/3' });
    expect(edges.some((e) => e.sq === e.tq && e.sq.startsWith('Deleg::header'))).toBe(false);
  });

  it('resolves remote calls to the called arity and refuses a sibling arity', async () => {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'lib', 'store.ex'),
      `defmodule Store do
  def get(k), do: get(k, nil)
  def get(k, default), do: {k, default}
end
`
    );
    fs.writeFileSync(
      path.join(dir, 'lib', 'client.ex'),
      `defmodule Client do
  def fetch(k), do: Store.get(k, nil)
  def broken(k), do: Store.get(k, nil, :extra)
end
`
    );
    const edges = await callEdges(dir);
    expect(edges).toContainEqual({ sq: 'Client::fetch/1', tq: 'Store::get/2' });
    expect(edges.some((e) => e.sq === 'Client::broken/1' && e.tq.startsWith('Store::get'))).toBe(false);
  });

  it('resolves a shorter call onto a default-args def when it is the only arity', async () => {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'lib', 'opts.ex'),
      `defmodule Opts do
  def get(id, opts \\\\ []) do
    {id, opts}
  end

  def run(id), do: get(id)
end
`
    );
    const edges = await callEdges(dir);
    expect(edges).toContainEqual({ sq: 'Opts::run/1', tq: 'Opts::get/2' });
  });

  it('resolves aliased remote calls across files', async () => {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'lib', 'repo.ex'),
      `defmodule MyApp.Repo do
  def get(schema, id), do: {schema, id}
end
`
    );
    fs.writeFileSync(
      path.join(dir, 'lib', 'accounts.ex'),
      `defmodule MyApp.Accounts do
  alias MyApp.Repo

  def get_user(id), do: Repo.get(User, id)
end
`
    );
    const edges = await callEdges(dir);
    expect(edges).toContainEqual({ sq: 'MyApp.Accounts::get_user/1', tq: 'MyApp.Repo::get/2' });
  });
});
