import { Edge, ExtractionError, ExtractionResult, Node, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';

interface Section {
  name: string;
  content: string;
  startLine: number;
  markerLine: number;
}

export class GlslfxExtractor {
  private readonly nodes: Node[] = [];
  private readonly edges: Edge[] = [];
  private readonly unresolvedReferences: UnresolvedReference[] = [];
  private readonly errors: ExtractionError[] = [];
  private readonly fileNode: Node;

  constructor(private readonly filePath: string, private readonly source: string) {
    const lines = source.split('\n');
    this.fileNode = {
      id: `file:${filePath}`,
      kind: 'file',
      name: filePath.split(/[/\\]/).pop() || filePath,
      qualifiedName: filePath,
      filePath,
      language: 'glsl',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      updatedAt: Date.now(),
    };
  }

  extract(): ExtractionResult {
    const started = Date.now();
    this.extractVersion();
    this.nodes.push(this.fileNode);
    try {
      this.extractImports();
      const sections = this.sections();
      const sectionNodes = new Map<string, Node[]>();
      for (const section of sections) {
        const node = this.extractSection(section);
        sectionNodes.set(section.name, [...(sectionNodes.get(section.name) ?? []), node]);
      }
      this.extractConfiguration(sectionNodes);
    } catch (error) {
      this.errors.push({
        message: `GLSLFX extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
      durationMs: Date.now() - started,
    };
  }

  private extractVersion(): void {
    const match = this.source.match(/^--\s+glslfx\s+version\s+([^\s]+)\s*$/m);
    if (!match) return;
    const version = match[1]!;
    this.fileNode.decorators = [`glslfx:${version}`];
    this.fileNode.signature = match[0];
    if (version !== '0.1') {
      this.errors.push({
        message: `Unsupported GLSLFX version ${version}; parsing as the 0.1 container dialect`,
        filePath: this.filePath,
        line: this.lineAt(match.index ?? 0),
        severity: 'warning',
        code: 'glslfx_version',
      });
    }
  }

  private sections(): Section[] {
    const markers = [...this.source.matchAll(/^--\s+glsl\s+([^\r\n]+?)\s*$/gm)];
    return markers.map((marker, index) => {
      const contentStart = (marker.index ?? 0) + marker[0].length;
      const next = markers[index + 1]?.index ?? this.source.length;
      const content = this.source.slice(contentStart, next).replace(/^\r?\n/, '');
      const markerLine = this.lineAt(marker.index ?? 0);
      return { name: marker[1]!.trim(), content, markerLine, startLine: markerLine + 1 };
    });
  }

  private extractSection(section: Section): Node {
    const sectionId = generateNodeId(this.filePath, 'module', section.name, section.markerLine);
    const sectionNode: Node = {
      id: sectionId,
      kind: 'module',
      name: section.name,
      qualifiedName: `${this.filePath}::${section.name}`,
      filePath: this.filePath,
      language: 'glsl',
      signature: `-- glsl ${section.name}`,
      decorators: ['glslfx:section'],
      startLine: section.markerLine,
      endLine: section.startLine + section.content.split('\n').length - 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(sectionNode);
    this.edges.push({ source: this.fileNode.id, target: sectionId, kind: 'contains' });

    const embedded = new TreeSitterExtractor(`${this.filePath}#${section.name}.glsl`, section.content, 'glsl').extract();
    const idMap = new Map<string, string>();
    const embeddedFileId = `file:${this.filePath}#${section.name}.glsl`;
    idMap.set(embeddedFileId, sectionId);
    for (const node of embedded.nodes) {
      if (node.kind === 'file') continue;
      const oldId = node.id;
      node.startLine += section.startLine - 1;
      node.endLine += section.startLine - 1;
      node.filePath = this.filePath;
      node.language = 'glsl';
      node.qualifiedName = `${section.name}::${node.qualifiedName}`;
      node.id = generateNodeId(this.filePath, node.kind, `${section.name}::${node.name}`, node.startLine);
      idMap.set(oldId, node.id);
      this.nodes.push(node);
    }
    for (const edge of embedded.edges) {
      const source = idMap.get(edge.source);
      const target = idMap.get(edge.target);
      if (!source || !target) continue;
      this.edges.push({ ...edge, source, target, line: edge.line ? edge.line + section.startLine - 1 : undefined });
    }
    for (const ref of embedded.unresolvedReferences) {
      const fromNodeId = idMap.get(ref.fromNodeId);
      if (!fromNodeId) continue;
      this.unresolvedReferences.push({
        ...ref,
        fromNodeId,
        filePath: this.filePath,
        language: 'glsl',
        line: ref.line + section.startLine - 1,
      });
    }
    for (const error of embedded.errors) {
      this.errors.push({ ...error, filePath: this.filePath, line: error.line ? error.line + section.startLine - 1 : undefined });
    }
    return sectionNode;
  }

  private extractImports(): void {
    for (const match of this.source.matchAll(/^\s*#import\s+[<"]?([^>"\r\n]+)[>"]?\s*$/gm)) {
      const moduleName = match[1]!.trim();
      const line = this.lineAt(match.index ?? 0);
      const id = generateNodeId(this.filePath, 'import', moduleName, line);
      this.nodes.push({
        id,
        kind: 'import',
        name: moduleName,
        qualifiedName: `${this.filePath}::import:${moduleName}`,
        filePath: this.filePath,
        language: 'glsl',
        signature: match[0].trim(),
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        updatedAt: Date.now(),
      });
      this.edges.push({ source: this.fileNode.id, target: id, kind: 'contains' });
      this.unresolvedReferences.push({
        fromNodeId: this.fileNode.id,
        referenceName: moduleName,
        referenceKind: 'imports',
        filePath: this.filePath,
        language: 'glsl',
        line,
        column: 0,
      });
    }
  }

  private extractConfiguration(sectionNodes: Map<string, Node[]>): void {
    const marker = /^--\s+configuration\s*$/gm.exec(this.source);
    if (!marker) return;
    const start = marker.index + marker[0].length;
    const tail = this.source.slice(start);
    const nextMarker = /^--\s+/m.exec(tail);
    const raw = tail.slice(0, nextMarker?.index ?? tail.length).trim();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.errors.push({
        message: 'GLSLFX configuration block is not valid JSON',
        filePath: this.filePath,
        line: this.lineAt(marker.index),
        severity: 'warning',
        code: 'glslfx_config',
      });
      return;
    }
    const techniques = (parsed as { techniques?: Record<string, unknown> }).techniques;
    if (!techniques || typeof techniques !== 'object') return;
    for (const [name, value] of Object.entries(techniques)) {
      const line = this.lineAt(marker.index);
      const id = generateNodeId(this.filePath, 'component', name, line);
      const technique: Node = {
        id,
        kind: 'component',
        name,
        qualifiedName: `${this.filePath}::technique:${name}`,
        filePath: this.filePath,
        language: 'glsl',
        signature: JSON.stringify(value).slice(0, 400),
        decorators: ['glslfx:technique'],
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };
      this.nodes.push(technique);
      this.edges.push({ source: this.fileNode.id, target: id, kind: 'contains' });
      const strings: string[] = [];
      const walk = (item: unknown): void => {
        if (typeof item === 'string') strings.push(item);
        else if (Array.isArray(item)) item.forEach(walk);
        else if (item && typeof item === 'object') Object.values(item).forEach(walk);
      };
      walk(value);
      for (const sectionName of new Set(strings)) {
        const sections = sectionNodes.get(sectionName) ?? [];
        if (sections.length === 1) {
          this.edges.push({ source: id, target: sections[0]!.id, kind: 'references' });
        } else if (/\.(?:glslfx|glsl|hlsl|hlsli)$/i.test(sectionName)) {
          this.unresolvedReferences.push({
            fromNodeId: id,
            referenceName: sectionName,
            referenceKind: 'imports',
            filePath: this.filePath,
            language: 'glsl',
            line,
            column: 0,
          });
        }
      }
    }
  }

  private lineAt(index: number): number {
    return (this.source.slice(0, index).match(/\n/g) || []).length + 1;
  }
}
