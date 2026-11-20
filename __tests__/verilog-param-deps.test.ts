import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => { await initGrammars(); await loadAllGrammars(); });

describe('HDL parameter dependencies', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('a parameter references the identifiers of its value, never its own name or a callee', () => {
    const code = `module m;
  parameter  N = 8;
  localparam K = (N + 1) * 2;
  localparam M = K << 1, W = $clog2(N) + width_of(K);
  localparam P = pkg::BASE + N;
endmodule`;
    const result = extractFromSource('m.sv', code);
    const byName = Object.fromEntries(result.nodes.filter(n => n.kind === 'constant').map(n => [n.name, n]));
    const refsFrom = (name: string) => result.unresolvedReferences
      .filter(r => r.fromNodeId === byName[name]!.id && r.referenceName.startsWith('hdl:signal:'))
      .map(r => r.referenceName.slice('hdl:signal:'.length));
    expect(refsFrom('N')).toEqual([]);
    expect(refsFrom('K')).toEqual(['N']);
    expect(refsFrom('M')).toEqual(['K']);
    // $clog2 is a system task, width_of a callee: only their arguments count.
    expect(refsFrom('W').sort()).toEqual(['K', 'N']);
    // pkg::BASE is a package item, not evidence for a local named BASE.
    expect(refsFrom('P')).toEqual(['N']);
  });

  it('impact on a parameter follows the derived-parameter chain, and stays inside its module', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-hdl-params-'));
    fs.writeFileSync(path.join(dir, 'a.sv'), `module a;
  parameter  N = 8;
  localparam K = (N + 1) * 2;
  localparam M = K << 1;
endmodule
module b;
  parameter  N = 4;
  localparam Q = N * 3;
endmodule
`);
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      const constant = (qualified: string) => cg.getNodesByKind('constant').find(n => n.qualifiedName === qualified)!;
      const dependents = (qualified: string) => cg.getCallers(constant(qualified).id)
        .filter(c => c.edge.kind === 'references').map(c => c.node.qualifiedName).sort();
      expect(dependents('a::N')).toEqual(['a::K']);
      expect(dependents('a::K')).toEqual(['a::M']);
      // Same-named parameter of another module: bound lexically, not by name.
      expect(dependents('b::N')).toEqual(['b::Q']);
      const impacted = [...cg.getImpactRadius(constant('a::N').id, 3).nodes.values()].map(n => n.qualifiedName);
      expect(impacted).toEqual(expect.arrayContaining(['a::K', 'a::M']));
      expect(impacted).not.toContain('b::Q');
    } finally {
      cg.close();
    }
  });
});
