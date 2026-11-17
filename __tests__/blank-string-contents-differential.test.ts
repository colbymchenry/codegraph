import { describe, it, expect } from 'vitest';
import { blankStringContents, REGEX_START_BEFORE } from '../src/resolution/strip-comments';

/**
 * The split('')-based blankStringContents, kept verbatim as the ORACLE: the
 * slice-built rewrite must be byte-identical on every input, regex-literal
 * offsets included (the JS/TS scope reader and many receiver readers run their
 * regexes over this text).
 */
function referenceBlankStringContents(text: string, regexLiterals?: number[]): string {
  const out = text.split('');
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '/' && REGEX_START_BEFORE.test(text.slice(Math.max(0, i - 32), i))) {
      let end = i + 1;
      let inClass = false;
      for (; end < n && text[end] !== '\n'; end++) {
        if (text[end] === '\\') { end++; continue; }
        if (text[end] === '[') inClass = true;
        if (text[end] === ']') inClass = false;
        if (text[end] === '/' && !inClass) break;
      }
      if (end < n && text[end] === '/') {
        regexLiterals?.push(i, end);
        i = end + 1;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\' && i + 1 < n) {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (quote !== '`' && text[i] === '\n') break;
        if (text[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n && text[i] === quote) i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

const FIXTURES: Array<[string, string]> = [
  ['no strings', 'const a = b + c;\n'],
  ['double and single quotes', `const a = "x y"; const b = 'z';\n`],
  ['template over lines', 'const t = `one\ntwo ${x}\nthree`;\n'],
  ['template with CRLF', 'const t = `one\r\ntwo`;\r\n'],
  ['escaped quote', 'const s = "say \\"hi\\"";\n'],
  ['escaped newline continues a string', 'const s = "a\\\nb"; const c = 1;\n'],
  ['unescaped newline ends a string', 'const s = "open\nconst c = 1;\n'],
  ['escape as last char', 'const s = "\\'],
  ['unterminated template', 'const t = `runs\nto the end'],
  ['regex with quote', "const r = /it's/; const s = 'x';\n"],
  ['regex with class slash', 'const r = /[/"]/g; f("a");\n'],
  ['division is no regex', 'const x = a / b; const s = "/";\n'],
  ['regex after return', "function f() { return /'/.test(s); }\n"],
  ['astral and accents', "const s = 'café 🚀'; const t = `é\n🚀`;\n"],
  ['empty', ''],
  ['quote at end', '"'],
];

describe('blankStringContents by slices vs the split-based oracle', () => {
  for (const [name, src] of FIXTURES) {
    it(`fixture: ${name}`, () => {
      const got: number[] = [];
      const want: number[] = [];
      expect(blankStringContents(src, got)).toBe(referenceBlankStringContents(src, want));
      expect(got).toEqual(want);
      expect(blankStringContents(src)).toBe(referenceBlankStringContents(src));
    });
  }

  it('randomized differential (seeded, 2000 cases)', () => {
    // Tiny deterministic LCG — no Math.random in tests that must reproduce.
    let seed = 0x3bn;
    const rand = (max: number): number => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      return Number(seed % BigInt(max));
    };
    const ATOMS = ['"', "'", '`', '\\', '/', '[', ']', '\n', '\r\n', 'x', ' ', '=', '(', ')', 'return ', '${', '}', 'é', '🚀', 'a / b'];
    for (let caseN = 0; caseN < 2000; caseN++) {
      let s = '';
      const len = rand(48);
      for (let k = 0; k < len; k++) s += ATOMS[rand(ATOMS.length)]!;
      const got: number[] = [];
      const want: number[] = [];
      expect(blankStringContents(s, got), `case ${caseN}: ${JSON.stringify(s)}`).toBe(referenceBlankStringContents(s, want));
      expect(got, `case ${caseN} offsets`).toEqual(want);
    }
  });

  it('text with no string returns the identical string', () => {
    const src = 'const a = b + c;\n';
    expect(blankStringContents(src)).toBe(src);
  });
});
