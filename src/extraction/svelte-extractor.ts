import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, Language } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';
import { isLanguageSupported } from './grammars';

/** Svelte 5 rune names — compiler builtins, not real functions */
const SVELTE_RUNES = new Set([
  '$props', '$state', '$derived', '$effect', '$bindable',
  '$inspect', '$host', '$snippet',
]);

/**
 * SvelteExtractor - Extracts code relationships from Svelte component files
 *
 * Svelte files are multi-language (script + template + style). Rather than
 * parsing the full Svelte grammar, we extract the <script> block content
 * and delegate it to the TypeScript/JavaScript TreeSitterExtractor.
 *
 * Also extracts function calls from template expressions (`{fn(...)}`) so
 * cross-file call edges are captured even when calls live in markup.
 *
 * Every .svelte file produces a component node (Svelte components are always importable).
 */
export class SvelteExtractor {
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

  /**
   * Extract from Svelte source
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      // Create component node for the .svelte file itself
      const componentNode = this.createComponentNode();

      // Extract and process script blocks
      const scriptBlocks = this.extractScriptBlocks();

      for (const block of scriptBlocks) {
        this.processScriptBlock(block, componentNode.id);
      }

      // Extract function calls from template expressions ({fn(...)})
      this.extractTemplateCalls(componentNode.id, scriptBlocks);

      // Extract component usages from template (<ComponentName>)
      this.extractTemplateComponents(componentNode.id);

      // Filter out Svelte rune calls ($state, $props, $derived, etc.)
      this.unresolvedReferences = this.unresolvedReferences.filter(
        ref => !SVELTE_RUNES.has(ref.referenceName)
      );
    } catch (error) {
      this.errors.push({
        message: `Svelte extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
   * Create a component node for the .svelte file
   */
  private createComponentNode(): Node {
    const lines = this.source.split('\n');
    const fileName = this.filePath.split(/[/\\]/).pop() || this.filePath;
    const componentName = fileName.replace(/\.svelte$/, '');
    const id = generateNodeId(this.filePath, 'component', componentName, 1);

    const node: Node = {
      id,
      kind: 'component',
      name: componentName,
      qualifiedName: `${this.filePath}::${componentName}`,
      filePath: this.filePath,
      language: 'svelte',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      isExported: true, // Svelte components are always importable
      updatedAt: Date.now(),
    };

    this.nodes.push(node);
    return node;
  }

