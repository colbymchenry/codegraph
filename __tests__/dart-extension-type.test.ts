/**
 * A Dart 3 `extension type` is a type, and its members are its methods (#1784).
 *
 * `extension_type_declaration` was listed in neither extraction path's class
 * types. `extension_declaration` — the older `extension` — was, and the two
 * names are near neighbours, so the omission reads as an oversight.
 *
 * That is why #1780's `isInsideClassLikeNode()` gate dropped these members and
 * no others: the gate asks whether a class-like node is on the stack, and an
 * `extension type` never put one there. Before that gate the members were still
 * reached, but as top-level `function:km` rather than `method:MetersT::km` —
 * indexed, and attributed to nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const SRC = [
  'extension type MetersT(double value) {',
  '  double get km => value / 1000;',
  '  void report() {',
  '    print(km);',
  '  }',
  '}',
  '',
  'class Widget {',
  '  double get half => 1.0;',
  '}',
  '',
].join('\n');

describe('Dart extension type (#1784)', () => {
  it('is a type of its own, and its members are its methods', () => {
    const result = extractFromSource('probe.dart', SRC);
    expect(result.nodes.find((n) => n.name === 'MetersT')?.kind).toBe('class');

    const km = result.nodes.find((n) => n.name === 'km');
    expect(km, 'the getter must have a node').toBeDefined();
    expect(km?.kind).toBe('method');
    expect(km?.qualifiedName).toBe('MetersT::km');
  });

  it('does not cut the span of the member that follows a getter', () => {
    const result = extractFromSource('probe.dart', SRC);
    const report = result.nodes.find((n) => n.name === 'report');
    // The body runs to its closing brace, not to the signature line.
    expect(report?.endLine).toBeGreaterThan(report!.startLine);
  });

  it('leaves an ordinary class as it was', () => {
    const result = extractFromSource('probe.dart', SRC);
    expect(result.nodes.find((n) => n.name === 'Widget')?.kind).toBe('class');
    expect(result.nodes.find((n) => n.name === 'half')?.kind).toBe('method');
  });
});
