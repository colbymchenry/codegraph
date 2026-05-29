import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, NodeKind } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * LispExtractor — a hand-rolled s-expression extractor for Common Lisp (and
 * Emacs Lisp / Scheme-ish dialects, since they share the reader syntax).
 *
 * WHY NOT TREE-SITTER: the `tree-sitter-commonlisp` grammar is incomplete for
 * real-world CL — it mis-parses `^` as a reader macro, chokes on `lambda` as a
 * parameter name, reader conditionals inside `loop`, parameterised format
 * directives inside strings, `{}[]`/backslash escapes in symbol names, and
 * block comments containing parens. Reaching 100% parse coverage on the
 * Clozure ANSI suite required ~12 source-preprocessing patches, each a workaround
 * for the grammar's incompleteness. S-expressions are trivially tokenisable, so
 * a hand-rolled tokenizer + recursive-descent parser (modelled on the CCL ARM64
 * port's own `tools/extract-ppc2-section.py`) parses ALL of it with zero
 * preprocessing: the atom reader simply consumes everything up to whitespace or
 * a structural delimiter, which handles `^ { } [ ] \+ pkg:sym ccl.bug#252a` for
 * free.
 *
 * The extraction logic (which forms produce which node kinds, how call edges
 * are emitted and which positions are suppressed) is a direct port of the
 * earlier tree-sitter-based extractor; see the per-handler comments.
 */

// =============================================================================
// Form-classification constants (lower-cased, package-prefix stripped)
// =============================================================================

const VAR_HEADS = new Set(['defvar', 'defparameter', 'defglobal']);
const CONST_HEADS = new Set(['defconstant', 'defconst', 'define-constant']);
const CLASS_HEADS = new Set(['defclass', 'define-condition']);
const STRUCT_HEADS = new Set(['defstruct']);
const TYPE_ALIAS_HEADS = new Set(['deftype']);
const PACKAGE_HEADS = new Set(['defpackage', 'define-package']);
const IMPORT_HEADS = new Set(['require', 'use-package', 'import-from', 'load']);
const ASDF_IMPORT_HEADS = new Set(['asdf:load-system', 'load-system']);

// (defun|defmacro|defmethod|defgeneric|lambda …) — function-defining forms.
const DEFUN_HEADS = new Set(['defun', 'defmacro', 'defmethod', 'defgeneric', 'lambda']);

// (let ((var val) …) body…) / let* / symbol-macrolet / prog / prog* — same
// leading shape (binding list + body).
const LET_HEADS = new Set(['let', 'let*', 'symbol-macrolet', 'prog', 'prog*']);
// (flet ((name (params) body…) …) outer-body…) / labels / macrolet.
const FLET_HEADS = new Set(['flet', 'labels', 'macrolet']);
// (do ((var init [step]) …) (end-test result…) body…) / do*.
const DO_HEADS = new Set(['do', 'do*']);
// (dolist (var list [result]) body…) / dotimes / with-open-file / … — first
// arg is a binding list whose FIRST element is the bound name.
const SINGLE_BINDING_HEADS = new Set([
  'dolist', 'dotimes',
  'do-symbols', 'do-external-symbols', 'do-all-symbols',
  'with-open-file', 'with-output-to-string', 'with-input-from-string',
  'with-open-stream', 'with-input-from-pipe', 'with-output-to-pipe',
  'with-package-iterator', 'with-hash-table-iterator',
]);
// (multiple-value-bind (vars…) form body…) / (destructuring-bind pattern form body…).
const MV_BIND_HEADS = new Set(['multiple-value-bind', 'destructuring-bind']);
// Macros whose first arg is a parenthesised data list (vars + keyword opts),
// carrying no callable code. Skip arg 2; walk the body (arg 3+).
const SKIP_ARG2_HEADS = new Set(['with-slots', 'with-accessors', 'print-unreadable-object']);

const COND_HEADS = new Set(['cond']);
const CASE_HEADS = new Set(['case', 'ecase', 'ccase', 'typecase', 'etypecase']);
const DECLARE_HEADS = new Set(['declare', 'declaim', 'proclaim']);
const FUNCALL_HEADS = new Set(['funcall', 'apply']);
// CCL vinsn-emission macros: (! VINSN …) / (!! VINSN …) — target is arg 2.
const VINSN_EMIT_HEADS = new Set(['!', '!!']);
const ASSERT_HEADS = new Set(['check-type', 'assert']);

// Scope/control forms — present so their head doesn't become a spurious call
// edge. Binding forms and the specialised forms above are handled separately.
const CONTROL_HEADS = new Set([
  'progn', 'prog1', 'prog2', 'block', 'tagbody', 'go', 'return', 'return-from',
  'if', 'when', 'unless',
  'and', 'or', 'not',
  'loop',
  'function', 'setf', 'setq', 'psetf', 'psetq', 'incf', 'decf',
  'quote', 'unquote', 'list', 'cons', 'car', 'cdr',
  'eval-when', 'the',
  'handler-case', 'handler-bind', 'restart-case', 'restart-bind',
  'with-condition-restarts',
  'unwind-protect', 'ignore-errors',
  'catch', 'throw', 'progv',
  'in-package', 'eval',
]);

// Standard def-forms with dedicated handlers (defun-family handled even
// earlier). defsetf/define-modify-macro/define-symbol-macro/etc are
// intentionally OMITTED so the user-defmacro fallback surfaces them.
const KNOWN_DEF_HEADS = new Set([
  ...VAR_HEADS, ...CONST_HEADS, ...CLASS_HEADS, ...STRUCT_HEADS,
  ...TYPE_ALIAS_HEADS, ...PACKAGE_HEADS,
  'defun', 'defmacro', 'defmethod', 'defgeneric',
]);

// Heuristic for user-defined defining macros (CCL: def-x86-opcode,
// define-arm-vinsn, defcommand, deftest, …). Scoped to top-level positions.
const DEF_FALLBACK_RE = /^def/i;

// =============================================================================
// Pure helpers (symbol-name handling)
// =============================================================================

// Strip the package prefix at the last UNescaped colon (`\:` is a literal
// colon in a name, not a separator — e.g. the ANSI test `format.\:{.6`).
function baseSymbol(text: string): string {
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== ':') continue;
    let bs = 0;
    let k = i - 1;
    while (k >= 0 && text[k] === '\\') { bs++; k--; }
    if (bs % 2 === 0) return text.slice(i + 1);
  }
  return text;
}

