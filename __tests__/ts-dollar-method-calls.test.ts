/**
 * A TypeScript or JavaScript call to a method whose name carries a `$` goes
 * through the receiver's type like any other method call: bitwarden's
 * `this.organizationService.organizations$(userId)` on its abstract
 * `OrganizationService`, and vscode's RPC
 * `this._proxy.$acceptModelChanged(…)` on a `MainThread…Shape` interface.
 *
 * The method-call pattern took the method name as `\w+`, which has no `$`,
 * so such a call matched no method-call shape and linked nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let roots: string[] = [];
let graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs) graph.close();
  graphs = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

/** Index `files` and return each call edge as `<file>: <refName> -> <target file>::<target qualified name>`. */
async function callsOf(files: Record<string, string>): Promise<string[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-dollar-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  const nodes = graph.getFiles().flatMap((f) => graph.getNodesInFile(f.path));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return graph.getOutgoingEdgesFrom(nodes.map((n) => n.id), ['calls'])
    .map((e) => {
      const target = byId.get(e.target);
      return `${byId.get(e.source)?.filePath}: ${e.metadata?.refName} -> ${target?.filePath}::${target?.qualifiedName}`;
    })
    .sort();
}

describe('a call to a method whose name has a $', () => {
  it("reaches the method of a field's or a parameter's class", async () => {
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/common/organization.service.ts':
        'export abstract class OrganizationService {\n  abstract organizations$(userId: string): string[];\n}\n',
      'src/legacy/organization.service.ts':
        'export class OrganizationService {\n  organizations$(userId: string) {\n    return [userId];\n  }\n}\n',
      'src/app/vault.component.ts':
        "import { OrganizationService } from '../common/organization.service';\n" +
        'export class VaultComponent {\n  constructor(private readonly organizationService: OrganizationService) {}\n' +
        "  load() {\n    return this.organizationService.organizations$('u');\n  }\n}\n" +
        "export function load(service: OrganizationService) {\n  return service.organizations$('u');\n}\n",
    });
    expect(calls.filter((c) => c.includes('organizations$'))).toEqual([
      'src/app/vault.component.ts: service.organizations$ -> src/common/organization.service.ts::OrganizationService::organizations$',
      'src/app/vault.component.ts: this.organizationService.organizations$ -> src/common/organization.service.ts::OrganizationService::organizations$',
    ]);
  }, 60_000);

  it("reaches an RPC proxy's method on the interface the field is declared with", async () => {
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/api/extHost.protocol.ts': 'export interface MainThreadDocumentsShape {\n  $acceptModelChanged(uri: string): void;\n}\n',
      'src/api/extHostDocuments.ts':
        "import { MainThreadDocumentsShape } from './extHost.protocol';\n" +
        'export class ExtHostDocuments {\n  constructor(private readonly _proxy: MainThreadDocumentsShape) {}\n' +
        "  change() {\n    this._proxy.$acceptModelChanged('a');\n  }\n}\n",
    });
    expect(calls.filter((c) => c.includes('$acceptModelChanged'))).toEqual([
      'src/api/extHostDocuments.ts: this._proxy.$acceptModelChanged -> src/api/extHost.protocol.ts::MainThreadDocumentsShape::$acceptModelChanged',
    ]);
  }, 60_000);

  it('is linked by a sync that adds the class after the caller', async () => {
    const caller = {
      'package.json': JSON.stringify({ name: 'app' }),
      'src/app/vault.component.ts':
        "import { OrganizationService } from '../common/organization.service';\n" +
        "export function load(service: OrganizationService) {\n  return service.organizations$('u');\n}\n",
    };
    const service = {
      'src/common/organization.service.ts':
        'export abstract class OrganizationService {\n  abstract organizations$(userId: string): string[];\n}\n',
    };
    const write = (root: string, files: Record<string, string>) => {
      for (const [file, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
      }
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-dollar-sync-'));
    roots.push(root);
    write(root, caller);
    const graph = await CodeGraph.init(root, { index: true });
    graphs.push(graph);
    const links = () => {
      const nodes = graph.getFiles().flatMap((f) => graph.getNodesInFile(f.path));
      return graph.getOutgoingEdgesFrom(nodes.map((n) => n.id), ['calls'])
        .map((e) => `${e.metadata?.refName} -> ${graph.getNode(e.target)?.qualifiedName}`);
    };
    expect(links()).toEqual([]);

    write(root, service);
    expect((await graph.sync()).filesAdded).toBe(1);
    expect(links()).toEqual(['service.organizations$ -> OrganizationService::organizations$']);
    expect(graph.getPendingReferenceCount()).toBe(0);
  }, 120_000);

  it("links nothing when the field's class and its bases don't declare it", async () => {
    const calls = await callsOf({
      'package.json': JSON.stringify({ name: 'app' }),
      'src/state/store.ts': 'export class Store {\n  get(key: string) {\n    return key;\n  }\n}\n',
      'src/state/other.ts': 'export class Other {\n  state$() {\n    return 1;\n  }\n}\n',
      'src/app/view.ts':
        "import { Store } from '../state/store';\n" +
        'export class View {\n  private readonly store = new Store();\n  run() {\n    return this.store.state$();\n  }\n}\n',
    });
    expect(calls.filter((c) => c.includes('state$'))).toEqual([]);
  }, 60_000);
});
