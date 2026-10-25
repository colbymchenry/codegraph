import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, Language } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';
import { isLanguageSupported } from './grammars';
import { foldScriptResult, sfcFileNode, sfcScriptLanguage } from './sfc-script';

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
      // The file, holding the component the .svelte file is
      this.nodes.push(sfcFileNode(this.filePath, this.source, 'svelte'));
      const componentNode = this.createComponentNode();
      this.edges.push({ source: `file:${this.filePath}`, target: componentNode.id, kind: 'contains' });

      // Extract and process script blocks
      const scriptBlocks = this.extractScriptBlocks();

      for (const block of scriptBlocks) {
        this.processScriptBlock(block, componentNode.id);
      }

      // Extract template references: `{fn(...)}` calls and `<Component>`
      // usages, in one pass over the template lines.
      this.extractTemplateReferences(componentNode.id);

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
      const isTypeScript = sfcScriptLanguage(attrs, 'svelte') === 'typescript';

      // Detect module script: Svelte 4's `context="module"`, Svelte 5's `module`
      const isModule = /context\s*=\s*["']module["']|(?:^|\s)module(?=[\s=]|$)/.test(attrs);

      // Calculate the 0-indexed line where the content begins. The content
      // starts right after the opening tag's `>` — its leading `\n` is part
      // of the content, so relative line 1 sits ON the tag's closing line
      // (adding 1 here double-counted the embedded newline and shifted every
      // script-block symbol down a line).
      const beforeScript = this.source.substring(0, match.index);
      const scriptTagLine = (beforeScript.match(/\n/g) || []).length;
      const openingTag = match[0].substring(0, match[0].indexOf('>') + 1);
      const openingTagLines = (openingTag.match(/\n/g) || []).length;
      const contentStartLine = scriptTagLine + openingTagLines; // 0-indexed line

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

    foldScriptResult(
      result,
      { filePath: this.filePath, componentNodeId, lineOffset: block.startLine, language: 'svelte', perInstance: !block.isModule },
      { nodes: this.nodes, edges: this.edges, unresolvedReferences: this.unresolvedReferences, errors: this.errors }
    );
  }

  /**
   * Extract template references in ONE pass over the template lines: both the
   * `{fn(...)}` call expressions and the `<PascalCase>` component usages.
   *
   * In Svelte, many function calls happen in markup (e.g., `class={cn(...)}`),
   * not inside `<script>` blocks, and PascalCase tags are component
   * instantiations — analogous to function calls in imperative code. Both
   * extractions read the same lines and skip the same `<script>`/`<style>`
   * ranges, so they share the walk: one covered-line set, one line split, one
   * iteration. (They used to be two full passes over every line.)
   *
   * Reference ORDER is preserved exactly as the two-pass version emitted it —
   * all call references first, then all component references — because
   * resolution can disambiguate same-named candidates by insertion order.
   */
  private extractTemplateReferences(componentNodeId: string): void {
    // Line indices covered by <script>/<style> blocks — neither extraction
    // looks inside them. A Set gives O(1) per-line lookup.
    const covered = new Set<number>();
    const tagRegex = /<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(this.source)) !== null) {
      const startLine = (this.source.substring(0, tagMatch.index).match(/\n/g) || []).length;
      const endLine = startLine + (tagMatch[0].match(/\n/g) || []).length;
      for (let ln = startLine; ln <= endLine; ln++) covered.add(ln);
    }

    const lines = this.source.split('\n');
    // Template expressions: {...} outside script/style blocks, excluding Svelte
    // block syntax ({#if}, {:else}, {/if}, {@html}, {@render}).
    const exprRegex = /\{([^}#/:@][^}]*)\}/g;
    // Function calls: identifiers followed by ( — cn(...), obj.method(...)
    const callRegex = /\b([a-zA-Z_$][\w$.]*)\s*\(/g;
    // PascalCase opening/self-closing tags (closing tags </Foo> start with </)
    const componentTagRegex = /<([A-Z][a-zA-Z0-9_$]*)\b/g;

    const calls: UnresolvedReference[] = [];
    const components: UnresolvedReference[] = [];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (covered.has(lineIdx)) continue;
      const line = lines[lineIdx]!;

      exprRegex.lastIndex = 0;
      let exprMatch;
      while ((exprMatch = exprRegex.exec(line)) !== null) {
        const expr = exprMatch[1]!;
        callRegex.lastIndex = 0;
        let callMatch;
        while ((callMatch = callRegex.exec(expr)) !== null) {
          const calleeName = callMatch[1]!;
          // Skip Svelte runes, control flow keywords, and common non-function patterns
          if (SVELTE_RUNES.has(calleeName)) continue;
          if (calleeName === 'if' || calleeName === 'else' || calleeName === 'each' || calleeName === 'await') continue;

          calls.push({
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

      componentTagRegex.lastIndex = 0;
      let tagHit;
      while ((tagHit = componentTagRegex.exec(line)) !== null) {
        components.push({
          fromNodeId: componentNodeId,
          referenceName: tagHit[1]!,
          referenceKind: 'references',
          line: lineIdx + 1, // 1-indexed
          column: tagHit.index + 1,
          filePath: this.filePath,
          language: 'svelte',
        });
      }
    }

    this.unresolvedReferences.push(...calls, ...components);
  }

}
