/**
 * In an HDL the design hierarchy IS the flow: how `top` reaches `uart_rx` is
 * `top` instantiating `uart_bridge` instantiating `uart_rx`. The flow finder
 * rides `instantiates` edges between Verilog modules (indexed as `class`),
 * and only there — a TS `new X()` stays a dependency, not a step.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';

let tempDir: string;
let cg: CodeGraph | null = null;

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-verilog-flow-'));
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(tempDir, rel), content);
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  return cg;
}

describe('Verilog: the module-instantiation hierarchy is the flow', () => {
  it('connects top to a leaf module through an unnamed bridge module', async () => {
    const g = await index({
      'top.v': 'module top(input clk, input rx, output tx);\n    uart_bridge bridge (.clk(clk), .rx(rx), .tx(tx));\nendmodule\n',
      'uart_bridge.v': 'module uart_bridge(input clk, input rx, output tx);\n    uart_rx rx_inst (.clk(clk), .rx(rx));\n    uart_tx tx_inst (.clk(clk), .tx(tx));\nendmodule\n',
      'uart_rx.v': 'module uart_rx(input clk, input rx);\nendmodule\n',
      'uart_tx.v': 'module uart_tx(input clk, output tx);\nendmodule\n',
    });
    const flow = resolveNamedSymbolFlow(g, 'top uart_rx');
    expect(flow.chains.length).toBeGreaterThan(0);
    const steps = flow.chains[0]!.steps;
    expect(steps.map((s) => s.node.name)).toEqual(['top', 'uart_bridge', 'uart_rx']);
    expect(steps.slice(1).map((s) => s.edge?.kind)).toEqual(['instantiates', 'instantiates']);
  });

  it('does not ride a TypeScript `new X()` the same way', async () => {
    const g = await index({
      'top.ts': "import { Bridge } from './bridge';\nexport function top() { return new Bridge(); }\n",
      'bridge.ts': "import { Leaf } from './leaf';\nexport class Bridge { leaf = new Leaf(); }\n",
      'leaf.ts': 'export class Leaf {}\n',
    });
    const flow = resolveNamedSymbolFlow(g, 'top Leaf');
    expect(flow.chains.map((c) => c.steps.map((s) => s.edge?.kind))).not.toContainEqual([undefined, 'instantiates', 'instantiates']);
  });
});
