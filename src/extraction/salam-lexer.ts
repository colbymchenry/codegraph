/**
 * Salam lexer
 *
 * Mirrors the tokenizer of the Salam compiler (`compiler/lexer/` and
 * `compiler/langpack.salam` in https://github.com/SalamLang/Salam) closely
 * enough that the extractor sees the same token stream the compiler parses:
 *
 *  - Two keyword sets (English and Persian). A file's set comes from a
 *    `// language: fa` marker in its first lines, else from whichever set
 *    matches more of the file's words.
 *  - Identifiers are any run of ASCII letters/digits/`_` and non-ASCII
 *    characters, so `اعشار۶۴` is one word. A ZWNJ inside an identifier reads as
 *    a space, and Arabic yeh/kaf fold to the Persian forms.
 *  - A newline ends a statement unless the line stops on an operator, a comma,
 *    a `.`, a `:` or an opening bracket, or sits inside parentheses.
 *  - After `layout:` (and after a `component Name(...)` header) the source is
 *    scanned line by line as the layout DSL, exactly like the compiler does.
 */

/** Keyword packs: English and Persian, as in the compiler's `compiler/langpack.salam`. */
export type SalamLang = 'en' | 'fa';

export type TokType =
  | 'id' // identifier word
  | 'kw' // keyword (v = canonical English spelling)
  | 'num'
  | 'str'
  | 'op' // punctuation / operator (v = the symbol)
  | 'end' // statement terminator
  | 'meta' // @en / @fa annotation (v = canonical language code)
  | 'lel' // layout element name
  | 'lattr' // layout attribute name
  | 'eof';

export interface Tok {
  t: TokType;
  v: string;
  line: number;
  col: number;
  off: number;
  eLine: number;
  eCol: number;
  eOff: number;
}

export interface SalamComment {
  line: number;
  endLine: number;
  /** Comment body without its delimiters, trimmed. */
  text: string;
  block: boolean;
}

export interface LexResult {
  toks: Tok[];
  comments: SalamComment[];
  lang: SalamLang;
}

export type SalamKeyword =
  | 'func' | 'ret' | 'if' | 'else' | 'until' | 'on' | 'mut' | 'const' | 'type'
  | 'struct' | 'enum' | 'end' | 'import' | 'as' | 'true' | 'false' | 'null'
  | 'this' | 'break' | 'continue' | 'layout' | 'package' | 'print' | 'println'
  | 'printerr' | 'printerrln' | 'input' | 'defer' | 'operator' | 'extern'
  | 'interface' | 'pub' | 'inline' | 'noinline' | 'pure' | 'noret'
  | 'deprecated' | 'component' | 'repeat' | 'impl' | 'to' | 'step' | 'each'
  | 'in' | 'with' | 'match' | 'switch';

/** Word operators. Persian spells `&&`, `||`, `==` and `!=` as words. */
type WordOp = '&&' | '||' | '==' | '!=';
const WORD_OPS = new Set<string>(['&&', '||', '==', '!=']);

// Keyword spellings. Source of truth: `compiler/langpack.salam` (k_kw_spell_*).
const EN_KEYWORDS: Array<[string, SalamKeyword]> = [
  ['func', 'func'], ['ret', 'ret'], ['if', 'if'], ['else', 'else'], ['until', 'until'],
  ['on', 'on'], ['mut', 'mut'], ['const', 'const'], ['type', 'type'], ['struct', 'struct'],
  ['enum', 'enum'], ['end', 'end'], ['import', 'import'], ['as', 'as'], ['true', 'true'],
  ['false', 'false'], ['null', 'null'], ['this', 'this'], ['break', 'break'],
  ['continue', 'continue'], ['layout', 'layout'], ['package', 'package'], ['print', 'print'],
  ['println', 'println'], ['printerr', 'printerr'], ['printerrln', 'printerrln'],
  ['input', 'input'], ['defer', 'defer'], ['operator', 'operator'], ['extern', 'extern'],
  ['interface', 'interface'], ['pub', 'pub'], ['inline', 'inline'], ['noinline', 'noinline'],
  ['pure', 'pure'], ['noret', 'noret'], ['deprecated', 'deprecated'],
  ['component', 'component'], ['repeat', 'repeat'], ['impl', 'impl'], ['to', 'to'],
  ['by', 'step'], ['each', 'each'], ['in', 'in'], ['with', 'with'], ['match', 'match'],
  ['switch', 'switch'],
];

