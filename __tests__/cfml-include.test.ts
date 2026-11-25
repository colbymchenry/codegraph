/**
 * CFML includes (#2651). Only cfscript's `include "x.cfm";`, written outside
 * any function, linked the including code to the template: the tag form
 * `<cfinclude template="x.cfm">` — the common one in tag-based code — made
 * nothing anywhere, the function form `cfinclude(template="x.cfm")` became a
 * call to a function named `cfinclude`, and an `include` inside a function
 * was dropped. A template path is relative to the including file's directory
 * (or to the web root with a leading `/`), so `../shared/helpers.cfm` is that
 * file even when another `helpers.cfm` exists.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

let dir = '';
let edges: string[] = [];
let imports: string[] = [];
let unresolved: string[] = [];
let importTargetKinds: string[] = [];

const files: Record<string, string> = {
  // Tag form at component scope: same directory, relative, upper case, unquoted.
  'app/core/baseform.cfc': `<cfcomponent output="false">
\t<cffunction name="init"><cfreturn this></cffunction>
\t<cfinclude template="formlistshared.cfm">
\t<cfinclude template="../shared/helpers.cfm">
\t<CFINCLUDE TEMPLATE="Upper.cfm">
\t<cfinclude template=bare.cfm>
</cfcomponent>
`,
  // Tag form in a function body, nested in control flow; runtime-built paths and <cfmodule> are no includes.
  'app/core/report.cfc': `<cfcomponent>
\t<cffunction name="render">
\t\t<cfif arguments.full>
\t\t\t<cfinclude template="formlistshared.cfm" />
\t\t</cfif>
\t\t<cfinclude template="#variables.view#">
\t\t<cfinclude template="#variables.dir#/helpers.cfm">
\t\t<cfmodule template="formlistshared.cfm">
\t</cffunction>
</cfcomponent>
`,
  // Tag form in a template, and a path from the web root.
  'app/page.cfm': `<cfinclude template="core/formlistshared.cfm">
<cfif x><cfinclude template="/app/shared/helpers.cfm"></cfif>
`,
  // A template and a function including a path no file has (a server
  // mapping's): the function may not link to the template's import of it.
  'app/one.cfm': `<cfinclude template="/mapped/runner.cfm">\n`,
  'app/core/runtests.cfc': `component {\n\tfunction run() {\n\t\tinclude "/mapped/runner.cfm";\n\t}\n}\n`,
  // The only file of the name an include names is the includer itself.
  'app/views/wheels/wheels.cfm': `<cfinclude template="../../wheels/public/wheels.cfm">\n`,
  // Script forms: in a function body, the attribute form, the function form.
  'app/core/scriptform.cfc': `component {
\tinclude "formlistshared.cfm";
\tfunction render() {
\t\tinclude "../shared/helpers.cfm";
\t\tcfinclude(template="upper.cfm");
\t\tcfinclude("bare.cfm");
\t\tCFINCLUDE( TEMPLATE = 'formlistshared.cfm' );
\t}
\tfunction other() {
\t\tinclude template="formlistshared.cfm";
\t\tcfinclude(template=variables.view);
\t\tinclude "#variables.view#";
\t\tinclude "#variables.dir#/helpers.cfm";
\t}
}
`,
  'app/core/formlistshared.cfm': `<cffunction name="checkRightsPartPrepare"></cffunction>\n`,
  'app/core/Upper.cfm': `<cfset x = 1>\n`,
  'app/core/bare.cfm': `<cfset x = 1>\n`,
  'app/shared/helpers.cfm': `<cfset x = 1>\n`,
  // A namesake the relative path does not name.
  'other/shared/helpers.cfm': `<cfset x = 1>\n`,
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfml-include-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const cg = await CodeGraph.init(dir, { silent: true });
  await cg.indexAll();
  const db = (cg as any).db.db;
  edges = db
    .prepare(
      `SELECT s.qualified_name src, t.file_path tgt FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
        WHERE e.kind = 'imports'`
    )
    .all()
    .map((r: any) => `${r.src} -> ${r.tgt}`)
    .sort();
  imports = db.prepare(`SELECT qualified_name q FROM nodes WHERE kind = 'import'`).all().map((r: any) => r.q).sort();
  importTargetKinds = db
    .prepare(`SELECT DISTINCT t.kind k FROM edges e JOIN nodes t ON t.id = e.target WHERE e.kind = 'imports'`)
    .all()
    .map((r: any) => r.k);
  unresolved = db
    .prepare(`SELECT reference_kind k, reference_name n FROM unresolved_refs`)
    .all()
    .map((r: any) => `${r.k} ${r.n}`);
  cg.close?.();
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('CFML includes (#2651)', () => {
  it('links <cfinclude template="…"> at component scope to the template, relative to the including file', () => {
    expect(edges).toEqual(expect.arrayContaining([
      'app/core/baseform.cfc::baseform -> app/core/formlistshared.cfm',
      'app/core/baseform.cfc::baseform -> app/shared/helpers.cfm',
      'app/core/baseform.cfc::baseform -> app/core/Upper.cfm',
      'app/core/baseform.cfc::baseform -> app/core/bare.cfm',
    ]));
    expect(imports).toContain('baseform::formlistshared.cfm');
  });

  it('links a <cfinclude> in a function body from that function', () => {
    expect(edges).toContain('report::render -> app/core/formlistshared.cfm');
    expect(imports).toContain('report::render::formlistshared.cfm');
  });

  it('links a <cfinclude> in a template, including one from the web root', () => {
    expect(edges).toContain('app/page.cfm -> app/core/formlistshared.cfm');
    expect(edges).toContain('app/page.cfm -> app/shared/helpers.cfm');
  });

  it('makes nothing of a template built at runtime or of <cfmodule>', () => {
    expect(edges.filter((e) => e.startsWith('report::render ->'))).toEqual(['report::render -> app/core/formlistshared.cfm']);
    expect(imports.filter((q) => q.startsWith('report::'))).toEqual(['report::render::formlistshared.cfm']);
    expect(edges.filter((e) => e.startsWith('scriptform::other ->'))).toEqual(['scriptform::other -> app/core/formlistshared.cfm']);
    expect(imports.filter((q) => q.includes('#'))).toEqual([]);
  });

  it('links the script forms: in a function body, `include template=…` and cfinclude(…)', () => {
    expect(edges).toEqual(expect.arrayContaining([
      'scriptform::render -> app/shared/helpers.cfm',
      'scriptform::render -> app/core/Upper.cfm',
      'scriptform::render -> app/core/bare.cfm',
      'scriptform::render -> app/core/formlistshared.cfm',
      'scriptform::other -> app/core/formlistshared.cfm',
    ]));
    expect(unresolved.filter((r) => /cfinclude/i.test(r))).toEqual([]);
  });

  it('never links a relative include to a namesake the path does not name', () => {
    expect(edges.filter((e) => e.endsWith('other/shared/helpers.cfm'))).toEqual([]);
  });

  it('links an include to a file or to nothing: never to an import statement, nor to the including file', () => {
    expect(importTargetKinds).toEqual(['file']);
    expect(edges.filter((e) => e.startsWith('app/one.cfm') || e.startsWith('runtests::'))).toEqual([]);
    expect(edges.filter((e) => e.startsWith('app/views/wheels/wheels.cfm'))).toEqual([]);
  });
});
