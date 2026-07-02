/**
 * CFML dotted / relative component-path inheritance resolution (#1152).
 *
 * CFML names a supertype by its component path, not a bare class name:
 * `extends="coldbox.system.web.Controller"` (dots = directories from the
 * webroot or a CFML mapping) or `extends="../base"` (FW/1's relative style).
 * The graph indexes the class under its final segment only, so before #1152
 * these references never resolved — measured on ColdBox core, 49 of 52
 * extends declarations were dotted and only 3 inheritance edges existed.
 *
 * These tests pin the matcher's precision rules: the mapping-root prefix may
 * be absent from the repo (`coldbox.` IS the repo root in the coldbox repo),
 * directory comparison is case-insensitive, a candidate needs at least one
 * corroborating parent directory (an uncorroborated same-named class is
 * almost always an out-of-repo library supertype — mxunit/testbox), a
 * corroboration tie yields no edge, and dotted `calls` refs (member-access
 * chains) are never treated as component paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('CFML component-path inheritance resolution (#1152)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfml-inh-')); });
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
    const edges: { src: string; srcFile: string; tgt: string; tgtFile: string; kind: string }[] = db
      .prepare(
        `SELECT s.name src, s.file_path srcFile, t.name tgt, t.file_path tgtFile, e.kind kind
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind IN ('extends', 'implements')`
      )
      .all();
    cg.close?.();
    return edges;
  };
  const has = (edges: any[], src: string, tgt: string, tgtFile: string, kind = 'extends') =>
    edges.some((e) => e.src === src && e.tgt === tgt && e.tgtFile === tgtFile && e.kind === kind);

  it('resolves a dotted path whose mapping root is absent from the repo (the ColdBox shape)', async () => {
    write('system/web/Controller.cfc', `component {\n  function handle() { return 1; }\n}\n`);
    write('handlers/Main.cfc', `component extends="coldbox.system.web.Controller" {\n  function index() { return 1; }\n}\n`);
    const edges = await load();
    expect(has(edges, 'Main', 'Controller', 'system/web/Controller.cfc')).toBe(true);
  });

  it('disambiguates same-named classes by directory corroboration', async () => {
    write('system/web/Controller.cfc', `component {}\n`);
    write('other/Controller.cfc', `component {}\n`);
    write('handlers/Main.cfc', `component extends="coldbox.system.web.Controller" {}\n`);
    const edges = await load();
    expect(has(edges, 'Main', 'Controller', 'system/web/Controller.cfc')).toBe(true);
    expect(has(edges, 'Main', 'Controller', 'other/Controller.cfc')).toBe(false);
  });

  it('compares directories case-insensitively (CFML path resolution is)', async () => {
    write('system/web/Controller.cfc', `component {}\n`);
    write('handlers/Main.cfc', `component extends="COLDBOX.System.Web.Controller" {}\n`);
    const edges = await load();
    expect(has(edges, 'Main', 'Controller', 'system/web/Controller.cfc')).toBe(true);
  });

  it('creates no edge when the only same-named class has no corroborating directory (out-of-repo supertype)', async () => {
    // `mxunit.framework.TestCase` is an external library; the repo's own
    // unrelated TestCase must NOT be claimed as the supertype.
    write('lib/TestCase.cfc', `component {}\n`);
    write('tests/MyTest.cfc', `component extends="mxunit.framework.TestCase" {}\n`);
    const edges = await load();
    expect(edges.filter((e) => e.src === 'MyTest')).toHaveLength(0);
  });

  it('creates no edge on a corroboration tie', async () => {
    write('a/models/User.cfc', `component {}\n`);
    write('b/models/User.cfc', `component {}\n`);
    write('handlers/Main.cfc', `component extends="models.User" {}\n`);
    const edges = await load();
    expect(edges.filter((e) => e.src === 'Main')).toHaveLength(0);
  });

  it('resolves a relative path against the referencing file (the FW/1 shape)', async () => {
    write('examples/base.cfc', `component {\n  function shared() { return 1; }\n}\n`);
    write('examples/sub/app.cfc', `component extends="../base" {}\n`);
    write('examples/sub/sibling.cfc', `component extends="./app" {}\n`);
    const edges = await load();
    expect(has(edges, 'app', 'base', 'examples/base.cfc')).toBe(true);
    expect(has(edges, 'sibling', 'app', 'examples/sub/app.cfc')).toBe(true);
  });

  it('resolves dotted implements to an interface as an implements edge', async () => {
    write('app/interfaces/IService.cfc', `interface {\n  public string function getName();\n}\n`);
    write('app/services/Greeter.cfc', `component implements="app.interfaces.IService" {\n  public string function getName() { return "hi"; }\n}\n`);
    const edges = await load();
    expect(has(edges, 'Greeter', 'IService', 'app/interfaces/IService.cfc', 'implements')).toBe(true);
  });

  it('resolves the tag-based extends attribute the same way', async () => {
    write('system/Base.cfc', `component {}\n`);
    write('legacy/Old.cfc', `<cfcomponent extends="app.system.Base">\n<cffunction name="run"><cfreturn 1></cffunction>\n</cfcomponent>\n`);
    const edges = await load();
    expect(has(edges, 'Old', 'Base', 'system/Base.cfc')).toBe(true);
  });

  it('lowercase dotted paths still resolve when the file name case matches (framework.one)', async () => {
    write('framework/one.cfc', `component {\n  function onRequest() { return 1; }\n}\n`);
    write('Application.cfc', `component extends="framework.one" {}\n`);
    const edges = await load();
    expect(has(edges, 'Application', 'one', 'framework/one.cfc')).toBe(true);
  });

  it('never treats a dotted calls reference as a component path', async () => {
    // `variables.dsn.getName()` is a member-access chain; the matcher is
    // gated to extends/implements so this must not mint a bogus edge to
    // a class that happens to share a trailing name.
    write('util/getName.cfc', `component {}\n`);
    write('svc/Caller.cfc', `component {\n  function go() { return variables.dsn.getName(); }\n}\n`);
    const edges = await load();
    expect(edges.filter((e) => e.src === 'Caller' || e.src === 'go')).toHaveLength(0);
  });
});