// `#:my-app` / `:my-app` / `"my-app"` → `my-app`.
function cleanName(text: string): string {
  return text.trim().replace(/^#?:/, '').replace(/^["']|["']$/g, '');
}

// =============================================================================
// S-expression model
// =============================================================================

type SKind = 'list' | 'sym' | 'keyword' | 'number' | 'string' | 'quote';

interface Sexp {
  kind: SKind;
  /** Original source slice (verbatim — what getNodeText returned in the TS port). */
  text: string;
  /** For lists: child forms (comments already dropped). For quote: [innerForm]. */
  children: Sexp[];
  /** For quote nodes: the prefix marker (`'`, `` ` ``, `,`, `,@`, `#'`, `#+x`, `#-x`). */
  prefix?: string;
  startLine: number; // 1-based
  startCol: number;  // 0-based
  endLine: number;   // 1-based
  endCol: number;    // 0-based
}

interface CommentTok {
  text: string;
  startLine: number;
  endLine: number;
}

// Classify a bare atom's text (strings are tagged during tokenisation).
function classifyAtom(text: string): SKind {
  if (/^:/.test(text)) return 'keyword';
  // Numbers: integer / float / ratio / scientific. Names like `*x*`, `1+`,
  // `+max+`, `foo.1`, `.SPx` must stay symbols.
  if (
    /^[+-]?\d+$/.test(text) ||
    /^[+-]?\d+\/\d+$/.test(text) ||
    /^[+-]?\d*\.\d+([eEdDsSfFlL][+-]?\d+)?$/.test(text) ||
    /^[+-]?\d+\.?\d*[eEdDsSfFlL][+-]?\d+$/.test(text) ||
    /^[+-]?\d+\.$/.test(text)
  ) {
    return 'number';
  }
  return 'sym';
}

// =============================================================================
// Tokenizer + parser
// =============================================================================

type TokType = 'lparen' | 'rparen' | 'string' | 'quote' | 'atom' | 'comment';

interface Tok {
  type: TokType;
  text: string;
  startLine: number; startCol: number;
  endLine: number; endCol: number;
}

const DELIM = new Set(['(', ')', '"', "'", '`', ',', ';', ' ', '\t', '\n', '\r', '\f']);

function tokenize(src: string): { tokens: Tok[]; comments: CommentTok[] } {
  const tokens: Tok[] = [];
  const comments: CommentTok[] = [];
  const n = src.length;
  let i = 0;
  let row = 0; // 0-based
  let col = 0; // 0-based

  // Advance the cursor to absolute index `to`, updating row/col over consumed chars.
  const advanceTo = (to: number): void => {
    while (i < to) {
      if (src[i] === '\n') { row++; col = 0; }
      else { col++; }
      i++;
    }
  };
  const push = (type: TokType, start: number, end: number, sRow: number, sCol: number): void => {
    const eRow = row, eCol = col;
    const t: Tok = {
      type, text: src.slice(start, end),
      startLine: sRow + 1, startCol: sCol, endLine: eRow + 1, endCol: eCol,
    };
    if (type === 'comment') comments.push({ text: t.text, startLine: t.startLine, endLine: t.endLine });
    else tokens.push(t);
  };

  while (i < n) {
    const c = src[i]!;
    const sRow = row, sCol = col, start = i;

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      advanceTo(i + 1);
      continue;
    }
    if (c === ';') {
      let j = i + 1;
      while (j < n && src[j] !== '\n') j++;
      advanceTo(j);
      push('comment', start, j, sRow, sCol);
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '"') { j++; break; }
        j++;
      }
      advanceTo(j);
      push('string', start, j, sRow, sCol);
      continue;
    }
    if (c === '(') { advanceTo(i + 1); push('lparen', start, i, sRow, sCol); continue; }
    if (c === ')') { advanceTo(i + 1); push('rparen', start, i, sRow, sCol); continue; }
    if (c === "'" || c === '`') { advanceTo(i + 1); push('quote', start, i, sRow, sCol); continue; }
    if (c === ',') {
      const j = (src[i + 1] === '@') ? i + 2 : i + 1;
      advanceTo(j);
      push('quote', start, j, sRow, sCol);
      continue;
    }
    if (c === '#') {
      const c1 = src[i + 1];
      // #| … |# nested block comment
      if (c1 === '|') {
        let j = i + 2;
        let depth = 1;
        while (j < n && depth > 0) {
          if (src[j] === '#' && src[j + 1] === '|') { depth++; j += 2; }
          else if (src[j] === '|' && src[j + 1] === '#') { depth--; j += 2; }
          else j++;
        }
        advanceTo(j);
        push('comment', start, j, sRow, sCol);
        continue;
      }
      // #+ / #- reader conditional → quote-like prefix (transparent in walk)
      if (c1 === '+' || c1 === '-') {
        advanceTo(i + 2);
        push('quote', start, i, sRow, sCol);
        continue;
      }
      // #' function quote → quote-like prefix
      if (c1 === "'") {
        advanceTo(i + 2);
        push('quote', start, i, sRow, sCol);
        continue;
      }
      // #\char, #xNN, #(…) vector, #:sym, #.expr, etc. — read as an atom.
      // #\X reads the char (incl. structural ones like `#\(`); the rest read
      // up to whitespace/delimiter.
      let j = i + 1;
      if (src[j] === '\\') {
        j += 2; // consume the escaped char itself (may be `(`/`)`/space)
        while (j < n && !DELIM.has(src[j]!)) j++;
      } else {
        while (j < n && !DELIM.has(src[j]!)) j++;
      }
      advanceTo(j);
      push('atom', start, j, sRow, sCol);
      continue;
    }
    // Plain atom: read up to whitespace or a structural delimiter. A backslash
    // escapes the next char (so `\(`/`\ `/`\:` stay inside the atom).
    let j = i;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (DELIM.has(src[j]!)) break;
      j++;
    }
    if (j === i) j = i + 1; // never stall on a stray char
    advanceTo(j);
    push('atom', start, j, sRow, sCol);
  }

  return { tokens, comments };
}

