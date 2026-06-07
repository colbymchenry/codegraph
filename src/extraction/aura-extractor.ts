import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * AuraExtractor — extracts the component graph from Aura component markup
 * (`.cmp`, `.app`, `.evt`, `.intf`).
 *
 * The bundle's `*Controller.js` / `*Helper.js` are indexed by the JavaScript
 * extractor (with the Aura object-literal handler path in tree-sitter.ts). This
 * markup extractor links the component to:
 *
 *  - `<c:childComponent>` (custom `c:` namespace) → the child Aura/LWC component
 *  - `{!c.handleClick}` action expressions      → the controller handler method
 *
 * Mirrors RazorExtractor/VisualforceExtractor: exactly ONE `component` node per
 * file; child/handler links are EDGES, never nodes. Standard namespaces
 * (`aura:`, `lightning:`, `ui:`, `force:`, `ltng:`) are framework built-ins and
 * skipped. `{!v.attr}` value bindings are intra-component data flow — deferred.
 *
 * `<c:child>` refs resolve through the Salesforce framework resolver
 * (salesforce.ts); `{!c.handler}` refs are `calls` and resolve through the
 * generic name-matcher (cross-language `calls` bridges aren't gated).
 */
export class AuraExtractor {
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
      this.extractControllerActions(componentId);
    } catch (error) {
      this.errors.push({
        message: `Aura extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
    const componentName = fileName.replace(/\.(cmp|app|evt|intf)$/i, '');
    const node: Node = {
      id: generateNodeId(this.filePath, 'component', componentName, 1),
      kind: 'component',
      name: componentName,
      qualifiedName: `${this.filePath}::${componentName}`,
      filePath: this.filePath,
      language: 'aura',
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

  private lineAt(index: number): number {
    return (this.source.slice(0, index).match(/\n/g) || []).length + 1;
  }

  /**
   * Custom child components in the `c:` namespace (`<c:accountList>`). Closing
   * tags (`</c:…>`) don't match (leading `/`); standard namespaces never match.
   */
  private extractChildComponentTags(componentId: string): void {
    const tagRe = /<c:([A-Za-z_]\w*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(this.source)) !== null) {
      const name = m[1];
      if (!name) continue;
      this.unresolvedReferences.push({
        fromNodeId: componentId,
        referenceName: name,
        referenceKind: 'references',
        line: this.lineAt(m.index),
        column: 0,
        filePath: this.filePath,
        language: 'aura',
      });
    }
  }

  /**
   * Controller action expressions `{!c.handleClick}` → the controller handler
   * method (a `calls` edge; the handler is a node via the Aura object-literal
   * path in tree-sitter.ts). `{!v.x}` value bindings are skipped.
   */
  private extractControllerActions(componentId: string): void {
    const re = /\{!\s*c\.([A-Za-z_]\w*)\s*\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.source)) !== null) {
      const name = m[1];
      if (!name) continue;
      this.unresolvedReferences.push({
        fromNodeId: componentId,
        referenceName: name,
        referenceKind: 'calls',
        line: this.lineAt(m.index),
        column: 0,
        filePath: this.filePath,
        language: 'aura',
      });
    }
  }
}
