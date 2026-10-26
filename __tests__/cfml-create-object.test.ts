/**
 * CFML `createObject("component", "a.b.Batch")` (#2652). `new a.b.Batch()`
 * made an `instantiates` edge; createObject, the form older code uses most,
 * made none — it was a call to an engine function that never resolves. And a
 * call chained onto either construction, `createObject(…).init()` or `new
 * a.b.Batch().init()`, was emitted as a bare `init`, which matched whichever
 * component's `init` came first. A component path resolves as `extends`
 * resolves one: by its folders, from the right.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

let dir = '';
let edges: string[] = [];
let unresolved: string[] = [];

const files: Record<string, string> = {
  // Other components with an `init`, which a guess by name would reach first.
  'contens/aaa/alpha.cfc': `component {\n\tfunction init() { return this; }\n\tfunction $init() { return this; }\n}\n`,
  'contens/core/mixin.cfc': `component {\n\tfunction $init() { return this; }\n}\n`,
  // A framework's own source, where its mapping (`wheels`) is the project root.
  'JobWorker.cfc': `component {\n\tfunction processNext() {}\n}\n`,
  'tests/specs/JobSpec.cfc': `component {
\tfunction run() {
\t\tnew wheels.JobWorker().processNext();
\t\tvar w = createObject("component", "wheels.JobWorker");
\t}
}
`,
  // An app's own Controller is not the framework's `wheels.Controller`.
  'app/controllers/Controller.cfc': `component {\n\tfunction init() { return this; }\n}\n`,
  'app/handlers/Main.cfc': `component {\n\tfunction index() {\n\t\tcreateObject("component", "wheels.Controller").init();\n\t}\n}\n`,
  'contens/aaa/beta.cfc': `component {\n\tfunction init() { return this; }\n}\n`,
  'contens/core/base.cfc': `component {\n\tfunction init() { return this; }\n}\n`,
  'contens/core/queue/batchcontext.cfc': `<cfcomponent>
\t<cffunction name="init"><cfreturn this></cffunction>
\t<cffunction name="run"></cffunction>
</cfcomponent>
`,
  // Inherits its init.
  'contens/core/queue/jobrunner.cfc': `component extends="contenscms.core.base" {\n\tfunction start() {}\n}\n`,
  'contens/api/batch/collection.cfc': `<cfcomponent>
\t<cffunction name="process">
\t\t<cfset var oContext = createObject("component", "contenscms.core.queue.batchcontext").init()>
\t\t<cfset oContext.run()>
\t\t<cfset var oRunner = CreateObject('Component', 'contenscms.core.queue.jobrunner')>
\t</cffunction>
</cfcomponent>
`,
  'contens/api/batch/scriptcollection.cfc': `component {
\tfunction process() {
\t\tvar oRunner = createObject("contenscms.core.queue.jobrunner").init();
\t\tvar oNew = new contenscms.core.queue.batchcontext().init();
\t\tvar oMap = createObject("java", "java.util.HashMap");
\t\tvar oBox = createObject("component", "testbox.system.TestBox").init();
\t\tvar oDyn = createObject("component", "#variables.root#.batchcontext");
\t\tvar oMix = new contenscms.core.mixin().$init();
\t}
}
`,
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfml-create-object-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const cg = await CodeGraph.init(dir, { silent: true });
  await cg.indexAll();
  const db = (cg as any).db.db;
  edges = db
    .prepare(
      `SELECT e.kind, e.line, s.qualified_name src, t.qualified_name tgt FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
        WHERE e.kind IN ('instantiates', 'calls')`
    )
    .all()
    .map((r: any) => `${r.src} -${r.kind}-> ${r.tgt} @${r.line}`)
    .sort();
  unresolved = db
    .prepare(`SELECT reference_kind k, reference_name n, line FROM unresolved_refs`)
    .all()
    .map((r: any) => `${r.k} ${r.n} @${r.line}`);
  cg.close?.();
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('CFML createObject (#2652)', () => {
  it('links createObject("component", "a.b.c") to the component it makes, in tags and in script', () => {
    expect(edges).toEqual(expect.arrayContaining([
      'collection::process -instantiates-> contens/core/queue/batchcontext.cfc::batchcontext @3',
      'collection::process -instantiates-> contens/core/queue/jobrunner.cfc::jobrunner @5',
      'scriptcollection::process -instantiates-> contens/core/queue/jobrunner.cfc::jobrunner @3',
    ]));
    // Only the Java object and the component named at runtime are left as calls.
    expect(unresolved.filter((r) => r.startsWith('calls createObject')).sort()).toEqual(['calls createObject @5', 'calls createObject @7']);
  });

  it('links a call chained onto the construction to that component\'s method, or one it inherits', () => {
    expect(edges).toEqual(expect.arrayContaining([
      'collection::process -calls-> batchcontext::init @3',
      'scriptcollection::process -calls-> base::init @3',
      'scriptcollection::process -calls-> batchcontext::init @4',
      'scriptcollection::process -calls-> mixin::$init @8',
    ]));
    expect(edges.filter((e) => /-> (alpha|beta)::\$?init/.test(e))).toEqual([]);
  });

  it('makes nothing of a component outside the project, another type of object or a name built at runtime', () => {
    expect(edges.filter((e) => / @[567]$/.test(e) && e.startsWith('scriptcollection::'))).toEqual([]);
  });

  it('still types a variable assigned from createObject', () => {
    expect(edges).toContain('collection::process -calls-> batchcontext::run @4');
  });

  it('finds a component at the project root by a one-folder path, and only there', () => {
    expect(edges).toEqual(expect.arrayContaining([
      'JobSpec::run -calls-> JobWorker::processNext @3',
      'JobSpec::run -instantiates-> JobWorker.cfc::JobWorker @4',
    ]));
    expect(edges.filter((e) => e.startsWith('Main::index'))).toEqual([]);
  });
});