/**
 * Persian spellings (`k_kw_spell_fa` in `compiler/langpack.salam`). `تا` is
 * `until` and `to`; the lexer picks by context (`atValueEnd`: right after a
 * value it continues a range, otherwise it opens a fresh loop). `هر` and `از`
 * double as the `repeat` step and index words (`each` / `in`).
 */
const FA_KEYWORDS: Array<[string, SalamKeyword | WordOp]> = [
  ['روال', 'func'], ['برگشت', 'ret'], ['اگر', 'if'], ['وگرنه', 'else'], ['تا', 'until'],
  ['بر', 'on'], ['ناپایا', 'mut'], ['پایا', 'const'], ['گونه', 'type'], ['ساختار', 'struct'],
  ['جداشمار', 'enum'], ['پایان', 'end'], ['واردسازی', 'import'], ['برگردان', 'as'],
  ['درست', 'true'], ['نادرست', 'false'], ['پوچ', 'null'], ['این', 'this'], ['بشکن', 'break'],
  ['گذر', 'continue'], ['چیدمان', 'layout'], ['بسته', 'package'], ['چاپ', 'print'],
  ['سرچاپ', 'println'], ['نادرست‌چاپ', 'printerr'], ['نادرست‌سرچاپ', 'printerrln'],
  ['ورودی', 'input'], ['دیرکن', 'defer'], ['کارور', 'operator'], ['فراخوانه', 'extern'],
  ['میانجی', 'interface'], ['همگانی', 'pub'], ['درخط', 'inline'], ['نادرخط', 'noinline'],
  ['ناب', 'pure'], ['نابرگشت', 'noret'], ['بی‌کاره', 'deprecated'], ['بخش', 'component'],
  ['تکرار', 'repeat'], ['کاربست', 'impl'], ['هر', 'each'], ['از', 'in'],
  ['همخوان', 'match'], ['و', '&&'], ['یا', '||'], ['برابر', '=='], ['نابرابر', '!='],
  ['ترابرد', 'switch'],
];

const ZWNJ = '‌';
const FA_LINK_KINDS: Record<string, string> = {
  static: 'static', dynamic: 'dynamic', framework: 'framework',
  ایستا: 'static', پویا: 'dynamic', چارچوب: 'framework',
};

/** Fold characters the compiler treats as interchangeable in keywords. */
function foldKeywordKey(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch === ' ' || ch === ZWNJ) continue;
    if (ch === 'ي' || ch === 'ی') out += '\u0001';
    else if (ch === 'ك' || ch === 'ک') out += '\u0002';
    else out += ch;
  }
  return out;
}

function hasJoinChar(s: string): boolean {
  return /[ ‌يیكک]/.test(s);
}

/** Identifier normalisation used for every non-keyword word. */
export function normalizeIdent(raw: string): string {
  if (!/[‌يك]/.test(raw)) return raw;
  return raw.replace(/‌/g, ' ').replace(/ي/g, 'ی').replace(/ك/g, 'ک');
}

const EN_MAP = new Map<string, SalamKeyword | WordOp>(EN_KEYWORDS);
const FA_EXACT = new Map<string, SalamKeyword | WordOp>(FA_KEYWORDS);
const FA_FOLDED = new Map<string, SalamKeyword | WordOp>(
  FA_KEYWORDS.map(([k, v]) => [foldKeywordKey(k), v]),
);

