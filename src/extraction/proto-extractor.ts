import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, NodeKind } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * ProtoExtractor — Protocol Buffers (`.proto`) IDL.
 *
 * A `.proto` file is a CONTRACT: one field definition is implemented three or
 * more times over, once per generated language, and every one of those sites is
 * machine-written and must never be hand-edited. That makes the `.proto` the
 * highest-value file per byte in a polyglot repository and the natural anchor
 * for "what else moves when this changes" — but only if a field is a symbol the
 * graph can answer questions about.
 *
 * Written as a standalone scanner rather than a vendored tree-sitter grammar,
 * following the same precedent as the Liquid / Razor / MyBatis extractors. The
 * protobuf IDL is tiny and effectively frozen (proto2 and proto3 are published,
 * stable specs), so the usual reason to want a grammar — keeping up with an
 * evolving syntax surface — does not apply; and every vendored `.wasm` is a
 * megabyte of shipped binary plus an ABI obligation, whose silent absence is
 * itself a failure mode worth not multiplying.
 *
 * Two properties are modelled deliberately, because they are where protobuf's
 * real defects live and neither is expressible without them:
 *
 *   - THE TAG NUMBER IS PART OF A FIELD'S IDENTITY. Renaming a field while
 *     keeping its tag is wire-compatible; changing its TYPE (or its meaning)
 *     while keeping tag and name is a silent mis-decode that every
 *     single-language check passes. Both the declaration text and the tag are
 *     recorded, so the difference is expressible.
 *   - `reserved` IS SEMANTIC. A retired field number must never be re-used, and
 *     a reader that touches a reserved field is a defect. Reservations are kept
 *     as nodes rather than discarded as syntax, so that check can be written.
 */

/** Built-in scalar types — never a reference to another declaration. */
const SCALAR_TYPES = new Set([
  'double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64',
  'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes',
]);

/** Statement keywords that carry no graph structure of their own. */
const IGNORED_STATEMENTS = new Set(['syntax', 'option', 'extensions', 'edition']);

interface Scope {
  /** Dotted protobuf name of this scope, e.g. `pkg.Outer.Inner`. */
  qualified: string;
  /** What opened it — decides how child statements are read. */
  kind: 'message' | 'enum' | 'service' | 'oneof' | 'extend' | 'rpc' | 'unknown';
  /** Node id, so children attach by `contains`. */
  nodeId?: string;
}

