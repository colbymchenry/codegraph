import { Edge, ExtractionError, ExtractionResult, Node, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';
import { isLanguageSupported } from './grammars';

/**
 * SqlxExtractor — parses Dataform `.sqlx` models.
 *
 * A `.sqlx` file is a SQL SELECT wrapped in Dataform's own syntax: a
 * `config { }` header, optional `js { }` / `pre_operations { }` /
 * `post_operations { }` blocks, and `${ … }` JavaScript interpolations inside
 * the SQL. It is therefore NOT valid SQL — handing it to the SQL grammar
 * yields an error tree — and the edges we want aren't in the SQL anyway: a
 * model's dependencies are named by `ref()` / `resolve()` calls and by the
 * config `dependencies` list. So this is a hand scanner in the shape of
 * {@link MyBatisExtractor}, not a tree-sitter language.
 *
 * It emits the file node plus ONE model node (kind `class`, like the tables
 * and views the SQL extractor emits), and one `references` reference per
 * distinct model the file depends on, so `codegraph_explore` and impact
 * queries walk the model DAG.
 *
 * referenceName shape: a **dotted `schema.name`** when the ref names a schema,
 * a **bare `name`** when it doesn't. `UnresolvedReference` has no metadata
 * field to park the schema in, and the two forms hit the two resolver
 * strategies that already do the right thing: a dotted name matches a model
 * node's `qualifiedName` exactly through `matchByQualifiedName` (0.95), a bare
 * one matches its `name` through `matchByExactName` (0.9). Emitting the bare
 * name always would lose the disambiguation a schema gives; emitting a dotted
 * name always would invent a schema the target may not declare.
 */

interface Span {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/** A model this file depends on, as written at the reference site. */
interface RefTarget {
  schema?: string;
  name: string;
  line: number;
}

/** The blocks that are Dataform syntax rather than SQL. */
const BLOCK_KEYWORDS = ['config', 'js', 'pre_operations', 'post_operations'] as const;

export class SqlxExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private lineStarts: number[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
    this.computeLineStarts();
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    const fileNode = this.createFileNode();

    try {
      const { blocks, interpolations } = this.scan();
      const config = blocks.get('config');
      const entries = config ? this.topLevelEntries(config.body) : new Map<string, Span>();

      const model = this.createModelNode(entries);
      this.edges.push({ source: fileNode.id, target: model.id, kind: 'contains' });

      const targets: RefTarget[] = [];
      for (const span of interpolations) this.scanRefCalls(span, targets);
      const js = blocks.get('js');
      if (js) this.scanRefCalls(js.body, targets);
      this.addDependencies(entries.get('dependencies'), targets);

      const seen = new Set<string>();
      for (const t of targets) {
        this.addReference(model.id, t.schema ? `${t.schema}.${t.name}` : t.name, t.line, seen);
      }

      this.extractSqlBody(model.id, blocks, interpolations, seen);
    } catch (error) {
      this.errors.push({
        message: `Dataform extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    const node: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'sql',
      startLine: 1,
      endLine: lines.length || 1,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  /**
   * The model itself. Dataform names it by the config `name`, defaulting to
   * the file stem, and qualifies it by the config `schema` (the dataset) —
   * which is exactly the `schema.name` a sibling model writes in its `ref()`.
   * The config `type` (`table`/`view`/`incremental`/…) rides in `signature`,
   * the field MyBatis uses for the same "which flavor of statement is this".
   */
  private createModelNode(entries: Map<string, Span>): Node {
    const stem = (this.filePath.split('/').pop() || this.filePath).replace(/\.sqlx$/i, '');
    const name = this.literalOf(entries.get('name')) ?? stem;
    const schema = this.literalOf(entries.get('schema'));
    const qualifiedName = schema ? `${schema}.${name}` : name;
    const lines = this.source.split('\n');
    const node: Node = {
      id: generateNodeId(this.filePath, 'class', qualifiedName, 1),
      kind: 'class',
      name,
      qualifiedName,
      filePath: this.filePath,
      language: 'sql',
      signature: this.literalOf(entries.get('type')),
      startLine: 1,
      endLine: lines.length || 1,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  /** Each entry of the config `dependencies: ["n", "s.n"]` array. */
  private addDependencies(span: Span | undefined, out: RefTarget[]): void {
    if (!span) return;
    const line = this.getLineNumber(span.start);
    for (const dep of this.stringLiterals(span)) {
      if (dep) out.push({ name: dep, line });
    }
  }

  private addReference(
    fromNodeId: string,
    referenceName: string,
    line: number,
    seen: Set<string>
  ): void {
    if (seen.has(referenceName)) return;
    seen.add(referenceName);
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName,
      referenceKind: 'references',
      line,
      column: 0,
      filePath: this.filePath,
      language: 'sql',
    });
  }

  /**
   * Tables the SQL body reads that are NOT `ref()`s — a literal source table in
   * a FROM/JOIN. Blank every Dataform span to spaces (length-preserving, so
   * line numbers still map) and hand the remainder to the SQL extractor,
   * keeping only its references, re-pointed at the model. Its own file node is
   * dropped: this file already has one.
   */
  private extractSqlBody(
    modelNodeId: string,
    blocks: Map<string, { body: Span; full: Span }>,
    interpolations: Span[],
    seen: Set<string>
  ): void {
    if (!isLanguageSupported('sql')) return;
    const chars = this.source.split('');
    // A block is statement-level, so whitespace in its place still parses.
    for (const block of blocks.values()) this.mask(chars, block.full, ' ');
    // An interpolation stands where a TABLE NAME goes, so it has to leave an
    // identifier behind: blanked to whitespace, `FROM ${ref("x")} c` reads as
    // `FROM c` and the alias becomes a phantom table reference. The mask is a
    // run of underscores, filtered back out below. (Back out to the `${` and
    // forward over the `}` the body span excludes.)
    for (const span of interpolations) {
      this.mask(chars, { start: span.start - 2, end: span.end + 1 }, '_');
    }
    const result = new TreeSitterExtractor(this.filePath, chars.join(''), 'sql').extract();
    for (const ref of result.unresolvedReferences) {
      if (ref.referenceKind !== 'references' || /^_+$/.test(ref.referenceName)) continue;
      this.addReference(modelNodeId, ref.referenceName, ref.line, seen);
    }
  }

  /** Overwrite a span with `fill`, keeping newlines so line numbers still map. */
  private mask(chars: string[], span: Span, fill: string): void {
    for (let i = Math.max(0, span.start); i < Math.min(span.end, chars.length); i++) {
      if (chars[i] !== '\n') chars[i] = fill;
    }
  }

  // ---------------------------------------------------------------------------
  // Scanner
  // ---------------------------------------------------------------------------

  /**
   * One pass over the file, at brace depth 0, collecting the Dataform blocks
   * and every `${ … }` interpolation. Strings and comments are skipped whole,
   * so a `${ref("x")}` written inside a string literal or after a `--` is
   * neither a block nor an interpolation, and produces nothing.
   */
  private scan(): { blocks: Map<string, { body: Span; full: Span }>; interpolations: Span[] } {
    const s = this.source;
    const blocks = new Map<string, { body: Span; full: Span }>();
    const interpolations: Span[] = [];
    let i = 0;
    while (i < s.length) {
      const skipped = this.skipAtomic(i, true);
      if (skipped > i) {
        i = skipped;
        continue;
      }
      if (s[i] === '$' && s[i + 1] === '{') {
        const end = this.matchBrace(i + 1, s.length);
        interpolations.push({ start: i + 2, end: end - 1 });
        i = end;
        continue;
      }
      const block = this.blockAt(i);
      if (block) {
        blocks.set(block.name, { body: block.body, full: block.full });
        i = block.full.end;
        continue;
      }
      i++;
    }
    return { blocks, interpolations };
  }

  /** A `config|js|pre_operations|post_operations {` starting at `i`. */
  private blockAt(i: number): { name: string; body: Span; full: Span } | null {
    const s = this.source;
    if (i > 0 && /[A-Za-z0-9_$]/.test(s[i - 1]!)) return null;
    for (const name of BLOCK_KEYWORDS) {
      if (!s.startsWith(name, i)) continue;
      let j = i + name.length;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      if (s[j] !== '{') continue;
      const end = this.matchBrace(j, s.length);
      return { name, body: { start: j + 1, end: end - 1 }, full: { start: i, end } };
    }
    return null;
  }

  /**
   * `ref(…)` / `resolve(…)` targets inside a span. A dotted receiver is
   * allowed (`ctx.ref("x")` in a `js` block is the same call), `self()` is not
   * one of these names so it is never a reference, and a call written inside a
   * string or a comment is skipped along with it.
   */
  private scanRefCalls(span: Span, out: RefTarget[]): void {
    let i = span.start;
    while (i < span.end) {
      // Backticks stay transparent here: a `js` block's template literal is
      // where `${ref("x")}` lives, and skipping it whole would lose the call.
      const skipped = this.skipAtomic(i, false);
      if (skipped > i) {
        i = Math.min(skipped, span.end);
        continue;
      }
      const call = this.refCallAt(i, span.end);
      if (call) {
        const target = this.parseRefArgs(call.args);
        if (target) out.push({ ...target, line: this.getLineNumber(i) });
        i = call.end;
        continue;
      }
      i++;
    }
  }

  private refCallAt(i: number, end: number): { args: Span; end: number } | null {
    const s = this.source;
    if (i > 0 && /[A-Za-z0-9_$]/.test(s[i - 1]!)) return null;
    const name = s.startsWith('ref', i) ? 'ref' : s.startsWith('resolve', i) ? 'resolve' : null;
    if (!name) return null;
    let j = i + name.length;
    while (j < end && /\s/.test(s[j]!)) j++;
    if (s[j] !== '(') return null;
    const close = this.matchParen(j, end);
    return { args: { start: j + 1, end: close - 1 }, end: close };
  }

  /**
   * `ref("n")`, `ref("s", "n")`, `ref("d", "s", "n")` and
   * `ref({ schema: "s", name: "n" })`. Positionally the model name is always
   * last and the schema the one before it (the first of three is the
   * database/project, which the graph doesn't key on). Args that aren't
   * literals — `ref(someVariable)` — name nothing statically and are dropped.
   */
  private parseRefArgs(args: Span): { schema?: string; name: string } | null {
    const s = this.source;
    let i = args.start;
    while (i < args.end && /\s/.test(s[i]!)) i++;
    if (s[i] === '{') {
      const entries = this.topLevelEntries({ start: i + 1, end: this.matchBrace(i, args.end) - 1 });
      const name = this.literalOf(entries.get('name'));
      return name ? { schema: this.literalOf(entries.get('schema')), name } : null;
    }
    const parts = this.stringLiterals(args);
    const name = parts[parts.length - 1];
    if (!name) return null;
    return { schema: parts.length >= 2 ? parts[parts.length - 2] : undefined, name };
  }

  /**
   * The `key: value` pairs at the TOP level of a `{ … }` body — a value that
   * is itself an object or array is stepped over whole, so the `name:` inside
   * `columns: { name: "…" }` is not mistaken for the model's own name.
   */
  private topLevelEntries(body: Span): Map<string, Span> {
    const out = new Map<string, Span>();
    let i = body.start;
    while (i < body.end) {
      const key = this.keyAt(i, body.end);
      if (key) {
        const valueEnd = this.endOfValue(key.valueStart, body.end);
        out.set(key.name, { start: key.valueStart, end: valueEnd });
        i = valueEnd;
        continue;
      }
      const skipped = this.skipAtomic(i, true);
      i = skipped > i ? Math.min(skipped, body.end) : i + 1;
    }
    return out;
  }

  /** A bare or quoted `key:` at `i`, and where its value starts. */
  private keyAt(i: number, end: number): { name: string; valueStart: number } | null {
    const s = this.source;
    let name: string;
    let j: number;
    const quote = s[i];
    if (quote === '"' || quote === "'") {
      const close = this.endOfString(i, quote);
      if (close > end) return null;
      name = s.slice(i + 1, close - 1);
      j = close;
    } else {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(s.slice(i, end));
      if (!m) return null;
      name = m[0];
      j = i + m[0].length;
    }
    while (j < end && /\s/.test(s[j]!)) j++;
    if (s[j] !== ':') return null;
    j++;
    while (j < end && /\s/.test(s[j]!)) j++;
    return { name, valueStart: j };
  }

  /** End of the value starting at `start`: the next top-level `,` or closer. */
  private endOfValue(start: number, end: number): number {
    const s = this.source;
    let depth = 0;
    let i = start;
    while (i < end) {
      const skipped = this.skipAtomic(i, true);
      if (skipped > i) {
        i = Math.min(skipped, end);
        continue;
      }
      const c = s[i]!;
      if (c === '{' || c === '[' || c === '(') depth++;
      else if (c === '}' || c === ']' || c === ')') {
        if (depth === 0) return i;
        depth--;
      } else if (c === ',' && depth === 0) return i;
      i++;
    }
    return end;
  }

  /** The first string literal in a span, or undefined. */
  private literalOf(span: Span | undefined): string | undefined {
    return span ? this.stringLiterals(span)[0] : undefined;
  }

  /** Every quoted string in a span, in order, unquoted. Comments are skipped. */
  private stringLiterals(span: Span): string[] {
    const s = this.source;
    const out: string[] = [];
    let i = span.start;
    while (i < span.end) {
      const c = s[i];
      if (c === '"' || c === "'") {
        const close = Math.min(this.endOfString(i, c), span.end);
        out.push(s.slice(i + 1, close - 1));
        i = close;
        continue;
      }
      const skipped = this.skipAtomic(i, false);
      i = skipped > i ? Math.min(skipped, span.end) : i + 1;
    }
    return out;
  }

  /** Offset just past the string or comment starting at `i`, else -1. */
  private skipAtomic(i: number, backtickIsString: boolean): number {
    const s = this.source;
    const c = s[i];
    const next = s[i + 1];
    if ((c === '-' && next === '-') || (c === '/' && next === '/')) {
      const nl = s.indexOf('\n', i);
      return nl < 0 ? s.length : nl;
    }
    if (c === '/' && next === '*') {
      const close = s.indexOf('*/', i + 2);
      return close < 0 ? s.length : close + 2;
    }
    if (c === '"' || c === "'" || (c === '`' && backtickIsString)) return this.endOfString(i, c);
    return -1;
  }

  /**
   * Offset just past the string opened at `i`. Both escape conventions in play
   * here are handled: a JS backslash and SQL's doubled quote. An unterminated
   * quote ends at the newline rather than swallowing the rest of the file.
   */
  private endOfString(i: number, quote: string): number {
    const s = this.source;
    for (let j = i + 1; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') {
        j++;
        continue;
      }
      if (c === quote) {
        if (s[j + 1] === quote) {
          j++;
          continue;
        }
        return j + 1;
      }
      if (c === '\n' && quote !== '`') return j;
    }
    return s.length;
  }

  /** Offset just past the `}` closing the `{` at `open`. */
  private matchBrace(open: number, end: number): number {
    return this.matchDelimiter(open, end, '{', '}');
  }

  /** Offset just past the `)` closing the `(` at `open`. */
  private matchParen(open: number, end: number): number {
    return this.matchDelimiter(open, end, '(', ')');
  }

  private matchDelimiter(open: number, end: number, opener: string, closer: string): number {
    const s = this.source;
    let depth = 0;
    let i = open;
    while (i < end) {
      const skipped = this.skipAtomic(i, true);
      if (skipped > i) {
        i = Math.min(skipped, end);
        continue;
      }
      const c = s[i];
      if (c === opener) depth++;
      else if (c === closer) {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return end;
  }

  private computeLineStarts(): void {
    this.lineStarts = [0];
    for (let i = 0; i < this.source.length; i++) {
      if (this.source.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  private getLineNumber(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}