export function lookupKeyword(lang: SalamLang, raw: string): SalamKeyword | WordOp | undefined {
  if (lang === 'en') return EN_MAP.get(raw);
  const exact = FA_EXACT.get(raw);
  if (exact) return exact;
  if (hasJoinChar(raw)) return FA_FOLDED.get(foldKeywordKey(raw));
  return undefined;
}

/** `link static "lib"` names a native library; `kind` is its canonical kind. */
export function canonLinkKind(word: string): string | undefined {
  return FA_LINK_KINDS[word];
}

/** Persian word for `link` (`compiler/langpack.salam`, k_ctx_spell_fa). */
export const LINK_WORDS = new Set(['link', 'پیوند']);

/** Keywords the compiler lets a multi-word member name absorb. */
export function isAliasWordKeyword(v: string): boolean {
  return v === 'with' || v === 'package' || v === 'in' || v === 'input' || v === 'repeat' || v === 'component';
}

function isAsciiDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/** ASCII, Arabic-Indic (U+0660..) and Persian (U+06F0..) digits. */
function isDigitCode(c: number): boolean {
  return isAsciiDigit(c) || (c >= 0x660 && c <= 0x669) || (c >= 0x6f0 && c <= 0x6f9);
}

function isAlpha(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
}

function isIdentStart(c: number): boolean {
  return isAlpha(c) || c === 95 || c >= 128;
}

function isIdentCont(c: number): boolean {
  return isIdentStart(c) || isAsciiDigit(c);
}

/** Persian comma `،` and question mark `؟` end a word and are operators. */
function isPersianPunct(c: number): boolean {
  return c === 0x60c || c === 0x61f;
}

const OPS3 = new Set(['<<=', '>>=', '^^=', '...']);
const OPS2 = new Set([
  ':=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '++', '--', '==', '!=', '<=',
  '>=', '<<', '>>', '&&', '||', '^^', '=>',
]);
const OPS1 = new Set('()[]{},:?.+-*/%=!<>&|^~;'.split(''));

/** Operators after which a newline does not end the statement. */
const CONTINUING_OPS = new Set([
  '+', '-', '/', '%', '^^', '==', '!=', '<', '>', '<=', '>=', '&&', '||', '!', '=', '+=',
  '-=', '*=', '/=', '%=', '^^=', ',', '.', ':', '(', '[', '{',
]);

const enum LayoutSub { Name, Value }

class Lexer {
  private off = 0;
  private line = 1;
  private lineStart = 0;
  private readonly n: number;
  toks: Tok[] = [];
  comments: SalamComment[] = [];

  private groupDepth = 0;
  private lastTok: Tok | undefined;
  private layoutMode = false;
  private layoutDepth = 0;
  private layoutSub: LayoutSub = LayoutSub.Name;
  private compHeader = false;

  constructor(private readonly src: string, private readonly lang: SalamLang) {
    this.n = src.length;
  }

  run(): void {
    while (this.off < this.n) {
      if (this.layoutMode) {
        this.layoutStep();
        continue;
      }
      this.skipTrivia();
      if (this.off >= this.n) break;
      this.scanOne();
    }
    this.newlineTerminator();
    this.toks.push({
      t: 'eof', v: '', line: this.line, col: this.off - this.lineStart, off: this.off,
      eLine: this.line, eCol: this.off - this.lineStart, eOff: this.off,
    });
  }

  private cc(o = this.off): number {
    return o < this.n ? this.src.charCodeAt(o) : 0;
  }

  /** Move to `to`, keeping line bookkeeping. */
  private goto(to: number): void {
    const end = Math.min(to, this.n);
    for (let i = this.off; i < end; i++) {
      if (this.src.charCodeAt(i) === 10) {
        this.line++;
        this.lineStart = i + 1;
      }
    }
    this.off = end;
  }

