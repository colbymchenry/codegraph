/**
 * A TypeScript abstract method (`abstract send(path: string): Promise<unknown>;`)
 * is indexed as a method of its class, as an interface's method signature is.
 *
 * Neither extractor read `abstract_method_signature`, so an abstract class
 * used as a dependency-injection token, like bitwarden's `abstract class
 * ApiService` in `libs/common/src/abstractions`, had none of its methods in
 * the graph. A call through a field of that type then linked to whichever
 * class of the same name declared the method, such as the browser app's
 * `I18nService` for a library's `this.i18nService.t()`.
 *
 * Runs against the native kernel (when built) and the wasm extractor, which
 * must agree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app' }),
  'src/abstractions/api.service.ts':
    'export abstract class ApiService {\n' +
    '  abstract send(method: string, path: string): Promise<unknown>;\n' +
    '  protected abstract nativeFetch(request: Request): Promise<Response>;\n' +
    '  ping() {\n    return 1;\n  }\n' +
    '}\n',
  'src/services/api.service.ts':
    "import { ApiService as ApiServiceAbstraction } from '../abstractions/api.service';\n" +
    'export class ApiService implements ApiServiceAbstraction {\n' +
    '  send(method: string, path: string) {\n    return Promise.resolve(method + path);\n  }\n' +
    '  nativeFetch(request: Request) {\n    return fetch(request);\n  }\n' +
    '  ping() {\n    return 2;\n  }\n' +
    '}\n',
  'src/app/sync.ts':
    "import { ApiService } from '../abstractions/api.service';\n" +
    'export class SyncService {\n' +
    '  constructor(private readonly apiService: ApiService) {}\n' +
    "  run() {\n    return this.apiService.send('GET', '/sync');\n  }\n" +
    '}\n',
};

describe('a TypeScript abstract method', () => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-abstract-methods-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    kernel = process.env.CODEGRAPH_KERNEL;
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  it.each(['default', 'wasm'])('is a method of its class, and what a call through the abstract type links to (%s)', async (backend) => {
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    cg = await CodeGraph.init(root, { index: true });
    const graph = cg;
    const declared = graph.getNodesInFile('src/abstractions/api.service.ts')
      .filter((n) => n.kind === 'method' || n.kind === 'function')
      .map((n) => `${n.kind} ${n.qualifiedName}`)
      .sort();
    expect(declared).toEqual(['method ApiService::nativeFetch', 'method ApiService::ping', 'method ApiService::send']);

    const run = graph.getNodesInFile('src/app/sync.ts').find((n) => n.qualifiedName === 'SyncService::run')!;
    const calls = graph.getOutgoingEdgesFrom([run.id], ['calls']).map((e) => {
      const target = graph.getNode(e.target)!;
      return `${target.filePath}::${target.qualifiedName}`;
    });
    expect(calls).toEqual(['src/abstractions/api.service.ts::ApiService::send']);
  }, 60_000);
});
