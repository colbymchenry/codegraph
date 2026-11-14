import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('Elixir extraction and resolution', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elixir-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('extracts Elixir modules, functions with arity, private functions, and docstrings', async () => {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'lib', 'math.ex'),
      `defmodule MyApp.Math do
  @moduledoc """
  Math utilities.
  """

  @doc """
  Add two numbers.
  """
  def add(a, b), do: a + b

  def add(a, b, c) do
    a + b + c
  end

  defp secret(x) do
    x * 42
  end
end
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const nodes = db
      .prepare(`SELECT kind, name, qualified_name, visibility, docstring FROM nodes WHERE language = 'elixir'`)
      .all();

    cg.destroy();

    const moduleNode = nodes.find((n: any) => n.kind === 'module');
    expect(moduleNode).toBeDefined();
    expect(moduleNode.name).toBe('MyApp.Math');
    expect(moduleNode.docstring).toContain('Math utilities');

    const add2 = nodes.find((n: any) => n.qualified_name === 'MyApp.Math::add/2');
    expect(add2).toBeDefined();
    expect(add2.visibility).toBe('public');
    expect(add2.docstring).toContain('Add two numbers');

    const add3 = nodes.find((n: any) => n.qualified_name === 'MyApp.Math::add/3');
    expect(add3).toBeDefined();
    expect(add3.visibility).toBe('public');

    const secret = nodes.find((n: any) => n.qualified_name === 'MyApp.Math::secret/1');
    expect(secret).toBeDefined();
    expect(secret.visibility).toBe('private');
  });

  it('merges multiple clauses of the same function with the same arity', async () => {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'lib', 'util.ex'),
      `defmodule MyApp.Util do
  def format(nil), do: ""
  def format(val) when is_binary(val) do
    String.trim(val)
  end
  def format(val), do: to_string(val)
end
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const fnNodes = db
      .prepare(`SELECT name, qualified_name FROM nodes WHERE kind = 'function' AND language = 'elixir'`)
      .all();

    cg.destroy();

    // Multiple clauses of format/1 must be merged into ONE function node
    expect(fnNodes.length).toBe(1);
    expect(fnNodes[0].name).toBe('format');
    expect(fnNodes[0].qualified_name).toBe('MyApp.Util::format/1');
  });

  it('resolves remote calls, local calls, and pipe operator |> calls with arity adjustment', async () => {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'lib', 'math.ex'),
      `defmodule MyApp.Math do
  def double(x), do: x * 2
  def add(a, b), do: a + b
end
`
    );

    fs.writeFileSync(
      path.join(dir, 'lib', 'pipeline.ex'),
      `defmodule MyApp.Pipeline do
  alias MyApp.Math

  def run(input) do
    input
    |> Math.double()
    |> local_step(10)
  end

  def local_step(x, bonus) do
    x + bonus
  end
end
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const edges = db
      .prepare(
        `SELECT s.qualified_name sq, t.qualified_name tq, e.kind
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE s.language = 'elixir'`
      )
      .all();

    cg.destroy();

    // Pipe |> Math.double() on input is calling MyApp.Math::double/1
    expect(edges).toContainEqual({
      sq: 'MyApp.Pipeline::run/1',
      tq: 'MyApp.Math::double/1',
      kind: 'calls',
    });

    // Pipe |> local_step(10) with piped input is calling MyApp.Pipeline::local_step/2
    expect(edges).toContainEqual({
      sq: 'MyApp.Pipeline::run/1',
      tq: 'MyApp.Pipeline::local_step/2',
      kind: 'calls',
    });
  });

  it('extracts multi-aliases (alias Foo.{Bar, Baz}) correctly as imports and resolves calls', async () => {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'lib', 'services.ex'),
      `defmodule MyApp.Services.Auth do
  def login, do: :ok
end

defmodule MyApp.Services.Payment do
  def process, do: :ok
end

defmodule MyApp.Repo do
  def get, do: :ok
end
`
    );

    fs.writeFileSync(
      path.join(dir, 'lib', 'nested.ex'),
      `defmodule MyApp.Consumer do
  alias MyApp.Services.{Auth, Payment}
  alias MyApp.Repo

  def do_pay do
    Payment.process()
  end
end
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const edges = db
      .prepare(
        `SELECT s.qualified_name sq, t.qualified_name tq, e.kind
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE s.language = 'elixir'`
      )
      .all();

    cg.destroy();

    // Imports edges
    expect(edges).toContainEqual({
      sq: 'MyApp.Consumer',
      tq: 'MyApp.Services.Auth',
      kind: 'imports',
    });
    expect(edges).toContainEqual({
      sq: 'MyApp.Consumer',
      tq: 'MyApp.Services.Payment',
      kind: 'imports',
    });
    expect(edges).toContainEqual({
      sq: 'MyApp.Consumer',
      tq: 'MyApp.Repo',
      kind: 'imports',
    });

    // Calls edge through alias
    expect(edges).toContainEqual({
      sq: 'MyApp.Consumer::do_pay/0',
      tq: 'MyApp.Services.Payment::process/0',
      kind: 'calls',
    });
  });
});
