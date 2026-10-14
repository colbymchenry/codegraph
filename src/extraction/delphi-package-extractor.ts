import * as path from 'path';
import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { NodeIdAllocator } from './tree-sitter-helpers';

type Clause = 'requires' | 'contains';

interface Token {
  kind: 'name' | 'string' | 'punct' | 'eof';
  text: string;
  value: string;
  offset: number;
  line: number;
  column: number;
  endColumn: number;
  afterDirective: boolean;
}

class PackageSyntaxError extends Error {
  constructor(message: string, readonly line: number, readonly column: number) {
    super(message);
  }
}

const NAME_START = /[\p{L}_&]/u;
const NAME_PART = /[\p{L}\p{N}_$]/u;
const RESERVED: Record<string, true> = { package: true, requires: true, contains: true, end: true, in: true };

const CONDITIONAL_DIRECTIVE = /^\$(?:if|ifdef|ifndef|ifopt|else|elseif|endif|ifend)(?![\p{L}\p{N}_])/iu;

class Lexer {
  private pos: number;
  private line = 1;
  private lineStart: number;

  constructor(private readonly source: string) {
    this.pos = source.charCodeAt(0) === 0xfeff ? 1 : 0;
    this.lineStart = this.pos;
  }

  next(): Token {
    let afterDirective = false;
    for (;;) {
      const c = this.source[this.pos];
      if (c === undefined) break;
      if (c === '\n') {
        this.line++;
        this.pos++;
        this.lineStart = this.pos;
      } else if (/\s/.test(c)) {
        this.pos++;
      } else if (c === '/' && this.source[this.pos + 1] === '/') {
        while (this.pos < this.source.length && this.source[this.pos] !== '\n') this.pos++;
      } else if (c === '{') {
        afterDirective ||= CONDITIONAL_DIRECTIVE.test(this.source.slice(this.pos + 1, this.pos + 15));
        this.skipBlockComment('}', 1);
      } else if (c === '(' && this.source[this.pos + 1] === '*') {
        afterDirective ||= CONDITIONAL_DIRECTIVE.test(this.source.slice(this.pos + 2, this.pos + 16));
        this.skipBlockComment('*)', 2);
      } else {
        break;
      }
    }
    return this.token(afterDirective);
  }

  private skipBlockComment(close: string, openLength: number): void {
    const line = this.line;
    const column = this.pos - this.lineStart;
    const end = this.source.indexOf(close, this.pos + openLength);
    if (end < 0) throw new PackageSyntaxError('unterminated comment', line, column);
    this.advanceTo(end + close.length);
  }

  private advanceTo(target: number): void {
    for (let i = this.pos; i < target; i++) {
      if (this.source[i] === '\n') {
        this.line++;
        this.lineStart = i + 1;
      }
    }
    this.pos = target;
  }

  private token(afterDirective: boolean): Token {
    const source = this.source;
    const offset = this.pos;
    const line = this.line;
    const column = offset - this.lineStart;
    const make = (kind: Token['kind'], end: number, value: string): Token => {
      const text = source.slice(offset, end);
      this.pos = end;
      return { kind, text, value, offset, line, column, endColumn: column + text.length, afterDirective };
    };
    const c = source[offset];
    if (c === undefined) return make('eof', offset, '');
    if (c === "'") {
      let end = offset + 1;
      let value = '';
      for (;;) {
        const ch = source[end];
        if (ch === undefined || ch === '\n' || ch === '\r') {
          throw new PackageSyntaxError('unterminated string', line, column);
        }
        end++;
        if (ch !== "'") {
          value += ch;
        } else if (source[end] === "'") {
          value += "'";
          end++;
        } else {
          break;
        }
      }
      return make('string', end, value);
    }
    if (NAME_START.test(c)) {
      let end = offset + 1;
      for (;;) {
        while (end < source.length && NAME_PART.test(source[end]!)) end++;
        if (source[end] === '.' && end + 1 < source.length && NAME_START.test(source[end + 1]!)) {
          end++;
        } else {
          break;
        }
      }
      const text = source.slice(offset, end);
      return make('name', end, text.replace(/(^|\.)&/g, '$1'));
    }
    if (c === ',' || c === ';' || c === '.') return make('punct', offset + 1, c);
    throw new PackageSyntaxError(`unexpected character '${c}'`, line, column);
  }
}

/**
 * Extractor for Delphi package sources (.dpk). The bundled Pascal grammar has
 * no `package` production, so the header, `requires` and `contains` clauses
 * are read by a dedicated scanner that follows the same module/import
 * conventions as `unit` and `uses`.
 */
export class DelphiPackageExtractor {
  private readonly nodes: Node[] = [];
  private readonly edges: Edge[] = [];
  private readonly unresolvedReferences: UnresolvedReference[] = [];
  private readonly errors: ExtractionError[] = [];
  private readonly nodeIds = new NodeIdAllocator();
  private readonly seen = new Set<string>();
  private lexer: Lexer;
  private lookahead: Token | null = null;
  private fileNode!: Node;
  private moduleNode: Node | null = null;
  private lastEnd = { line: 1, column: 0 };

