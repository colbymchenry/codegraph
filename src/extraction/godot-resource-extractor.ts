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
  private extResources = new Map<string, string>();
  private nodesByScenePath = new Map<string, Node>();
  private rootNode: Node | null = null;

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
    let currentOwner: Node | null = null;

    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i] ?? '';
      const lineNumber = i + 1;
      const section = line.match(/^\[([A-Za-z_]+)([^\]]*)\]/);
      if (!section) {
        if (currentOwner) this.extractSectionProperty(currentOwner, line, lineNumber);
        continue;
      }

      const type = section[1]!;
      const attrs = this.parseAttributes(section[2] ?? '');
      if (type === 'node') {
        const name = attrs.get('name') || '<unnamed_node>';
        const nodeType = attrs.get('type');
        const scenePath = this.scenePathForNode(name, attrs.get('parent'));
        const node = this.createNode('component', name, `${this.filePath}::node:${scenePath}`, lineNumber, 0, line.length);
        node.signature = nodeType ? `[node name="${name}" type="${nodeType}"]` : line.trim();
        if (!attrs.has('parent') && !this.rootNode) this.rootNode = node;
        this.nodesByScenePath.set(scenePath, node);
        this.addNodeContainment(fileNodeId, node, attrs.get('parent'));
        currentOwner = node;
      } else if (type === 'ext_resource') {
        const resourcePath = attrs.get('path');
        const id = attrs.get('id');
        if (!resourcePath) continue;
        if (id) this.extResources.set(id, resourcePath);
        const node = this.createNode('import', resourcePath, `${this.filePath}::ext_resource:${resourcePath}`, lineNumber, 0, line.length);
        node.signature = line.trim();
        this.addContains(fileNodeId, node.id);
        this.addReference(fileNodeId, resourcePath, 'references', lineNumber, line.indexOf(resourcePath));
        currentOwner = null;
      } else if (type === 'sub_resource') {
        const id = attrs.get('id') || `line:${lineNumber}`;
        const resourceType = attrs.get('type') || 'sub_resource';
        const node = this.createNode('component', id, `${this.filePath}::sub_resource:${id}`, lineNumber, 0, line.length);
        node.signature = `[sub_resource type="${resourceType}" id="${id}"]`;
        this.addContains(fileNodeId, node.id);
        currentOwner = node;
      } else if (type === 'resource') {
        const node = this.createNode('component', 'resource', `${this.filePath}::resource`, lineNumber, 0, line.length);
        node.signature = line.trim();
        this.addContains(fileNodeId, node.id);
        currentOwner = node;
      } else if (type === 'gd_resource') {
        const scriptClass = attrs.get('script_class');
        if (scriptClass) {
          this.addReference(fileNodeId, scriptClass, 'references', lineNumber, line.indexOf(scriptClass));
        }
        currentOwner = null;
      } else if (type === 'connection') {
        this.extractConnection(fileNodeId, attrs, line, lineNumber);
        currentOwner = null;
      } else {
        currentOwner = null;
      }
    }

    this.extractInlineResourcePaths(fileNodeId);
  }

  private extractSectionProperty(owner: Node, line: string, lineNumber: number): void {
    const scriptMatch = line.match(/^\s*script\s*=\s*ExtResource\("([^"]+)"\)/);
    if (scriptMatch) {
      const resourcePath = this.extResources.get(scriptMatch[1]!);
      if (resourcePath) {
        this.addReference(owner.id, resourcePath, 'references', lineNumber, line.indexOf('ExtResource'));
      }
      return;
    }

    const idMatch = line.match(/^\s*(id|content_id|card_id|relic_id|enemy_id|event_id|status_id|encounter_id|pool_id)\s*=\s*&?"([^"]+)"/);
    if (!idMatch) return;

    const value = idMatch[2]!;
    const node = this.createNode('constant', value, `${this.filePath}::${idMatch[1]}:${value}`, lineNumber, line.indexOf(value), line.length);
    node.signature = line.trim();
    this.addContains(owner.id, node.id);
  }

  private extractConnection(fileNodeId: string, attrs: Map<string, string>, line: string, lineNumber: number): void {
    const method = attrs.get('method');
    if (!method) return;

    const fromNode = this.resolveSceneNode(attrs.get('from') || '.');
    const toNode = this.resolveSceneNode(attrs.get('to') || '.');
    const ownerId = fromNode?.id ?? fileNodeId;
    this.addReference(ownerId, method, 'calls', lineNumber, line.indexOf(method));

    if (toNode) {
      this.edges.push({
        source: ownerId,
        target: toNode.id,
        kind: 'references',
        line: lineNumber,
        column: line.indexOf('to='),
        provenance: 'heuristic',
        metadata: {
          signal: attrs.get('signal'),
          method,
        },
      });
    }
  }

  private addNodeContainment(fileNodeId: string, node: Node, parent: string | undefined): void {
    if (!parent) {
      this.addContains(fileNodeId, node.id);
      return;
    }

    const parentPath = this.normalizeScenePath(parent || '.');
    const parentNode = parentPath === '.' ? this.rootNode : this.nodesByScenePath.get(parentPath);
    this.addContains(parentNode?.id ?? fileNodeId, node.id);
  }

  private scenePathForNode(name: string, parent: string | undefined): string {
    if (!parent) return name;

    const parentPath = this.normalizeScenePath(parent || '.');
    if (parentPath === '.') return this.rootNode ? `${this.rootNode.name}/${name}` : name;
    return `${parentPath}/${name}`;
  }

  private normalizeScenePath(scenePath: string): string {
    if (!scenePath || scenePath === '.') return '.';
    return scenePath.replace(/^\.\//, '');
  }

  private resolveSceneNode(scenePath: string): Node | null {
    const normalized = this.normalizeScenePath(scenePath);
    if (normalized === '.') return this.rootNode;

    const direct = this.nodesByScenePath.get(normalized);
    if (direct) return direct;

    if (this.rootNode) {
      return this.nodesByScenePath.get(`${this.rootNode.name}/${normalized}`) ?? null;
    }

    return null;
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