  private push(t: TokType, v: string, start: number, sLine: number, sCol: number): Tok {
    const tok: Tok = {
      t, v, line: sLine, col: sCol, off: start,
      eLine: this.line, eCol: this.off - this.lineStart, eOff: this.off,
    };
    this.toks.push(tok);
    this.lastTok = tok;
    return tok;
  }

  private continues(tok: Tok): boolean {
    if (tok.t === 'op') return CONTINUING_OPS.has(tok.v);
    return tok.t === 'kw' && tok.v === 'as';
  }

  private newlineTerminator(): void {
    if (this.groupDepth !== 0 || !this.lastTok || this.lastTok.t === 'end' || this.continues(this.lastTok)) {
      return;
    }
    const col = this.off - this.lineStart;
    const tok: Tok = {
      t: 'end', v: '\n', line: this.line, col, off: this.off, eLine: this.line, eCol: col, eOff: this.off,
    };
    this.toks.push(tok);
    this.lastTok = tok;
    this.compHeader = false;
  }

  private skipTrivia(): void {
    for (;;) {
      const c = this.cc();
      if (this.off >= this.n) return;
      if (c === 32 || c === 9 || c === 13) {
        this.off++;
        continue;
      }
      if (c === 10) {
        this.goto(this.off + 1);
        this.newlineTerminator();
        continue;
      }
      if (c === 47 && this.cc(this.off + 1) === 47) {
        this.lineComment();
        continue;
      }
      if (c === 47 && this.cc(this.off + 1) === 42) {
        this.blockComment();
        continue;
      }
      return;
    }
  }

  private lineComment(): void {
    const start = this.off;
    let e = start;
    while (e < this.n && this.src.charCodeAt(e) !== 10) e++;
    this.comments.push({
      line: this.line, endLine: this.line, block: false,
      text: this.src.slice(start + 2, e).trim(),
    });
    this.off = e;
  }

  private blockComment(): void {
    const start = this.off;
    const sLine = this.line;
    let depth = 1;
    let i = start + 2;
    while (i < this.n) {
      const c = this.src.charCodeAt(i);
      if (c === 47 && this.src.charCodeAt(i + 1) === 42) {
        depth++;
        i += 2;
      } else if (c === 42 && this.src.charCodeAt(i + 1) === 47) {
        depth--;
        i += 2;
        if (depth === 0) break;
      } else {
        i++;
      }
    }
    const body = this.src.slice(start + 2, depth === 0 ? i - 2 : i);
    this.goto(i);
    this.comments.push({ line: sLine, endLine: this.line, block: true, text: body.trim() });
    if (this.line !== sLine) this.newlineTerminator();
  }

  private scanOne(): void {
    const c = this.cc();
    const start = this.off;
    const sLine = this.line;
    const sCol = start - this.lineStart;

    if (isDigitCode(c) || (c === 46 && isDigitCode(this.cc(start + 1)))) {
      this.scanNumber(start, sLine, sCol);
      return;
    }
    if (c === 117 /* u */ && (this.cc(start + 1) === 34 || this.cc(start + 1) === 39)) {
      this.off = start + 1;
      this.scanQuoted(this.cc(), start, sLine, sCol);
      return;
    }
    if (c === 0xab) {
      this.scanGuillemet(start, sLine, sCol);
      return;
    }
    if (c >= 128 && this.scanUnicodeOp(start, sLine, sCol)) return;
    if (isIdentStart(c)) {
      this.scanIdent(start, sLine, sCol);
      return;
    }
    if (c === 34 || c === 39) {
      this.scanQuoted(c, start, sLine, sCol);
      return;
    }
    if (c === 96) {
      this.scanRaw(start, sLine, sCol);
      return;
    }
    if (c === 64 && isIdentStart(this.cc(start + 1))) {
      this.scanMeta(start, sLine, sCol);
      return;
    }
    this.scanOp(start, sLine, sCol);
  }