// Recursive-descent parse into a forest of top-level Sexp forms. Leading quote
// tokens attach as a `quote` wrapper around the following form. Unbalanced
// parens are tolerated (auto-closed at EOF) so a malformed file still yields
// whatever parsed cleanly.
function parse(tokens: Tok[]): Sexp[] {
  let pos = 0;
  const atEnd = () => pos >= tokens.length;
  const peek = () => tokens[pos];

  function atomSexp(t: Tok): Sexp {
    const kind: SKind = t.type === 'string' ? 'string' : classifyAtom(t.text);
    return {
      kind, text: t.text, children: [],
      startLine: t.startLine, startCol: t.startCol, endLine: t.endLine, endCol: t.endCol,
    };
  }

  function parseOne(): Sexp | null {
    if (atEnd()) return null;
    // Gather leading quote prefixes.
    const prefixes: Tok[] = [];
    while (!atEnd() && peek()!.type === 'quote') prefixes.push(tokens[pos++]!);
    if (atEnd()) {
      // Trailing quote with no form — represent as a bare sym so positions survive.
      if (prefixes.length) {
        const q = prefixes[prefixes.length - 1]!;
        return { kind: 'sym', text: q.text, children: [], startLine: q.startLine, startCol: q.startCol, endLine: q.endLine, endCol: q.endCol };
      }
      return null;
    }

    let form: Sexp;
    const t = peek()!;
    if (t.type === 'lparen') {
      pos++; // consume (
      const children: Sexp[] = [];
      const open = t;
      let close: Tok | null = null;
      while (!atEnd()) {
        if (peek()!.type === 'rparen') { close = tokens[pos++]!; break; }
        const child = parseOne();
        if (child) children.push(child);
        else break;
      }
      const endTok = close ?? tokens[pos - 1] ?? open;
      form = {
        kind: 'list', text: '', children,
        startLine: open.startLine, startCol: open.startCol,
        endLine: endTok.endLine, endCol: endTok.endCol,
      };
    } else if (t.type === 'rparen') {
      // Stray close paren — skip it.
      pos++;
      return parseOne();
    } else {
      pos++;
      form = atomSexp(t);
    }

    // Wrap with quote prefixes (innermost first). The wrapper is transparent
    // to the walker except where `#'name` / `'name` is explicitly unwrapped.
    for (let k = prefixes.length - 1; k >= 0; k--) {
      const q = prefixes[k]!;
      form = {
        kind: 'quote', text: q.text, prefix: q.text, children: [form],
        startLine: q.startLine, startCol: q.startCol, endLine: form.endLine, endCol: form.endCol,
      };
    }
    return form;
  }

  const forms: Sexp[] = [];
  while (!atEnd()) {
    const before = pos;
    const f = parseOne();
    if (f) forms.push(f);
    if (pos === before) pos++; // guard against non-advancing loop
  }
  return forms;
}

