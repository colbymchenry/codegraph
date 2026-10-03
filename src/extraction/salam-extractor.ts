import * as path from 'path';
import {
  Node,
  Edge,
  ExtractionResult,
  ExtractionError,
  UnresolvedReference,
  NodeKind,
  ReferenceKind,
} from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import {
  candidateLangs,
  normalizeIdent,
  lexSalam,
  LexResult,
  Tok,
  SalamComment,
  SalamLang,
  isAliasWordKeyword,
  LINK_WORDS,
  canonLinkKind,
} from './salam-lexer';

/**
 * SalamExtractor: symbols, calls and type references from `.salam` files.
 *
 * Salam is not parsed with tree-sitter. A recursive-descent parser over the
 * token stream from `salam-lexer.ts` follows the compiler's own grammar
 * (`compiler/parser/` in https://github.com/SalamLang/Salam), because the
 * language has two keyword sets (English and Persian), multi-word identifiers
 * and a line-oriented layout DSL that no single tree-sitter grammar covers.
 *
 * What it produces:
 *  - `module` for `package`, `function`/`method` (extern and interface
 *    signatures too), `struct`, `interface`, `enum` + `enum_member` (multi-word
 *    names allowed, same as functions), `field`, `type_alias`,
 *    `constant`/`variable`, `import`, `component` (layout blocks and
 *    `component` declarations) and a `namespace` node for every
 *    `impl Iface on Type` block.
 *  - `calls`, `instantiates`, `references`, `implements` and `imports`
 *    references. Receivers are typed from parameters, annotations, struct
 *    literals and casts; calls through an imported package become
 *    `pkg::Name`; calls on the built-in Vector/HashMap/... methods are dropped
 *    rather than guessed.
 *  - `switch`/`case` is a statement (unlike the `match` expression): its
 *    labels are literals, ranges, relational tests, or — when the subject's
 *    type is known — a bare enum member name, which is linked the same way
 *    `EnumName.Member` is.
 *
 * Parsing recovers from syntax errors the way the compiler does (skip to the
 * next statement or declaration keyword), so one bad line never loses a file.
 */

type ExKind = 'id' | 'member' | 'this' | 'lit' | 'other';

interface Ex {
  k: ExKind;
  name?: string;
  tok?: Tok;
  obj?: Ex | null;
  typeName?: string;
  /** For a call result: the callee (`f` or `pkg::f`), so a local can be typed by its return type. */
  callInner?: string;
  used?: boolean;
}

interface Mods {
  isPub: boolean;
  deprecated: boolean;
  inline: boolean;
  noinline: boolean;
  pure: boolean;
  noret: boolean;
  first: Tok | undefined;
}

interface Meta {
  lang: string;
  value: string;
  line: number;
}

interface Binding {
  pkg?: string;
}

interface PendingImpl {
  node: Node;
  iface: string;
  target: string;
  tok: Tok;
}

const PRIMITIVES = new Set([
  'void', 'bool', 'char', 'str', 'uchar', 'i8', 'i16', 'i32', 'int', 'i64', 'u8', 'u16', 'u32',
  'uint', 'u64', 'size', 'f32', 'float', 'f64', 'auto', 'func',
  'تهی', 'منطقی', 'نویسه', 'رشته', 'یونیکد', 'صحیح۸', 'صحیح۱۶', 'صحیح۳۲', 'صحیح', 'صحیح۶۴',
  'صحیح8', 'صحیح16', 'صحیح32', 'صحیح64', 'طبیعی۸', 'طبیعی۱۶', 'طبیعی۳۲', 'طبیعی', 'طبیعی۶۴',
  'طبیعی8', 'طبیعی16', 'طبیعی32', 'طبیعی64', 'اندازه', 'اعشار۳۲', 'اعشار', 'اعشار۶۴',
  'اعشار32', 'اعشار64', 'خودکار', 'تلقائي',
]);

/** Built-in generic containers; their methods are compiler intrinsics. */
const INTRINSIC_TYPES = new Set([
  'Vector', 'HashMap', 'MapIter', 'File', 'Variant',
  'وکتور', 'نگاشت', 'پیمایشگرنگاشت', 'پرونده', 'گوناگون',
]);

const INTRINSIC_METHODS = new Set([
  'push', 'pop', 'get', 'ref', 'set', 'len', 'cap', 'free', 'put', 'has', 'remove', 'size',
  'iter', 'has_next', 'key', 'value', 'next', 'read', 'readline', 'write', 'seek', 'close',
  'concat', 'substr', 'find', 'split', 'trim', 'to_int', 'to_float', 'clear',
  'بیفزا', 'دربیاور', 'بگیر', 'ارجاع', 'بنشان', 'طول', 'ظرفیت', 'آزادکن', 'درج', 'دارد',
  'حذف', 'اندازه', 'پیمایش', 'داردبعدی', 'کلید', 'مقدار', 'بعدی', 'خواندن', 'نوشتن',
  'جابجایی', 'ببند', 'پیوست', 'زیررشته', 'بیاب', 'بشکاف', 'پیراست',
]);

/** Free functions and words that are never references to a project symbol. */
const BUILTIN_NAMES = new Set([
  'len', 'sizeof', 'print', 'println', 'printerr', 'printerrln', 'input', 'char_from_code',
  'strcmp', 'join', 'spawn',
]);

const LAYOUT_ELEMENTS = new Set([
  'layout', 'box', 'header', 'footer', 'nav', 'section', 'article', 'heading', 'paragraph',
  'span', 'bold', 'strong', 'italic', 'font', 'line', 'break', 'list', 'item', 'link',
  'head_link', 'image', 'media', 'iframe', 'canvas', 'table', 'row', 'cell', 'form', 'label',
  'input', 'button', 'script', 'style', 'meta', 'global',
  // Persian spellings of the same elements (`@fa` names in std/layout/elements)
  'پررنگ', 'بوم', 'شکست', 'مقاله', 'دکمه', 'پاورقی', 'تصویر', 'برچسب', 'فهرست', 'پاراگراف',
  'اسپن', 'سلول', 'قلم', 'فرم', 'سراسری', 'پیوند سر', 'سرصفحه', 'جعبه', 'سرتیتر', 'مورد',
  'صفحه', 'کج', 'خط', 'متا', 'اسکریپت سفارشی', 'ظاهر سفارشی', 'رسانه', 'ناوبری', 'ردیف',
  'قاب درونی', 'جدول', 'ورودی', 'قوی', 'بخش', 'پیوند', 'سبک',
]);

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '^^=', '&=', '|=', '^=', '<<=', '>>=']);

/** Local types that name a call instead of a type: `x := f()` is typed by what `f` returns. */
const CALL_MARK = '\u0001call:';

/** Comment text that is data for the test harness or the editor, not documentation. */
const DOC_MARKER = /^(?:(?:EXPECT|DEFINE|CONST|انتظار|توقع)\s*:|!)/;

const MAX_DEPTH = 200;

/** Messages kept per file; the count itself stays exact. */
const MAX_RECORDED_ERRORS = 50;

function firstLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

class SalamFileParser {
  private filePath: string;
  private source: string;
  private toks: Tok[] = [];
  private comments: SalamComment[] = [];
  private lang: SalamLang = 'en';

  get keywordLanguage(): SalamLang {
    return this.lang;
  }

  private pos = 0;
  private panic = false;
  private depth = 0;
  private dry = 0;
  private anglePending = 0;
  private noStructLit = false;
  private noWithWord = false;
  private syntaxErrors: Array<{ line: number; message: string }> = [];
  private syntaxErrorTotal = 0;

  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private refs: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  private nodeStack: string[] = [];
  private qualParts: string[] = [];
  private ownerId = '';
  private ownerType = '';
  private scopes: Array<Map<string, string>> = [];
  private typeParamSets: Array<Set<string>> = [];
  private imports = new Map<string, Binding>();
  private pendingIds: Ex[][] = [];
  private pendingImpls: PendingImpl[] = [];
  private layoutDepth = 0;
  private layoutValueRefs: Array<{ name: string; tok: Tok; from: string }> = [];

  constructor(filePath: string, source: string, private readonly lexed: LexResult) {
    this.filePath = filePath;
    this.source = source;
  }

  /** Number of syntax problems met while parsing (exposed for tests). */
  get syntaxErrorCount(): number {
    return this.syntaxErrorTotal;
  }

  get syntaxErrorMessages(): string[] {
    return this.syntaxErrors.map((e) => `${e.line}: ${e.message}`);
  }