  private scanNumber(start: number, sLine: number, sCol: number): void {
    let i = start;
    let hex = false;
    if (this.cc(i) === 48 && (this.cc(i + 1) === 120 || this.cc(i + 1) === 88)) hex = true;
    let seenDot = false;
    while (i < this.n) {
      const c = this.src.charCodeAt(i);
      if (isDigitCode(c) || isAlpha(c) || c === 95) {
        i++;
      } else if (c === 46 && !seenDot && !hex && isDigitCode(this.cc(i + 1))) {
        seenDot = true;
        i++;
      } else if ((c === 43 || c === 45) && !hex && (this.cc(i - 1) === 101 || this.cc(i - 1) === 69) && isDigitCode(this.cc(i + 1))) {
        i++;
      } else {
        break;
      }
    }
    if (i === start) i++;
    this.off = i;
    this.push('num', this.src.slice(start, i), start, sLine, sCol);
  }

  private scanQuoted(quote: number, start: number, sLine: number, sCol: number): void {
    if (quote === 34 && this.cc(this.off + 1) === 34 && this.cc(this.off + 2) === 34) {
      let i = this.off + 3;
      while (i < this.n) {
        const c = this.src.charCodeAt(i);
        if (c === 92) i += 2;
        else if (c === 34 && this.cc(i + 1) === 34 && this.cc(i + 2) === 34) {
          i += 3;
          break;
        } else i++;
      }
      this.goto(Math.min(i, this.n));
      this.push('str', this.src.slice(start, this.off), start, sLine, sCol);
      return;
    }
    let i = this.off + 1;
    while (i < this.n) {
      const c = this.src.charCodeAt(i);
      if (c === 92) {
        i += 2;
      } else if (c === quote) {
        i++;
        break;
      } else if (c === 10) {
        break;
      } else {
        i++;
      }
    }
    this.off = Math.min(i, this.n);
    this.push('str', this.src.slice(start, this.off), start, sLine, sCol);
  }

  private scanGuillemet(start: number, sLine: number, sCol: number): void {
    let i = start + 1;
    while (i < this.n) {
      const c = this.src.charCodeAt(i);
      if (c === 92) i += 2;
      else if (c === 0xbb) {
        i++;
        break;
      } else if (c === 10) break;
      else i++;
    }
    this.off = Math.min(i, this.n);
    this.push('str', this.src.slice(start, this.off), start, sLine, sCol);
  }

  private scanRaw(start: number, sLine: number, sCol: number): void {
    let i = start + 1;
    while (i < this.n && this.src.charCodeAt(i) !== 96) i++;
    this.goto(Math.min(i + 1, this.n));
    this.push('str', this.src.slice(start, this.off), start, sLine, sCol);
  }

  private scanUnicodeOp(start: number, sLine: number, sCol: number): boolean {
    const c = this.cc();
    let v: string | undefined;
    if (c === 0xff0b) v = '+';
    else if (c === 0x60c) v = ',';
    else if (c === 0xff0d || c === 0x2212) v = '-';
    else if (c === 0x61f) v = '?';
    if (!v) return false;
    this.off = start + 1;
    this.push('op', v, start, sLine, sCol);
    return true;
  }

