import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * LwcTemplateExtractor — extracts the component graph from a Lightning Web
 * Component HTML template (`.../lwc/<bundle>/<bundle>.html`).
 *
 * The component's `.js` is already indexed by the JavaScript extractor; the
 * template adds the child-component usages that the JS never names:
 *
 *  - `<c-child-comp>` (custom `c-` namespace) → the child LWC component class
 *
 * The kebab-case tag (`c-acct-tile`) maps to the child's PascalCase class
 * (`AcctTile`) by Lightning's naming convention; resolution happens through the
 * Salesforce framework resolver (salesforce.ts).
 *
 * Scope: only the `c-` namespace is captured. Base components (`lightning-*`,
 * `lightning/*`) are framework built-ins not defined in-repo. Template member
 * bindings (`{getter}`, `onclick={handler}`) are intra-bundle and lower value —
 * deferred (the `.js` already carries those members).
 */
export class LwcTemplateExtractor {
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
      const componentId = this.createComponentNode().id;
      this.extractChildComponentTags(componentId);
    } catch (error) {
      this.errors.push({
        message: `LWC template extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
    const componentName = fileName.replace(/\.html$/i, '');
    const node: Node = {
      id: generateNodeId(this.filePath, 'component', componentName, 1),
      kind: 'component',
      name: componentName,
      qualifiedName: `${this.filePath}::${componentName}`,
      filePath: this.filePath,
      language: 'lwc',
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

  /** `acct-tile` → `AcctTile` (Lightning kebab → PascalCase class convention). */
  private pascalize(kebab: string): string {
    return kebab
      .split('-')
      .filter(Boolean)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join('');
  }

  private lineAt(index: number): number {
    return (this.source.slice(0, index).match(/\n/g) || []).length + 1;
  }

  /**
   * Custom child components in the `c-` namespace (`<c-acct-tile>`). Closing tags
   * (`</c-…>`) don't match because of the leading `/`. Base components
   * (`lightning-…`) start with a different prefix and never match.
   */
  private extractChildComponentTags(componentId: string): void {
    const tagRe = /<c-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(this.source)) !== null) {
      const kebab = m[1];
      if (!kebab) continue;
      this.unresolvedReferences.push({
        fromNodeId: componentId,
        referenceName: this.pascalize(kebab),
        referenceKind: 'references',
        line: this.lineAt(m.index),
        column: 0,
        filePath: this.filePath,
        language: 'lwc',
      });
    }
  }
}