  /**
   * Extract <script> blocks from the Svelte source
   */
  private extractScriptBlocks(): Array<{
    content: string;
    startLine: number;
    isModule: boolean;
    isTypeScript: boolean;
  }> {
    const blocks: Array<{
      content: string;
      startLine: number;
      isModule: boolean;
      isTypeScript: boolean;
    }> = [];

    const scriptRegex = /<script(\s[^>]*)?>(?<content>[\s\S]*?)<\/script>/g;
    let match;

    while ((match = scriptRegex.exec(this.source)) !== null) {
      const attrs = match[1] || '';
      const content = match.groups?.content || match[2] || '';

      // Detect TypeScript from lang attribute
      const isTypeScript = /lang\s*=\s*["'](ts|typescript)["']/.test(attrs);

      // Detect module script
      const isModule = /context\s*=\s*["']module["']/.test(attrs);

      // Calculate start line of the script content (line after <script>)
      const beforeScript = this.source.substring(0, match.index);
      const scriptTagLine = (beforeScript.match(/\n/g) || []).length;
      // The content starts on the line after the opening <script> tag
      const openingTag = match[0].substring(0, match[0].indexOf('>') + 1);
      const openingTagLines = (openingTag.match(/\n/g) || []).length;
      const contentStartLine = scriptTagLine + openingTagLines + 1; // 0-indexed line

      blocks.push({
        content,
        startLine: contentStartLine,
        isModule,
        isTypeScript,
      });
    }

    return blocks;
  }

  /**
   * Process a script block by delegating to TreeSitterExtractor
   */
  private processScriptBlock(
    block: { content: string; startLine: number; isModule: boolean; isTypeScript: boolean },
    componentNodeId: string
  ): void {
    const scriptLanguage: Language = block.isTypeScript ? 'typescript' : 'javascript';

    // Check if the script language parser is available
    if (!isLanguageSupported(scriptLanguage)) {
      this.errors.push({
        message: `Parser for ${scriptLanguage} not available, cannot parse Svelte script block`,
        severity: 'warning',
      });
      return;
    }

    // Delegate to TreeSitterExtractor
    const extractor = new TreeSitterExtractor(this.filePath, block.content, scriptLanguage);
    const result = extractor.extract();

    // Offset line numbers from script block back to .svelte file positions
    for (const node of result.nodes) {
      node.startLine += block.startLine;
      node.endLine += block.startLine;
      node.language = 'svelte'; // Mark as svelte, not TS/JS

      this.nodes.push(node);

      // Add containment edge from component to this node
      this.edges.push({
        source: componentNodeId,
        target: node.id,
        kind: 'contains',
      });
    }

    // Offset edges (they reference line numbers)
    for (const edge of result.edges) {
      if (edge.line) {
        edge.line += block.startLine;
      }
      this.edges.push(edge);
    }

    // Offset unresolved references
    for (const ref of result.unresolvedReferences) {
      ref.line += block.startLine;
      ref.filePath = this.filePath;
      ref.language = 'svelte';
      this.unresolvedReferences.push(ref);
    }

    // Carry over errors
    for (const error of result.errors) {
      if (error.line) {
        error.line += block.startLine;
      }
      this.errors.push(error);
    }
  }

  /**
   * Extract function calls from Svelte template expressions.
   *
   * In Svelte, many function calls happen in markup (e.g., `class={cn(...)}`),
   * not inside `<script>` blocks. We scan the template portion for `{expression}`
   * blocks and extract call patterns from them.
   */
  private extractTemplateCalls(
    componentNodeId: string,
    _scriptBlocks: Array<{ content: string; startLine: number }>
  ): void {
    // Build a set of line ranges covered by <script> and <style> blocks so we skip them
    const coveredRanges: Array<[number, number]> = [];

    // Find all <script>...</script> and <style>...</style> ranges
    const tagRegex = /<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(this.source)) !== null) {
      const startLine = (this.source.substring(0, tagMatch.index).match(/\n/g) || []).length;
      const endLine = startLine + (tagMatch[0].match(/\n/g) || []).length;
      coveredRanges.push([startLine, endLine]);
    }

    // Find template expressions: {...} outside of script/style blocks
    // Matches curly-brace expressions, excluding Svelte block syntax ({#if}, {:else}, {/if}, {@html}, {@render})
    const lines = this.source.split('\n');
    const exprRegex = /\{([^}#/:@][^}]*)\}/g;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      // Skip lines inside script/style blocks
      if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue;

      const line = lines[lineIdx]!;
      let exprMatch;
      while ((exprMatch = exprRegex.exec(line)) !== null) {
        const expr = exprMatch[1]!;
        // Extract function calls: identifiers followed by (
        // Matches: cn(...), buttonVariants(...), obj.method(...)
        const callRegex = /\b([a-zA-Z_$][\w$.]*)\s*\(/g;
        let callMatch;
        while ((callMatch = callRegex.exec(expr)) !== null) {
          const calleeName = callMatch[1]!;
          // Skip Svelte runes, control flow keywords, and common non-function patterns
          if (SVELTE_RUNES.has(calleeName)) continue;
          if (calleeName === 'if' || calleeName === 'else' || calleeName === 'each' || calleeName === 'await') continue;

          this.unresolvedReferences.push({
            fromNodeId: componentNodeId,
            referenceName: calleeName,
            referenceKind: 'calls',
            line: lineIdx + 1, // 1-indexed
            column: exprMatch.index + callMatch.index,
            filePath: this.filePath,
            language: 'svelte',
          });
        }
      }
    }
  }

  /**
   * Extract component usages from the Svelte template.
   *
   * PascalCase tags like <Modal>, <Button />, <DevServerPreview> represent
   * component instantiations — analogous to function calls in imperative code.
   * Capturing these creates graph edges from parent to child components and
   * gives codegraph_explore anchor points in the template markup.
   */
  private extractTemplateComponents(componentNodeId: string): void {
    // Build ranges covered by <script> and <style> blocks to skip them
    const coveredRanges: Array<[number, number]> = [];
    const tagRegex = /<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(this.source)) !== null) {
      const startLine = (this.source.substring(0, tagMatch.index).match(/\n/g) || []).length;
      const endLine = startLine + (tagMatch[0].match(/\n/g) || []).length;
      coveredRanges.push([startLine, endLine]);
    }

    const lines = this.source.split('\n');
    // Match PascalCase opening/self-closing tags (closing tags </Foo> start with </ so won't match)
    const componentTagRegex = /<([A-Z][a-zA-Z0-9_$]*)\b/g;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue;

      const line = lines[lineIdx]!;
      let match;
      while ((match = componentTagRegex.exec(line)) !== null) {
        const componentName = match[1]!;

        this.unresolvedReferences.push({
          fromNodeId: componentNodeId,
          referenceName: componentName,
          referenceKind: 'references',
          line: lineIdx + 1, // 1-indexed
          column: match.index + 1,
          filePath: this.filePath,
          language: 'svelte',
        });
      }
    }
  }
}
