/**
 * `memberTypesInTree`'s python reader, at the unit level — the shapes it must
 * read and the ones it must refuse to be fooled by.
 *
 * The end-to-end behaviour lives in `python-attr-type.test.ts`; these pin the
 * reader itself, because several of the defects below are invisible end-to-end
 * whenever the resolver would have produced nothing anyway.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { memberTypesInSource } from '../src/graph/branch-guards';

const read = async (src: string, line: number) =>
  Object.fromEntries(await memberTypesInSource(src, 'python', line));

describe('python member types', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['python']);
  });

  it('reads a decorated __init__ and a decorated method', async () => {
    // tree-sitter wraps a decorated `def` in `decorated_definition`; testing the
    // wrapper's type made every decorated method invisible, and dependency
    // injection and `@property` are exactly where python puts its types.
    expect(
      await read(
        'class B:\n    @inject\n    def __init__(self, dep: Real):\n        self._dep = dep\n\n'
          + '    def go(self, x):\n        return self._dep.run(x)\n',
        6,
      ),
    ).toEqual({ _dep: 'Real' });

    expect(
      await read(
        'class B:\n    @property\n    def setup(self):\n        self.h = Real()\n\n'
          + '    def go(self, x):\n        return self.h.run(x)\n',
        6,
      ),
    ).toEqual({ h: 'Real' });
  });

  it("does not leak an __init__ parameter's type onto a same-named local elsewhere", async () => {
    // `dep` in `load` is an unrelated local. Binding the constructor's type to
    // it produced a wrong edge — the fabrication class this whole path exists
    // to prevent.
    expect(
      await read(
        'class B:\n    def __init__(self, dep: Real):\n        self._dep = dep\n\n'
          + '    def load(self):\n        dep = make_decoy()\n        self._cache = dep\n\n'
          + '    def go(self, x):\n        return self._cache.run(x)\n',
        9,
      ),
    ).toEqual({ _dep: 'Real' });
  });

  it('finds the class from a deeply nested call site', async () => {
    // `with` + `for` + `if` + `try` + `while` inside a method is ordinary
    // python; a fixed 16-frame climb lost the class at six and read as "this
    // class declares nothing".
    expect(
      await read(
        'class B:\n    def __init__(self):\n        self.h = Real()\n\n    def go(self, x):\n'
          + '        with a() as f:\n            for i in x:\n                if i:\n'
          + '                    try:\n                        while i:\n'
          + '                            return self.h.run(i)\n'
          + '                    except E:\n                        pass\n',
        11,
      ),
    ).toEqual({ h: 'Real' });
  });

  it('ignores a docstring and a nested class', async () => {
    expect(
      await read(
        'class B:\n    """Docs.\n\n    Example:\n        self.h = Decoy()\n    """\n\n'
          + '    class Nested:\n        def __init__(self):\n            self.h = Inner()\n\n'
          + '    def __init__(self):\n        self.h = Real()\n\n'
          + '    def go(self, x):\n        return self.h.run(x)\n',
        15,
      ),
    ).toEqual({ h: 'Real' });
  });

  it('prefers an annotation over a constructor call written earlier', async () => {
    expect(
      await read(
        'class B:\n    def __init__(self):\n        self.h = Decoy()\n\n'
          + '    def wire(self, c):\n        self.h: Real = c\n\n'
          + '    def go(self, x):\n        return self.h.run(x)\n',
        8,
      ),
    ).toEqual({ h: 'Real' });
  });
});
