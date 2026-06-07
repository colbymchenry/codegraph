import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * VisualforceExtractor — extracts code relationships from Salesforce Visualforce
 * (`.page`) and Visualforce component (`.component`) markup.
 *
 * Visualforce markup references Apex backing classes and custom components that
 * the engine otherwise never parses, so those Apex classes look like nothing
 * depends on them. This extractor links the markup → the symbols it names,
 * mirroring RazorExtractor (markup → C# type):
 *
 *  - `<apex:page controller="AccountController">`  → the Apex controller class
 *  - `extensions="ExtA,ExtB"`                      → each Apex extension class
 *  - `<c:MyChild>` (custom-namespace component)    → the Visualforce/LWC component
 *
 * Risk mitigations:
 *  - Exactly ONE `component` node per file; controller/extension/component refs
 *    become `references` EDGES, never nodes — no per-tag node explosion.
 *  - `standardController="Account"` is intentionally SKIPPED — it names an
 *    SObject, not an Apex class, and would mis-link to a same-named class.
 *  - Only the custom `c:` namespace is captured; standard namespaces (`apex:`,
 *    `lightning:`, `chatter:`, …) are framework built-ins not defined in-repo,
 *    so a ref would just dangle.
 *  - Refs resolve through the Salesforce framework resolver (salesforce.ts),
 *    which keeps the cross-language edge (Apex is its own language family, so the
 *    framework gate never drops it).
 */
export class VisualforceExtractor {
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
      this.extractControllerRefs(componentId);
      this.extractCustomComponentTags(componentId);
    } catch (error) {
      this.errors.push({
        message: `Visualforce extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
    const componentName = fileName.replace(/\.(page|component)$/i, '');
    const node: Node = {
      id: generateNodeId(this.filePath, 'component', componentName, 1),
      kind: 'component',
      name: componentName,
      qualifiedName: `${this.filePath}::${componentName}`,
      filePath: this.filePath,
      language: 'visualforce',
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

  /** 0-indexed source offset → 1-indexed line number. */
  private lineAt(index: number): number {
    return (this.source.slice(0, index).match(/\n/g) || []).length + 1;
  }

  private pushRef(componentId: string, name: string, line: number): void {
    this.unresolvedReferences.push({
      fromNodeId: componentId,
      referenceName: name,
      referenceKind: 'references',
      line,
      column: 0,
      filePath: this.filePath,
      language: 'visualforce',
    });
  }

  /**
   * `controller="X"` (an Apex class) and `extensions="A,B"` (comma-separated Apex
   * classes). `standardController` is deliberately not matched — `(?:^|\s)` before
   * `controller` ensures the `Controller` inside `standardController` never matches.
   */
  private extractControllerRefs(componentId: string): void {
    const ctrl = this.source.match(/(?:^|\s)controller\s*=\s*"([^"]+)"/i);
    if (ctrl && ctrl[1]) {
      const name = ctrl[1].trim();
      if (name) this.pushRef(componentId, name, this.lineAt(ctrl.index ?? 0));
    }
    const ext = this.source.match(/(?:^|\s)extensions\s*=\s*"([^"]+)"/i);
    if (ext && ext[1]) {
      const line = this.lineAt(ext.index ?? 0);
      // Comma list; cap at 5 to bound pathological input.
      for (const raw of ext[1].split(',').slice(0, 5)) {
        const name = raw.trim();
        if (name) this.pushRef(componentId, name, line);
      }
    }
  }

  /**
   * Custom component tags in the default `c:` namespace (`<c:MyChild>`). Standard
   * namespaces (`apex:`, `lightning:`, etc.) are skipped. Closing tags (`</c:…>`)
   * don't match because of the leading `/`.
   */
  private extractCustomComponentTags(componentId: string): void {
    const tagRe = /<c:([A-Za-z_][\w]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(this.source)) !== null) {
      const name = m[1];
      if (name) this.pushRef(componentId, name, this.lineAt(m.index));
    }
  }
}