// =============================================================================
// Sexp accessors mirroring the tree-sitter helpers
// =============================================================================

function isSymbolish(s: Sexp): boolean {
  return s.kind === 'sym';
}

// Base symbol name from a sym (package prefix stripped). undefined otherwise.
function symbolName(s: Sexp): string | undefined {
  if (s.kind !== 'sym') return undefined;
  const t = baseSymbol(s.text.trim());
  return t || undefined;
}

// n-th child (1-indexed); children already exclude comments.
function nthArg(s: Sexp, n: number): Sexp | null {
  return s.children[n - 1] ?? null;
}

function* argsFrom(s: Sexp, start: number): Generator<Sexp> {
  for (let i = start - 1; i < s.children.length; i++) yield s.children[i]!;
}

// Resolve `#'name` / `'name` (incl. `#'pkg:name`) to its base symbol name.
function unwrapQuotedSymbol(s: Sexp): string | null {
  if (s.kind !== 'quote') return null;
  if (s.prefix !== "'" && s.prefix !== "#'") return null;
  const inner = s.children[0];
  if (!inner) return null;
  return symbolName(inner) ?? null;
}

// =============================================================================
// Extractor
// =============================================================================

export class LispExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private nodeStack: string[] = [];
  private nodeById = new Map<string, Node>();
  private comments: CommentTok[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    try {
      const { tokens, comments } = tokenize(this.source);
      this.comments = comments;
      const forms = parse(tokens);

      const fileNode: Node = {
        id: `file:${this.filePath}`,
        kind: 'file',
        name: this.filePath.split(/[\\/]/).pop() || this.filePath,
        qualifiedName: this.filePath,
        filePath: this.filePath,
        language: 'lisp',
        startLine: 1,
        endLine: Math.max(1, this.source.split('\n').length),
        startColumn: 0,
        endColumn: 0,
        isExported: false,
        updatedAt: Date.now(),
      };
      this.nodes.push(fileNode);
      this.nodeById.set(fileNode.id, fileNode);
      this.nodeStack.push(fileNode.id);

      for (const form of forms) this.processForm(form);

      this.nodeStack.pop();
    } catch (error) {
      this.errors.push({
        message: `Lisp extraction error: ${error instanceof Error ? error.message : String(error)}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  // --- node/scope plumbing (port of TreeSitterExtractor.createNode) ---------

  private buildQualifiedName(name: string): string {
    const parts: string[] = [];
    for (const id of this.nodeStack) {
      const n = this.nodeById.get(id);
      if (n && n.kind !== 'file') parts.push(n.name);
    }
    parts.push(name);
    return parts.join('::');
  }

  private createNode(
    kind: NodeKind,
    name: string,
    s: Sexp,
    extra: Partial<Node> = {}
  ): Node | null {
    if (!name) return null;
    const id = generateNodeId(this.filePath, kind, name, s.startLine);
    const node: Node = {
      id,
      kind,
      name,
      qualifiedName: this.buildQualifiedName(name),
      filePath: this.filePath,
      language: 'lisp',
      startLine: s.startLine,
      endLine: s.endLine,
      startColumn: s.startCol,
      endColumn: s.endCol,
      updatedAt: Date.now(),
      ...extra,
    };
    this.nodes.push(node);
    this.nodeById.set(id, node);
    if (this.nodeStack.length > 0) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      if (parentId) this.edges.push({ source: parentId, target: id, kind: 'contains' });
    }
    return node;
  }

  private addRef(ref: UnresolvedReference): void {
    this.unresolvedReferences.push(ref);
  }

  // Contiguous `;`-comment block (or trailing block comment) immediately
  // preceding `startLine`, cleaned of comment markers. Best-effort docstring.
  private docBefore(startLine: number): string | undefined {
    const lines: string[] = [];
    let target = startLine - 1;
    // Walk comments in reverse, collecting those that end on the line directly
    // above the running target.
    for (let pass = 0; pass < this.comments.length; pass++) {
      const c = this.comments.find((cm) => cm.endLine === target);
      if (!c) break;
      lines.unshift(c.text);
      target = c.startLine - 1;
    }
    if (!lines.length) return undefined;
    const cleaned = lines
      .map((c) => c.replace(/^#\|/, '').replace(/\|#$/, '').replace(/^;+/gm, '').trim())
      .join('\n')
      .trim();
    return cleaned || undefined;
  }

  // --- walker ---------------------------------------------------------------

  private processForm(s: Sexp): void {
    if (s.kind !== 'list') {
      // quote wrappers and any composite get descended transparently.
      for (const c of s.children) this.processForm(c);
      return;
    }
    const first = s.children[0];
    if (!first) return;

    // Head text only when the head is a bare/package-qualified symbol.
    let head: string | null = null;
    if (first.kind === 'sym') head = first.text.trim();
    if (head === null) {
      for (const c of s.children) this.processForm(c);
      return;
    }
    const headBase = baseSymbol(head).toLowerCase();

    // Function-defining forms first (incl. lambda).
    if (DEFUN_HEADS.has(headBase)) { this.extractDefun(s, headBase); return; }

    if (VAR_HEADS.has(headBase)) { this.extractVarOrConst(s, 'variable'); return; }
    if (CONST_HEADS.has(headBase)) { this.extractVarOrConst(s, 'constant'); return; }
    if (CLASS_HEADS.has(headBase)) { this.extractDefclass(s); return; }
    if (STRUCT_HEADS.has(headBase)) { this.extractDefstruct(s); return; }
    if (TYPE_ALIAS_HEADS.has(headBase)) {
      const nameNode = nthArg(s, 2);
      if (nameNode) { const name = symbolName(nameNode); if (name) this.createNode('type_alias', name, s); }
      return;
    }
    if (PACKAGE_HEADS.has(headBase)) { this.extractDefpackage(s); return; }
    if (IMPORT_HEADS.has(headBase) || ASDF_IMPORT_HEADS.has(head.toLowerCase())) { this.extractImport(s); return; }
    if (KNOWN_DEF_HEADS.has(headBase)) return;

    // User-defined `def*` DSL macros (top-level only).
    if (DEF_FALLBACK_RE.test(headBase) && this.shouldApplyDefFallback()) {
      this.extractUserDefMacro(s, head);
      return;
    }

    // Binding forms.
    if (LET_HEADS.has(headBase)) { this.handleLet(s); return; }
    if (FLET_HEADS.has(headBase)) { this.handleFlet(s); return; }
    if (DO_HEADS.has(headBase)) { this.handleDo(s); return; }
    if (SINGLE_BINDING_HEADS.has(headBase)) { this.handleSingleBinding(s); return; }
    if (MV_BIND_HEADS.has(headBase)) {
      for (const a of argsFrom(s, 3)) this.processForm(a);
      return;
    }
    if (SKIP_ARG2_HEADS.has(headBase)) {
      for (const a of argsFrom(s, 3)) this.processForm(a);
      return;
    }

    // Specialised control forms.
    if (DECLARE_HEADS.has(headBase)) return;
    if (COND_HEADS.has(headBase)) {
      for (const clause of argsFrom(s, 2)) {
        if (clause.kind !== 'list') continue;
        for (const c of clause.children) this.processForm(c);
      }
      return;
    }
    if (CASE_HEADS.has(headBase)) {
      const keyform = nthArg(s, 2);
      if (keyform) this.processForm(keyform);
      for (const clause of argsFrom(s, 3)) {
        if (clause.kind !== 'list') continue;
        for (const c of argsFrom(clause, 2)) this.processForm(c);
      }
      return;
    }
    if (FUNCALL_HEADS.has(headBase)) { this.handleFuncall(s); return; }
    if (VINSN_EMIT_HEADS.has(headBase)) { this.handleVinsnEmit(s); return; }
    if (ASSERT_HEADS.has(headBase)) { this.handleAssertOrCheckType(s, headBase); return; }

    // Plain control forms.
    if (CONTROL_HEADS.has(headBase)) {
      for (const a of argsFrom(s, 2)) this.processForm(a);
      return;
    }

    // Default: a function call.
    this.emitCall(s, head);
    for (const a of argsFrom(s, 2)) this.processForm(a);
  }

  // --- binding-form handlers ------------------------------------------------

  private handleLet(s: Sexp): void {
    const bindings = nthArg(s, 2);
    if (bindings?.kind === 'list') {
      for (const binding of bindings.children) {
        if (binding.kind !== 'list') continue;
        for (const c of argsFrom(binding, 2)) this.processForm(c);
      }
    }
    for (const a of argsFrom(s, 3)) this.processForm(a);
  }

  private handleFlet(s: Sexp): void {
    const bindings = nthArg(s, 2);
    if (bindings?.kind === 'list') {
      for (const binding of bindings.children) {
        if (binding.kind !== 'list') continue;
        const nameNode = nthArg(binding, 1);
        if (!nameNode || nameNode.kind !== 'sym') continue;
        const fnName = nameNode.text.trim();
        const paramsNode = nthArg(binding, 2);
        const sig = paramsNode ? paramsNode.text.trim() : undefined;
        const innerFn = this.createNode('function', fnName, binding, { signature: sig });
        if (!innerFn) continue;
        this.nodeStack.push(innerFn.id);
        for (const c of argsFrom(binding, 3)) this.processForm(c);
        this.nodeStack.pop();
      }
    }
    for (const a of argsFrom(s, 3)) this.processForm(a);
  }

  private handleDo(s: Sexp): void {
    const bindings = nthArg(s, 2);
    if (bindings?.kind === 'list') {
      for (const binding of bindings.children) {
        if (binding.kind !== 'list') continue;
        for (const c of argsFrom(binding, 2)) this.processForm(c);
      }
    }
    const term = nthArg(s, 3);
    if (term?.kind === 'list') {
      for (const c of term.children) this.processForm(c);
    }
    for (const a of argsFrom(s, 4)) this.processForm(a);
  }

  private handleSingleBinding(s: Sexp): void {
    const binding = nthArg(s, 2);
    if (binding?.kind === 'list') {
      for (const c of argsFrom(binding, 2)) this.processForm(c);
    }
    for (const a of argsFrom(s, 3)) this.processForm(a);
  }

  private handleAssertOrCheckType(s: Sexp, headBase: string): void {
    if (headBase === 'check-type') {
      const place = nthArg(s, 2);
      if (place) this.processForm(place);
      for (const a of argsFrom(s, 4)) this.processForm(a);
      return;
    }
    const test = nthArg(s, 2);
    if (test) this.processForm(test);
    const placesList = nthArg(s, 3);
    if (placesList?.kind === 'list') {
      for (const p of placesList.children) this.processForm(p);
    }
    for (const a of argsFrom(s, 4)) this.processForm(a);
  }

  private handleVinsnEmit(s: Sexp): void {
    const target = nthArg(s, 2);
    if (target) {
      if (isSymbolish(target)) {
        const name = symbolName(target);
        if (name) this.emitCall(s, name);
      } else {
        this.processForm(target);
      }
    }
    for (const a of argsFrom(s, 3)) this.processForm(a);
  }

  private handleFuncall(s: Sexp): void {
    const target = nthArg(s, 2);
    if (target) {
      const quotedName = unwrapQuotedSymbol(target);
      if (quotedName) this.emitCall(s, quotedName);
      else this.processForm(target);
    }
    for (const a of argsFrom(s, 3)) this.processForm(a);
  }

  // --- defining-form handlers ----------------------------------------------

  private extractVarOrConst(s: Sexp, kind: NodeKind): void {
    const nameNode = nthArg(s, 2);
    if (nameNode) {
      const name = symbolName(nameNode);
      if (name) this.createNode(kind, name, s, { signature: this.slice(s) });
    }
    const init = nthArg(s, 3);
    if (init) this.processForm(init);
  }

  private extractDefclass(s: Sexp): void {
    const nameNode = nthArg(s, 2);
    if (!nameNode) return;
    const className = symbolName(nameNode);
    if (!className) return;
    const classNode = this.createNode('class', className, s, { docstring: this.docBefore(s.startLine) });
    if (!classNode) return;

    for (const sup of this.defclassSupers(s)) {
      this.addRef({
        fromNodeId: classNode.id,
        referenceName: baseSymbol(sup),
        referenceKind: 'extends',
        line: s.startLine,
        column: s.startCol,
      });
    }

    const slotList = nthArg(s, 4);
    if (slotList?.kind === 'list') {
      this.nodeStack.push(classNode.id);
      for (const slot of slotList.children) {
        if (isSymbolish(slot)) {
          const slotName = symbolName(slot);
          if (slotName) this.createNode('field', slotName, slot, {});
          continue;
        }
        if (slot.kind !== 'list') continue;
        const slotNameNode = nthArg(slot, 1);
        if (!slotNameNode) continue;
        const slotName = symbolName(slotNameNode);
        if (!slotName) continue;
        this.createNode('field', slotName, slot, { signature: this.slice(slot) });

        // Walk slot keyword options.
        for (let j = 0; j < slot.children.length; j++) {
          const c = slot.children[j]!;
          if (c.kind !== 'keyword') continue;
          const kwText = c.text.trim().toLowerCase();
          const value = slot.children[j + 1];
          if (!value) continue;
          if (kwText === ':accessor' || kwText === ':reader' || kwText === ':writer') {
            if (isSymbolish(value)) {
              const accName = symbolName(value);
              if (accName) this.createNode('function', accName, value, { signature: kwText.slice(1) });
            }
          } else if (kwText === ':initform' || kwText === ':default') {
            this.processForm(value);
          }
        }
      }
      this.nodeStack.pop();
    }

    // Class options (arg 5+) — walk option value forms for callable code.
    for (const opt of argsFrom(s, 5)) {
      if (opt.kind !== 'list') continue;
      for (const c of argsFrom(opt, 2)) this.processForm(c);
    }
  }

  private extractDefstruct(s: Sexp): void {
    const hdr = this.defstructHeader(s);
    if (!hdr) return;
    const structNode = this.createNode('struct', hdr.name, s, { docstring: this.docBefore(s.startLine) });
    if (!structNode) return;

    this.nodeStack.push(structNode.id);
    for (const slot of argsFrom(s, hdr.slotsStartArg)) {
      if (slot.kind === 'string') continue; // docstring slot
      if (isSymbolish(slot)) {
        const slotName = symbolName(slot);
        if (slotName) this.createNode('field', slotName, slot, {});
        continue;
      }
      if (slot.kind !== 'list') continue;
      const slotNameNode = nthArg(slot, 1);
      if (!slotNameNode) continue;
      const slotName = symbolName(slotNameNode);
      if (!slotName) continue;
      this.createNode('field', slotName, slot, { signature: this.slice(slot) });
      const def = nthArg(slot, 2);
      if (def?.kind === 'list') this.processForm(def);
    }
    this.nodeStack.pop();
  }

  private extractDefpackage(s: Sexp): void {
    const second = nthArg(s, 2);
    if (!second) return;
    const name = cleanName(second.text);
    if (!name) return;

    const nicknames: string[] = [];
    for (const opt of argsFrom(s, 3)) {
      if (opt.kind !== 'list') continue;
      const optHead = opt.children[0];
      if (!optHead || optHead.kind !== 'keyword') continue;
      if (cleanName(optHead.text).toLowerCase() !== 'nicknames') continue;
      for (const val of argsFrom(opt, 2)) {
        const t = cleanName(val.text);
        if (t) nicknames.push(t);
      }
    }
    const nsSignature = nicknames.length ? `nicknames: ${nicknames.join(', ')}` : undefined;
    const nsNode = this.createNode('namespace', name, s, { signature: nsSignature });
    if (!nsNode) return;

    this.nodeStack.push(nsNode.id);
    for (const opt of argsFrom(s, 3)) {
      if (opt.kind !== 'list') continue;
      const optHead = opt.children[0];
      if (!optHead || optHead.kind !== 'keyword') continue;
      const optName = cleanName(optHead.text).toLowerCase();

      if (optName === 'use') {
        for (const val of argsFrom(opt, 2)) {
          const pkg = cleanName(val.text);
          if (!pkg) continue;
          const imp = this.createNode('import', pkg, val, { signature: `:use ${pkg}` });
          if (imp) this.addRef({ fromNodeId: nsNode.id, referenceName: pkg, referenceKind: 'imports', line: val.startLine, column: val.startCol });
        }
      } else if (optName === 'import-from') {
        const pkgNode = nthArg(opt, 2);
        const pkgName = pkgNode ? cleanName(pkgNode.text) : '';
        if (pkgName && pkgNode) {
          this.createNode('import', pkgName, pkgNode, { signature: `:import-from ${pkgName}` });
          this.addRef({ fromNodeId: nsNode.id, referenceName: pkgName, referenceKind: 'imports', line: pkgNode.startLine, column: pkgNode.startCol });
        }
        for (const val of argsFrom(opt, 3)) {
          const sym = cleanName(val.text);
          if (!sym) continue;
          this.createNode('import', sym, val, { signature: pkgName ? `from ${pkgName}` : `:import-from` });
          this.addRef({ fromNodeId: nsNode.id, referenceName: sym, referenceKind: 'imports', line: val.startLine, column: val.startCol });
        }
      } else if (optName === 'export') {
        for (const val of argsFrom(opt, 2)) {
          const sym = cleanName(val.text);
          if (!sym) continue;
          this.createNode('export', sym, val, { signature: `:export ${sym}` });
        }
      } else if (optName === 'shadowing-import-from') {
        const pkgNode = nthArg(opt, 2);
        const pkgName = pkgNode ? cleanName(pkgNode.text) : '';
        for (const val of argsFrom(opt, 3)) {
          const sym = cleanName(val.text);
          if (!sym) continue;
          this.createNode('import', sym, val, { signature: pkgName ? `shadowing from ${pkgName}` : `:shadowing-import-from` });
        }
      }
    }
    this.nodeStack.pop();
  }

  private extractImport(s: Sexp): void {
    const nameNode = nthArg(s, 2);
    if (!nameNode) return;
    const mod = cleanName(nameNode.text);
    if (!mod) return;
    const imp = this.createNode('import', mod, s, { signature: this.slice(s) });
    if (imp && this.nodeStack.length > 0) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      if (parentId) this.addRef({ fromNodeId: parentId, referenceName: mod, referenceKind: 'imports', line: s.startLine, column: s.startCol });
    }
  }

  private shouldApplyDefFallback(): boolean {
    const topId = this.nodeStack[this.nodeStack.length - 1];
    if (!topId) return false;
    return !topId.startsWith('function:') && !topId.startsWith('method:');
  }

  private extractUserDefMacro(s: Sexp, head: string): void {
    const nameNode = nthArg(s, 2);
    if (!nameNode) return;
    let macroName: string | undefined;
    if (isSymbolish(nameNode)) {
      macroName = symbolName(nameNode);
    } else if (nameNode.kind === 'list') {
      for (const c of nameNode.children) {
        if (isSymbolish(c)) { macroName = symbolName(c); break; }
      }
    }
    if (!macroName) return;

    const macroNode = this.createNode('function', macroName, s, {
      signature: `(${head} ...)`,
      docstring: this.docBefore(s.startLine),
    });
    if (!macroNode) return;

    this.nodeStack.push(macroNode.id);
    let skippedFirstList = false;
    for (const arg of argsFrom(s, 3)) {
      if (!skippedFirstList && arg.kind === 'list') { skippedFirstList = true; continue; }
      this.processForm(arg);
    }
    this.nodeStack.pop();
  }

  private extractDefun(s: Sexp, headBase: string): void {
    // lambda — anonymous: walk body (everything after the lambda-list).
    if (headBase === 'lambda') {
      for (const a of argsFrom(s, 3)) this.processForm(a);
      return;
    }

    const isMethod = headBase === 'defmethod';
    const nameNode = nthArg(s, 2);
    if (!nameNode) return;

    // Name: a bare sym (verbatim) or a `(setf foo)` list.
    let name: string | undefined;
    if (nameNode.kind === 'sym') name = nameNode.text.trim();
    else if (nameNode.kind === 'list') name = this.slice(nameNode);
    if (!name) return;

    // defmethod qualifiers (`:before`/`:after`/`:around`) sit between the name
    // and the lambda-list; the lambda-list is the first list after the name.
    const qualifiers: string[] = [];
    let lambdaIdx = -1;
    for (let i = 2; i < s.children.length; i++) {
      const c = s.children[i]!;
      if (c.kind === 'list') { lambdaIdx = i; break; }
      if (isMethod && c.kind === 'keyword') { qualifiers.push(c.text.trim()); }
    }
    const lambdaList = lambdaIdx >= 0 ? s.children[lambdaIdx]! : null;
    const lambdaSig = lambdaList ? this.slice(lambdaList) : undefined;
    const qualStr = qualifiers.join(' ');
    const signature = qualStr ? (lambdaSig ? `${qualStr} ${lambdaSig}` : qualStr) : lambdaSig;

    const receiver = isMethod && lambdaList ? this.defmethodReceiverType(lambdaList) : undefined;
    const qualSuffix = qualStr
      ? '::' + qualifiers.map((q) => q.replace(/^:/, '')).join('::')
      : '';

    const extra: Partial<Node> = { signature, docstring: this.docBefore(s.startLine) };

    let pushedClassScope = false;
    if (receiver) {
      const owner = this.nodes.find((n) => n.name === receiver && n.filePath === this.filePath && n.kind === 'class');
      if (owner) {
        this.nodeStack.push(owner.id);
        pushedClassScope = true;
        if (qualSuffix) extra.qualifiedName = `${receiver}::${name}${qualSuffix}`;
      } else {
        extra.qualifiedName = `${receiver}::${name}${qualSuffix}`;
      }
    } else if (qualSuffix) {
      extra.qualifiedName = `${name}${qualSuffix}`;
    }

    const kind: NodeKind = isMethod ? 'method' : 'function';
    const fnNode = this.createNode(kind, name, s, extra);
    if (pushedClassScope) this.nodeStack.pop();
    if (!fnNode) return;

    // Body = forms after the lambda-list.
    this.nodeStack.push(fnNode.id);
    const bodyStart = lambdaIdx >= 0 ? lambdaIdx + 1 : 2;
    for (let i = bodyStart; i < s.children.length; i++) this.processForm(s.children[i]!);
    this.nodeStack.pop();
  }

  // (defmethod NAME ((arg TYPE) …) …) — receiver = TYPE of first specialised param.
  private defmethodReceiverType(lambdaList: Sexp): string | undefined {
    for (const arg of lambdaList.children) {
      if (arg.kind === 'sym') {
        if (arg.text.trim().startsWith('&')) return undefined;
        continue;
      }
      if (arg.kind !== 'list') continue;
      const typeNode = nthArg(arg, 2);
      if (typeNode && isSymbolish(typeNode)) return symbolName(typeNode);
      return undefined;
    }
    return undefined;
  }

  private defclassSupers(s: Sexp): string[] {
    const supersList = nthArg(s, 3);
    if (!supersList || supersList.kind !== 'list') return [];
    const out: string[] = [];
    for (const sup of supersList.children) {
      const name = symbolName(sup);
      if (name) out.push(name);
    }
    return out;
  }

  private defstructHeader(s: Sexp): { name: string; slotsStartArg: number } | null {
    const second = nthArg(s, 2);
    if (!second) return null;
    if (isSymbolish(second)) {
      const name = symbolName(second);
      if (name) return { name, slotsStartArg: 3 };
    }
    if (second.kind === 'list') {
      for (const c of second.children) {
        if (isSymbolish(c)) { const name = symbolName(c); if (name) return { name, slotsStartArg: 3 }; }
      }
    }
    return null;
  }

  private emitCall(s: Sexp, head: string): void {
    if (this.nodeStack.length === 0) return;
    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;
    this.addRef({
      fromNodeId: callerId,
      referenceName: baseSymbol(head),
      referenceKind: 'calls',
      line: s.startLine,
      column: s.startCol,
    });
  }

  // First 100 chars of a form's source slice (for signatures). Uses byte range
  // from positions; falls back to reconstructing from source via line offsets.
  private slice(s: Sexp): string {
    const lines = this.source.split('\n');
    if (s.startLine === s.endLine) {
      return (lines[s.startLine - 1] ?? '').slice(s.startCol, s.endCol).slice(0, 100);
    }
    const buf: string[] = [];
    for (let ln = s.startLine; ln <= s.endLine && ln <= lines.length; ln++) {
      const line = lines[ln - 1] ?? '';
      if (ln === s.startLine) buf.push(line.slice(s.startCol));
      else if (ln === s.endLine) buf.push(line.slice(0, s.endCol));
      else buf.push(line);
      if (buf.join('\n').length > 100) break;
    }
    return buf.join('\n').slice(0, 100);
  }
}
