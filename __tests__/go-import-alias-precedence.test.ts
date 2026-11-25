/**
 * Go binds a name to one import per file. etcd's benchmark tool imports
 * `"github.com/cheggaaa/pb/v3"` (package `pb`) beside
 * `v3 "go.etcd.io/etcd/client/v3"`, so `v3.Op` is clientv3's `Op`. The index
 * also listed the unaliased import under its last path element, `v3`, and the
 * import met first — the progress-bar library, outside the project — took
 * every `v3.` qualifier, so `v3.Op`, `v3.Client` and `v3.OpGet(…)` linked to
 * nothing.
 *
 * An unaliased import is no longer listed under a name another import is
 * explicitly given; it keeps the name goimports assumes for it (`pb`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const MODULE: Record<string, string> = {
  'go.mod': 'module go.etcd.io/etcd\n\ngo 1.24\n',
  'client/v3/op.go': [
    'package clientv3',
    '',
    'type Op struct{}',
    '',
    'type Client struct{}',
    '',
    'func (c *Client) Do(op Op) error { return nil }',
    '',
    'func OpGet(key string) Op { return Op{} }',
    '',
  ].join('\n'),
  // The unaliased import first, as etcd writes it.
  'tools/benchmark/cmd/txn_mixed.go': [
    'package cmd',
    '',
    'import (',
    '\t"github.com/cheggaaa/pb/v3"',
    '',
    '\tv3 "go.etcd.io/etcd/client/v3"',
    ')',
    '',
    'type request struct {',
    '\top v3.Op',
    '}',
    '',
    'func run(c *v3.Client, bar *pb.ProgressBar) error {',
    '\treturn c.Do(v3.OpGet("k"))',
    '}',
    '',
  ].join('\n'),
  // The aliased import first.
  'tools/benchmark/cmd/put.go': [
    'package cmd',
    '',
    'import (',
    '\tv3 "go.etcd.io/etcd/client/v3"',
    '\t"github.com/cheggaaa/pb/v3"',
    ')',
    '',
    'func put(bar *pb.ProgressBar) v3.Op {',
    '\treturn v3.OpGet("k")',
    '}',
    '',
  ].join('\n'),
};

describe.each([
  ['default', 'LF'],
  ['wasm', 'LF'],
  ['default', 'CRLF'],
  ['wasm', 'CRLF'],
])('a Go import named explicitly owns its name (%s, %s)', (backend, eol) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-alias-'));
    for (const [rel, content] of Object.entries(MODULE)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), eol === 'CRLF' ? content.replace(/\n/g, '\r\n') : content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.destroy();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  const linksFrom = (file: string, name: string) => {
    const node = cg!.getNodesInFile(file).find((n) => n.name === name && n.kind !== 'import')!;
    expect(node, `${name} in ${file}`).toBeTruthy();
    return cg!.getOutgoingEdgesFrom([node.id])
      .filter((e) => e.kind !== 'contains')
      .map((e) => `${e.kind} ${cg!.getNode(e.target)!.filePath}:${cg!.getNode(e.target)!.qualifiedName}`)
      .sort();
  };

  it('`v3.` is the aliased import, whichever import comes first', () => {
    expect(linksFrom('tools/benchmark/cmd/txn_mixed.go', 'request')).toEqual(['references client/v3/op.go:Op']);
    expect(linksFrom('tools/benchmark/cmd/txn_mixed.go', 'run')).toEqual([
      'calls client/v3/op.go:Client::Do',
      'calls client/v3/op.go:OpGet',
      'references client/v3/op.go:Client',
    ]);
    expect(linksFrom('tools/benchmark/cmd/put.go', 'put')).toEqual([
      'calls client/v3/op.go:OpGet',
      'references client/v3/op.go:Op',
    ]);
  });
});
