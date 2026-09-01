/**
 * Erlang arity-aware resolution (#1610).
 *
 * Arity is part of a function's identity: `f/1` and `f/2` are unrelated
 * definitions. Extraction gives each arity its own node (`mod::f/1`) and
 * stamps refs with the call-site arity; resolution must land each ref on the
 * def of exactly that arity — the everyday `header/2 -> header/3` delegation
 * must be a real edge, never a self-loop — and refuse to guess a sibling
 * arity when the named one doesn't exist.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('erlang arity-aware resolution', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erlang-arity-')); });
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
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'deleg.erl'),
      `-module(deleg).
-export([header/2]).

header(Name, Req) ->
    header(Name, Req, undefined).

-spec header(binary(), map(), any()) -> any().
header(Name, Headers, Default) ->
    maps:get(Name, Headers, Default).
`
    );
    const edges = await callEdges(dir);
    expect(edges).toContainEqual({ sq: 'deleg::header/2', tq: 'deleg::header/3' });
    // No self-loop in either direction.
    expect(edges.some((e) => e.sq === e.tq && e.sq.startsWith('deleg::header'))).toBe(false);
  });

  it('resolves remote calls to the called arity and refuses a sibling arity', async () => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'store.erl'),
      `-module(store).
-export([get/1, get/2]).

get(K) -> get(K, undefined).
get(K, Default) -> {K, Default}.
`
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'client.erl'),
      `-module(client).
-export([fetch/1, broken/1]).

fetch(K) ->
    store:get(K, nil).

broken(K) ->
    store:get(K, nil, extra).
`
    );
    const edges = await callEdges(dir);
    expect(edges).toContainEqual({ sq: 'client::fetch/1', tq: 'store::get/2' });
    // store:get/3 doesn't exist — the ref must resolve to NOTHING, not /1 or /2.
    expect(edges.some((e) => e.sq === 'client::broken/1' && e.tq.startsWith('store::get'))).toBe(false);
  });

  it('resolves an arity-less dynamic MFA ref only when exactly one arity exists', async () => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'single.erl'),
      `-module(single).
-export([work/1]).

work(X) -> X.
`
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'multi.erl'),
      `-module(multi).
-export([job/1, job/2]).

job(X) -> X.
job(X, Y) -> {X, Y}.
`
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'spawner.erl'),
      `-module(spawner).
-export([go/1]).

go(Args) ->
    erlang:spawn(single, work, Args),
    erlang:spawn(multi, job, Args).
`
    );
    const edges = await callEdges(dir);
    // `Args` is dynamic, so both refs are arity-less. single:work has exactly
    // one arity — it resolves; multi:job has two — silent beats wrong.
    expect(edges).toContainEqual({ sq: 'spawner::go/1', tq: 'single::work/1' });
    expect(edges.some((e) => e.sq === 'spawner::go/1' && e.tq.startsWith('multi::job'))).toBe(false);
  });

  it('counts arity past comments written inside a parameter or argument list', async () => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'noted.erl'),
      `-module(noted).
-export([run/0, plain/2, spaced/2]).

plain(X, Y) -> X + Y.

spaced(X, % why this one is special
       Y) ->
    X * Y.

run() ->
    A = plain( % leading note
        1, 2),
    B = plain(1, % separating note
              2),
    C = spaced(1, 2),
    D = erlang:spawn(noted, plain, [1, % note inside the MFA list
                                    2]),
    {A, B, C, D}.
`
    );
    const edges = await callEdges(dir);
    // A comment is a NAMED child, but it is not an argument: every call below
    // is arity 2, and `spaced` is defined with arity 2.
    expect(edges).toContainEqual({ sq: 'noted::run/0', tq: 'noted::plain/2' });
    expect(edges).toContainEqual({ sq: 'noted::run/0', tq: 'noted::spaced/2' });
    // Nothing resolved to a phantom arity the comments would have produced.
    expect(edges.some((e) => /::(plain|spaced)\/[^2]$/.test(e.tq))).toBe(false);
  });

  it('lands `fun mod:f/1` references on the written arity', async () => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'lib_m.erl'),
      `-module(lib_m).
-export([bump/1, bump/2]).

bump(X) -> X + 1.
bump(X, N) -> X + N.
`
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'user_m.erl'),
      `-module(user_m).
-export([run/1]).

run(L) ->
    lists:map(fun lib_m:bump/1, L).
`
    );
    const edges = await callEdges(dir);
    expect(edges).toContainEqual({ sq: 'user_m::run/1', tq: 'lib_m::bump/1' });
    expect(edges.some((e) => e.sq === 'user_m::run/1' && e.tq === 'lib_m::bump/2')).toBe(false);
  });
});
