import { describe, it, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars, getParser } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const CODE = `struct V {
    int x;
    V operator+(const V& o) const { return V{x + o.x}; }
    V operator[](int i) const { return V{x + i}; }
    int get() const { return x; }
};

int plainCaller(const V& a) { return a.get(); }
V explicitCaller(const V& a, const V& b) { return a.operator+(b); }
`;

describe('scratch', () => {
  it('dumps', async () => {
    const parser: any = getParser('cpp' as any);
    const tree = parser.parse(CODE);
    const dump = (n: any, d = 0) => {
      let out = `${'  '.repeat(d)}${n.type} [${JSON.stringify(n.text.slice(0, 40))}]\n`;
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        const f = n.fieldNameForChild ? n.fieldNameForChild(i) : null;
        out += `${'  '.repeat(d + 1)}${f ? f + ': ' : ''}`.trimEnd() ? '' : '';
        out += dump(c, d + 1);
      }
      return out;
    };
    // just dump the explicitCaller subtree
    console.log(dump(tree.rootNode));

    const result = extractFromSource('optest.cpp', CODE);
    console.log('NODES', result.nodes.map((n: any) => `${n.kind}:${n.name}`));
    console.log('KEYS', Object.keys(result));
    console.log('UREFS', JSON.stringify((result as any).unresolvedReferences, null, 1));
  });
});