  private scanIdent(start: number, sLine: number, sCol: number): void {
    let i = start;
    while (i < this.n && isIdentCont(this.src.charCodeAt(i)) && !isPersianPunct(this.src.charCodeAt(i))) i++;
    this.off = i;
    let raw = this.src.slice(start, i);
    let kw = lookupKeyword(this.lang, raw);
    // `input` before a plain word is the start of a name (`ورودی خروجی`), not the keyword.
    if (kw === 'input' && this.inputStartsName(i)) kw = undefined;
    if (this.lang === 'fa') {
      // `تا` is `to` right after a value (an operand just ended, so this
      // continues a range) and `until` at the start of a fresh statement.
      if (kw === 'until' && raw === 'تا' && this.atValueEnd()) kw = 'to';
      // `نادرست چاپ` (with a space) spells the same keyword as `نادرست‌چاپ`.
      if (kw === 'false') {
        const merged = this.spacedKeywordEnd(i);
        if (merged > 0) {
          const cand = this.src.slice(start, merged);
          const k2 = lookupKeyword('fa', cand);
          if (k2 === 'printerr' || k2 === 'printerrln') {
            kw = k2;
            raw = cand;
            this.off = merged;
          }
        }
      }
    }
    if (kw && WORD_OPS.has(kw)) {
      this.push('op', kw, start, sLine, sCol);
      return;
    }
    if (kw) {
      this.push('kw', kw, start, sLine, sCol);
      if (kw === 'component') this.compHeader = true;
      return;
    }
    this.push('id', normalizeIdent(raw), start, sLine, sCol);
  }

  /**
   * Whether the token just lexed ends a value (a literal, an identifier, or a
   * closing `)`/`]`) — the position after which Persian `تا` continues a range
   * (`to`) rather than opening a fresh `until` loop.
   */
  private atValueEnd(): boolean {
    const t = this.lastTok;
    if (!t) return false;
    if (t.t === 'num' || t.t === 'str' || t.t === 'id') return true;
    if (t.t === 'op') return t.v === ')' || t.v === ']';
    if (t.t === 'kw') return t.v === 'true' || t.v === 'false' || t.v === 'null' || t.v === 'this';
    return false;
  }

  /** Whether the word after `at` (past ASCII spaces) is an ordinary identifier. */
  private inputStartsName(at: number): boolean {
    const e = this.spacedKeywordEnd(at);
    if (e === 0) return false;
    let j = at;
    while (this.src.charCodeAt(j) === 32) j++;
    return lookupKeyword(this.lang, this.src.slice(j, e)) === undefined;
  }

  /** End of a word that follows `at` after ASCII spaces, or 0. */
  private spacedKeywordEnd(at: number): number {
    let j = at;
    while (j < this.n && this.src.charCodeAt(j) === 32) j++;
    if (j === at || j >= this.n || !isIdentStart(this.src.charCodeAt(j))) return 0;
    let e = j;
    while (e < this.n && isIdentCont(this.src.charCodeAt(e))) e++;
    return e;
  }

  private scanMeta(start: number, sLine: number, sCol: number): void {
    let i = start + 1;
    while (i < this.n && isIdentCont(this.src.charCodeAt(i))) i++;
    this.off = i;
    this.push('meta', this.src.slice(start + 1, i), start, sLine, sCol);
  }

  private scanOp(start: number, sLine: number, sCol: number): void {
    const s3 = this.src.substr(start, 3);
    const s2 = s3.slice(0, 2);
    let v: string;
    if (OPS3.has(s3)) v = s3;
    else if (OPS2.has(s2)) v = s2;
    else v = this.src[start] ?? '';
    if (!OPS1.has(v) && !OPS2.has(v) && !OPS3.has(v)) {
      // Unknown character: consume it as an operator token so the parser
      // reports a syntax problem instead of stalling.
      v = this.src[start] ?? '';
    }
    const prev = this.lastTok;
    this.off = start + v.length;
    if (v === '(') this.groupDepth++;
    else if (v === ')' && this.groupDepth > 0) this.groupDepth--;
    this.push('op', v, start, sLine, sCol);

    if (v === ':' && ((prev && prev.t === 'kw' && prev.v === 'layout') || (this.compHeader && this.groupDepth === 0))) {
      this.layoutMode = true;
      this.layoutDepth = 1;
      this.layoutSub = LayoutSub.Name;
      this.compHeader = false;
    }
  }

  // ---- layout DSL ---------------------------------------------------------

