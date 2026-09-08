/**
 * A function bound by a `const` inside another function is a symbol (#1669).
 *
 * `const handleClear = () => {…}` inside a component is how every React
 * handler that skips `useCallback` is written. At module scope the same
 * declaration already names a function; inside a body it was skipped, so the
 * handler was absent from callers / impact — "Symbol not found", which reads
 * exactly like "no callers" — and its calls attributed to the component.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const refsFrom = (result: ReturnType<typeof extractFromSource>, id: string) =>
  result.unresolvedReferences.filter((r) => r.fromNodeId === id).map((r) => r.referenceName);

describe('declarator-bound functions inside a body', () => {
  it('extracts const arrows and function expressions as functions of the enclosing one', () => {
    const code = `
import { formatLabel, parseLabel } from './labels'
export default function Widget({ items, onPick }) {
  const handleClear = () => {
    onPick(null, null)
  }
  const describe = function (item) {
    return formatLabel(item)
  }
  let later = (x) => parseLabel(x)
  const count = items.length
  const [a, b] = [() => 1, () => 2]
  return items.map((i) => <button onClick={handleClear} onDoubleClick={() => describe(i)}>{later(i)}</button>)
}
`;
    const result = extractFromSource('src/widget.jsx', code);
    const fns = result.nodes.filter((n) => n.kind === 'function');
    const names = fns.map((n) => n.name);
    expect(names).toEqual(expect.arrayContaining(['Widget', 'handleClear', 'describe', 'later']));
    // A value, a destructuring and an inline arrow stay out.
    expect(names).not.toContain('count');
    expect(names).not.toContain('a');
    expect(names.filter((n) => n === '<anonymous>')).toEqual([]);

    const widget = fns.find((n) => n.name === 'Widget')!;
    const handleClear = fns.find((n) => n.name === 'handleClear')!;
    const describeFn = fns.find((n) => n.name === 'describe')!;
    expect(handleClear.qualifiedName).toBe('Widget::handleClear');
    expect(handleClear.startLine).toBe(4);
    expect(describeFn.startLine).toBe(7);

    // The handler's calls are its own; the component keeps what it does itself.
    expect(refsFrom(result, handleClear.id)).toContain('onPick');
    expect(refsFrom(result, widget.id)).not.toContain('onPick');
    expect(refsFrom(result, describeFn.id)).toContain('formatLabel');
    expect(refsFrom(result, widget.id)).toContain('handleClear');

    // Containment: the component contains its handlers.
    const contains = result.edges.filter((e) => e.kind === 'contains' && e.source === widget.id).map((e) => e.target);
    expect(contains).toContain(handleClear.id);
    expect(contains).toContain(describeFn.id);
  });

  it('does not apply outside the JS family', () => {
    const code = `
def outer():
    inner = lambda x: x + 1
    return inner(1)
`;
    const result = extractFromSource('src/mod.py', code);
    expect(result.nodes.filter((n) => n.kind === 'function').map((n) => n.name)).toEqual(['outer']);
  });
});
