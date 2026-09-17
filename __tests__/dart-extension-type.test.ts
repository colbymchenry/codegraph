/**
 * Dart 3 `extension type` members (#1784).
 *
 * Dart spells an ordinary implemented method `method_signature`, the same node
 * type TypeScript uses for a bodiless interface member. #1780 gated that node
 * type behind `isInsideClassLikeNode()` to stop a TS interface member minting a
 * phantom free function — correct for TS, but an `extension type` body was not
 * class-like, so its members stopped being indexed at all.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Dart extension type members (#1784)', () => {
  it('indexes an extension type member, as a method of the extension type', () => {
    const code = `extension type Meters(double value) {
  double get km => value / 1000;
  void show() {
    print(km);
  }
}
`;
    const result = extractFromSource('meters.dart', code);
    const kinds = result.nodes.filter((n) => n.kind !== 'file').map((n) => `${n.kind}:${n.qualifiedName}`).sort();
    expect(kinds).toContain('class:Meters');
    expect(kinds).toContain('method:Meters::km');
    expect(kinds).toContain('method:Meters::show');
  });

  it('leaves extension, mixin and class bodies alone', () => {
    const code = `extension StringHelpers on String {
  String shout() => toUpperCase();
}

mixin Logger {
  void log(String m) {}
}

class Widget {
  void build() {}
}
`;
    const result = extractFromSource('rest.dart', code);
    const kinds = result.nodes.filter((n) => n.kind !== 'file').map((n) => `${n.kind}:${n.qualifiedName}`).sort();
    expect(kinds).toContain('method:StringHelpers::shout');
    expect(kinds).toContain('method:Logger::log');
    expect(kinds).toContain('method:Widget::build');
  });
});
