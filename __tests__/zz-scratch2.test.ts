import { describe, it, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars, getParser } from '../src/extraction/grammars';

beforeAll(async () => { await initGrammars(); await loadAllGrammars(); });

const CASES: Record<string,string> = {
  dot_plus: 'V f(V a, V b) { return a.operator+(b); }',
  arrow_plus: 'V f(V* a, V b) { return a->operator+(b); }',
  dot_sub: 'V f(V a) { return a.operator[](3); }',
  dot_call: 'V f(V a) { return a.operator()(3); }',
  dot_eq: 'bool f(V a, V b) { return a.operator==(b); }',
  dot_bool: 'bool f(V a) { return a.operator bool(); }',
  qualified: 'V f(V a, V b) { return V::operator+(a, b); }',
  free_op: 'V f(V a, V b) { return operator+(a, b); }',
  this_op: 'struct V { V g(V b) { return this->operator+(b); } };',
  member_op: 'struct V { V x; V g(V b) { return x.operator+(b); } };',
  arrow_deref: 'V f(V a) { return a.operator->(); }',
  dot_notop: 'bool f(V a) { return a.operator!(); }',
};

describe('dump', () => {
  it('all', () => {
    const p: any = getParser('cpp' as any);
    for (const [k, code] of Object.entries(CASES)) {
      const tree = p.parse(code);
      const dump = (n: any, d = 0): string => {
        let out = `${'  '.repeat(d)}${n.type}${n.childCount === 0 ? ' ' + JSON.stringify(n.text) : ''}\n`;
        for (let i = 0; i < n.childCount; i++) out += dump(n.child(i), d + 1);
        return out;
      };
      const call = (function find(n: any): any {
        if (n.type === 'call_expression') return n;
        for (let i = 0; i < n.childCount; i++) { const r = find(n.child(i)); if (r) return r; }
        return null;
      })(tree.rootNode);
      const refs = extractFromSource('t.cpp', code).unresolvedReferences.filter((r: any) => r.referenceKind === 'calls');
      console.log(`\n=== ${k}: ${code}\n${call ? dump(call) : '(no call_expression)'}refs: ${JSON.stringify(refs.map((r: any) => r.referenceName))}  hasError=${tree.rootNode.hasError}`);
    }
  });
});
