import * as path from 'path';
import { Edge, ExtractionError, ExtractionResult, Node, NodeKind, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

interface Scope {
  id: string;
  indent: number;
  kind: NodeKind;
}

interface FunctionScope extends Scope {
  startLine: number;
}

const KEYWORDS = new Set([
  'if',
  'elif',
  'for',
  'while',
  'match',
  'return',
  'await',
  'assert',
  'print',
  'push_error',
  'push_warning',
  'preload',
  'load',
  'super',
]);

const ANNOTATION_PREFIX = '(?:(?:@\\w+(?:\\([^)]*\\))?)\\s+)*';

/**
 * Lightweight GDScript extractor.
 *
 * This intentionally avoids a hard dependency on a GDScript WASM grammar while
 * still giving Godot projects useful symbol search and reference edges.
 */
export class GDScriptExtractor {
  private filePath: string;
  private source: string;
  private lines: string[];
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
    this.lines = source.split('\n');
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const fileNode = this.createFileNode();
      const scriptClass = this.extractScriptClass(fileNode) ?? this.extractImplicitScriptClass(fileNode);
      this.extractDeclarations(fileNode, scriptClass);
      this.extractReferences(fileNode, scriptClass);
    } catch (error) {
      this.errors.push({
        message: `GDScript extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  private createFileNode(): Node {
    const node: Node = {
      id: `file:${this.filePath}`,
      kind: 'file',
      name: path.basename(this.filePath),
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'gdscript',
      startLine: 1,
      endLine: this.lines.length,
      startColumn: 0,
      endColumn: this.lines[this.lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  private extractScriptClass(fileNode: Node): Node | null {
    const classNameMatch = this.source.match(new RegExp(`^\\s*${ANNOTATION_PREFIX}class_name\\s+([A-Za-z_]\\w*)`, 'm'));
    if (!classNameMatch) return null;

    const index = classNameMatch.index ?? 0;
    const line = this.getLineNumber(index);
    const column = index - this.getLineStart(line) + classNameMatch[0].indexOf(classNameMatch[1]!);
    const name = classNameMatch[1]!;
    const node = this.createNode('class', name, `${this.filePath}::${name}`, line, column, line, column + classNameMatch[0].trimEnd().length);
    this.addContains(fileNode.id, node.id);
    return node;
  }

  private extractImplicitScriptClass(fileNode: Node): Node | null {
    const extendsMatch = this.source.match(new RegExp(`^\\s*${ANNOTATION_PREFIX}extends\\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\\w.]*))`, 'm'));
    if (!extendsMatch) return null;

    const index = extendsMatch.index ?? 0;
    const line = this.getLineNumber(index);
    const name = this.scriptClassNameFromPath();
    const column = index - this.getLineStart(line);
    const node = this.createNode('class', name, `${this.filePath}::${name}`, line, column, line, column + (this.lines[line - 1]?.trimEnd().length ?? 0));
    node.signature = `implicit script class extends ${extendsMatch[1] || extendsMatch[2] || extendsMatch[3]}`;
    this.addContains(fileNode.id, node.id);
    return node;
  }

  private extractDeclarations(fileNode: Node, scriptClass: Node | null): void {
    const scopes: Scope[] = [{ id: scriptClass?.id ?? fileNode.id, indent: -1, kind: scriptClass ? 'class' : 'file' }];

    for (let i = 0; i < this.lines.length; i++) {
      const lineNumber = i + 1;
      const rawLine = this.lines[i] ?? '';
      const code = this.stripComment(rawLine);
      if (!code.trim()) continue;

      const indent = this.indentOf(rawLine);
      while (scopes.length > 1 && indent <= scopes[scopes.length - 1]!.indent) {
        scopes.pop();
      }

      const trimmed = code.trim();
      if (new RegExp(`^${ANNOTATION_PREFIX}class_name\\s+`).test(trimmed)) continue;

      const classMatch = trimmed.match(new RegExp(`^${ANNOTATION_PREFIX}class\\s+([A-Za-z_]\\w*)\\s*(?:extends\\s+[^:]+)?\\s*:?`));
      if (classMatch) {
        const node = this.createDeclarationNode('class', classMatch[1]!, rawLine, lineNumber, indent);
        this.addContains(scopes[scopes.length - 1]!.id, node.id);
        scopes.push({ id: node.id, indent, kind: 'class' });
        continue;
      }

      const enumMatch = trimmed.match(/^enum(?:\s+([A-Za-z_]\w*))?/);
      if (enumMatch) {
        const name = enumMatch[1] || '<anonymous_enum>';
        const node = this.createDeclarationNode('enum', name, rawLine, lineNumber, indent);
        this.addContains(scopes[scopes.length - 1]!.id, node.id);
        continue;
      }

      const signalMatch = trimmed.match(/^signal\s+([A-Za-z_]\w*)/);
      if (signalMatch) {
        const node = this.createDeclarationNode('function', signalMatch[1]!, rawLine, lineNumber, indent);
        node.signature = trimmed;
        this.addContains(scopes[scopes.length - 1]!.id, node.id);
        continue;
      }

      const funcMatch = trimmed.match(new RegExp(`^${ANNOTATION_PREFIX}(?:static\\s+)?func\\s+([A-Za-z_]\\w*)\\s*(\\([^)]*\\))?(?:\\s*->\\s*([^:]+))?`));
      if (funcMatch) {
        const insideClass = scopes.some((scope) => scope.kind === 'class');
        const node = this.createDeclarationNode(insideClass ? 'method' : 'function', funcMatch[1]!, rawLine, lineNumber, indent);
        node.signature = `${funcMatch[2] || '()'}${funcMatch[3] ? ` -> ${funcMatch[3].trim()}` : ''}`;
        node.isStatic = /\bstatic\s+func\b/.test(trimmed);
        this.addContains(scopes[scopes.length - 1]!.id, node.id);
        scopes.push({ id: node.id, indent, kind: node.kind });
        continue;
      }

      const varMatch = trimmed.match(new RegExp(`^${ANNOTATION_PREFIX}(?:static\\s+)?(var|const)\\s+([A-Za-z_]\\w*)`));
      if (varMatch) {
        const kind: NodeKind = varMatch[1] === 'const' ? 'constant' : 'variable';
        const node = this.createDeclarationNode(kind, varMatch[2]!, rawLine, lineNumber, indent);
        node.signature = trimmed;
        this.addContains(scopes[scopes.length - 1]!.id, node.id);
      }
    }
  }

  private extractReferences(fileNode: Node, scriptClass: Node | null): void {
    const functionScopes = this.nodes
      .filter((node) => (node.kind === 'function' || node.kind === 'method') && node.language === 'gdscript')
      .map((node) => ({ id: node.id, indent: this.indentOf(this.lines[node.startLine - 1] ?? ''), kind: node.kind, startLine: node.startLine } as FunctionScope))
      .sort((a, b) => a.startLine - b.startLine);

    const ownerForLine = (line: number, indent: number): string => {
      let owner = scriptClass?.id ?? fileNode.id;
      for (const scope of functionScopes) {
        if (scope.startLine < line && scope.indent < indent) {
          owner = scope.id;
        }
      }
      return owner;
    };

    for (let i = 0; i < this.lines.length; i++) {
      const lineNumber = i + 1;
      const rawLine = this.lines[i] ?? '';
      const code = this.stripComment(rawLine);
      const indent = this.indentOf(rawLine);
      const owner = ownerForLine(lineNumber, indent);

      const extendsMatch = code.match(new RegExp(`^\\s*${ANNOTATION_PREFIX}(?:(?:class_name|class)\\s+[A-Za-z_]\\w*\\s+)?extends\\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\\w.]*))`));
      if (extendsMatch) {
        this.addReference(owner, extendsMatch[1] || extendsMatch[2] || extendsMatch[3]!, 'extends', lineNumber, code.indexOf('extends'));
      }

      const resourceRegex = /\b(?:preload|load)\s*\(\s*["']([^"']+)["']\s*\)/g;
      let resourceMatch;
      while ((resourceMatch = resourceRegex.exec(code)) !== null) {
        this.addReference(owner, resourceMatch[1]!, 'references', lineNumber, resourceMatch.index);
      }

      const callRegex = /\b([A-Za-z_]\w*)\s*\(/g;
      let callMatch;
      while ((callMatch = callRegex.exec(code)) !== null) {
        const name = callMatch[1]!;
        const prefix = code.slice(Math.max(0, callMatch.index - 8), callMatch.index);
        if (KEYWORDS.has(name) || /\bfunc\s+$/.test(prefix) || /\bsignal\s+$/.test(prefix)) continue;
        this.addReference(owner, name, 'calls', lineNumber, callMatch.index);
      }
    }
  }

  private createDeclarationNode(kind: NodeKind, name: string, rawLine: string, line: number, indent: number): Node {
    const column = rawLine.indexOf(name);
    return this.createNode(kind, name, `${this.filePath}::${name}`, line, column < 0 ? indent : column, line, rawLine.length);
  }

  private createNode(kind: NodeKind, name: string, qualifiedName: string, startLine: number, startColumn: number, endLine: number, endColumn: number): Node {
    const node: Node = {
      id: generateNodeId(this.filePath, kind, name, startLine),
      kind,
      name,
      qualifiedName,
      filePath: this.filePath,
      language: 'gdscript',
      startLine,
      endLine,
      startColumn,
      endColumn,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  private addContains(source: string, target: string): void {
    this.edges.push({ source, target, kind: 'contains' });
  }

  private addReference(fromNodeId: string, referenceName: string, referenceKind: UnresolvedReference['referenceKind'], line: number, column: number): void {
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName,
      referenceKind,
      line,
      column,
      filePath: this.filePath,
      language: 'gdscript',
    });
  }

  private indentOf(line: string): number {
    let indent = 0;
    for (const char of line) {
      if (char === ' ') indent += 1;
      else if (char === '\t') indent += 4;
      else break;
    }
    return indent;
  }

  private stripComment(line: string): string {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const prev = line[i - 1];
      if (char === "'" && !inDouble && prev !== '\\') inSingle = !inSingle;
      if (char === '"' && !inSingle && prev !== '\\') inDouble = !inDouble;
      if (char === '#' && !inSingle && !inDouble) return line.slice(0, i);
    }
    return line;
  }

  private getLineNumber(index: number): number {
    return this.source.substring(0, index).split('\n').length;
  }

  private getLineStart(line: number): number {
    let pos = 0;
    for (let i = 1; i < line; i++) {
      pos += (this.lines[i - 1]?.length ?? 0) + 1;
    }
    return pos;
  }

  private scriptClassNameFromPath(): string {
    const base = path.basename(this.filePath, path.extname(this.filePath));
    const words = base.split(/[^A-Za-z0-9]+/).filter(Boolean);
    const pascal = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
    return pascal || path.basename(this.filePath);
  }
}
