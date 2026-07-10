/**
 * Erlang behaviour-callback dispatch bridge.
 *
 * A behaviour module declares `-callback fn/N`, implementers declare
 * `-behaviour(B)` and export the callbacks, and the framework dispatches
 * through a variable module (`Handler:init(...)`, `Mod:handle_thing(...)`) — a
 * dynamic hop extraction deliberately leaves silent. This bridges each
 * `Var:fn(args)` site to every in-repo implementer of the ONE behaviour that
 * declares (fn, site-arity), and proves the precision gates: a same-named
 * function in a non-implementer module contributes no edge, an arity mismatch
 * contributes no edge, and a (fn, arity) declared by TWO behaviours bails
 * entirely.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('erlang-behaviour synthesizer', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erlang-behaviour-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  async function synthEdges(d: string): Promise<any[]> {
    const cg = await CodeGraph.init(d, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT s.name source, s.file_path sf, t.name target, t.file_path tf,
                json_extract(e.metadata,'$.via') via
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'erlang-behaviour'`
      )
      .all();
    cg.destroy();
    return rows;
  }

  it('bridges Var:fn(...) dispatch to every implementer, gated on behaviour + export + arity', async () => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'worker_behaviour.erl'),
      `-module(worker_behaviour).

-callback handle_thing(Arg :: term()) -> ok | {error, term()}.
-callback init(list()) -> {ok, term()}.

-export([dispatch/2]).

dispatch(Mod, Arg) ->
    Mod:handle_thing(Arg).
`
    );
    // Two real implementers, exporting the callback.
    fs.writeFileSync(
      path.join(dir, 'src', 'worker_a.erl'),
      `-module(worker_a).
-behaviour(worker_behaviour).
-export([handle_thing/1, init/1]).

handle_thing(X) -> {ok, X}.
init(_) -> {ok, state}.
`
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'worker_b.erl'),
      `-module(worker_b).
-behaviour(worker_behaviour).
-export([handle_thing/1, init/1]).

handle_thing(X) -> {done, X}.
init(_) -> {ok, state}.
`
    );
    // Defines + exports the same function name but does NOT implement the behaviour.
    fs.writeFileSync(
      path.join(dir, 'src', 'freeloader.erl'),
      `-module(freeloader).
-export([handle_thing/1]).

handle_thing(X) -> X.
`
    );
    // A second dispatcher in another module, plus an arity-mismatched site and a
    // macro-module site — neither of the latter two may produce edges.
    fs.writeFileSync(
      path.join(dir, 'src', 'runner.erl'),
      `-module(runner).
-export([run/2, wrong/2, self_call/1]).

run(Mod, Arg) ->
    Mod:handle_thing(Arg).

wrong(Mod, Arg) ->
    Mod:handle_thing(Arg, extra).

self_call(X) ->
    ?MODULE:handle_thing(X).
`
    );

    const rows = await synthEdges(dir);
    const targets = (src: string) =>
      rows.filter((r) => r.source === src).map((r) => `${path.basename(r.tf)}:${r.target}`).sort();

    // Both dispatch sites link both implementers — and only them (no freeloader).
    expect(targets('dispatch')).toEqual(['worker_a.erl:handle_thing', 'worker_b.erl:handle_thing']);
    expect(targets('run')).toEqual(['worker_a.erl:handle_thing', 'worker_b.erl:handle_thing']);
    // Arity mismatch (handle_thing/2 undeclared) and ?MODULE sites: nothing.
    expect(targets('wrong')).toEqual([]);
    expect(targets('self_call')).toEqual([]);
    // Provenance metadata names the contract.
    expect(rows.every((r) => r.via === 'worker_behaviour:handle_thing/1')).toBe(true);
  });

  it('bails when two behaviours declare the same callback name and arity', async () => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    for (const b of ['left_behaviour', 'right_behaviour']) {
      fs.writeFileSync(
        path.join(dir, 'src', `${b}.erl`),
        `-module(${b}).

-callback common_cb(term()) -> ok.
`
      );
    }
    fs.writeFileSync(
      path.join(dir, 'src', 'impl_left.erl'),
      `-module(impl_left).
-behaviour(left_behaviour).
-export([common_cb/1]).

common_cb(X) -> X.
`
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'caller.erl'),
      `-module(caller).
-export([go/2]).

go(Mod, X) ->
    Mod:common_cb(X).
`
    );

    const rows = await synthEdges(dir);
    expect(rows).toEqual([]);
  });

  it('does not link an implementer whose callback is not exported', async () => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'hook_behaviour.erl'),
      `-module(hook_behaviour).

-callback on_event(term()) -> ok.

-export([fire/2]).

fire(Mod, Ev) ->
    Mod:on_event(Ev).
`
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'private_impl.erl'),
      `-module(private_impl).
-behaviour(hook_behaviour).
-export([start/0]).

start() -> ok.

on_event(_Ev) -> ok.
`
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'public_impl.erl'),
      `-module(public_impl).
-behaviour(hook_behaviour).
-export([on_event/1]).

on_event(Ev) -> {seen, Ev}.
`
    );

    const rows = await synthEdges(dir);
    expect(rows.map((r) => path.basename(r.tf))).toEqual(['public_impl.erl']);
  });
});
