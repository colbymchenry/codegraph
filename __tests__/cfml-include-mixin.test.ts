/**
 * CFML mixin membership (#2651). A component that includes a template at
 * component scope — `<cfinclude template="formlistshared.cfm">` or
 * `include "formlistshared.cfm";` — gains that template's functions as its
 * own members, and its subclasses gain them too, so `this.checkRightsPartPrepare()`
 * and an unqualified `checkRightsPartPrepare()` in a subclass are member
 * calls. Extraction is per file and cannot see the included template's
 * declarations, so membership is a synthesized `contains` edge; resolution
 * reads the same include chain, which is what keeps a same-named function in
 * another directory from winning the call. An include written inside a
 * function mixes nothing into the component — it is in scope for that
 * function's calls only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

let dir = '';
let calls: string[] = [];
let members: string[] = [];

const files: Record<string, string> = {
  // Tag form at component scope: this.-scoped and unqualified calls, an
  // include of a second template that itself includes a third.
  'app/core/baseform.cfc': `<cfcomponent output="false">
\t<cffunction name="run" access="public">
\t\t<cfset this.checkRightsPartPrepare()>
\t\t<cfset helperA()>
\t\t<cfset nestedFn()>
\t</cffunction>
\t<cfinclude template="formlistshared.cfm">
\t<cfinclude template="../shared/helpers.cfm">
</cfcomponent>
`,
  // A subclass reaches the parent's mixin with a bare call.
  'app/core/subform.cfc': `<cfcomponent extends="baseform">
\t<cffunction name="go" access="public">
\t\t<cfset checkRightsPartPrepare()>
\t</cffunction>
</cfcomponent>
`,
  // Script form at component scope, a path from the web root.
  'app/core/scriptcomp.cfc': `component {
\tinclude "/app/shared/helpers.cfm";
\tfunction handle() {
\t\treturn this.helperA();
\t}
}
`,
  // A function-scoped include is in scope for that function's calls only.
  'app/core/localonly.cfc': `component {
\tfunction run() {
\t\tinclude "../shared/localshared.cfm";
\t\treturn localFn();
\t}
}
`,
  'app/core/formlistshared.cfm': `<cffunction name="checkRightsPartPrepare">\n\t<cfreturn true>\n</cffunction>\n`,
  'app/shared/helpers.cfm': `<cfinclude template="nested.cfm">\n<cffunction name="helperA"><cfreturn 1></cffunction>\n`,
  'app/shared/nested.cfm': `<cffunction name="nestedFn"><cfreturn 2></cffunction>\n`,
  'app/shared/localshared.cfm': `<cffunction name="localFn"><cfreturn 3></cffunction>\n`,
  // Same-named functions in the callers' own directory: nearest-name matching
  // prefers these, so only the include chain can tell them apart.
  'app/core/adecoy.cfm': `<cffunction name="checkRightsPartPrepare"><cfreturn false></cffunction>\n<cffunction name="helperA"><cfreturn 98></cffunction>\n<cffunction name="nestedFn"><cfreturn 99></cffunction>\n<cffunction name="localFn"><cfreturn 97></cffunction>\n`,
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfml-mixin-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const cg = await CodeGraph.init(dir, { silent: true });
  await cg.indexAll();
  const db = (cg as any).db.db;
  calls = db
    .prepare(
      `SELECT s.qualified_name src, t.file_path tgt FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
        WHERE e.kind = 'calls'`
    )
    .all()
    .map((r: any) => `${r.src} -> ${r.tgt}`)
    .sort();
  members = db
    .prepare(
      `SELECT s.qualified_name src, t.file_path tgt FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
        WHERE e.kind = 'contains'
          AND json_extract(e.metadata, '$.synthesizedBy') = 'cfml-mixin'`
    )
    .all()
    .map((r: any) => `${r.src} -> ${r.tgt}`)
    .sort();
  cg.close?.();
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('CFML mixin membership (#2651)', () => {
  it('makes a component-level include’s functions members of the component, nested includes too', () => {
    expect(members).toEqual(expect.arrayContaining([
      'app/core/baseform.cfc::baseform -> app/core/formlistshared.cfm',
      'app/core/baseform.cfc::baseform -> app/shared/helpers.cfm',
      'app/core/baseform.cfc::baseform -> app/shared/nested.cfm',
      'app/core/scriptcomp.cfc::scriptcomp -> app/shared/helpers.cfm',
      'app/core/scriptcomp.cfc::scriptcomp -> app/shared/nested.cfm',
    ]));
  });

  it('does not make a function-scoped include a member of the component', () => {
    expect(members.filter((m) => m.startsWith('app/core/localonly.cfc::localonly'))).toEqual([]);
  });

  it('resolves this.-scoped and unqualified calls to the mixin, not to a same-named function elsewhere', () => {
    expect(calls).toEqual(expect.arrayContaining([
      'baseform::run -> app/core/formlistshared.cfm',
      'baseform::run -> app/shared/helpers.cfm',
      'baseform::run -> app/shared/nested.cfm',
      'scriptcomp::handle -> app/shared/helpers.cfm',
    ]));
    expect(calls.filter((c) => c.endsWith('app/core/adecoy.cfm'))).toEqual([]);
  });

  it('resolves an unqualified call in a subclass through the parent’s mixin', () => {
    expect(calls).toEqual(expect.arrayContaining([
      'subform::go -> app/core/formlistshared.cfm',
    ]));
  });

  it('still resolves a call to a function included in the calling function', () => {
    expect(calls).toContain('localonly::run -> app/shared/localshared.cfm');
  });
});
