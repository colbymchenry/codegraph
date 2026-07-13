import { describe, it, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
beforeAll(async () => { await initGrammars(); await loadAllGrammars(); });
describe('d', () => { it('n', () => {
  const code = `struct V {
  int x;
  operator bool() const { return x != 0; }
  V operator+(const V& o) const { return V{x+o.x}; }
  V& operator=(const V& o) { x = o.x; return *this; }
};`;
  const r = extractFromSource('t.cpp', code);
  console.log('NODES', r.nodes.map((n: any) => `${n.kind}:${JSON.stringify(n.name)}`));
}); });