  private layoutSkipInlineWs(): void {
    for (;;) {
      const c = this.cc();
      if (c === 32 || c === 9 || c === 13) {
        this.off++;
      } else if (c === 47 && this.cc(this.off + 1) === 47) {
        this.lineComment();
      } else {
        return;
      }
    }
  }

  private layoutEmitOp(v: string): void {
    const start = this.off;
    const sLine = this.line;
    const sCol = start - this.lineStart;
    this.off = start + 1;
    this.push('op', v, start, sLine, sCol);
  }

  private layoutClose(): void {
    this.layoutDepth--;
    if (this.layoutDepth <= 0) this.layoutMode = false;
  }

  private layoutEndKeyword(): string {
    return this.lang === 'en' ? 'end' : 'پایان';
  }

  private layoutTryEndInline(start: number, sLine: number, sCol: number): boolean {
    const isBoundary = (c: number) => c === 32 || c === 9 || c === 13 || c === 10 || c === 0;
    const kws = this.lang === 'en' ? ['end'] : [this.layoutEndKeyword(), 'end'];
    for (const kw of kws) {
      if (this.src.startsWith(kw, start) && isBoundary(this.cc(start + kw.length))) {
        this.off = start + kw.length;
        this.push('kw', 'end', start, sLine, sCol);
        this.layoutClose();
        return true;
      }
    }
    return false;
  }

  private layoutName(): void {
    const start = this.off;
    const sLine = this.line;
    const sCol = start - this.lineStart;
    if (this.layoutTryEndInline(start, sLine, sCol)) return;
    let i = start;
    while (i < this.n) {
      const c = this.src.charCodeAt(i);
      if (c === 58 || c === 61 || c === 10) break;
      i++;
    }
    let stop = i;
    while (stop > start && [32, 9, 13].includes(this.src.charCodeAt(stop - 1))) stop--;
    const name = this.src.slice(start, stop);
    const term = i < this.n ? this.src.charCodeAt(i) : 0;
    if (name.length === 0) {
      this.off = i;
      if (term === 58) this.layoutEmitOp(':');
      else if (term === 61) {
        this.layoutEmitOp('=');
        this.layoutSub = LayoutSub.Value;
      }
      return;
    }
    this.off = stop;
    if ((term === 10 || term === 0) && lookupKeyword(this.lang, name) === 'end') {
      this.push('kw', 'end', start, sLine, sCol);
      this.layoutClose();
      return;
    }
    if (term === 58) {
      this.push('lel', normalizeIdent(name), start, sLine, sCol);
      this.off = i;
      this.layoutEmitOp(':');
      this.layoutDepth++;
      this.layoutSub = LayoutSub.Name;
      return;
    }
    if (term === 61) {
      this.push('lattr', normalizeIdent(name), start, sLine, sCol);
      this.off = i;
      this.layoutEmitOp('=');
      this.layoutSub = LayoutSub.Value;
      return;
    }
    // Malformed line; keep it as an element so the block still balances.
    this.push('lel', normalizeIdent(name), start, sLine, sCol);
  }

  private layoutFuncValue(): void {
    let depth = 0;
    for (;;) {
      this.layoutSkipInlineWs();
      const d = this.cc();
      if (this.off >= this.n || d === 10) return;
      const start = this.off;
      const sLine = this.line;
      const sCol = start - this.lineStart;
      if (d === 40) {
        depth++;
        this.layoutEmitOp('(');
      } else if (d === 41) {
        depth--;
        this.layoutEmitOp(')');
        if (depth <= 0) return;
      } else if (d === 34) {
        this.scanQuoted(34, start, sLine, sCol);
      } else if (isDigitCode(d)) {
        this.scanNumber(start, sLine, sCol);
      } else if (isIdentStart(d)) {
        this.scanIdent(start, sLine, sCol);
      } else {
        this.scanLayoutOp(start, sLine, sCol);
      }
    }
  }

