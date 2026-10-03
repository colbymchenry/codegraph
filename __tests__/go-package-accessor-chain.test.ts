/**
 * Go package-qualified accessor chains — `pkg.Factory().Method()`.
 *
 * The extractor re-encodes a chained receiver as `<innerCallee>().<method>` so
 * resolution can infer the method's type from what the inner call RETURNS
 * (the #645/#608 mechanism). Go used to re-encode only a BARE inner callee
 * (`New().Method()`, an `identifier`), which left the package-qualified form
 * `service.Order().Method()` — the `gf gen service` accessor every GoFrame app
 * has — emitting a bare `Method` ref that the name fallbacks then matched
 * against ANY same-named method on an unrelated type.
 *
 * A package-qualified inner callee is a `selector_expression`, the same node
 * type as an instance chain (`obj.Method().Other()`), whose receiver type is not
 * recoverable and which must therefore stay bare — re-encoding it would drop the
 * edge instead. The file's import set separates the two, so the guards below pin
 * both directions.
 *
 * Resolution then reads the factory's declared return type. Go package-level
 * functions carry a BARE qualifiedName (`Order`, not `service.Order`), so the
 * `Class::method` lookup used by the dot-notation languages can never match;
 * the factory is looked up by name and disambiguated by its package directory.
 * The method is validated on the inferred type through `resolveMethodOnType`, so
 * a type that lacks the method yields no edge rather than a decoy. An interface
 * return lands on the INTERFACE's method, which the dynamic-dispatch pass then
 * bridges to the implementation — closing caller -> interface -> impl.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('Go package-qualified accessor chains', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-pkg-accessor-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  const load = async () => {
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const calls: { src: string; tgt: string; tgtQn: string }[] = db
      .prepare(
        `SELECT s.name src, t.name tgt, t.qualified_name tgtQn
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'calls'`,
      )
      .all();
    cg.close?.();
    return calls;
  };
  const hasCall = (calls: any[], src: string, tgtQn: string) =>
    calls.some((e) => e.src === src && e.tgtQn === tgtQn);
  /** Any resolved call `src` makes to something of the given bare name. */
  const callsNamed = (calls: any[], src: string, tgt: string) =>
    calls.some((e) => e.src === src && e.tgt === tgt);

  /** `svc` exposes an interface accessor; `impl` implements it; `ctrl` is a decoy. */
  const svc = `package svc

type IAlpha interface{ Handle() string }

var localAlpha IAlpha

func RegisterAlpha(i IAlpha) { localAlpha = i }
func Alpha() IAlpha          { return localAlpha }
`;
  const impl = `package impl

type SAlpha struct{}

func (s *SAlpha) Handle() string { return "real" }
`;
  // Same method name on an unrelated type, with a signature that does NOT
  // satisfy IAlpha — so only name matching could ever reach it.
  const decoy = `package ctrl

type Req struct{ N int }

type Ctrl struct{}

func (c *Ctrl) Handle(req *Req) string { return "decoy" }
`;

  it('resolves an interface-returning accessor to the interface method, not a same-named decoy', async () => {
    write('go.mod', 'module repro\n\ngo 1.25\n');
    write('svc/svc.go', svc);
    write('impl/impl.go', impl);
    write('ctrl/ctrl.go', decoy);
    write('caller/caller.go', `package caller

import "repro/svc"

func RunA() string { return svc.Alpha().Handle() }
`);
    const calls = await load();
    expect(hasCall(calls, 'RunA', 'IAlpha::Handle')).toBe(true);
    expect(hasCall(calls, 'RunA', 'Ctrl::Handle')).toBe(false);
  });

  it('reaches the implementation through the interface (caller -> interface -> impl)', async () => {
    write('go.mod', 'module repro\n\ngo 1.25\n');
    write('svc/svc.go', svc);
    write('impl/impl.go', impl);
    write('caller/caller.go', `package caller

import "repro/svc"

func RunA() string { return svc.Alpha().Handle() }
`);
    const calls = await load();
    expect(hasCall(calls, 'RunA', 'IAlpha::Handle')).toBe(true);
    expect(hasCall(calls, 'Handle', 'SAlpha::Handle')).toBe(true);
  });

  it('resolves a concrete-returning accessor to the returned type, not a same-named decoy', async () => {
    write('go.mod', 'module repro\n\ngo 1.25\n');
    write('impl/impl.go', `package impl

type SGamma struct{}

func (s *SGamma) Execute() string { return "real" }
`);
    write('fac/fac.go', `package fac

import "repro/impl"

func Gamma() *impl.SGamma { return &impl.SGamma{} }
`);
    write('ctrl/ctrl.go', `package ctrl

type Req struct{ N int }

type Ctrl struct{}

func (c *Ctrl) Execute(req *Req) string { return "decoy" }
`);
    write('caller/caller.go', `package caller

import "repro/fac"

func RunC() string { return fac.Gamma().Execute() }
`);
    const calls = await load();
    expect(hasCall(calls, 'RunC', 'SGamma::Execute')).toBe(true);
    expect(hasCall(calls, 'RunC', 'Ctrl::Execute')).toBe(false);
  });

  it('honours an import alias as the package qualifier', async () => {
    write('go.mod', 'module repro\n\ngo 1.25\n');
    write('svc/svc.go', svc);
    write('impl/impl.go', impl);
    write('ctrl/ctrl.go', decoy);
    write('caller/caller.go', `package caller

import svcx "repro/svc"

func RunAlias() string { return svcx.Alpha().Handle() }
`);
    const calls = await load();
    expect(hasCall(calls, 'RunAlias', 'IAlpha::Handle')).toBe(true);
    expect(hasCall(calls, 'RunAlias', 'Ctrl::Handle')).toBe(false);
  });

  it('leaves an INSTANCE chain on the bare-name path — a variable receiver is not a package', async () => {
    // `b.Inner().Value()` shares the `selector_expression` inner-callee shape
    // with a package-qualified accessor. Re-encoding it would strip the edge
    // (a variable's type is not recoverable here), so it must stay bare.
    write('go.mod', 'module repro\n\ngo 1.25\n');
    write('box/box.go', `package box

type Box struct{}

func (b *Box) Inner() *Box   { return b }
func (b *Box) Value() string { return "v" }

func UseInstance() string {
	var b Box
	return b.Inner().Value()
}
`);
    const calls = await load();
    expect(hasCall(calls, 'UseInstance', 'Box::Value')).toBe(true);
  });

  it('picks the aliased package the import path names, not another with the same function', async () => {
    // Two packages export `Build()` returning different interfaces. The call site
    // says `nope.Build()`, a name no directory carries — only the import path
    // maps it back to `one`.
    write('go.mod', 'module repro\n\ngo 1.25\n');
    write('one/one.go', `package one

type IOne interface{ Run() string }

func Build() IOne { var x IOne; return x }
`);
    write('two/two.go', `package two

type ITwo interface{ Run() string }

func Build() ITwo { var x ITwo; return x }
`);
    write('caller/caller.go', `package caller

import nope "repro/one"

func RunAliased() string { return nope.Build().Run() }
`);
    const calls = await load();
    expect(hasCall(calls, 'RunAliased', 'IOne::Run')).toBe(true);
    expect(hasCall(calls, 'RunAliased', 'ITwo::Run')).toBe(false);
  });

  it('makes no edge when the inferred type does not declare the method', async () => {
    // Absent-method safety. The fixture is deliberately not type-correct — any
    // call to a method the receiver lacks is a Go compile error, and extraction
    // is syntactic — but it is the shape a stale or mistaken inference produces,
    // and a same-named decoy must not be matched instead.
    write('go.mod', 'module repro\n\ngo 1.25\n');
    write('svc/svc.go', svc);
    write('impl/impl.go', impl);
    write('ctrl/ctrl.go', `package ctrl

type Ctrl struct{}

func (c *Ctrl) Missing() string { return "decoy" }
`);
    write('caller/caller.go', `package caller

import "repro/svc"

func RunMissing() string { return svc.Alpha().Missing() }
`);
    const calls = await load();
    expect(callsNamed(calls, 'RunMissing', 'Missing')).toBe(false);
  });

  it('makes no edge when the factory belongs to a package outside the index', async () => {
    // `g.Redis().Do(...)` — the accessor and its type live in a dependency, so
    // nothing about the receiver is knowable. Previously the bare `Do` matched a
    // project function of that name; it must now resolve to nothing.
    write('go.mod', 'module repro\n\ngo 1.25\n');
    write('carrier/carrier.go', `package carrier

func Do() string { return "unrelated project function" }
`);
    write('caller/caller.go', `package caller

import "github.com/gogf/gf/v2/frame/g"

func RunExternal() string {
	v, _ := g.Redis().Do(nil, "GET", "k")
	return v.String()
}
`);
    const calls = await load();
    expect(callsNamed(calls, 'RunExternal', 'Do')).toBe(false);
  });
});
