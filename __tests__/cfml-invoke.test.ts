/**
 * CFML `<cfinvoke component="a.b.Svc" method="run">`, the tag form of a method
 * call that tag-based code uses for most of its calls between components, made
 * no reference at all, so those methods showed no callers. It is now the call
 * `createObject("component", "a.b.Svc").run()` is: `a.b.Svc().run`, linked to
 * that component's method or one it inherits, and to no other component's
 * method of the same name.
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
  'app/services/AuthService.cfc': `<cfcomponent>
\t<cffunction name="validateToken" access="public"><cfreturn true></cffunction>
</cfcomponent>
`,
  // Another component's method of the same name, which a guess by name could reach.
  'app/legacy/OldAuth.cfc': `component {\n\tfunction validateToken() { return false; }\n\tfunction send() {}\n}\n`,
  'app/services/MailService.cfc': `component {\n\tfunction send() {}\n}\n`,
  'app/services/BaseService.cfc': `component {\n\tfunction audit() {}\n}\n`,
  'app/services/ReportService.cfc': `component extends="app.services.BaseService" {\n\tfunction build() {}\n}\n`,
  'app/i18n/Translations.cfc': `component {\n\tfunction getText(key) { return key; }\n}\n`,
  'app/api/Orders.cfc': `<cfcomponent>
\t<cffunction name="list" access="remote">
\t\t<cfinvoke component="authService" method="validateToken" returnvariable="ok">
\t\t<cfinvoke component="app.services.MailService" method="send">
\t\t\t<cfinvokeargument name="to" value="a@example.com">
\t\t</cfinvoke>
\t\t<cfif ok>
\t\t\t<cfinvoke component="#application.cfcRoot#.Translations" method="getText" returnvariable="t"/>
\t\t</cfif>
\t\t<cfinvoke component="#application.root#.services.ReportService" method="audit">
\t\t<cfinvoke method="helper" returnvariable="h">
\t\t<cfinvoke component="#oSvc#" method="send">
\t\t<cfinvoke component="app.services.MailService" method="#dynamicMethod#">
\t\t<cfinvoke webservice="https://example.com/svc?wsdl" method="send">
\t\t<cfinvoke component="testbox.system.TestBox" method="run">
\t</cffunction>
\t<cffunction name="helper" access="private"><cfreturn 1></cffunction>
</cfcomponent>
`,
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfml-invoke-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const cg = await CodeGraph.init(dir, { silent: true });
  await cg.indexAll();
  const db = (cg as any).db.db;
  edges = db
    .prepare(
      `SELECT e.kind, e.line, s.qualified_name src, t.qualified_name tgt, t.file_path file FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
        WHERE e.kind = 'calls'`
    )
    .all()
    .map((r: any) => `${r.src} -calls-> ${r.file}::${r.tgt.split('::').pop()} @${r.line}`)
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

describe('CFML <cfinvoke>', () => {
  it('links a call to the method of the component it names, by bare name or by path, whatever its case', () => {
    expect(edges).toEqual(expect.arrayContaining([
      'Orders::list -calls-> app/services/AuthService.cfc::validateToken @3',
      'Orders::list -calls-> app/services/MailService.cfc::send @4',
    ]));
    expect(edges.filter((e) => e.includes('app/legacy/OldAuth.cfc'))).toEqual([]);
  });

  it('reads the literal part of a component path that starts with a runtime prefix', () => {
    expect(edges).toEqual(expect.arrayContaining([
      'Orders::list -calls-> app/i18n/Translations.cfc::getText @8',
    ]));
  });

  it('links a method the component inherits', () => {
    expect(edges).toContain('Orders::list -calls-> app/services/BaseService.cfc::audit @10');
  });

  it('links a call without a component to the calling component\'s own method', () => {
    expect(edges).toContain('Orders::list -calls-> app/api/Orders.cfc::helper @11');
  });

  it('makes nothing of a component in a variable, a method named at runtime, a web service or a component outside the project', () => {
    expect(edges.filter((e) => / @1[2-5]$/.test(e))).toEqual([]);
    expect(unresolved.filter((r) => / @1[2-4]$/.test(r))).toEqual([]);
  });
});