  private scanLayoutOp(start: number, sLine: number, sCol: number): void {
    const c = this.src[start] ?? '';
    this.off = start + 1;
    this.push('op', c, start, sLine, sCol);
  }

  private layoutValue(): void {
    this.layoutSkipInlineWs();
    const c = this.cc();
    if (this.off >= this.n || c === 10) return;
    const start = this.off;
    const sLine = this.line;
    const sCol = start - this.lineStart;
    if (c === 34) {
      this.scanQuoted(34, start, sLine, sCol);
    } else if (c === 96) {
      this.scanRaw(start, sLine, sCol);
    } else if (isDigitCode(c)) {
      this.scanNumber(start, sLine, sCol);
    } else if (isIdentStart(c)) {
      this.scanIdent(start, sLine, sCol);
      if (this.cc() === 40) this.layoutFuncValue();
    } else {
      this.scanLayoutOp(start, sLine, sCol);
    }
  }

  private layoutStep(): void {
    this.layoutSkipInlineWs();
    const c = this.cc();
    if (this.off >= this.n) return;
    if (c === 10) {
      const start = this.off;
      const sLine = this.line;
      const sCol = start - this.lineStart;
      this.goto(this.off + 1);
      const tok: Tok = {
        t: 'end', v: '\n', line: sLine, col: sCol, off: start, eLine: sLine, eCol: sCol + 1, eOff: this.off,
      };
      this.toks.push(tok);
      this.lastTok = tok;
      this.layoutSub = LayoutSub.Name;
      return;
    }
    if (this.layoutSub === LayoutSub.Value) {
      this.layoutValue();
      this.layoutSub = LayoutSub.Name;
      return;
    }
    this.layoutName();
  }
}

/** Language chosen by the file's marker comment, if it has one. */
function markerLang(source: string): 'en' | 'fa' | undefined {
  const lines = source.split('\n', 8);
  for (const raw of lines) {
    const line = raw.replace(/^[ \t]+/, '');
    if (!line.startsWith('//')) continue;
    const m = /(language|lang|زبان)[ \t]*:[ \t]*(\S*)/i.exec(line.slice(2));
    if (!m) continue;
    const tag = m[1]!;
    const val = m[2]!;
    if (tag === 'زبان') {
      if (val.startsWith('فارسی')) return 'fa';
      if (val.startsWith('انگلیسی')) return 'en';
      continue;
    }
    const low = val.toLowerCase();
    if (low.startsWith('english')) return 'en';
    if (low.startsWith('persian') || low.startsWith('farsi')) return 'fa';
    const word = /^[A-Za-z]{2}(?![A-Za-z])/.exec(val)?.[0]?.toLowerCase();
    if (word === 'en') return 'en';
    if (word === 'fa') return 'fa';
  }
  return undefined;
}

function countKeywords(toks: Tok[]): number {
  let n = 0;
  for (const t of toks) if (t.t === 'kw') n++;
  return n;
}

/**
 * Keyword packs worth trying for a file, best guess first. A `// language:`
 * marker decides; otherwise whichever pack reads more keywords wins, as in the
 * compiler. The caller keeps the pack that parses the file with the fewest
 * syntax errors, so a wrong guess costs one extra pass, never a wrong result.
 */
export function candidateLangs(source: string): SalamLang[] {
  const marker = markerLang(source);
  if (marker) return [marker];
  if (!/[\u0600-\u06FF]/.test(source)) return ['en'];
  const fa = countKeywords(finish(source, 'fa').toks);
  const en = countKeywords(finish(source, 'en').toks);
  return fa > en ? ['fa', 'en'] : ['en', 'fa'];
}

/** Tokenize a Salam source file with one keyword pack. */
export function lexSalam(source: string, lang: SalamLang): LexResult {
  return finish(source, lang);
}

function finish(source: string, lang: SalamLang): LexResult {
  const lx = new Lexer(source, lang);
  lx.run();
  return { toks: lx.toks, comments: lx.comments, lang };
}
