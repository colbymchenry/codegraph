/**
 * A `<cfquery>` or `<cfscript>` block that fails to parse (#2654). Each block
 * is read with its own grammar, and that extraction warned "parse produced no
 * symbols (tree has errors) — the file is indexed but contributes nothing to
 * the graph" — about the block, which in a query never declares a symbol. The
 * warning landed on the whole file, so `init` printed it and `status` counted
 * the file as one whose symbols are missing, though its component, methods and
 * calls were all in the graph. The file now records which block failed, under
 * a code of its own.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

// `EQV` in the condition is one of the shapes the bundled query grammar can't read.
const dao = `<cfcomponent output="false">
\t<cffunction name="getPages" access="public" returntype="query">
\t\t<cfargument name="a" type="boolean" required="true">
\t\t<cfargument name="b" type="boolean" required="true">
\t\t<cfset var q = "">
\t\t<cfquery name="q" datasource="#dsn#">
\t\t\tSELECT <cfif arguments.a EQV arguments.b>COUNT(*)<cfelse>p.*</cfif>
\t\t\tFROM pages p
\t\t\tWHERE p.site = <cfqueryparam value="#getSiteId()#" cfsqltype="cf_sql_integer">
\t\t</cfquery>
\t\t<cfreturn q>
\t</cffunction>
\t<cffunction name="getSiteId" access="public" returntype="numeric">
\t\t<cfreturn 1>
\t</cffunction>
</cfcomponent>
`;

const svc = `<cfcomponent output="false">
\t<cffunction name="build" access="public" returntype="any">
\t\t<cfscript>
\t\t\tdoThing(1, ;
\t\t\tother();
\t\t</cfscript>
\t\t<cfreturn this>
\t</cffunction>
</cfcomponent>
`;

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('CFML blocks that fail to parse (#2654)', () => {
  it('names the <cfquery> that failed, not the whole file, and keeps what the file declares and calls', () => {
    const result = extractFromSource('appsettingsdao.cfc', dao);
    expect(result.nodes.filter((n) => n.kind === 'class' || n.kind === 'method').map((n) => n.name).sort())
      .toEqual(['appsettingsdao', 'getPages', 'getSiteId']);
    expect(result.unresolvedReferences.some((r) => r.referenceName === 'getSiteId' && r.referenceKind === 'calls')).toBe(true);
    expect(result.errors).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'partial_parse', line: 6, message: expect.stringContaining('<cfquery> at line 6') }),
    ]);
    expect(result.errors.some((e) => /no symbols|contributes nothing/.test(e.message))).toBe(false);
  });

  it('names a <cfscript> block that failed', () => {
    const result = extractFromSource('svc.cfc', svc);
    expect(result.nodes.some((n) => n.kind === 'method' && n.name === 'build')).toBe(true);
    expect(result.errors).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'partial_parse', line: 3, message: expect.stringContaining('<cfscript> at line 3') }),
    ]);
  });

  describe('in the index', () => {
    let dir = '';
    let cg: CodeGraph;
    beforeAll(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfml-block-warning-'));
      fs.writeFileSync(path.join(dir, 'appsettingsdao.cfc'), dao);
      fs.writeFileSync(path.join(dir, 'svc.cfc'), svc);
      cg = await CodeGraph.init(dir, { silent: true });
      await cg.indexAll();
    });
    afterAll(() => {
      cg?.close?.();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('does not count the files as ones whose symbols are missing', () => {
      expect(cg.getIndexHealth().parseErrors).toEqual([]);
    });
  });
});