  constructor(private readonly filePath: string, private readonly source: string) {
    this.lexer = new Lexer(source);
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    this.createFileNode();
    try {
      this.parsePackage();
    } catch (error) {
      if (!(error instanceof PackageSyntaxError)) throw error;
      this.errors.push({
        message: `Delphi package syntax error: ${error.message}`,
        filePath: this.filePath,
        line: error.line,
        column: error.column,
        severity: 'error',
        code: 'parse_error',
      });
    }
    if (this.moduleNode) {
      this.moduleNode.endLine = this.lastEnd.line;
      this.moduleNode.endColumn = this.lastEnd.column;
    }
    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  private createFileNode(): void {
    this.fileNode = {
      id: `file:${this.filePath}`,
      kind: 'file',
      name: path.basename(this.filePath),
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'pascal',
      startLine: 1,
      endLine: this.source.split('\n').length,
      startColumn: 0,
      endColumn: 0,
      isExported: false,
      updatedAt: Date.now(),
    };
    this.nodes.push(this.fileNode);
  }

  private peek(): Token {
    this.lookahead ??= this.lexer.next();
    return this.lookahead;
  }

  private take(): Token {
    const token = this.peek();
    this.lookahead = null;
    this.lastEnd = { line: token.line, column: token.endColumn };
    return token;
  }

  private isKeyword(token: Token, keyword: string): boolean {
    return token.kind === 'name' && token.text.toLowerCase() === keyword;
  }

  private isClauseKeyword(token: Token): Clause | null {
    if (this.isKeyword(token, 'requires')) return 'requires';
    if (this.isKeyword(token, 'contains')) return 'contains';
    return null;
  }

  private fail(token: Token, expected: string): never {
    const found = token.kind === 'eof' ? 'end of file' : `'${token.text}'`;
    throw new PackageSyntaxError(`expected ${expected}, found ${found}`, token.line, token.column);
  }

  private expectPunct(value: string): Token {
    const token = this.peek();
    if (token.kind !== 'punct' || token.value !== value) this.fail(token, `'${value}'`);
    return this.take();
  }

  private parsePackage(): void {
    const head = this.peek();
    if (!this.isKeyword(head, 'package')) this.fail(head, "'package'");
    this.take();

    const nameToken = this.peek();
    let name: string;
    if (nameToken.kind === 'name' && RESERVED[nameToken.text.toLowerCase()] !== true) {
      name = nameToken.value;
      this.take();
    } else {
      name = path.basename(this.filePath).replace(/\.[^.]+$/, '');
      this.module(name, head);
      this.fail(nameToken, 'a package name');
    }
    this.module(name, head);
    this.expectPunct(';');

    for (;;) {
      const token = this.peek();
      const clause = this.isClauseKeyword(token);
      if (clause) {
        this.take();
        this.parseList(clause);
      } else if (this.isKeyword(token, 'end')) {
        this.take();
        this.expectPunct('.');
        const trailing = this.peek();
        if (trailing.kind !== 'eof') this.fail(trailing, 'end of file');
        return;
      } else {
        this.fail(token, "'requires', 'contains' or 'end'");
      }
    }
  }

  private module(name: string, head: Token): void {
    if (this.moduleNode) return;
    const id = this.nodeIds.generate(this.filePath, 'module', name, head.line, head.column);
    this.moduleNode = {
      id,
      kind: 'module',
      name,
      qualifiedName: name,
      filePath: this.filePath,
      language: 'pascal',
      startLine: head.line,
      endLine: head.line,
      startColumn: head.column,
      endColumn: head.endColumn,
      updatedAt: Date.now(),
    };
    this.nodes.push(this.moduleNode);
    this.edges.push({ source: this.fileNode.id, target: id, kind: 'contains' });
  }

  private parseList(initial: Clause): void {
    let clause = initial;
    for (;;) {
      const first = this.peek();
      if (first.kind !== 'name' || RESERVED[first.text.toLowerCase()] === true) {
        this.fail(first, 'a unit name');
      }
      this.take();
      let signature = `${clause} ${first.text}`;
      if (clause === 'contains' && this.isKeyword(this.peek(), 'in')) {
        this.take();
        const file = this.peek();
        if (file.kind !== 'string') this.fail(file, 'a quoted file path');
        this.take();
        signature += ` in ${file.text}`;
      }
      this.addImport(clause, first, signature);

      const separator = this.peek();
      if (separator.kind === 'punct' && separator.value === ',') {
        this.take();
        const following = this.peek();
        const switched = this.isClauseKeyword(following);
        if (switched && following.afterDirective) {
          this.take();
          clause = switched;
        }
      } else if (separator.kind === 'punct' && separator.value === ';') {
        this.take();
        return;
      } else {
        this.fail(separator, "',' or ';'");
      }
    }
  }

  private addImport(clause: Clause, token: Token, signature: string): void {
    const key = `${clause}:${token.value.toLowerCase()}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const owner = this.fileNode;
    const id = this.nodeIds.generate(this.filePath, 'import', token.value, token.line, token.column);
    this.nodes.push({
      id,
      kind: 'import',
      name: token.value,
      qualifiedName: token.value,
      filePath: this.filePath,
      language: 'pascal',
      startLine: token.line,
      endLine: token.line,
      startColumn: token.column,
      endColumn: token.endColumn,
      signature,
      updatedAt: Date.now(),
    });
    this.edges.push({ source: owner.id, target: id, kind: 'contains' });
    this.unresolvedReferences.push({
      fromNodeId: owner.id,
      referenceName: token.value,
      referenceKind: 'imports',
      line: token.line,
      column: token.column,
    });
  }
}
