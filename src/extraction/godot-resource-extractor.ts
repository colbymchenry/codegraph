import * as path from 'path';
import { Edge, ExtractionError, ExtractionResult, Node, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * Lightweight extractor for Godot text resources (.tscn, .tres, project.godot).
 */
export class GodotResourceExtractor {
  private filePath: string;
  private source: string;
  private lines: string[];
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private referenceKeys = new Set<string>();
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
      this.extractSections(fileNode.id);
    } catch (error) {
      this.errors.push({
        message: `Godot resource extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
      language: 'godot_resource',
      startLine: 1,
      endLine: this.lines.length,
      startColumn: 0,
      endColumn: this.lines[this.lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  private extractSections(fileNodeId: string): void {
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i] ?? '';
      const lineNumber = i + 1;
      const section = line.match(/^\[([A-Za-z_]+)([^\]]*)\]/);
      if (!section) continue;

      const type = section[1]!;
      const attrs = this.parseAttributes(section[2] ?? '');
      if (type === 'node') {
        const name = attrs.get('name') || '<unnamed_node>';
        const nodeType = attrs.get('type');
        const node = this.createNode('component', name, `${this.filePath}::node:${name}`, lineNumber, 0, line.length);
        node.signature = nodeType ? `[node name="${name}" type="${nodeType}"]` : line.trim();
        this.addContains(fileNodeId, node.id);
      } else if (type === 'ext_resource') {
        const resourcePath = attrs.get('path');
        if (!resourcePath) continue;
        const node = this.createNode('import', resourcePath, `${this.filePath}::ext_resource:${resourcePath}`, lineNumber, 0, line.length);
        node.signature = line.trim();
        this.addContains(fileNodeId, node.id);
        this.addReference(fileNodeId, resourcePath, 'references', lineNumber, line.indexOf(resourcePath));
      } else if (type === 'sub_resource') {
        const id = attrs.get('id') || `line:${lineNumber}`;
        const resourceType = attrs.get('type') || 'sub_resource';
        const node = this.createNode('component', id, `${this.filePath}::sub_resource:${id}`, lineNumber, 0, line.length);
        node.signature = `[sub_resource type="${resourceType}" id="${id}"]`;
        this.addContains(fileNodeId, node.id);
      }
    }

    this.extractInlineResourcePaths(fileNodeId);
  }

  private extractInlineResourcePaths(fileNodeId: string): void {
    const pathRegex = /["'](res:\/\/[^"']+)["']/g;
    let match;
    while ((match = pathRegex.exec(this.source)) !== null) {
      const resourcePath = match[1];
      if (!resourcePath) continue;
      const line = this.getLineNumber(match.index);
      this.addReference(fileNodeId, resourcePath, 'references', line, match.index - this.getLineStart(line));
    }
  }

  private parseAttributes(text: string): Map<string, string> {
    const attrs = new Map<string, string>();
    const attrRegex = /([A-Za-z_]\w*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
    let match;
    while ((match = attrRegex.exec(text)) !== null) {
      attrs.set(match[1]!, match[2] ?? match[3] ?? match[4] ?? '');
    }
    return attrs;
  }

  private createNode(kind: Node['kind'], name: string, qualifiedName: string, line: number, startColumn: number, endColumn: number): Node {
    const node: Node = {
      id: generateNodeId(this.filePath, kind, name, line),
      kind,
      name,
      qualifiedName,
      filePath: this.filePath,
      language: 'godot_resource',
      startLine: line,
      endLine: line,
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
    const key = `${fromNodeId}:${referenceKind}:${referenceName}`;
    if (this.referenceKeys.has(key)) return;
    this.referenceKeys.add(key);

    this.unresolvedReferences.push({
      fromNodeId,
      referenceName,
      referenceKind,
      line,
      column,
      filePath: this.filePath,
      language: 'godot_resource',
    });
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
}
