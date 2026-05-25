import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * CSSExtractor — Extracts design-system-relevant symbols from CSS files.
 *
 * Indexed:
 *   - CSS custom properties (--token-name)  → variable nodes (design tokens)
 *   - var(--name) usages                    → unresolved references
 *   - @keyframes name                       → constant nodes
 *   - animation/animation-name usages       → references to keyframes
 *   - @layer name                           → namespace nodes
 *   - @import / @use                        → import edges
 *
 * Not indexed:
 *   - Selectors, declarations, media queries (too many; not useful for cross-file queries)
 *
 * Spec: docs/06-CSS.md
 */
export class CSSExtractor {
  protected filePath: string;
  protected source: string;
  protected language: 'css' | 'scss' | 'sass' = 'css';
  protected nodes: Node[] = [];
  protected edges: Edge[] = [];
  protected unresolvedReferences: UnresolvedReference[] = [];
  protected errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const fileNode = this.createFileNode();
      this.extractCustomProperties(fileNode.id);
      this.extractKeyframes(fileNode.id);
      this.extractLayers(fileNode.id);
      this.extractImports(fileNode.id);
    } catch (error) {
      this.errors.push({
        message: `CSS extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  protected createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    const name = this.filePath.split(/[/\\]/).pop() || this.filePath;

    const fileNode: Node = {
      id,
      kind: 'file',
      name,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: this.language,
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      updatedAt: Date.now(),
    };

    this.nodes.push(fileNode);
    return fileNode;
  }

  /**
   * CSS custom properties — design tokens.
   *   --color-primary: #1a1a2e;
   * Only the first definition is indexed; var() usages produce references.
   */
  protected extractCustomProperties(fileNodeId: string): void {
    const propRegex = /(--[\w-]+)\s*:\s*([^;}{]+);/g;
    const seen = new Set<string>();
    let match: RegExpExecArray | null;

    while ((match = propRegex.exec(this.source)) !== null) {
      const [fullMatch, propName, rawValue] = match;
      if (seen.has(propName!)) continue;
      seen.add(propName!);

      const line = this.getLineNumber(match.index);
      const col = match.index - this.getLineStart(line);
      const value = rawValue!.trim().substring(0, 80);
      const nodeId = generateNodeId(this.filePath, 'variable', propName!, line);

      this.nodes.push({
        id: nodeId,
        kind: 'variable',
        name: propName!,
        qualifiedName: `${this.filePath}::${propName}`,
        filePath: this.filePath,
        language: this.language,
        signature: `${propName}: ${value}`,
        startLine: line,
        endLine: line,
        startColumn: col,
        endColumn: col + fullMatch.length,
        updatedAt: Date.now(),
      });
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
    }

    // var(--name) usages → references for impact analysis
    const usageRegex = /var\(\s*(--[\w-]+)/g;
    while ((match = usageRegex.exec(this.source)) !== null) {
      const [, propName] = match;
      const line = this.getLineNumber(match.index);
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: propName!,
        referenceKind: 'references',
        line,
        column: match.index - this.getLineStart(line),
      });
    }
  }

  /**
   * @keyframes name { ... }
   * Also indexes animation-name usages as references.
   */
  protected extractKeyframes(fileNodeId: string): void {
    const kfRegex = /@(?:-webkit-)?keyframes\s+([\w-]+)/g;
    let match: RegExpExecArray | null;

    while ((match = kfRegex.exec(this.source)) !== null) {
      const [fullMatch, kfName] = match;
      const line = this.getLineNumber(match.index);
      const col = match.index - this.getLineStart(line);
      const nodeId = generateNodeId(this.filePath, 'constant', `keyframes:${kfName}`, line);

      this.nodes.push({
        id: nodeId,
        kind: 'constant',
        name: kfName!,
        qualifiedName: `${this.filePath}::keyframes:${kfName}`,
        filePath: this.filePath,
        language: this.language,
        signature: fullMatch,
        startLine: line,
        endLine: line,
        startColumn: col,
        endColumn: col + fullMatch.length,
        updatedAt: Date.now(),
      });
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
    }

    // animation: name 0.3s / animation-name: name → references to keyframes
    const animationRegex = /animation(?:-name)?\s*:\s*([\w-]+)/g;
    const cssKeywords = new Set(['none', 'inherit', 'initial', 'unset', 'revert']);
    while ((match = animationRegex.exec(this.source)) !== null) {
      const [, animName] = match;
      if (cssKeywords.has(animName!)) continue;
      const line = this.getLineNumber(match.index);
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: `keyframes:${animName}`,
        referenceKind: 'references',
        line,
        column: match.index - this.getLineStart(line),
      });
    }
  }

  /**
   * @layer name; (order declaration)
   * @layer name { ... } (block declaration)
   * Same layer name is only indexed once.
   */
  protected extractLayers(fileNodeId: string): void {
    const seen = new Set<string>();

    // Order declarations: @layer a, b, c;
    const orderRegex = /@layer\s+([\w,\s-]+);/g;
    let match: RegExpExecArray | null;
    while ((match = orderRegex.exec(this.source)) !== null) {
      const [, layerList] = match;
      const line = this.getLineNumber(match.index);
      for (const layerName of layerList!.split(',').map(s => s.trim()).filter(Boolean)) {
        if (seen.has(layerName)) continue;
        seen.add(layerName);
        this.addLayerNode(fileNodeId, layerName, line, `@layer ${layerName}`);
      }
    }

    // Block declarations: @layer name { ... }
    const blockRegex = /@layer\s+([\w-]+)\s*\{/g;
    while ((match = blockRegex.exec(this.source)) !== null) {
      const [fullMatch, layerName] = match;
      if (seen.has(layerName!)) continue;
      seen.add(layerName!);
      const line = this.getLineNumber(match.index);
      this.addLayerNode(fileNodeId, layerName!, line, fullMatch.trimEnd());
    }
  }

  private addLayerNode(fileNodeId: string, layerName: string, line: number, signature: string): void {
    const nodeId = generateNodeId(this.filePath, 'namespace', `layer:${layerName}`, line);
    this.nodes.push({
      id: nodeId,
      kind: 'namespace',
      name: layerName,
      qualifiedName: `${this.filePath}::layer:${layerName}`,
      filePath: this.filePath,
      language: this.language,
      signature,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: signature.length,
      updatedAt: Date.now(),
    });
    this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
  }

  /**
   * @import 'path.css' / @import url(...)
   */
  protected extractImports(fileNodeId: string): void {
    const importRegex = /@import\s+(?:url\()?['"]([^'"]+)['"]\)?/g;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(this.source)) !== null) {
      const [fullMatch, importPath] = match;
      const line = this.getLineNumber(match.index);
      const col = match.index - this.getLineStart(line);
      const nodeId = generateNodeId(this.filePath, 'import', importPath!, line);

      this.nodes.push({
        id: nodeId,
        kind: 'import',
        name: importPath!,
        qualifiedName: `${this.filePath}::import:${importPath}`,
        filePath: this.filePath,
        language: this.language,
        signature: fullMatch,
        startLine: line,
        endLine: line,
        startColumn: col,
        endColumn: col + fullMatch.length,
        updatedAt: Date.now(),
      });
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });

      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: importPath!,
        referenceKind: 'imports',
        line,
        column: col,
      });
    }
  }

  protected getLineNumber(index: number): number {
    return (this.source.substring(0, index).match(/\n/g) || []).length + 1;
  }

  protected getLineStart(lineNumber: number): number {
    const lines = this.source.split('\n');
    let index = 0;
    for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
      index += lines[i]!.length + 1;
    }
    return index;
  }
}
