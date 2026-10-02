/**
 * Tag-based CFML end to end (#2091). Most calls in a tag-based component sit
 * in `<cfset>`/`<cfif>`/`<cfreturn>` and `#hash#` expressions, not in
 * `<cfscript>`; on a 6,000-file tag-based codebase only 6.4% of methods had a
 * caller in the graph. Functions wrapped in `<cfprocessingdirective>` (the
 * Application.cfc shape) and `<cfinterface>` components were missing as well,
 * so their callers and implementers had nothing to land on.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cfml-tag-calls-'));
  const files: Record<string, string> = {
    'model/Svc.cfc': `<cfcomponent>
\t<cffunction name="a">
\t\t<cfset x = b(1)>
\t\t<cfif c(2)></cfif>
\t\t<cfreturn d()>
\t</cffunction>
\t<cffunction name="b"></cffunction>
\t<cffunction name="c"></cffunction>
\t<cffunction name="d"></cffunction>
</cfcomponent>
`,
    'Application.cfc': `<cfcomponent>
\t<cfprocessingdirective suppresswhitespace="true">
\t\t<cffunction name="onRequestStart">
\t\t\t<cfset loadConfig()>
\t\t</cffunction>
\t\t<cffunction name="loadConfig"></cffunction>
\t</cfprocessingdirective>
</cfcomponent>
`,
    'model/ISearchable.cfc': `<cfinterface>
\t<cffunction name="search" access="public"></cffunction>
</cfinterface>
`,
    'model/Catalog.cfc': `<cfcomponent implements="ISearchable">
\t<cffunction name="search" access="public"></cffunction>
</cfcomponent>
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const edgesFrom = (file: string, kind: string): string[] => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === kind)
    .map((e) => `${cg.getNode(e.source)!.qualifiedName} -> ${cg.getNode(e.target)!.qualifiedName}`)
    .sort();
};

describe('tag-based CFML (#2091)', () => {
  it('links calls written in <cfset>, <cfif> and <cfreturn> to the methods they call', () => {
    expect(edgesFrom('model/Svc.cfc', 'calls')).toEqual(['Svc::a -> Svc::b', 'Svc::a -> Svc::c', 'Svc::a -> Svc::d']);
  });

  it('indexes a method wrapped in <cfprocessingdirective> and the calls it makes', () => {
    expect(edgesFrom('Application.cfc', 'calls')).toEqual(['Application::onRequestStart -> Application::loadConfig']);
  });

  it('resolves <cfcomponent implements="…"> to a <cfinterface> component', () => {
    const iface = cg.getNodesInFile('model/ISearchable.cfc').find((n) => n.kind === 'interface');
    expect(iface?.name).toBe('ISearchable');
    expect(edgesFrom('model/Catalog.cfc', 'implements')).toEqual(['model/Catalog.cfc::Catalog -> model/ISearchable.cfc::ISearchable']);
  });
});
