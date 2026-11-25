import { describe, it, expect } from 'vitest';
import { stripCommentsForRegex } from '../src/resolution/strip-comments';
import { getKernel } from '../src/extraction/kernel/loader';

/**
 * The pre-optimization split('')-based stripCStyle, kept verbatim as the
 * ORACLE: the rewritten segment-builder must be byte-identical on every
 * input (the C fn-pointer synthesizer's regexes run over this text, and any
 * divergence would silently change synthesized edges).
 */
function referenceStripCStyle(src: string, allowSingleQuoteStrings: boolean): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blankRange = (buf: string[], start: number, end: number): void => {
    for (let k = start; k < end; k++) {
      buf[k] = src[k] === '\n' ? '\n' : ' ';
    }
  };
  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? '';
    if (c === '/' && c2 === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i < n) i += 2;
      blankRange(out, start, i);
      continue;
    }
    if (c === '/' && c2 === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i);
      continue;
    }
    if (c === '"' || (allowSingleQuoteStrings && c === "'") || c === '`') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (quote !== '`' && src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === quote) i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

const FIXTURES: Array<[string, string]> = [
  ['plain code, no comments', 'int main(void) {\n\treturn a / b;\n}\n'],
  ['block comment', 'int x; /* a comment\nspanning lines */ int y;\n'],
  ['line comment', 'int x; // trailing\nint y;\n'],
  ['comment markers inside string', 'const char *s = "/* not a comment */ // nor this";\nint z;\n'],
  ['string inside comment', '/* "a string" inside */ int q;\n'],
  ['unterminated block comment', 'int a;\n/* runs to the end'],
  ['unterminated string', 'const char *s = "no close\nint b; /* real comment */\n'],
  ['escape at end of string', 'const char *s = "ends with backslash \\\\";\nint c;\n'],
  ['escape as last char of file', 'const char *s = "\\'],
  ['star at last char', 'int d; /*'],
  ['slash at last char', 'int e; /'],
  ['crlf line comment', 'int f; // comment\r\nint g;\r\n'],
  ['unicode in comment', 'int h; /* café résumé — dash */\nint i;\n'],
  ['astral chars in comment', 'int j; /* 🚀🎉 emoji */\nint k;\n'],
  ['unicode in string', 'const char *s = "café 🚀";\nint l;\n'],
  ['nested-looking block', '/* outer /* inner */ int m;\n'],
  ['comment right after string', '"str"/*c*/int n;\n'],
  ['backtick template (js mode relevance)', 'const t = `multi\nline ${x} // not comment`;\nint o;\n'],
  ['single quotes with escapes', "char c = '\\''; // char literal\nint p;\n"],
  ['empty input', ''],
  ['only a newline', '\n'],
  ['only a comment', '/*x*/'],
];

describe('stripCStyle segment-builder vs split-based oracle', () => {
  for (const [name, src] of FIXTURES) {
    it(`fixture: ${name} (c mode)`, () => {
      expect(stripCommentsForRegex(src, 'c')).toBe(referenceStripCStyle(src, false));
    });
    it(`fixture: ${name} (js mode, single-quote strings on)`, () => {
      expect(stripCommentsForRegex(src, 'javascript')).toBe(referenceStripCStyle(src, true));
    });
  }

  it('randomized differential (seeded, 500 cases)', () => {
    // Tiny deterministic LCG — no Math.random in tests that must reproduce.
    let seed = 0x2fn;
    const rand = (max: number): number => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      return Number(seed % BigInt(max));
    };
    const ATOMS = ['/*', '*/', '//', '\n', '"', "'", '`', '\\', 'x', ' ', '/', '*', 'é', '🚀', '\r\n', 'int a;'];
    for (let caseN = 0; caseN < 500; caseN++) {
      let s = '';
      const len = rand(40);
      for (let k = 0; k < len; k++) s += ATOMS[rand(ATOMS.length)]!;
      expect(stripCommentsForRegex(s, 'c'), `c-mode case ${caseN}: ${JSON.stringify(s)}`).toBe(
        referenceStripCStyle(s, false)
      );
      expect(stripCommentsForRegex(s, 'javascript'), `js-mode case ${caseN}: ${JSON.stringify(s)}`).toBe(
        referenceStripCStyle(s, true)
      );
    }
  });

  it('comment-free input returns the identical string (zero-copy path)', () => {
    const src = 'static int add(int a, int b) {\n\treturn a + b;\n}\n';
    expect(stripCommentsForRegex(src, 'c')).toBe(src);
  });
});

// The native kernel's C stripper (codegraph-kernel/src/cfnptr.rs) blanks per
// UTF-16 code unit precisely so its output is string-identical to the TS
// stripper — the cFnPtr extraction sweep's scanners then run over the same
// character stream on both paths. Pinned here against the same fixtures and
// randomized corpus as the TS rewrite.
const kernelStrip = getKernel()?.cfnptrStripC;
describe.runIf(typeof kernelStrip === 'function')('native cfnptrStripC vs TS stripper (c mode)', () => {
  for (const [name, src] of FIXTURES) {
    it(`fixture: ${name}`, () => {
      expect(kernelStrip!(src)).toBe(stripCommentsForRegex(src, 'c'));
    });
  }

  it('randomized differential (seeded, 500 cases)', () => {
    let seed = 0x2fn;
    const rand = (max: number): number => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      return Number(seed % BigInt(max));
    };
    const ATOMS = ['/*', '*/', '//', '\n', '"', "'", '`', '\\', 'x', ' ', '/', '*', 'é', '🚀', '\r\n', 'int a;'];
    for (let caseN = 0; caseN < 500; caseN++) {
      let s = '';
      const len = rand(40);
      for (let k = 0; k < len; k++) s += ATOMS[rand(ATOMS.length)]!;
      expect(kernelStrip!(s), `case ${caseN}: ${JSON.stringify(s)}`).toBe(stripCommentsForRegex(s, 'c'));
    }
  });
});
