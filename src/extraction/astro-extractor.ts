import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, Language } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';
import { isLanguageSupported } from './grammars';

/**
 * AstroExtractor - Extracts code relationships from Astro component files (.astro)
 *
 * Astro files are multi-language: a TypeScript frontmatter block (delimited by
 * `---`) followed by an HTML template. Rather than relying on the Astro
 * tree-sitter grammar (which treats the frontmatter as a raw text blob), we
 * extract the frontmatter content and delegate it to the TypeScript
 * TreeSitterExtractor, then scan the template for component usages and
 * expression call references.
 *
 * Every .astro file produces a `component` node (Astro components are always
 * importable as named exports).
 */
export class AstroExtractor {
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
    try {
      const componentNode = this.createComponentNode();
      const frontmatter = this.extractFrontmatter();
      if (frontmatter) {
        this.processFrontmatter(frontmatter, componentNode.id);
      }
      this.extractTemplateCalls(componentNode.id, frontmatter);
      this.extractTemplateComponents(componentNode.id, frontmatter);
    } catch (error) {
      this.errors.push({
        message: `Astro extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  private createComponentNode(): Node {
    const lines = this.source.split('\n');
    const fileName = this.filePath.split(/[/\\]/).pop() || this.filePath;
    const componentName = fileName.replace(/\.astro$/, '');
    const id = generateNodeId(this.filePath, 'component', componentName, 1);
    const node: Node = {
      id,
      kind: 'component',
      name: componentName,
      qualifiedName: `${this.filePath}::${componentName}`,
      filePath: this.filePath,
      language: 'astro',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      isExported: true,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  /**
   * Extract the frontmatter block content and its line offset within the file.
   * Frontmatter is the TypeScript/JavaScript code between the opening and
   * closing `---` fence lines at the top of the file.
   */
  private extractFrontmatter(): { content: string; startLine: number } | null {
    // Must start with `---` (optional trailing whitespace, then newline)
    const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(this.source);
    if (!match) return null;
    const content = match[1] ?? '';
    // `---` is line 1 (1-indexed); content starts on line 2
    const startLine = 1;
    return { content, startLine };
  }

  /**
   * Re-parse frontmatter as TypeScript and incorporate the extracted symbols,
   * offsetting all line numbers by the frontmatter's position in the file.
   */
  private processFrontmatter(
    frontmatter: { content: string; startLine: number },
    componentNodeId: string
  ): void {
    const lang: Language = 'typescript';
    if (!isLanguageSupported(lang)) {
      this.errors.push({
        message: 'TypeScript parser not available; cannot parse Astro frontmatter',
        severity: 'warning',
      });
      return;
    }

    const extractor = new TreeSitterExtractor(this.filePath, frontmatter.content, lang);
    const result = extractor.extract();

    for (const node of result.nodes) {
      node.startLine += frontmatter.startLine;
      node.endLine += frontmatter.startLine;
      node.language = 'astro';
      this.nodes.push(node);
      this.edges.push({ source: componentNodeId, target: node.id, kind: 'contains' });
    }
    for (const edge of result.edges) {
      if (edge.line) edge.line += frontmatter.startLine;
      this.edges.push(edge);
    }
    for (const ref of result.unresolvedReferences) {
      ref.line += frontmatter.startLine;
      ref.filePath = this.filePath;
      ref.language = 'astro';
      this.unresolvedReferences.push(ref);
    }
    for (const error of result.errors) {
      if (error.line) error.line += frontmatter.startLine;
      this.errors.push(error);
    }
  }

  /**
   * Extract function calls from Astro template expressions (`{expr(...)}`)
   * outside the frontmatter block.
   */
  private extractTemplateCalls(
    componentNodeId: string,
    frontmatter: { content: string; startLine: number } | null
  ): void {
    const frontmatterEndLine = frontmatter
      ? frontmatter.startLine + frontmatter.content.split('\n').length + 1
      : 0;

    const lines = this.source.split('\n');
    const exprRegex = /\{([^}]+)\}/g;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (lineIdx < frontmatterEndLine) continue;
      const line = lines[lineIdx]!;
      let exprMatch;
      exprRegex.lastIndex = 0;
      while ((exprMatch = exprRegex.exec(line)) !== null) {
        const expr = exprMatch[1]!;
        const callRegex = /\b([a-zA-Z_$][\w$.]*)\s*\(/g;
        let callMatch;
        while ((callMatch = callRegex.exec(expr)) !== null) {
          const calleeName = callMatch[1]!;
          // Skip common non-function identifiers
          if (
            calleeName === 'if' || calleeName === 'else' || calleeName === 'for' ||
            calleeName === 'while' || calleeName === 'switch' || calleeName === 'return'
          ) continue;
          this.unresolvedReferences.push({
            fromNodeId: componentNodeId,
            referenceName: calleeName,
            referenceKind: 'calls',
            line: lineIdx + 1,
            column: exprMatch.index + callMatch.index,
            filePath: this.filePath,
            language: 'astro',
          });
        }
      }
    }
  }

  /**
   * Extract component usages from the Astro template.
   *
   * PascalCase tags (<Header />, <BlogPost>, etc.) and client directive
   * components represent component instantiations — creates `references`
   * edges from this component to the imported child component.
   */
  private extractTemplateComponents(
    componentNodeId: string,
    frontmatter: { content: string; startLine: number } | null
  ): void {
    const frontmatterEndLine = frontmatter
      ? frontmatter.startLine + frontmatter.content.split('\n').length + 1
      : 0;

    const lines = this.source.split('\n');
    const componentTagRegex = /<([A-Z][a-zA-Z0-9_$]*)\b/g;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (lineIdx < frontmatterEndLine) continue;
      const line = lines[lineIdx]!;
      let match;
      componentTagRegex.lastIndex = 0;
      while ((match = componentTagRegex.exec(line)) !== null) {
        const componentName = match[1]!;
        this.unresolvedReferences.push({
          fromNodeId: componentNodeId,
          referenceName: componentName,
          referenceKind: 'references',
          line: lineIdx + 1,
          column: match.index + 1,
          filePath: this.filePath,
          language: 'astro',
        });
      }
    }
  }
}
