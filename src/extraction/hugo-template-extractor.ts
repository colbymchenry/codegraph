import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * HugoTemplateExtractor — Extracts relationships from Hugo layout/partial files.
 *
 * Hugo uses Go's html/template syntax embedded in HTML. We extract:
 *   - The partial file itself as a function node (it IS the definition)
 *   - {{ define "blockName" }}        → named template block definitions
 *   - {{ partial "name.html" . }}     → partial calls (function calls)
 *   - {{ partialCached "name" . }}    → cached partial calls
 *   - {{ block "name" . }}            → block slot definitions
 *   - {{ template "name" . }}         → named template calls
 *   - {{ $var := ... }}               → variable assignments
 *
 * PATH GATING: .html files are only processed when their path contains
 * "layouts/" or "themes/" — plain HTML files anywhere else are skipped.
 *
 * Spec: docs/05-HUGO-TEMPLATES.md
 */
export class HugoTemplateExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    // Path-gate: only process .html files under layouts/ or themes/.
    // .gohtml/.tmpl/.gotmpl files are processed regardless of path.
    const isHtml = /\.html$/i.test(this.filePath);
    const isHugoLayoutPath = /[/\\](layouts|themes)[/\\]/.test(this.filePath);
    if (isHtml && !isHugoLayoutPath) {
      return { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: Date.now() - startTime };
    }

    try {
      const fileNode = this.createFileNode();
      this.extractDefineBlocks(fileNode.id);
      this.extractPartialCalls(fileNode.id);
      this.extractBlockSlots(fileNode.id);
      this.extractTemplateCalls(fileNode.id);
      this.extractVariables(fileNode.id);
    } catch (error) {
      this.errors.push({
        message: `Hugo template extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  /**
   * The partial/layout file itself is a function (partial) or class (top-level layout).
   *   layouts/partials/header.html           → function "header"
   *   layouts/partials/components/card.html  → function "components/card"
   *   layouts/_default/baseof.html           → class "baseof"
   *   layouts/_default/single.html           → class "single"
   */
  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);

    const partialsMatch = this.filePath.match(/[/\\]partials[/\\](.+?)(?:\.html)?$/i);
    const isPartial = !!partialsMatch;
    const displayName = isPartial
      ? partialsMatch![1]!.replace(/\\/g, '/')
      : (this.filePath.split(/[/\\]/).pop() || this.filePath).replace(/\.(html|gohtml|tmpl|gotmpl)$/i, '');

    const kind = isPartial ? 'function' : 'class';

    const fileNode: Node = {
      id,
      kind,
      name: displayName,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'gotemplate',
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
   * {{ define "blockName" }} ... {{ end }}
   * Named template block — acts like a function definition.
   */
  private extractDefineBlocks(fileNodeId: string): void {
    const defineRegex = /\{\{-?\s*define\s+"([^"]+)"\s*-?\}\}/g;
    let match: RegExpExecArray | null;

    while ((match = defineRegex.exec(this.source)) !== null) {
      const [fullMatch, blockName] = match;
      const line = this.getLineNumber(match.index);
      const col = match.index - this.getLineStart(line);
      const nodeId = generateNodeId(this.filePath, 'function', `define:${blockName}`, line);

      this.nodes.push({
        id: nodeId,
        kind: 'function',
        name: blockName!,
        qualifiedName: `${this.filePath}::define:${blockName}`,
        filePath: this.filePath,
        language: 'gotemplate',
        signature: fullMatch,
        startLine: line,
        endLine: line,
        startColumn: col,
        endColumn: col + fullMatch.length,
        updatedAt: Date.now(),
      });

      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
    }
  }

  /**
   * {{ partial "name.html" . }} / {{ partialCached "name.html" . }}
   * The most important relationship — partial calls form the layout call graph.
   */
  private extractPartialCalls(fileNodeId: string): void {
    const partialRegex = /\{\{-?\s*(partialCached|partial)\s+"([^"]+)"/g;
    let match: RegExpExecArray | null;

    while ((match = partialRegex.exec(this.source)) !== null) {
      const [fullMatch, callType, partialName] = match;
      const line = this.getLineNumber(match.index);
      const col = match.index - this.getLineStart(line);

      // Import node — surfaces the partial by name in search
      const importNodeId = generateNodeId(this.filePath, 'import', partialName!, line);
      this.nodes.push({
        id: importNodeId,
        kind: 'import',
        name: partialName!,
        qualifiedName: `${this.filePath}::import:${partialName}`,
        filePath: this.filePath,
        language: 'gotemplate',
        signature: fullMatch,
        startLine: line,
        endLine: line,
        startColumn: col,
        endColumn: col + fullMatch.length,
        updatedAt: Date.now(),
      });
      this.edges.push({ source: fileNodeId, target: importNodeId, kind: 'contains' });

      // Component node at the call site
      const nodeId = generateNodeId(this.filePath, 'component', `${callType}:${partialName}`, line);
      this.nodes.push({
        id: nodeId,
        kind: 'component',
        name: partialName!,
        qualifiedName: `${this.filePath}::${callType}:${partialName}`,
        filePath: this.filePath,
        language: 'gotemplate',
        signature: fullMatch,
        startLine: line,
        endLine: line,
        startColumn: col,
        endColumn: col + fullMatch.length,
        updatedAt: Date.now(),
      });
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });

      // Unresolved reference → resolver links this to the target partial file node
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: `layouts/partials/${partialName}`,
        referenceKind: 'calls',
        line,
        column: col,
      });
    }
  }

  /**
   * {{ block "blockName" . }} ... {{ end }}
   * Block slot — extension point filled by {{ define }} in other files.
   */
  private extractBlockSlots(fileNodeId: string): void {
    const blockRegex = /\{\{-?\s*block\s+"([^"]+)"\s/g;
    let match: RegExpExecArray | null;

    while ((match = blockRegex.exec(this.source)) !== null) {
      const [fullMatch, blockName] = match;
      const line = this.getLineNumber(match.index);
      const col = match.index - this.getLineStart(line);
      const nodeId = generateNodeId(this.filePath, 'component', `block:${blockName}`, line);

      this.nodes.push({
        id: nodeId,
        kind: 'component',
        name: blockName!,
        qualifiedName: `${this.filePath}::block:${blockName}`,
        filePath: this.filePath,
        language: 'gotemplate',
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
        referenceName: blockName!,
        referenceKind: 'references',
        line,
        column: col,
      });
    }
  }

  /**
   * {{ template "name" . }} — direct named template call (lower-level than partials).
   */
  private extractTemplateCalls(fileNodeId: string): void {
    const templateRegex = /\{\{-?\s*template\s+"([^"]+)"/g;
    let match: RegExpExecArray | null;

    while ((match = templateRegex.exec(this.source)) !== null) {
      const [fullMatch, templateName] = match;
      const line = this.getLineNumber(match.index);
      const col = match.index - this.getLineStart(line);
      const nodeId = generateNodeId(this.filePath, 'component', `template:${templateName}`, line);

      this.nodes.push({
        id: nodeId,
        kind: 'component',
        name: templateName!,
        qualifiedName: `${this.filePath}::template:${templateName}`,
        filePath: this.filePath,
        language: 'gotemplate',
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
        referenceName: templateName!,
        referenceKind: 'calls',
        line,
        column: col,
      });
    }
  }

  /**
   * {{ $varName := ... }} — variable assignments. Only the first assignment
   * per variable is indexed.
   */
  private extractVariables(fileNodeId: string): void {
    const varRegex = /\{\{-?\s*\$(\w+)\s*:=/g;
    const seen = new Set<string>();
    let match: RegExpExecArray | null;

    while ((match = varRegex.exec(this.source)) !== null) {
      const [fullMatch, varName] = match;
      if (seen.has(varName!)) continue;
      seen.add(varName!);

      const line = this.getLineNumber(match.index);
      const col = match.index - this.getLineStart(line);
      const nodeId = generateNodeId(this.filePath, 'variable', varName!, line);

      this.nodes.push({
        id: nodeId,
        kind: 'variable',
        name: `$${varName}`,
        qualifiedName: `${this.filePath}::$${varName}`,
        filePath: this.filePath,
        language: 'gotemplate',
        signature: fullMatch,
        startLine: line,
        endLine: line,
        startColumn: col,
        endColumn: col + fullMatch.length,
        updatedAt: Date.now(),
      });
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
    }
  }

  private getLineNumber(index: number): number {
    return (this.source.substring(0, index).match(/\n/g) || []).length + 1;
  }

  private getLineStart(lineNumber: number): number {
    const lines = this.source.split('\n');
    let index = 0;
    for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
      index += lines[i]!.length + 1;
    }
    return index;
  }
}
