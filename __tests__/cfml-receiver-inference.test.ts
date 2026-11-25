/**
 * CFML local-variable / component-field receiver-type inference (#1108 family).
 *
 * `var svc = new UserService(); svc.save()` — the call's receiver type is
 * recoverable from its declaration, and resolveMethodOnType validates the
 * inferred type actually declares the method, so a mis-inference produces no
 * edge. CFML brings four declaration idioms the shared inferrer must know:
 * `new` (dotted component paths included), `createObject("component", "...")`,
 * typed arguments (cfscript params and `<cfargument>` tags), and component
 * properties — including WireBox DI (`property name="svc" inject="..."`),
 * whose receivers are `variables.`-scoped fields declared OUTSIDE the calling
 * function (so the scan must widen to the whole file, in both directions).
 *
 * These tests also pin the extraction prerequisite: CFML method
 * qualifiedNames carry the component scope (`UserService::save`) in all three
 * extraction paths (bare-script, `<cffunction>`, component-level `<cfscript>`
 * blocks) — without that, type-validated resolution can never match.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('CFML receiver-type inference', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfml-recv-')); });
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
         WHERE e.kind = 'calls' AND t.kind = 'method'`
      )
      .all();
    const methods: { name: string; qn: string }[] = db
      .prepare(`SELECT name, qualified_name qn FROM nodes WHERE kind = 'method'`)
      .all();
    cg.close?.();
    return { calls, methods };
  };
  const hasCall = (calls: any[], src: string, tgtQn: string) =>
    calls.some((e) => e.src === src && e.tgtQn === tgtQn);

  // Two same-named methods so resolution MUST disambiguate by receiver type —
  // plain name-matching alone can't pick one.
  const userService = `component {\n  function save(any u) { return u; }\n}\n`;
  const orderService = `component {\n  function save(any o) { return o; }\n}\n`;

  it('scopes method qualifiedNames under the component in all three extraction paths', async () => {
    write('svc/UserService.cfc', userService);
    write('tag/TagService.cfc', `<cfcomponent>\n<cffunction name="save"><cfreturn 1></cffunction>\n</cfcomponent>\n`);
    write('mod/ModuleConfig.cfc', `<cfcomponent>\n<cfscript>\nfunction configure() { return 1; }\n</cfscript>\n</cfcomponent>\n`);
    const { methods } = await load();
    expect(methods.find((m) => m.name === 'save' && m.qn === 'UserService::save')).toBeDefined();
    expect(methods.find((m) => m.name === 'save' && m.qn === 'TagService::save')).toBeDefined();
    expect(methods.find((m) => m.name === 'configure' && m.qn === 'ModuleConfig::configure')).toBeDefined();
  });

  it('infers a local declared with new, including a dotted component path', async () => {
    write('svc/UserService.cfc', userService);
    write('svc/OrderService.cfc', orderService);
    write('handlers/Main.cfc', `component {
  function bare() {
    var svc = new UserService();
    return svc.save(1);
  }
  function dotted() {
    var svc2 = new svc.UserService();
    return svc2.save(2);
  }
}
`);
    const { calls } = await load();
    expect(hasCall(calls, 'bare', 'UserService::save')).toBe(true);
    expect(hasCall(calls, 'dotted', 'UserService::save')).toBe(true);
    expect(hasCall(calls, 'bare', 'OrderService::save')).toBe(false);
  });

  it('infers a local declared with createObject (two-arg and single-arg forms)', async () => {
    write('svc/UserService.cfc', userService);
    write('svc/OrderService.cfc', orderService);
    write('handlers/Legacy.cfc', `component {
  function classic() {
    var svc = createObject("component", "svc.UserService");
    return svc.save(1);
  }
  function modern() {
    var svc2 = CreateObject("svc.OrderService");
    return svc2.save(2);
  }
}
`);
    const { calls } = await load();
    expect(hasCall(calls, 'classic', 'UserService::save')).toBe(true);
    expect(hasCall(calls, 'modern', 'OrderService::save')).toBe(true);
  });

  it('infers a typed cfscript parameter', async () => {
    write('svc/UserService.cfc', userService);
    write('svc/OrderService.cfc', orderService);
    write('handlers/Typed.cfc', `component {
  function process(required UserService svc) {
    return svc.save(1);
  }
}
`);
    const { calls } = await load();
    expect(hasCall(calls, 'process', 'UserService::save')).toBe(true);
    expect(hasCall(calls, 'process', 'OrderService::save')).toBe(false);
  });

  it('infers a <cfargument> typed argument used inside a <cfscript> body', async () => {
    write('svc/UserService.cfc', userService);
    write('svc/OrderService.cfc', orderService);
    write('handlers/TagTyped.cfc', `<cfcomponent>
<cffunction name="process">
  <cfargument name="svc" type="svc.UserService">
  <cfscript>
    return svc.save(1);
  </cfscript>
</cffunction>
</cfcomponent>
`);
    const { calls } = await load();
    expect(hasCall(calls, 'process', 'UserService::save')).toBe(true);
  });

  it('infers a variables-scoped field from its pseudoconstructor assignment, even when init sits below the call', async () => {
    write('svc/UserService.cfc', userService);
    write('svc/OrderService.cfc', orderService);
    write('handlers/Fielded.cfc', `component {
  function handle() {
    return variables.svc.save(1);
  }
  function init() {
    variables.svc = new UserService();
    return this;
  }
}
`);
    const { calls } = await load();
    expect(hasCall(calls, 'handle', 'UserService::save')).toBe(true);
    expect(hasCall(calls, 'handle', 'OrderService::save')).toBe(false);
  });

  it('infers a WireBox-injected property (the ColdBox DI shape)', async () => {
    write('svc/UserService.cfc', userService);
    write('svc/OrderService.cfc', orderService);
    write('handlers/Injected.cfc', `component {
  property name="svc" inject="UserService";

  function handle() {
    return variables.svc.save(1);
  }
}
`);
    const { calls } = await load();
    expect(hasCall(calls, 'handle', 'UserService::save')).toBe(true);
  });

  it('creates no method edge when the inferred type does not declare the method', async () => {
    write('svc/UserService.cfc', userService);
    write('handlers/Wrong.cfc', `component {
  function go() {
    var svc = new UserService();
    return svc.destroyEverything();
  }
}
`);
    const { calls } = await load();
    expect(calls.filter((e) => e.src === 'go')).toHaveLength(0);
  });
});