export class ProtoExtractor {
  private filePath: string;
  private source: string;
  /** Comments blanked to spaces, newlines preserved — offsets and lines hold. */
  private code: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private packageName = '';
  private scopes: Scope[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
    this.code = blankProtoComments(source);
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    try {
      const fileNode = this.createFileNode();
      this.scopes = [{ qualified: '', kind: 'unknown', nodeId: fileNode.id }];
      this.scan();
    } catch (error) {
      this.errors.push({
        message: `Proto extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  // --- scanning -------------------------------------------------------------

  /**
   * Walk the comment-free source once, splitting it into the two things
   * protobuf is made of: block HEADERS (text before a `{`) and STATEMENTS (text
   * before a `;`). A brace-depth scope stack gives every declaration its
   * enclosing message/service, which is what makes the dotted names below the
   * real protobuf fully-qualified names.
   */
  private scan(): void {
    let buffer = '';
    let bufferStart = -1;
    for (let i = 0; i < this.code.length; i++) {
      const ch = this.code[i]!;
      if (ch === '{' || ch === '}' || ch === ';') {
        const text = buffer.trim();
        const line = bufferStart >= 0 ? this.lineAt(bufferStart) : this.lineAt(i);
        if (ch === '{') this.openBlock(text, line, i);
        else if (ch === ';') this.statement(text, line, i);
        else this.closeBlock();
        buffer = '';
        bufferStart = -1;
        continue;
      }
      if (buffer.length === 0 && /\s/.test(ch)) continue; // skip leading space
      if (buffer.length === 0) bufferStart = i;
      buffer += ch;
    }
  }

  private openBlock(header: string, line: number, index: number): void {
    const decl = /^(message|enum|service|oneof|extend)\s+([A-Za-z_][\w.]*)/.exec(header);
    if (decl) {
      const kind = decl[1] as Scope['kind'];
      const name = decl[2]!;
      const node = this.declare(kind, name, line, index, header);
      // A `oneof` groups fields that already belong to the enclosing message —
      // on the wire they ARE its fields. It must not contribute a level to
      // their qualified names, which have to stay the protobuf FQN a generator
      // (and the code generated from it) uses.
      const qualified = kind === 'oneof' ? this.currentScope().qualified : this.qualify(name);
      this.scopes.push({
        qualified,
        kind,
        nodeId: node?.id ?? this.currentScope().nodeId,
      });
      return;
    }
    // `rpc Get(Req) returns (Res) { option ...; }` — the braced rpc form.
    const rpc = parseRpc(header);
    if (rpc) {
      const node = this.declareRpc(rpc, line, index, header);
      this.scopes.push({ qualified: this.qualify(rpc.name), kind: 'rpc', nodeId: node?.id });
      return;
    }
    // Anything else with a body (an `option (x) = { ... }` block, a group):
    // push an opaque scope so brace depth stays correct and its contents are
    // not mistaken for fields of the enclosing message.
    this.scopes.push({ qualified: this.currentScope().qualified, kind: 'unknown' });
  }

  private closeBlock(): void {
    if (this.scopes.length > 1) this.scopes.pop();
  }

  private statement(text: string, line: number, index: number): void {
    if (!text) return;
    const keyword = /^([A-Za-z_]\w*)/.exec(text)?.[1] ?? '';
    if (IGNORED_STATEMENTS.has(keyword)) return;

    if (keyword === 'package') {
      const pkg = /^package\s+([\w.]+)$/.exec(text)?.[1];
      if (pkg) this.packageName = pkg;
      return;
    }
    if (keyword === 'import') {
      this.declareImport(text, line, index);
      return;
    }
    if (keyword === 'reserved') {
      this.declareReserved(text, line, index);
      return;
    }
    if (keyword === 'rpc') {
      const rpc = parseRpc(text);
      if (rpc) this.declareRpc(rpc, line, index, text);
      return;
    }

    const scope = this.currentScope();
    if (scope.kind === 'enum') {
      this.declareEnumValue(text, line, index);
      return;
    }
    if (scope.kind === 'message' || scope.kind === 'oneof' || scope.kind === 'extend') {
      this.declareField(text, line, index);
    }
  }

  // --- declarations ---------------------------------------------------------

  private declare(
    kind: Scope['kind'],
    name: string,
    line: number,
    index: number,
    header: string
  ): Node | null {
    // A `oneof` is a grouping construct, not a type: its fields belong to the
    // enclosing message and its own name would only add a phantom level to
    // their qualified names, which must stay the wire-level protobuf FQN.
    if (kind === 'oneof') return null;
    const nodeKind: NodeKind =
      kind === 'enum' ? 'enum' : kind === 'service' ? 'interface' : 'struct';
    return this.push(nodeKind, name, line, index, {
      signature: collapse(header),
      docstring: this.docFor(index),
      isExported: true,
    });
  }

  private declareRpc(
    rpc: { name: string; input: string; output: string; streamIn: boolean; streamOut: boolean },
    line: number,
    index: number,
    header: string
  ): Node | null {
    const node = this.push('method', rpc.name, line, index, {
      signature: collapse(header).replace(/\s*\{$/, ''),
      docstring: this.docFor(index),
      isExported: true,
      returnType: rpc.output,
    });
    // The request and response messages are this method's real dependencies —
    // the edge that makes "what does changing this message break" answerable.
    for (const type of [rpc.input, rpc.output]) {
      this.reference(node?.id, type, line, index);
    }
    return node;
  }

  private declareField(text: string, line: number, index: number): void {
    const field = parseField(text);
    if (!field) return;
    const node = this.push('field', field.name, line, index, {
      signature: collapse(text),
      docstring: this.docFor(index),
      isExported: true,
      // The tag is part of the field's identity on the wire, so it is recorded
      // as a marker rather than left only in the signature prose: a check for
      // "same tag, changed type" has to be able to read it without re-parsing.
      decorators: [
        `tag=${field.tag}`,
        ...(field.label ? [field.label] : []),
        ...(this.currentScope().kind === 'oneof' ? ['oneof'] : []),
      ],
    });
    for (const type of typeReferences(field.type)) {
      this.reference(node?.id, type, line, index);
    }
  }

  private declareEnumValue(text: string, line: number, index: number): void {
    const m = /^([A-Za-z_]\w*)\s*=\s*(-?\d+)\b/.exec(text);
    if (!m) return;
    this.push('enum_member', m[1]!, line, index, {
      signature: collapse(text),
      docstring: this.docFor(index),
      isExported: true,
      decorators: [`number=${m[2]}`],
    });
  }

  /**
   * `reserved 2, 15, 9 to 11;` / `reserved "old_name";`
   *
   * Kept as a node so "was this number retired" and "is this name off-limits"
   * are answerable. Named after what it reserves so a lookup for the retired
   * name finds the reservation, with a `reserved` marker so it can never be
   * mistaken for a live field.
   */
  private declareReserved(text: string, line: number, index: number): void {
    const body = text.replace(/^reserved\s+/, '');
    const items: string[] = [];
    for (const m of body.matchAll(/"([^"]+)"|'([^']+)'/g)) items.push(m[1] ?? m[2]!);
    for (const m of body.matchAll(/(\d+)\s+to\s+(\d+|max)/gi)) items.push(`${m[1]} to ${m[2]}`);
    const ranged = body.replace(/(\d+)\s+to\s+(\d+|max)/gi, '');
    for (const m of ranged.matchAll(/\b(\d+)\b/g)) items.push(m[1]!);
    if (items.length === 0) return;
    for (const item of items) {
      this.push('constant', `reserved ${item}`, line, index, {
        signature: collapse(text),
        decorators: ['reserved'],
      });
    }
  }

  private declareImport(text: string, line: number, index: number): void {
    const target = /^import\s+(?:public\s+|weak\s+)?["']([^"']+)["']$/.exec(text)?.[1];
    if (!target) return;
    const node = this.push('import', target, line, index, { signature: collapse(text) });
    if (node) node.qualifiedName = target;
    const from = this.scopes[0]!.nodeId;
    if (!from) return;
    this.unresolvedReferences.push({
      fromNodeId: from,
      referenceName: target,
      referenceKind: 'imports',
      filePath: this.filePath,
      language: 'proto',
      line,
      column: 0,
    });
  }

  // --- helpers --------------------------------------------------------------

  private currentScope(): Scope {
    return this.scopes[this.scopes.length - 1]!;
  }

  /** The protobuf fully-qualified name of a member of the current scope. */
  private qualify(name: string): string {
    const parent = this.currentScope().qualified || this.packageName;
    return parent ? `${parent}.${name}` : name;
  }

  private push(kind: NodeKind, name: string, line: number, index: number, extra: Partial<Node>): Node | null {
    if (!name) return null;
    const qualifiedName = this.qualify(name);
    const node: Node = {
      id: generateNodeId(this.filePath, kind, qualifiedName, line),
      kind,
      name,
      qualifiedName,
      filePath: this.filePath,
      language: 'proto',
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
      ...extra,
    };
    this.nodes.push(node);
    const parentId = this.currentScope().nodeId;
    if (parentId) this.edges.push({ source: parentId, target: node.id, kind: 'contains' });
    void index;
    return node;
  }

  /** A dependency on another declaration (a field's type, an rpc's messages). */
  private reference(fromNodeId: string | undefined, typeName: string, line: number, index: number): void {
    if (!fromNodeId || !typeName || SCALAR_TYPES.has(typeName)) return;
    void index;
    this.unresolvedReferences.push({
      fromNodeId,
      // A leading dot is protobuf's "fully qualified from the root" marker;
      // an unqualified name resolves against the enclosing package.
      referenceName: typeName.replace(/^\./, ''),
      referenceKind: 'references',
      filePath: this.filePath,
      language: 'proto',
      line,
      column: 0,
    });
  }

  private lineAt(index: number): number {
    let line = 1;
    for (let i = 0; i < index && i < this.code.length; i++) {
      if (this.code[i] === '\n') line++;
    }
    return line;
  }

  /**
   * The `//` or `/* *\/` comment block immediately above a declaration, read
   * from the ORIGINAL source (the scanning copy has them blanked).
   */
  private docFor(index: number): string | undefined {
    const before = this.source.slice(0, index);
    const lines = before.split('\n');
    lines.pop(); // the declaration's own (partial) line
    const collected: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (line === '') { if (collected.length > 0) break; continue; }
      const lineComment = /^\/\/+\s?(.*)$/.exec(line);
      if (lineComment) { collected.unshift(lineComment[1]!); continue; }
      const single = /^\/\*+\s?([\s\S]*?)\s*\*+\/$/.exec(line);
      if (single) { collected.unshift(single[1]!); continue; }
      const starred = /^\*+\s?(.*)$/.exec(line);
      if (starred && collected.length > 0) { collected.unshift(starred[1]!); continue; }
      break;
    }
    const text = collected.join('\n').trim();
    return text || undefined;
  }

  private createFileNode(): Node {
    const node: Node = {
      id: `file:${this.filePath}`,
      kind: 'file',
      name: this.filePath.split('/').pop() ?? this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'proto',
      startLine: 1,
      endLine: this.source.split('\n').length,
      startColumn: 0,
      endColumn: 0,
      isExported: false,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }
}

// --- pure parsing helpers ---------------------------------------------------

/**
 * Replace comments with spaces, keeping every newline, so line numbers and
 * offsets in the blanked copy still match the original. String literals are
 * skipped so a `//` inside an option value is not mistaken for a comment.
 */
export function blankProtoComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i++;
      while (i < source.length) {
        const c = source[i]!;
        out += c;
        i++;
        if (c === '\\' && i < source.length) { out += source[i]!; i++; continue; }
        if (c === quote) break;
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < source.length) { out += '  '; i += 2; }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** `rpc Get(stream Req) returns (Res)` — both the `;` and `{` forms. */
export function parseRpc(text: string): {
  name: string; input: string; output: string; streamIn: boolean; streamOut: boolean;
} | null {
  const m = /^rpc\s+([A-Za-z_]\w*)\s*\(\s*(stream\s+)?([.\w]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([.\w]+)\s*\)/.exec(text);
  if (!m) return null;
  return {
    name: m[1]!,
    input: m[3]!,
    output: m[5]!,
    streamIn: !!m[2],
    streamOut: !!m[4],
  };
}

/**
 * `repeated Foo bar = 3 [deprecated = true]` — the label is optional, the type
 * may itself contain separators (`map<string, Foo>`, `.pkg.Foo`), and the tag
 * is what anchors the match.
 */
export function parseField(text: string): {
  label?: string; type: string; name: string; tag: number;
} | null {
  const m = /^(?:(repeated|optional|required)\s+)?(.+?)\s+([A-Za-z_]\w*)\s*=\s*(\d+)\b/.exec(text);
  if (!m) return null;
  const type = m[2]!.trim();
  if (!type) return null;
  return { label: m[1], type, name: m[3]!, tag: Number(m[4]) };
}

/** Declared types a field depends on — both halves of a `map<K, V>`. */
export function typeReferences(type: string): string[] {
  const map = /^map\s*<\s*([^,]+?)\s*,\s*(.+?)\s*>$/.exec(type);
  if (map) return [map[1]!, map[2]!].filter((t) => !SCALAR_TYPES.has(t));
  return SCALAR_TYPES.has(type) ? [] : [type];
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}