  extract(): ExtractionResult {
    const start = Date.now();
    try {
      this.toks = this.lexed.toks;
      this.comments = this.lexed.comments;
      this.lang = this.lexed.lang;
      const fileNode = this.createFileNode();
      this.nodeStack.push(fileNode.id);
      this.ownerId = fileNode.id;
      this.parseProgram();
      this.finishImpls();
      this.flushLayoutValueRefs();
      const symbols = this.nodes.filter((n) => n.kind !== 'file').length;
      if (this.syntaxErrorTotal > 0 && symbols === 0) {
        const first = this.syntaxErrors[0]!;
        this.errors.push({
          message: `${this.filePath}:${first.line}: ${first.message} — the file is indexed but contributes no symbols`,
          severity: 'warning',
          code: 'parse_error',
        });
      }
    } catch (error) {
      this.errors.push({
        message: `Salam extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
        code: 'parse_error',
      });
    }
    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.refs,
      errors: this.errors,
      durationMs: Date.now() - start,
    };
  }

  // ---- token cursor ---------------------------------------------------------

  private tk(o = 0): Tok {
    const i = Math.min(this.pos + o, this.toks.length - 1);
    return this.toks[i]!;
  }

  private isKw(v: string, o = 0): boolean {
    const t = this.tk(o);
    return t.t === 'kw' && t.v === v;
  }

  private isOp(v: string, o = 0): boolean {
    const t = this.tk(o);
    return t.t === 'op' && t.v === v;
  }

  private isId(o = 0): boolean {
    return this.tk(o).t === 'id';
  }

  private isEnd(o = 0): boolean {
    return this.tk(o).t === 'end';
  }

  private isEof(): boolean {
    return this.tk().t === 'eof';
  }

  private adv(): Tok {
    const t = this.tk();
    if (this.pos < this.toks.length - 1) this.pos++;
    return t;
  }

  private prev(): Tok {
    return this.toks[Math.max(0, this.pos - 1)]!;
  }

  private matchOp(v: string): boolean {
    if (this.isOp(v)) {
      this.adv();
      return true;
    }
    return false;
  }

  private matchKw(v: string): boolean {
    if (this.isKw(v)) {
      this.adv();
      return true;
    }
    return false;
  }

  private expectOp(v: string, what: string): boolean {
    if (this.matchOp(v)) return true;
    this.err(`expected ${what}`);
    return false;
  }

  private expectKw(v: string, what: string): boolean {
    if (this.matchKw(v)) return true;
    this.err(`expected ${what}`);
    return false;
  }

  private err(message: string): void {
    if (this.panic) return;
    this.syntaxErrorTotal++;
    if (this.syntaxErrors.length < MAX_RECORDED_ERRORS) {
      this.syntaxErrors.push({ line: this.tk().line, message });
    }
    this.panic = true;
  }

  private skipTerms(): void {
    while (this.isEnd()) this.adv();
  }

  private term(): void {
    if (this.isEnd()) this.adv();
  }

  private static readonly SYNC_KEYWORDS = new Set([
    'func', 'struct', 'enum', 'type', 'const', 'import', 'layout', 'if', 'until', 'each',
    'repeat', 'match', 'switch', 'ret', 'end',
  ]);

  private sync(): void {
    this.panic = false;
    this.anglePending = 0;
    while (!this.isEof()) {
      const t = this.tk();
      if (t.t === 'end') {
        this.adv();
        return;
      }
      if ((t.t === 'kw' && SalamFileParser.SYNC_KEYWORDS.has(t.v)) || (t.t === 'op' && t.v === '}')) return;
      this.adv();
    }
  }

  private enter(): boolean {
    if (this.depth >= MAX_DEPTH) {
      this.err('nested too deeply');
      return false;
    }
    this.depth++;
    return true;
  }

  private leave(): void {
    this.depth--;
  }

  // ---- names ------------------------------------------------------------------

  /** Source spelling of a token (a keyword used as a name keeps its own word). */
  private textOf(t: Tok): string {
    return t.t === 'kw' ? normalizeIdent(this.source.slice(t.off, t.eOff)) : t.v;
  }

  /** A single identifier; '' on failure. */
  private name(what: string): string {
    if (this.isId()) return this.adv().v;
    if (this.tk().t === 'kw') {
      this.err(`'${this.tk().v}' is a reserved word, so it cannot be used as a name`);
      this.adv();
      return '';
    }
    this.err(what);
    return '';
  }

  /** Consecutive identifier words on one line form a single name. */
  private munchName(): string {
    if (!this.isId()) return this.name('expected name');
    const line = this.tk().line;
    const words: string[] = [];
    while (this.isId() && this.tk().line === line) words.push(this.adv().v);
    return words.join(' ');
  }

  private munchValueName(): string {
    const line = this.tk().line;
    const words = [this.adv().v];
    while (
      (this.isId() || this.isKw('package')) &&
      this.tk().line === line &&
      !this.isOp(':=', 1)
    ) {
      words.push(this.textOf(this.adv()));
    }
    return words.join(' ');
  }

  private atMergeableWord(): boolean {
    const t = this.tk();
    if (t.t === 'id') return true;
    if (t.t === 'kw' && isAliasWordKeyword(t.v)) {
      return !((t.v === 'with' || t.v === 'in') && this.noWithWord);
    }
    return false;
  }

  /** A member name: any word or keyword, plus the words on its line that merge into it. */
  private munchMemberName(): string {
    if (!this.isId() && this.tk().t !== 'kw') {
      this.err('expected member name after \'.\'');
      return '';
    }
    const line = this.tk().line;
    const words = [this.textOf(this.adv())];
    while (this.atMergeableWord() && this.tk().line === line) words.push(this.textOf(this.adv()));
    return words.join(' ');
  }

  private identRunLen(): number {
    let m = 0;
    const line = this.tk().line;
    while (this.tk(m).t === 'id' && this.tk(m).line === line) m++;
    return m;
  }

  // ---- node & reference helpers ----------------------------------------------

  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const node: Node = {
      id: `file:${this.filePath}`,
      kind: 'file',
      name: path.basename(this.filePath),
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'salam',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      isExported: false,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  private qualified(name: string): string {
    return [...this.qualParts, name].join('::');
  }

  private addNode(
    kind: NodeKind,
    name: string,
    start: Tok,
    extra?: Partial<Node>,
  ): Node | null {
    if (!name) return null;
    const node: Node = {
      id: generateNodeId(this.filePath, kind, name, start.line),
      kind,
      name,
      qualifiedName: this.qualified(name),
      filePath: this.filePath,
      language: 'salam',
      startLine: start.line,
      endLine: start.eLine,
      startColumn: start.col,
      endColumn: start.eCol,
      updatedAt: Date.now(),
      ...extra,
    };
    this.nodes.push(node);
    const parent = this.nodeStack[this.nodeStack.length - 1];
    if (parent) this.edges.push({ source: parent, target: node.id, kind: 'contains' });
    return node;
  }

  private closeNode(node: Node | null): void {
    if (!node) return;
    const last = this.prev();
    node.endLine = Math.max(node.startLine, last.eLine);
    node.endColumn = last.eCol;
  }

  private addRef(kind: ReferenceKind, name: string, tok: Tok, from = this.ownerId): void {
    if (this.dry > 0 || !name || !from) return;
    this.refs.push({
      fromNodeId: from,
      referenceName: name,
      referenceKind: kind,
      line: tok.line,
      column: tok.col,
    });
  }

  /**
   * The comment block ending on the line above a declaration, plus its
   * `@fa`/`@en` aliases (so the other spelling is searchable). A copyright
   * banner at the top of the file, `//!` directives and the test harness's
   * `EXPECT:` / `DEFINE:` / `CONST:` markers are not documentation.
   */
  private docFor(first: Tok | undefined, metas: Meta[]): string | undefined {
    const lines: string[] = [];
    if (first) {
      // Annotations sit between the comment and the declaration.
      const top = Math.min(first.line, ...metas.map((m) => m.line));
      // Comments are in source order: find the last one that ends above `top`.
      let lo = 0;
      let hi = this.comments.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.comments[mid]!.endLine < top) lo = mid + 1;
        else hi = mid;
      }
      let expect = top - 1;
      for (let i = lo - 1; i >= 0; i--) {
        const c = this.comments[i]!;
        if (c.endLine !== expect || (c.block && c.line === 1) || DOC_MARKER.test(c.text)) break;
        lines.unshift(c.text);
        expect = c.line - 1;
      }
    }
    const doc = lines.join('\n').trim();
    const aliases = metas.map((m) => `@${m.lang} ${m.value}`).join('  ');
    const parts = [doc, aliases].filter((part) => part.length > 0);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  private metaDecorators(metas: Meta[]): string[] {
    return metas.map((m) => `@${m.lang} "${m.value}"`);
  }

  // ---- scopes -----------------------------------------------------------------

  private pushScope(): void {
    this.scopes.push(new Map());
  }

  private popScope(): void {
    this.scopes.pop();
  }

  private declare(name: string, type = ''): void {
    if (!name) return;
    const top = this.scopes[this.scopes.length - 1];
    if (top) top.set(name, type);
  }

  private lookupLocal(name: string): string | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const t = this.scopes[i]!.get(name);
      if (t !== undefined) return t;
    }
    return undefined;
  }

  private isTypeParam(name: string): boolean {
    return this.typeParamSets.some((s) => s.has(name));
  }

  private resolveImportedName(pkgAlias: string, member: string): string {
    const b = this.imports.get(pkgAlias);
    return b?.pkg ? `${b.pkg}::${member}` : `${pkgAlias}.${member}`;
  }

  // ---- program ----------------------------------------------------------------

  private parseProgram(): void {
    this.skipTerms();
    let metas = this.parseMetas();
    if (this.isKw('package')) {
      this.parsePackage(metas);
      metas = [];
    }
    while (!this.isEof()) {
      const before = this.pos;
      this.parseTopLevelItem(metas);
      metas = [];
      if (this.panic) this.sync();
      if (this.pos === before && !this.isEof()) this.adv();
    }
  }

  private parsePackage(metas: Meta[]): void {
    const kwTok = this.adv();
    let name = '';
    if (this.isId() || this.isKw('layout')) name = this.adv().v;
    else this.err('expected package name after \'package\'');
    this.term();
    if (!name) return;
    const node = this.addNode('module', name, kwTok, {
      isExported: true,
      docstring: this.docFor(kwTok, metas),
      decorators: metas.length > 0 ? this.metaDecorators(metas) : undefined,
    });
    if (!node) return;
    node.endLine = this.source.split('\n').length;
    this.nodeStack.push(node.id);
    this.qualParts.push(name);
    this.ownerId = node.id;
  }

  private parseMetas(): Meta[] {
    const out: Meta[] = [];
    this.skipTerms();
    while (this.tk().t === 'meta') {
      const metaTok = this.adv();
      const lang = metaTok.v;
      if (this.tk().t === 'str') {
        while (this.tk().t === 'str') out.push({ lang, value: this.stringValue(this.adv().v), line: metaTok.line });
      } else {
        this.err('expected a string after \'@\' annotation');
      }
      this.skipTerms();
    }
    return out;
  }

  private stringValue(raw: string): string {
    if (raw.startsWith('"""')) return raw.slice(3, raw.endsWith('"""') ? -3 : undefined);
    const first = raw[0];
    if (first === '"' || first === '`' || first === "'") {
      return raw.slice(1, raw.length > 1 && raw.endsWith(first) ? -1 : undefined);
    }
    if (first === 'u' && (raw[1] === '"' || raw[1] === "'")) return raw.slice(2, -1);
    if (first === '«') return raw.slice(1, raw.endsWith('»') ? -1 : undefined);
    return raw;
  }

  private parseTopLevelItem(metasIn: Meta[]): void {
    this.skipTerms();
    const metas = [...metasIn, ...this.parseMetas()];
    if (this.isEof()) return;
    if (this.isKw('import')) {
      this.parseImports();
      return;
    }
    if (this.isKw('extern') && this.isOp(':', 1)) {
      this.parseExternBlock();
      return;
    }
    if (this.tryLinkDirective()) return;
    if (this.isKw('if')) {
      this.parseTopLevelIf();
      return;
    }
    this.parseTopLevel(metas);
  }

  private parseMods(): Mods {
    const m: Mods = {
      isPub: false, deprecated: false, inline: false, noinline: false, pure: false, noret: false,
      first: undefined,
    };
    const take = (kw: string, set: () => void): boolean => {
      if (!this.isKw(kw)) return false;
      m.first ??= this.tk();
      set();
      this.adv();
      return true;
    };
    take('pub', () => (m.isPub = true));
    take('deprecated', () => (m.deprecated = true));
    if (!take('inline', () => (m.inline = true))) take('noinline', () => (m.noinline = true));
    if (!take('pure', () => (m.pure = true))) take('noret', () => (m.noret = true));
    // Modifiers written out of order are a compile error, but the declaration
    // after them is still worth indexing.
    while (
      this.isKw('pub') || this.isKw('deprecated') || this.isKw('inline') ||
      this.isKw('noinline') || this.isKw('pure') || this.isKw('noret')
    ) {
      const kw = this.adv().v;
      m.first ??= this.prev();
      if (kw === 'pub') m.isPub = true;
      else if (kw === 'deprecated') m.deprecated = true;
      else if (kw === 'inline') m.inline = true;
      else if (kw === 'noinline') m.noinline = true;
      else if (kw === 'pure') m.pure = true;
      else m.noret = true;
    }
    return m;
  }

  private modDecorators(m: Mods, extra: string[] = []): string[] | undefined {
    const d = [...extra];
    if (m.deprecated) d.push('deprecated');
    if (m.inline) d.push('inline');
    if (m.noinline) d.push('noinline');
    if (m.pure) d.push('pure');
    if (m.noret) d.push('noret');
    return d.length > 0 ? d : undefined;
  }

  private parseTopLevel(metas: Meta[]): void {
    const mods = this.parseMods();
    const first = mods.first ?? this.tk();
    const t = this.tk();
    if (t.t === 'kw') {
      switch (t.v) {
        case 'type': this.parseTypeAlias(mods, first, metas); return;
        case 'const': this.parseConst(mods, first, metas, true); return;
        case 'enum': this.parseEnum(mods, first, metas); return;
        case 'struct': this.parseStruct(mods, first, metas); return;
        case 'interface': this.parseInterface(mods, first, metas); return;
        case 'impl': this.parseImpl(first, metas); return;
        case 'func': this.parseFunction(mods, first, metas, 'function'); return;
        case 'layout': this.parseLayoutBlock(first, metas); return;
        case 'component': this.parseComponent(first, metas); return;
        case 'mut': this.parseVarDecl(mods, first, metas, true); this.term(); return;
        case 'package':
          this.err('\'package\' can be declared only once, and only as the very first statement');
          this.adv();
          return;
        default:
          break;
      }
    }
    if (t.t === 'id') {
      this.parseVarDecl(mods, first, metas, true);
      this.term();
      return;
    }
    this.err(mods.isPub ? 'expected a definition after \'pub\'' : 'expected a top-level definition');
    if (!this.isEof()) this.adv();
  }

  private parseTopLevelIf(): void {
    this.adv();
    this.parseTopLevelIfTail();
  }

  private parseTopLevelIfTail(): void {
    if (!this.enter()) return;
    this.parseCondExpr();
    this.expectOp(':', '\':\' after if condition');
    this.fillTopLevelBody();
    this.skipTerms();
    if (this.matchKw('else')) {
      this.matchKw('if');
      if (!this.isOp(':')) {
        this.parseTopLevelIfTail();
      } else {
        this.adv();
        this.fillTopLevelBody();
        this.expectKw('end', '\'end\' to close if');
      }
    } else {
      this.expectKw('end', '\'end\' to close if');
    }
    this.leave();
  }

  private fillTopLevelBody(): void {
    this.skipTerms();
    let metas: Meta[] = [];
    while (!this.isKw('end') && !this.isKw('else') && !this.isEof()) {
      const before = this.pos;
      this.skipTerms();
      if (this.isKw('end') || this.isKw('else') || this.isEof()) break;
      this.parseTopLevelItem(metas);
      metas = [];
      if (this.panic) this.sync();
      if (this.pos === before) this.adv();
    }
  }

  // ---- imports ------------------------------------------------------------------

  private parseImports(): void {
    const kwTok = this.adv();
    if (this.isOp('(')) {
      this.err('grouped imports are not supported; write import "a" "b"');
      return;
    }
    const isStringImport = () => this.tk().t === 'str' || (this.isId() && this.tk(1).t === 'str');
    if (isStringImport()) {
      while (isStringImport()) this.parseStringImport(kwTok);
    } else if (this.isId()) {
      this.parseIdentImport(kwTok);
    } else {
      this.err('expected import path string');
    }
    this.term();
  }

  private parseStringImport(kwTok: Tok): void {
    const startTok = this.tk();
    let alias = '';
    if (this.isId() && this.tk(1).t === 'str') alias = this.adv().v;
    if (this.tk().t !== 'str') {
      this.err('expected import path string');
      return;
    }
    const strTok = this.adv();
    const raw = this.stringValue(strTok.v);
    const withExt = /\.[A-Za-z0-9]+$/.test(raw) ? raw : `${raw}.salam`;
    const dir = path.posix.dirname(this.filePath);
    const target = withExt.startsWith('/') ? withExt : path.posix.normalize(path.posix.join(dir, withExt));
    const bindingName = alias || path.posix.basename(raw).replace(/\.salam$/, '');
    const node = this.addNode('import', bindingName || raw, startTok, {
      signature: this.sliceFrom(kwTok),
    });
    if (node) {
      this.closeNode(node);
      this.addRef('imports', target, strTok, node.id);
    }
    if (alias) this.imports.set(alias, {});
    else if (bindingName) this.imports.set(bindingName, {});
  }

  private parseIdentImport(kwTok: Tok): void {
    const startTok = this.tk();
    const parts: string[] = [this.munchName()];
    while (this.isOp('.')) {
      this.adv();
      parts.push(this.munchName());
    }
    const dotted = parts.join('.');
    const pkg = parts[parts.length - 1] ?? dotted;
    const node = this.addNode('import', dotted, startTok, { signature: this.sliceFrom(kwTok) });
    if (node) {
      this.closeNode(node);
      this.addRef('imports', pkg, startTok, node.id);
    }
    this.imports.set(pkg, { pkg });
  }

  private sliceFrom(start: Tok): string {
    return firstLine(this.source.slice(start.off, this.prev().eOff), 200);
  }

  private tryLinkDirective(): boolean {
    const t = this.tk();
    if (t.t !== 'id' || !LINK_WORDS.has(t.v)) return false;
    const next = this.tk(1);
    const ok = next.t === 'str' || (next.t === 'id' && canonLinkKind(next.v) !== undefined);
    if (!ok) return false;
    this.adv();
    if (this.isId() && canonLinkKind(this.tk().v)) this.adv();
    if (this.tk().t === 'str') this.adv();
    else this.err('expected a library-name string after \'link\'');
    this.term();
    return true;
  }

  // ---- types --------------------------------------------------------------------

  private atTypeStart(): boolean {
    return this.isId() || this.isKw('func') || this.isKw('extern');
  }

  /** Parses a type and returns its base name ('' when unknown). */
  private parseType(): string {
    if (!this.enter()) return '';
    let base = '';
    if (this.isKw('extern') && this.isKw('func', 1)) {
      this.adv();
      base = this.parseTypeFunc();
    } else if (this.isId() && this.tk().v === 'dyn' && this.isId(1)) {
      base = this.parseTypeDyn();
    } else if (this.isKw('func')) {
      base = this.parseTypeFunc();
    } else {
      base = this.parseTypeNamed();
    }
    this.leave();
    return base;
  }

  private typeRef(nameTok: Tok, dotted: string): string {
    const parts = dotted.split('.');
    const base = parts[parts.length - 1] ?? dotted;
    if (PRIMITIVES.has(base) || INTRINSIC_TYPES.has(base) || this.isTypeParam(base)) return base;
    if (parts.length === 2 && this.imports.has(parts[0]!)) {
      this.addRef('references', this.resolveImportedName(parts[0]!, base), nameTok);
    } else {
      this.addRef('references', base, nameTok);
    }
    return base;
  }

  private parseTypeNamed(): string {
    const nameTok = this.tk();
    let nm = this.name('expected type name');
    if (!nm) return '';
    if (this.isOp('.') && this.isId(1)) {
      this.adv();
      nm = `${nm}.${this.adv().v}`;
    }
    const base = this.typeRef(nameTok, nm);
    if (this.isOp('<')) {
      this.adv();
      this.parseType();
      while (this.matchOp(',')) this.parseType();
      this.closeAngle('\'>\' to close type arguments');
    }
    this.parsePtrAndDims();
    return base;
  }

  private parseTypeDyn(): string {
    this.adv();
    const nameTok = this.tk();
    let nm = this.adv().v;
    if (this.isOp('.') && this.isId(1)) {
      this.adv();
      nm = `${nm}.${this.adv().v}`;
    }
    const base = this.typeRef(nameTok, nm);
    this.parsePtrAndDims();
    return base;
  }

  private parseTypeFunc(): string {
    this.adv();
    this.expectOp('(', '\'(\' in function type');
    if (!this.isOp(')')) {
      do {
        this.parseType();
      } while (this.matchOp(','));
    }
    this.expectOp(')', '\')\' in function type');
    if (this.isId() || this.isKw('func')) this.parseType();
    while (this.matchOp('*')) { /* pointer suffix */ }
    return 'func';
  }

  private parsePtrAndDims(): void {
    while (this.isOp('*')) {
      let k = 1;
      while (this.isOp('*', k)) k++;
      if (!this.isOp('[', k)) break;
      this.adv();
    }
    this.parseArrayDims();
    while (this.matchOp('*')) { /* pointer suffix */ }
  }

  private parseArrayDims(): void {
    while (this.matchOp('[')) {
      this.skipTerms();
      if (this.isOp(':')) {
        this.adv();
        this.skipTerms();
        this.expectOp(']', '\']\' to close slice type \'T[:]\'');
        return;
      }
      if (!this.isOp(']')) this.parseExpr();
      this.skipTerms();
      this.expectOp(']', '\']\' in array type');
    }
  }

  private closeAngle(what: string): boolean {
    if (this.anglePending > 0) {
      this.anglePending--;
      return true;
    }
    if (this.isOp('>')) {
      this.adv();
      return true;
    }
    if (this.isOp('>>')) {
      this.adv();
      this.anglePending++;
      return true;
    }
    this.err(`expected ${what}`);
    return false;
  }

  private parseTypeAnno(): string {
    if (!this.expectOp(':', '\':\' before type')) return '';
    return this.parseType();
  }

  /** `<T: Bound, U>`; returns the parameter names. */
  private parseTypeParams(): string[] {
    const out: string[] = [];
    if (!this.matchOp('<')) return out;
    do {
      const tp = this.name('expected type parameter name');
      if (!tp) break;
      out.push(tp);
      if (this.matchOp(':')) {
        const boundTok = this.tk();
        let bound = this.name('expected an interface name after \':\' in type parameter bound');
        if (bound && this.isOp('.') && this.isId(1)) {
          this.adv();
          bound = `${bound}.${this.adv().v}`;
        }
        if (bound) this.typeRef(boundTok, bound);
      }
    } while (this.matchOp(','));
    this.closeAngle('\'>\' to close type parameters');
    return out;
  }

  // ---- declarations --------------------------------------------------------------

  private parseTypeAlias(mods: Mods, first: Tok, metas: Meta[]): void {
    const kwTok = this.adv();
    const nameTok = this.tk();
    const name = this.name('expected alias name');
    const node = name
      ? this.addNode('type_alias', name, first, {
          isExported: mods.isPub,
          visibility: mods.isPub ? 'public' : 'private',
          docstring: this.docFor(first, metas),
          decorators: metas.length > 0 ? this.metaDecorators(metas) : undefined,
        })
      : null;
    if (!this.expectOp('=', '\'=\' in type alias')) return;
    const prevOwner = this.ownerId;
    if (node) this.ownerId = node.id;
    this.parseType();
    this.ownerId = prevOwner;
    if (node) {
      node.signature = this.sliceFrom(kwTok);
      this.closeNode(node);
    }
    void nameTok;
    this.term();
  }

  private parseConst(mods: Mods, first: Tok, metas: Meta[], topLevel: boolean): void {
    const kwTok = this.adv();
    const name = this.name('expected constant name');
    let node: Node | null = null;
    if (topLevel && name) {
      node = this.addNode('constant', name, first, {
        isExported: mods.isPub,
        visibility: mods.isPub ? 'public' : 'private',
        docstring: this.docFor(first, metas),
        decorators: metas.length > 0 ? this.metaDecorators(metas) : undefined,
      });
    }
    const prevOwner = this.ownerId;
    if (node) this.ownerId = node.id;
    let type = '';
    if (this.isOp(':')) {
      this.err('constants with a type annotation were removed; use \'const NAME := value\'');
      type = this.parseTypeAnno();
      this.matchOp('=');
      this.parseExpr();
    } else if (this.isOp('=')) {
      this.err('constants are declared with \':=\'');
      this.adv();
      this.parseExpr();
    } else if (this.expectOp(':=', '\':=\' in const declaration')) {
      const ex = this.parseExpr();
      type = this.typeOfInit(ex);
    }
    this.ownerId = prevOwner;
    if (!topLevel) this.declare(name, type);
    if (node) {
      node.signature = this.sliceFrom(kwTok);
      this.closeNode(node);
    }
    this.term();
  }

  /**
   * `name := value`, `mut name := value` and `name: Type`. At the top level it
   * makes a node; inside a body it only declares the local.
   */
  private parseVarDecl(mods: Mods, first: Tok, metas: Meta[], topLevel: boolean, isMutIn?: boolean): void {
    const isMut = isMutIn ?? this.matchKw('mut');
    const startTok = this.tk();
    const name = this.munchName();
    let node: Node | null = null;
    if (topLevel && name) {
      node = this.addNode('variable', name, first, {
        isExported: mods.isPub,
        visibility: mods.isPub ? 'public' : 'private',
        docstring: this.docFor(first, metas),
        decorators: this.mergeDecorators(isMut ? ['mut'] : undefined, metas),
      });
    }
    const prevOwner = this.ownerId;
    if (node) this.ownerId = node.id;
    let type = '';
    if (this.matchOp(':=')) {
      const ex = this.parseExpr();
      type = this.typeOfInit(ex);
    } else if (this.isOp(':')) {
      type = this.parseTypeAnno();
      if (this.isOp('=')) {
        this.err('declarations with a type annotation were removed; use \'name := value\'');
        this.adv();
        this.parseExpr();
      }
    } else if (this.isOp('=')) {
      this.err('use \':=\' to declare a new variable; \'=\' only assigns to an existing one');
      this.adv();
      this.parseExpr();
    } else {
      this.err('expected \':=\' and an initializer, or \': Type\' for an uninitialized declaration');
    }
    this.ownerId = prevOwner;
    if (!topLevel) this.declare(name, type);
    if (node) {
      node.signature = firstLine(this.source.slice(startTok.off, this.prev().eOff), 160);
      this.closeNode(node);
    }
  }

  private parseEnum(mods: Mods, first: Tok, metas: Meta[]): void {
    this.adv();
    const name = this.name('expected enum name');
    if (!this.expectOp(':', '\':\' after enum name')) return;
    const node = this.addNode('enum', name, first, {
      isExported: mods.isPub,
      visibility: mods.isPub ? 'public' : 'private',
      docstring: this.docFor(first, metas),
      decorators: metas.length > 0 ? this.metaDecorators(metas) : undefined,
    });
    this.skipTerms();
    if (node) {
      this.nodeStack.push(node.id);
      this.qualParts.push(name);
    }
    const prevOwner = this.ownerId;
    if (node) this.ownerId = node.id;
    while (!this.isKw('end') && !this.isEof()) {
      const before = this.pos;
      this.skipTerms();
      if (this.isKw('end') || this.isEof()) break;
      const metasM = this.parseMetas();
      const mTok = this.tk();
      const mName = this.isId() ? this.munchName() : this.name('expected enum member name');
      const member = mName
        ? this.addNode('enum_member', mName, mTok, {
            visibility: mods.isPub ? 'public' : 'private',
            decorators: metasM.length > 0 ? this.metaDecorators(metasM) : undefined,
            docstring: this.docFor(mTok, metasM),
          })
        : null;
      if (this.matchOp('=')) this.parseExpr();
      this.closeNode(member);
      if (!this.matchOp(',')) this.skipTerms();
      if (this.panic) this.sync();
      if (this.pos === before && !this.isKw('end') && !this.isEof()) this.adv();
    }
    this.ownerId = prevOwner;
    if (node) {
      this.nodeStack.pop();
      this.qualParts.pop();
    }
    this.expectKw('end', '\'end\' to close enum');
    this.closeNode(node);
  }

  private parseStruct(mods: Mods, first: Tok, metas: Meta[]): void {
    const kwTok = this.adv();
    const name = this.name('expected struct name');
    const tparams = this.parseTypeParams();
    const node = name
      ? this.addNode('struct', name, first, {
          isExported: mods.isPub,
          visibility: mods.isPub ? 'public' : 'private',
          docstring: this.docFor(first, metas),
          decorators: metas.length > 0 ? this.metaDecorators(metas) : undefined,
          typeParameters: tparams.length > 0 ? tparams : undefined,
        })
      : null;
    if (node) node.signature = this.sliceFrom(kwTok);
    if (!this.expectOp(':', '\':\' after struct name')) {
      this.closeNode(node);
      return;
    }
    this.parseTypeBody(node, name, tparams, mods, false);
    this.expectKw('end', '\'end\' to close struct');
    this.closeNode(node);
  }

  private parseInterface(mods: Mods, first: Tok, metas: Meta[]): void {
    const kwTok = this.adv();
    const name = this.name('expected interface name');
    const tparams = this.parseTypeParams();
    const node = name
      ? this.addNode('interface', name, first, {
          isExported: mods.isPub,
          visibility: mods.isPub ? 'public' : 'private',
          docstring: this.docFor(first, metas),
          decorators: metas.length > 0 ? this.metaDecorators(metas) : undefined,
          typeParameters: tparams.length > 0 ? tparams : undefined,
        })
      : null;
    if (node) node.signature = this.sliceFrom(kwTok);
    if (!this.expectOp(':', '\':\' after interface name')) {
      this.closeNode(node);
      return;
    }
    this.parseTypeBody(node, name, tparams, mods, true);
    this.expectKw('end', '\'end\' to close interface');
    this.closeNode(node);
  }

  /** Members of a struct (fields and methods) or an interface (signatures). */
  private parseTypeBody(
    node: Node | null,
    name: string,
    tparams: string[],
    typeMods: Mods,
    isInterface: boolean,
  ): void {
    this.skipTerms();
    if (node) {
      this.nodeStack.push(node.id);
      this.qualParts.push(name);
    }
    const prevOwnerType = this.ownerType;
    const prevOwner = this.ownerId;
    this.ownerType = name;
    if (node) this.ownerId = node.id;
    this.typeParamSets.push(new Set(tparams));
    while (!this.isKw('end') && !this.isEof()) {
      const before = this.pos;
      this.skipTerms();
      const metas = this.parseMetas();
      if (this.isKw('end') || this.isEof()) break;
      const mods = this.parseMods();
      const first = mods.first ?? this.tk();
      if (this.isKw('func')) {
        if (isInterface) this.parseInterfaceMethod(first, metas, typeMods);
        else this.parseFunction(mods, first, metas, 'method');
      } else if (isInterface) {
        this.err('expected a method signature (\'func ...\') in interface');
        if (!this.isEof()) this.adv();
      } else {
        this.parseField(mods, first, metas);
      }
      if (this.panic) this.sync();
      if (this.pos === before && !this.isKw('end') && !this.isEof()) this.adv();
    }
    this.typeParamSets.pop();
    this.ownerType = prevOwnerType;
    this.ownerId = prevOwner;
    if (node) {
      this.nodeStack.pop();
      this.qualParts.pop();
    }
  }

  private parseField(mods: Mods, first: Tok, metas: Meta[]): void {
    const startTok = this.tk();
    const name = this.isId() ? this.munchName() : this.memberName('expected field name');
    if (!name) {
      this.err('expected field name');
      return;
    }
    const node = this.addNode('field', name, first, {
      visibility: mods.isPub ? 'public' : 'private',
      docstring: this.docFor(first, metas),
      decorators: metas.length > 0 ? this.metaDecorators(metas) : undefined,
    });
    const prevOwner = this.ownerId;
    if (node) this.ownerId = node.id;
    const type = this.parseTypeAnno();
    if (this.matchOp('=')) this.parseExpr();
    this.ownerId = prevOwner;
    if (node) {
      node.signature = firstLine(this.source.slice(startTok.off, this.prev().eOff), 160);
      if (type) node.returnType = type;
      this.closeNode(node);
    }
    if (!this.panic) this.term();
  }

  /** What a declaration's initializer tells about the variable's type. */
  private typeOfInit(ex: Ex | null): string {
    if (!ex) return '';
    if (ex.typeName) return ex.typeName;
    return ex.callInner ? `${CALL_MARK}${ex.callInner}` : '';
  }

  private memberName(what: string): string {
    if (this.isId() || this.tk().t === 'kw') return this.textOf(this.adv());
    this.err(what);
    return '';
  }

  private parseImpl(first: Tok, metas: Meta[]): void {
    const kwTok = this.adv();
    const ifaceTok = this.tk();
    let iface = this.name('expected interface name after \'impl\'');
    if (iface && this.isOp('.') && this.isId(1)) {
      this.adv();
      iface = `${iface}.${this.adv().v}`;
    }
    if (!this.expectKw('on', '\'on\' after interface name in impl block')) return;
    const targetTok = this.tk();
    const target = this.parseImplTarget();
    if (!this.expectOp(':', '\':\' after impl target type')) return;
    const nodeName = target ? `impl ${iface} on ${target}` : `impl ${iface}`;
    const node = this.addNode('namespace', nodeName, first, {
      docstring: this.docFor(first, metas),
      decorators: metas.length > 0 ? this.metaDecorators(metas) : undefined,
      signature: this.sliceFrom(kwTok),
    });
    if (node) {
      this.pendingImpls.push({ node, iface, target, tok: ifaceTok });
      if (target && !PRIMITIVES.has(target) && !INTRINSIC_TYPES.has(target)) {
        this.addRef('references', target, targetTok, node.id);
      }
    }
    this.skipTerms();
    if (node) this.nodeStack.push(node.id);
    const prevOwnerType = this.ownerType;
    const prevOwner = this.ownerId;
    this.ownerType = target;
    if (node) this.ownerId = node.id;
    const savedParts = this.qualParts;
    this.qualParts = target ? [...savedParts, target] : savedParts;
    while (!this.isKw('end') && !this.isEof()) {
      const before = this.pos;
      this.skipTerms();
      const mMetas = this.parseMetas();
      if (this.isKw('end') || this.isEof()) break;
      const mods = this.parseMods();
      const mFirst = mods.first ?? this.tk();
      if (this.isKw('func')) {
        this.parseFunction(mods, mFirst, mMetas, 'method');
      } else {
        this.err('expected a method (\'func ...\') in impl block');
        if (!this.isEof()) this.adv();
      }
      if (this.panic) this.sync();
      if (this.pos === before && !this.isKw('end') && !this.isEof()) this.adv();
    }
    this.qualParts = savedParts;
    this.ownerType = prevOwnerType;
    this.ownerId = prevOwner;
    if (node) this.nodeStack.pop();
    this.expectKw('end', '\'end\' to close impl block');
    this.closeNode(node);
  }

  /** The type after `on`; refs are added by the caller, so parse it dry. */
  private parseImplTarget(): string {
    this.dry++;
    const t = this.parseType();
    this.dry--;
    return t;
  }

  private finishImpls(): void {
    for (const p of this.pendingImpls) {
      const owner = this.nodes.find(
        (n) => n.name === p.target && (n.kind === 'struct' || n.kind === 'enum' || n.kind === 'type_alias'),
      );
      const from = owner?.id ?? p.node.id;
      const ifaceName = p.iface.includes('.') ? this.resolveDotted(p.iface) : p.iface;
      if (!ifaceName) continue;
      this.refs.push({
        fromNodeId: from,
        referenceName: ifaceName,
        referenceKind: 'implements',
        line: p.tok.line,
        column: p.tok.col,
      });
    }
  }

  private resolveDotted(dotted: string): string {
    const [pkg, member] = dotted.split('.');
    if (!pkg || !member) return dotted;
    return this.resolveImportedName(pkg, member);
  }

  // ---- functions --------------------------------------------------------------

  private parseOpMethodName(): string {
    const t = this.tk();
    if (t.t === 'op') {
      const map: Record<string, string> = {
        '+': 'operator_add', '-': 'operator_sub', '*': 'operator_mul', '/': 'operator_div',
        '%': 'operator_mod', '^^': 'operator_pow', '==': 'operator_eq', '!=': 'operator_ne',
        '<': 'operator_lt', '>': 'operator_gt', '<=': 'operator_le', '>=': 'operator_ge',
        '!': 'operator_not',
      };
      const mapped = map[t.v];
      if (mapped) {
        this.adv();
        return mapped;
      }
      if (t.v === '[') {
        this.adv();
        this.expectOp(']', '\']\' in operator[]');
        if (this.isOp('=')) {
          this.adv();
          return 'operator_index_set';
        }
        return 'operator_index';
      }
    }
    this.err('unsupported operator for overloading');
    return '';
  }

  private parseParams(): void {
    if (this.isOp(')')) return;
    do {
      const pname = this.munchName();
      if (!pname) return;
      this.matchOp('&');
      let type = '';
      if (this.isOp(':')) type = this.parseTypeAnno();
      if (this.matchOp('=')) this.parseExpr();
      this.declare(pname, type);
    } while (this.matchOp(','));
  }

  /**
   * The `: Type` before a block's colon. A colon followed by a type on the
   * same line and then another colon (or the end of the statement) is a
   * return type; anything else means the colon opens the block.
   */
  private tryReturnType(): string | undefined {
    if (!this.isOp(':')) return undefined;
    const save = this.pos;
    const savedPanic = this.panic;
    const savedAngle = this.anglePending;
    const colonLine = this.tk().line;
    this.adv();
    if (this.tk().line !== colonLine || !this.atTypeStart()) {
      this.pos = save;
      return undefined;
    }
    this.dry++;
    this.panic = true;
    const name = this.parseType();
    const valid = name.length > 0 && (this.isOp(':') || this.isEnd() || this.isEof());
    this.dry--;
    this.pos = save + 1;
    this.panic = savedPanic;
    this.anglePending = savedAngle;
    if (!valid) {
      this.pos = save;
      return undefined;
    }
    return this.parseType();
  }

  private parseFunction(mods: Mods, first: Tok, metas: Meta[], kind: 'function' | 'method'): void {
    const funcTok = this.adv();
    let name: string;
    if (this.isKw('operator')) {
      this.adv();
      name = this.parseOpMethodName();
    } else if (this.isId()) {
      name = this.munchName();
    } else {
      name = this.name('expected function name or \'operator <op>\'');
    }
    const tparams = this.parseTypeParams();
    const node = this.addNode(kind, name, first, {
      isExported: kind === 'function' ? mods.isPub : undefined,
      visibility: mods.isPub ? 'public' : 'private',
      docstring: this.docFor(first, metas),
      decorators: this.mergeDecorators(this.modDecorators(mods), metas),
      typeParameters: tparams.length > 0 ? tparams : undefined,
    });
    if (node && kind === 'method' && this.ownerType) {
      node.qualifiedName = this.qualified(name);
    }
    const prevOwner = this.ownerId;
    if (node) this.ownerId = node.id;
    this.typeParamSets.push(new Set(tparams));
    this.pushScope();
    if (this.matchOp('(')) {
      const savedNoStruct = this.noStructLit;
      this.noStructLit = false;
      this.parseParams();
      this.noStructLit = savedNoStruct;
      this.expectOp(')', '\')\' after parameters');
    }
    const ret = this.tryReturnType();
    if (node) {
      node.signature = firstLine(this.source.slice(funcTok.off, this.prev().eOff), 240);
      if (ret) node.returnType = ret;
    }
    if (this.isOp(':')) {
      this.parseBlock();
    } else {
      this.err('expected \':\' to open block');
    }
    this.popScope();
    this.typeParamSets.pop();
    this.ownerId = prevOwner;
    this.closeNode(node);
  }

  private mergeDecorators(a: string[] | undefined, metas: Meta[]): string[] | undefined {
    const d = [...(a ?? []), ...this.metaDecorators(metas)];
    return d.length > 0 ? d : undefined;
  }

  private parseInterfaceMethod(first: Tok, metas: Meta[], typeMods: Mods): void {
    const funcTok = this.adv();
    const name = this.munchNameOrError('expected method name in interface');
    void typeMods;
    const node = this.addNode('method', name, first, {
      visibility: 'public',
      isAbstract: true,
      docstring: this.docFor(first, metas),
      decorators: this.mergeDecorators(undefined, metas),
    });
    const prevOwner = this.ownerId;
    if (node) this.ownerId = node.id;
    this.pushScope();
    if (this.matchOp('(')) {
      this.parseParams();
      this.expectOp(')', '\')\' after parameters');
    }
    let ret = '';
    if (this.matchOp(':')) ret = this.parseType();
    this.popScope();
    this.ownerId = prevOwner;
    if (node) {
      node.signature = firstLine(this.source.slice(funcTok.off, this.prev().eOff), 240);
      if (ret) node.returnType = ret;
      this.closeNode(node);
    }
    this.term();
  }

  private munchNameOrError(what: string): string {
    if (this.isId()) return this.munchName();
    return this.name(what);
  }

  private parseExternBlock(): void {
    this.adv();
    this.expectOp(':', '\':\' to open extern block');
    this.skipTerms();
    while (!this.isKw('end') && !this.isEof()) {
      const before = this.pos;
      this.skipTerms();
      if (this.isKw('end') || this.isEof()) break;
      const metas = this.parseMetas();
      const mods = this.parseMods();
      const first = mods.first ?? this.tk();
      if (this.isKw('func')) {
        this.parseExternFunc(mods, first, metas);
      } else if (this.isKw('mut') || this.isId()) {
        this.parseExternVar(first, metas);
      } else {
        this.err('expected \'func\' or a variable in extern block');
        if (!this.isEof()) this.adv();
      }
      if (this.panic) this.sync();
      if (this.pos === before && !this.isKw('end') && !this.isEof()) this.adv();
    }
    this.expectKw('end', '\'end\' to close extern block');
    this.term();
  }

  private parseExternFunc(mods: Mods, first: Tok, metas: Meta[]): void {
    const funcTok = this.adv();
    const name = this.munchNameOrError('expected external function name');
    const node = this.addNode('function', name, first, {
      isExported: true,
      visibility: 'public',
      docstring: this.docFor(first, metas),
      decorators: this.mergeDecorators(this.modDecorators(mods, ['extern']), metas),
    });
    const prevOwner = this.ownerId;
    if (node) this.ownerId = node.id;
    if (this.expectOp('(', '\'(\' after external function name')) {
      if (!this.isOp(')')) {
        do {
          if (this.isOp('...')) {
            this.adv();
            break;
          }
          const pname = this.name('expected parameter name');
          if (!pname) break;
          this.matchOp('&');
          this.parseTypeAnno();
        } while (this.matchOp(','));
      }
      this.expectOp(')', '\')\' after parameters');
    }
    const ret = this.tryReturnType();
    this.ownerId = prevOwner;
    if (node) {
      node.signature = firstLine(this.source.slice(funcTok.off, this.prev().eOff), 240);
      if (ret) node.returnType = ret;
    }
    if (this.isOp(':')) {
      this.parseBlock();
    } else {
      this.term();
    }
    this.closeNode(node);
  }

  private parseExternVar(first: Tok, metas: Meta[]): void {
    let isMut = this.matchKw('mut');
    if (!isMut && this.isId() && this.tk().v === 'var' && this.isId(1)) {
      this.adv();
      isMut = true;
    }
    const startTok = this.tk();
    const name = this.munchNameOrError('expected external variable name');
    const node = this.addNode('variable', name, first, {
      isExported: true,
      visibility: 'public',
      decorators: this.mergeDecorators(isMut ? ['extern', 'mut'] : ['extern'], metas),
    });
    const prevOwner = this.ownerId;
    if (node) this.ownerId = node.id;
    this.parseTypeAnno();
    this.ownerId = prevOwner;
    if (node) {
      node.signature = firstLine(this.source.slice(startTok.off, this.prev().eOff), 160);
      this.closeNode(node);
    }
    this.term();
  }

  // ---- layout DSL -------------------------------------------------------------

  private parseLayoutBlock(first: Tok, metas: Meta[]): void {
    const kwTok = this.adv();
    const node = this.addNode('component', 'layout', first, {
      docstring: this.docFor(first, metas),
      decorators: metas.length > 0 ? this.metaDecorators(metas) : undefined,
      signature: this.sliceFrom(kwTok),
    });
    if (!this.expectOp(':', '\':\' after \'layout\'')) return;
    this.skipTerms();
    const prevOwner = this.ownerId;
    if (node) this.ownerId = node.id;
    this.layoutDepth++;
    this.pushScope();
    this.layoutBody();
    this.popScope();
    this.layoutDepth--;
    this.ownerId = prevOwner;
    this.expectKw('end', '\'end\' to close layout block');
    this.closeNode(node);
  }

  private parseComponent(first: Tok, metas: Meta[]): void {
    const kwTok = this.adv();
    const name = this.name('expected component name');
    const node = name
      ? this.addNode('component', name, first, {
          isExported: true,
          docstring: this.docFor(first, metas),
          decorators: metas.length > 0 ? this.metaDecorators(metas) : undefined,
        })
      : null;
    this.pushScope();
    const prevOwner = this.ownerId;
    if (node) this.ownerId = node.id;
    if (this.matchOp('(')) {
      if (!this.isOp(')')) {
        do {
          const pname = this.name('expected component parameter name');
          if (!pname) break;
          this.declare(pname);
          if (this.matchOp('=')) this.parseExpr();
        } while (this.matchOp(','));
      }
      this.expectOp(')', '\')\' after component parameters');
    }
    if (node) node.signature = firstLine(this.source.slice(kwTok.off, this.prev().eOff), 200);
    if (!this.expectOp(':', '\':\' after component header')) {
      this.popScope();
      this.ownerId = prevOwner;
      this.closeNode(node);
      return;
    }
    this.skipTerms();
    this.layoutDepth++;
    this.layoutBody();
    this.layoutDepth--;
    this.popScope();
    this.ownerId = prevOwner;
    this.expectKw('end', '\'end\' to close component');
    this.closeNode(node);
    this.term();
  }

  private layoutBody(): void {
    while (!this.isKw('end') && !this.isEof()) {
      const before = this.pos;
      this.skipTerms();
      if (this.isKw('end') || this.isEof()) break;
      const t = this.tk();
      if (t.t === 'lel') {
        this.layoutElement();
      } else if (t.t === 'lattr') {
        this.adv();
        this.expectOp('=', '\'=\' after layout attribute name');
        this.parseExpr();
        this.skipTerms();
      } else {
        this.err('unexpected token inside layout block');
        if (!this.isEof()) this.adv();
      }
      if (this.panic) this.sync();
      if (this.pos === before) this.adv();
    }
  }

  private layoutElement(): void {
    if (!this.enter()) return;
    const nameTok = this.adv();
    if (!LAYOUT_ELEMENTS.has(nameTok.v) && !nameTok.v.includes(' ')) {
      this.addRef('instantiates', nameTok.v, nameTok);
    }
    this.expectOp(':', '\':\' after layout element name');
    this.skipTerms();
    this.layoutBody();
    this.expectKw('end', '\'end\' to close layout element');
    this.skipTerms();
    this.leave();
  }

  private flushLayoutValueRefs(): void {
    if (this.layoutValueRefs.length === 0) return;
    const local = new Set(
      this.nodes
        .filter((n) => n.kind === 'function' || n.kind === 'constant' || n.kind === 'variable')
        .map((n) => n.name),
    );
    for (const r of this.layoutValueRefs) {
      if (local.has(r.name)) this.addRef('references', r.name, r.tok, r.from);
    }
  }

  // ---- statements -------------------------------------------------------------

  private parseBlock(): void {
    if (!this.enter()) return;
    this.expectOp(':', '\':\' to open block');
    this.pushScope();
    this.fillBlockBody();
    this.popScope();
    this.expectKw('end', '\'end\' to close block');
    this.leave();
  }

  private fillBlockBody(): void {
    this.skipTerms();
    while (!this.isKw('end') && !this.isKw('else') && !this.isEof()) {
      const before = this.pos;
      this.skipTerms();
      if (this.isKw('end') || this.isKw('else') || this.isEof()) break;
      this.parseStatement();
      if (this.panic) this.sync();
      if (this.pos === before) this.adv();
    }
  }

  private parseStatement(): void {
    const t = this.tk();
    if (t.t === 'kw') {
      switch (t.v) {
        case 'print': case 'println': case 'printerr': case 'printerrln':
          this.parsePrint();
          return;
        case 'mut':
          this.parseVarDecl(this.noMods(), t, [], false);
          this.term();
          return;
        case 'const':
          this.parseConst(this.noMods(), t, [], false);
          return;
        case 'if': this.adv(); this.parseIfTail(); return;
        case 'until': this.parseUntil(); return;
        case 'each': this.parseEach(); return;
        case 'repeat': this.parseRepeat(); return;
        case 'match': this.parseMatch(); return;
        case 'switch': this.parseSwitch(); return;
        case 'ret': this.parseReturn(); return;
        case 'defer':
          if (!this.enter()) return;
          this.adv();
          this.parseStatement();
          this.leave();
          return;
        case 'break': case 'continue':
          this.adv();
          this.term();
          return;
        default:
          break;
      }
    }
    if (t.t === 'id') {
      const m = this.identRunLen();
      const after = this.tk(m);
      if (after.t === 'op' && (after.v === ':' || after.v === ':=')) {
        this.parseVarDecl(this.noMods(), t, [], false, false);
        this.term();
        return;
      }
    }
    this.parseExpr();
    this.term();
  }

  private noMods(): Mods {
    return {
      isPub: false, deprecated: false, inline: false, noinline: false, pure: false, noret: false,
      first: undefined,
    };
  }

  private parsePrint(): void {
    this.adv();
    if (!this.isEnd() && !this.isKw('end') && !this.isOp('}') && !this.isEof()) {
      do {
        this.parseExpr();
      } while (this.matchOp(','));
    }
    this.term();
  }

  private parseReturn(): void {
    this.adv();
    if (!this.isEnd() && !this.isKw('end') && !this.isKw('else') && !this.isEof()) this.parseExpr();
    this.term();
  }

  private parseCondExpr(): Ex | null {
    const saved = this.noStructLit;
    this.noStructLit = true;
    const e = this.parseExpr();
    this.noStructLit = saved;
    return e;
  }

  private parseIfTail(): void {
    if (!this.enter()) return;
    this.parseCondExpr();
    this.expectOp(':', '\':\' after if condition');
    this.pushScope();
    this.fillBlockBody();
    this.popScope();
    this.skipTerms();
    if (this.matchKw('else')) {
      this.matchKw('if');
      if (!this.isOp(':')) {
        this.parseIfTail();
      } else {
        this.adv();
        this.pushScope();
        this.fillBlockBody();
        this.popScope();
        this.expectKw('end', '\'end\' to close if');
      }
    } else {
      this.expectKw('end', '\'end\' to close if');
    }
    this.leave();
  }

  private parseUntil(): void {
    this.adv();
    this.parseCondExpr();
    this.parseBlock();
  }

  private parseRepeat(): void {
    this.adv();
    const bound = () => {
      const saved = this.noWithWord;
      this.noWithWord = true;
      this.parseCondExpr();
      this.noWithWord = saved;
    };
    bound();
    if (this.matchKw('to')) bound();
    if (this.matchKw('step') || this.matchKw('each')) bound();
    this.pushScope();
    if (this.matchKw('with') || this.matchKw('in')) {
      this.declare(this.name('expected an index variable name after \'with\''), 'int');
    }
    this.parseBlock();
    this.popScope();
  }

  private parseEach(): void {
    this.adv();
    const names: string[] = [];
    if (this.matchOp('(')) {
      names.push(this.name('expected a binding name in \'each (key, value)\''));
      this.expectOp(',', '\',\' between the two \'each\' binding names');
      names.push(this.name('expected the value binding name in \'each (key, value)\''));
      this.expectOp(')', '\')\' after the \'each\' binding names');
    } else {
      names.push(this.name('expected a binding name after \'each\''));
    }
    this.expectKw('in', '\'in\' before the collection in an \'each\' loop');
    this.parseCondExpr();
    this.pushScope();
    for (const n of names) this.declare(n);
    this.parseBlock();
    this.popScope();
  }

  private parseMatch(): void {
    if (!this.enter()) return;
    this.adv();
    this.parseCondExpr();
    this.expectOp(':', '\':\' after match subject');
    this.skipTerms();
    while (!this.isKw('end') && !this.isEof()) {
      const before = this.pos;
      this.parseMatchArm();
      this.skipTerms();
      if (this.panic) this.sync();
      if (this.pos === before) this.adv();
    }
    this.expectKw('end', '\'end\' to close match');
    this.leave();
  }

  private parseMatchArm(): void {
    if (!this.enter()) return;
    this.pushScope();
    if (!this.matchKw('else')) {
      do {
        this.parseMatchPattern();
      } while (this.matchOp(','));
    }
    if (this.isOp(':')) {
      this.parseBlock();
    } else {
      this.expectOp('=>', '\'=>\' in match arm');
      this.parseExpr();
      this.term();
    }
    this.popScope();
    this.leave();
  }

  private parseMatchPattern(): void {
    const t = this.tk();
    if (t.t === 'num' || t.t === 'str' || (t.t === 'kw' && (t.v === 'true' || t.v === 'false' || t.v === 'null'))) {
      this.adv();
      return;
    }
    if (t.t === 'id') {
      this.adv();
      const line = t.line;
      const typeName = t.v;
      if (!PRIMITIVES.has(typeName) && !INTRINSIC_TYPES.has(typeName) && !this.isTypeParam(typeName)) {
        this.addRef('references', typeName, t);
      }
      if (this.isId() && this.tk().line === line) {
        this.declare(this.adv().v, typeName);
      }
      return;
    }
    this.err('expected a pattern (literal, identifier, or type name) in match arm');
  }

  /**
   * `switch`: a statement, unlike `match`. Cases fall through to the next one
   * unless they `break`; labels are literals, ranges (`lo to hi`) or a
   * relational test (`> x`), or — when the subject's type is known — a bare
   * enum member name (`red`), the shorthand the compiler expands to
   * `<SubjectType>.red`.
   */
  private static readonly CASE_REL_OPS = new Set(['>', '>=', '<', '<=', '!=', '==']);

  private parseSwitch(): void {
    if (!this.enter()) return;
    this.adv();
    const subj = this.parseCondExpr();
    this.expectOp(':', '\':\' after switch subject');
    this.skipTerms();
    const subjType = subj?.typeName;
    while (!this.isKw('end') && !this.isEof()) {
      const before = this.pos;
      this.parseCase(subjType);
      this.skipTerms();
      if (this.panic) this.sync();
      if (this.pos === before) this.adv();
    }
    this.expectKw('end', '\'end\' to close switch');
    this.leave();
  }

  private parseCase(subjType: string | undefined): void {
    if (!this.enter()) return;
    if (!this.matchKw('else')) {
      do {
        this.parseCaseItem(subjType);
      } while (this.matchOp(','));
    }
    this.parseBlock();
    this.leave();
  }

  private parseCaseItem(subjType: string | undefined): void {
    if (this.tk().t === 'op' && SalamFileParser.CASE_REL_OPS.has(this.tk().v)) {
      this.adv();
      this.parseCondExpr();
      return;
    }
    // A bare identifier naming a member of the subject's enum type, e.g.
    // `red:` under `switch c:` where `c` is a `Color` — shorthand for `Color.red`.
    // Only when the subject's type isn't a primitive/intrinsic (the compiler's
    // own gate is "subject is an enum") and the name isn't a known local —
    // `switch n: threshold:` (both `int`) means "compare to the variable
    // `threshold`", not a member named `threshold`.
    if (
      subjType && !PRIMITIVES.has(subjType) && !INTRINSIC_TYPES.has(subjType) &&
      this.isId() && this.lookupLocal(this.tk().v) === undefined &&
      !this.isOp('.', 1) && !this.isOp('(', 1) && !this.isKw('to', 1)
    ) {
      const nameTok = this.adv();
      this.addRef('references', `${subjType}.${nameTok.v}`, nameTok);
      return;
    }
    this.parseCondExpr();
    if (this.matchKw('to')) this.parseCondExpr();
  }

  // ---- expressions --------------------------------------------------------------

  private parseExpr(): Ex | null {
    this.pendingIds.push([]);
    const e = this.parseExprBp(0);
    const list = this.pendingIds.pop() ?? [];
    for (const ex of list) if (!ex.used) this.refValue(ex);
    return e;
  }

  private refValue(ex: Ex): void {
    const name = ex.name ?? '';
    if (!name || !ex.tok) return;
    if (this.lookupLocal(name) !== undefined) return;
    if (this.imports.has(name) || BUILTIN_NAMES.has(name) || this.isTypeParam(name)) return;
    if (PRIMITIVES.has(name) || INTRINSIC_TYPES.has(name)) return;
    if (name.startsWith('SALAM_')) return;
    if (this.layoutDepth > 0 && this.ownerId) {
      this.layoutValueRefs.push({ name, tok: ex.tok, from: this.ownerId });
      return;
    }
    this.addRef('references', name, ex.tok);
  }

  private static bindingPower(t: Tok): [number, number] | undefined {
    if (t.t === 'kw') return t.v === 'as' ? [80, 81] : undefined;
    if (t.t !== 'op') return undefined;
    if (ASSIGN_OPS.has(t.v)) return [10, 10];
    switch (t.v) {
      case '?': return [15, 14];
      case '||': return [20, 21];
      case '&&': return [30, 31];
      case '|': return [32, 33];
      case '^': return [34, 35];
      case '&': return [36, 37];
      case '==': case '!=': return [40, 41];
      case '<': case '>': case '<=': case '>=': return [50, 51];
      case '<<': case '>>': return [56, 57];
      case '+': case '-': return [60, 61];
      case '*': case '/': case '%': return [70, 71];
      case '^^': return [100, 100];
      case '++': case '--': return [105, 105];
      case '(': case '[': case '.': return [110, 111];
      default: return undefined;
    }
  }

  private parseExprBp(minBp: number): Ex | null {
    if (!this.enter()) return null;
    let lhs = this.parseNud();
    for (;;) {
      if (this.panic) break;
      const w = SalamFileParser.bindingPower(this.tk());
      if (!w || w[0] < minBp) break;
      lhs = this.parseLed(lhs, w);
    }
    this.leave();
    return lhs;
  }

  private parseNud(): Ex | null {
    const t = this.tk();
    if (t.t === 'op' && (t.v === '!' || t.v === '-' || t.v === '~')) {
      this.adv();
      this.parseExprBp(90);
      return { k: 'other' };
    }
    if (t.t === 'op' && (t.v === '++' || t.v === '--')) {
      this.adv();
      this.parseExprBp(105);
      return { k: 'other' };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Ex | null {
    const t = this.tk();
    if (t.t === 'num' || t.t === 'str' || (t.t === 'kw' && (t.v === 'true' || t.v === 'false' || t.v === 'null'))) {
      this.adv();
      return { k: 'lit' };
    }
    if (t.t === 'kw' && t.v === 'this') {
      this.adv();
      return { k: 'this', typeName: this.ownerType };
    }
    if (t.t === 'kw' && (t.v === 'print' || t.v === 'println' || t.v === 'printerr' || t.v === 'printerrln' || t.v === 'input')) {
      this.adv();
      return { k: 'id', name: t.v, tok: t, used: true };
    }
    if (t.t === 'op' && t.v === '(') {
      if (this.lambdaAhead()) return this.parseLambda();
      this.adv();
      const saved = this.noStructLit;
      this.noStructLit = false;
      const e = this.parseExpr();
      this.noStructLit = saved;
      this.expectOp(')', '\')\'');
      if (e) e.used = true;
      return e;
    }
    if (t.t === 'op' && t.v === '[') return this.parseArrayLit();
    if (t.t === 'kw' && t.v === 'match') {
      this.parseMatch();
      return { k: 'other' };
    }
    if (t.t === 'op' && t.v === '&') {
      this.adv();
      const nameTok = this.tk();
      const nm = this.name('expected a function name after \'&\'');
      if (nm && this.isOp('.') && this.isId(1)) {
        this.adv();
        const member = this.name('expected a function name after \'&\'');
        this.addRef('references', this.resolveImportedName(nm, member), nameTok);
      } else if (nm && this.lookupLocal(nm) === undefined) {
        this.addRef('references', nm, nameTok);
      }
      return { k: 'other' };
    }
    if (t.t === 'id') {
      if (this.isOp('{', 1) && !this.noStructLit) return this.parseStructLit();
      if (this.isOp('.', 1) && this.isId(2) && this.isOp('{', 3) && !this.noStructLit) return this.parseStructLit();
      const name = this.munchValueName();
      const ex: Ex = { k: 'id', name, tok: t };
      const list = this.pendingIds[this.pendingIds.length - 1];
      if (list) list.push(ex);
      const local = this.lookupLocal(name);
      if (local) ex.typeName = local;
      return ex;
    }
    this.err(t.t === 'kw' ? `'${t.v}' is a reserved word, so it cannot be used as a name` : 'expected an expression');
    if (!this.isEof()) this.adv();
    return { k: 'other' };
  }

  private parseArrayLit(): Ex {
    this.adv();
    const saved = this.noStructLit;
    this.noStructLit = false;
    this.skipTerms();
    while (!this.isOp(']') && !this.isEof()) {
      const before = this.pos;
      this.parseExpr();
      this.matchOp(',');
      this.skipTerms();
      if (this.panic || this.pos === before) break;
    }
    this.noStructLit = saved;
    this.expectOp(']', '\']\' to close array literal');
    return { k: 'other' };
  }

  private parseStructLit(): Ex {
    const nameTok = this.adv();
    let nm = nameTok.v;
    let dotted = false;
    if (this.isOp('.') && this.isId(1)) {
      this.adv();
      nm = `${nm}.${this.adv().v}`;
      dotted = true;
    }
    const parts = nm.split('.');
    const base = parts[parts.length - 1] ?? nm;
    if (dotted && this.imports.has(parts[0]!)) {
      this.addRef('instantiates', this.resolveImportedName(parts[0]!, base), nameTok);
    } else if (!INTRINSIC_TYPES.has(base) && !PRIMITIVES.has(base) && !this.isTypeParam(base)) {
      this.addRef('instantiates', base, nameTok);
    }
    this.expectOp('{', '\'{\' in struct literal');
    const saved = this.noStructLit;
    this.noStructLit = false;
    this.skipTerms();
    while (!this.isOp('}') && !this.isEof()) {
      const before = this.pos;
      const fname = this.isId() ? this.munchName() : this.memberName('expected field name in struct literal');
      if (!fname) break;
      this.expectOp('=', '\'=\' in field initializer');
      this.parseExpr();
      this.matchOp(',');
      this.skipTerms();
      if (this.panic || this.pos === before) break;
    }
    this.noStructLit = saved;
    this.expectOp('}', '\'}\' to close struct literal');
    return { k: 'other', typeName: base };
  }

  /** `(name: Type, ...)` followed by `=>` or `:` starts a lambda. */
  private lambdaAhead(): boolean {
    if (!this.isOp('(')) return false;
    const save = this.pos;
    const savedPanic = this.panic;
    const savedAngle = this.anglePending;
    this.panic = true;
    this.dry++;
    this.adv();
    let ok = true;
    if (!this.isOp(')')) {
      do {
        if (!this.isId()) {
          ok = false;
          break;
        }
        this.adv();
        if (!this.isOp(':')) {
          ok = false;
          break;
        }
        this.parseTypeAnno();
      } while (this.matchOp(','));
    }
    if (ok) ok = this.isOp(')');
    if (ok) this.adv();
    const isLambda = ok && (this.isOp('=>') || this.isOp(':'));
    this.dry--;
    this.pos = save;
    this.panic = savedPanic;
    this.anglePending = savedAngle;
    return isLambda;
  }

  private parseLambda(): Ex {
    this.expectOp('(', '\'(\' to open lambda parameters');
    this.pushScope();
    if (!this.isOp(')')) {
      do {
        const pname = this.name('expected parameter name');
        if (!pname) break;
        const type = this.parseTypeAnno();
        this.declare(pname, type);
      } while (this.matchOp(','));
    }
    this.expectOp(')', '\')\' after lambda parameters');
    if (this.isOp(':')) {
      this.parseBlock();
    } else if (this.expectOp('=>', '\'=>\' in lambda')) {
      this.parseExpr();
    }
    this.popScope();
    return { k: 'other' };
  }

  private parseLed(lhs: Ex | null, w: [number, number]): Ex | null {
    const t = this.tk();
    if (t.t === 'kw') {
      this.adv();
      const type = this.parseType();
      return { k: 'other', typeName: type };
    }
    switch (t.v) {
      case '(': return this.ledCall(lhs);
      case '[': return this.ledIndex();
      case '.': return this.ledMember(lhs);
      case '?': {
        this.adv();
        this.parseExprBp(0);
        this.expectOp(':', '\':\' in conditional expression \'cond ? a : b\'');
        this.parseExprBp(w[1]);
        return { k: 'other' };
      }
      case '++': case '--':
        this.adv();
        return { k: 'other' };
      default:
        this.adv();
        this.parseExprBp(w[1]);
        return { k: 'other' };
    }
  }

  private ledIndex(): Ex {
    this.adv();
    this.skipTerms();
    const saved = this.noStructLit;
    this.noStructLit = false;
    if (!this.isOp(':')) this.parseExprBp(0);
    this.skipTerms();
    if (this.isOp(':')) {
      this.adv();
      this.skipTerms();
      if (!this.isOp(']')) this.parseExprBp(0);
      this.skipTerms();
    }
    this.noStructLit = saved;
    this.expectOp(']', '\']\' after index');
    return { k: 'other' };
  }

  private ledMember(lhs: Ex | null): Ex {
    const dotTok = this.adv();
    const memberTok = this.tk();
    const name = this.munchMemberName();
    void dotTok;
    if (
      lhs?.k === 'id' && lhs.name && !this.isOp('(') && lhs.tok &&
      this.lookupLocal(lhs.name) === undefined && this.imports.has(lhs.name)
    ) {
      this.addRef('references', this.resolveImportedName(lhs.name, name), memberTok);
    }
    // `Color.Red` reads a member of a type, most often an enum: name it so the
    // resolver can link the member itself (the receiver is referenced too), and
    // type the expression as `Color` so `c := Color.Red` types `c` for later use
    // (e.g. a `switch c:` whose case items are bare member names).
    let typeName: string | undefined;
    if (
      lhs?.k === 'id' && lhs.name && !this.isOp('(') && name &&
      this.lookupLocal(lhs.name) === undefined && !this.imports.has(lhs.name) &&
      !BUILTIN_NAMES.has(lhs.name) && !PRIMITIVES.has(lhs.name) && !INTRINSIC_TYPES.has(lhs.name) &&
      !this.isTypeParam(lhs.name) && !this.isOp('=') && !this.isOp(':=')
    ) {
      this.addRef('references', `${lhs.name}.${name}`, memberTok);
      typeName = lhs.name;
    }
    // `pkg.Kind.Round`: the same read through an imported package
    if (
      lhs?.k === 'member' && lhs.name && lhs.obj?.k === 'id' && lhs.obj.name && name && !this.isOp('(') &&
      this.lookupLocal(lhs.obj.name) === undefined && this.imports.has(lhs.obj.name) &&
      !this.isOp('=') && !this.isOp(':=')
    ) {
      this.addRef('references', `${lhs.name}.${name}`, memberTok);
    }
    return { k: 'member', obj: lhs, name, tok: memberTok, typeName };
  }

  private ledCall(callee: Ex | null): Ex {
    const parenTok = this.adv();
    const savedNoStruct = this.noStructLit;
    this.noStructLit = false;
    const isSizeof = callee?.k === 'id' && callee.name === 'sizeof';
    if (isSizeof) {
      this.parseType();
      this.expectOp(')', '\')\' after sizeof type');
      this.noStructLit = savedNoStruct;
      return { k: 'other' };
    }
    if (callee?.k === 'id') callee.used = true;
    if (!this.isOp(')')) {
      do {
        this.parseExpr();
      } while (this.matchOp(','));
    }
    this.noStructLit = savedNoStruct;
    this.expectOp(')', '\')\' after arguments');
    this.emitCall(callee, parenTok);
    return { k: 'other', callInner: this.callInnerOf(callee) };
  }

  /** The callee of a call whose result may be typed: a plain function or a package function. */
  private callInnerOf(callee: Ex | null): string | undefined {
    if (!callee) return undefined;
    if (callee.k === 'id' && callee.name) {
      if (this.lookupLocal(callee.name) !== undefined || BUILTIN_NAMES.has(callee.name)) return undefined;
      return callee.name;
    }
    const obj = callee.obj;
    if (callee.k === 'member' && callee.name && obj?.k === 'id' && obj.name) {
      if (this.lookupLocal(obj.name) === undefined && this.imports.has(obj.name)) {
        return this.resolveImportedName(obj.name, callee.name);
      }
    }
    return undefined;
  }

  private emitCall(callee: Ex | null, parenTok: Tok): void {
    if (!callee) return;
    if (callee.k === 'id' && callee.name && callee.tok) {
      if (this.lookupLocal(callee.name) !== undefined || BUILTIN_NAMES.has(callee.name)) return;
      this.addRef('calls', callee.name, callee.tok);
      return;
    }
    if (callee.k !== 'member' || !callee.name || !callee.tok) return;
    void parenTok;
    const method = callee.name;
    const obj = callee.obj;
    if (!obj) return;
    if (obj.k === 'this') {
      this.addRef('calls', method, callee.tok);
      return;
    }
    if (obj.k === 'id' && obj.name) {
      const local = this.lookupLocal(obj.name);
      if (local === undefined && this.imports.has(obj.name)) {
        this.addRef('calls', this.resolveImportedName(obj.name, method), callee.tok);
        return;
      }
      if (local !== undefined) {
        if (local.startsWith(CALL_MARK)) {
          this.addRef('calls', `${local.slice(CALL_MARK.length)}().${method}`, callee.tok);
          return;
        }
        if (local && (INTRINSIC_TYPES.has(local) || PRIMITIVES.has(local) || this.isTypeParam(local))) return;
        if (local) {
          this.addRef('calls', `${local}.${method}`, callee.tok);
          return;
        }
        if (INTRINSIC_METHODS.has(method)) return;
        this.addRef('calls', `${obj.name}.${method}`, callee.tok);
        return;
      }
      if (INTRINSIC_METHODS.has(method)) return;
      this.addRef('calls', `${obj.name}.${method}`, callee.tok);
      return;
    }
    if (INTRINSIC_METHODS.has(method)) return;
    if (obj.typeName && (INTRINSIC_TYPES.has(obj.typeName) || PRIMITIVES.has(obj.typeName))) return;
    this.addRef('calls', obj.typeName ? `${obj.typeName}.${method}` : method, callee.tok);
  }
}

/**
 * Extracts a `.salam` file. English and Persian keywords each need their own
 * lexer pass; the pack that parses the file with the fewest syntax errors wins
 * (usually the first candidate, so a file is parsed once).
 */
export class SalamExtractor {
  private best: SalamFileParser | undefined;

  constructor(private readonly filePath: string, private readonly source: string) {}

  extract(): ExtractionResult {
    let best: { parser: SalamFileParser; result: ExtractionResult } | undefined;
    for (const lang of candidateLangs(this.source)) {
      const parser = new SalamFileParser(this.filePath, this.source, lexSalam(this.source, lang));
      const result = parser.extract();
      if (!best || parser.syntaxErrorCount < best.parser.syntaxErrorCount) best = { parser, result };
      if (parser.syntaxErrorCount === 0) break;
    }
    this.best = best!.parser;
    return best!.result;
  }

  /** Number of syntax problems in the chosen parse (exposed for tests). */
  get syntaxErrorCount(): number {
    return this.best?.syntaxErrorCount ?? 0;
  }

  get syntaxErrorMessages(): string[] {
    return this.best?.syntaxErrorMessages ?? [];
  }

  /** Keyword pack the file was read with, known after `extract()`. */
  get keywordLanguage(): SalamLang {
    return this.best?.keywordLanguage ?? 'en';
  }
}
