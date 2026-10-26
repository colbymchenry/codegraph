/**
 * A directed Flow question ("how does X reach Y") names its two ends exactly,
 * as the viewer's links write them — a symbol's own name. Names the free-text
 * token filter drops were lost: an Objective-C selector (`initWithFrame:`), a
 * Ruby predicate (`valid?`), a two-letter method (`ok`). The other end was
 * then reported as naming nothing, though it was in the index.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flow-exact-'));
  const files: Record<string, string> = {
    'src/check.ts': `export function ok(): number {
  return go();
}

export function go(): number {
  return 1;
}
`,
    'app/models/order.rb': `class Order
  def save!
    raise ArgumentError unless valid?
  end

  def valid?
    true
  end
end
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

const directed = (from: string, to: string) =>
  resolveNamedSymbolFlow(cg, `${from} ${to}`, { mode: 'directed', from, to });

describe('a directed flow question', () => {
  it('reaches a two-letter name', () => {
    const flow = directed('ok', 'go');
    expect(flow.chains[0]?.steps.map((s) => s.node.name)).toEqual(['ok', 'go']);
  });

  it('reaches a name with punctuation', () => {
    const flow = directed('save!', 'valid?');
    expect(flow.tokens).toEqual(['save!', 'valid?']);
    expect(flow.chains[0]?.steps.map((s) => s.node.name)).toEqual(['save!', 'valid?']);
  });
});
