import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * Custom extractor for Delphi DFM/FMX form files.
 *
 * DFM/FMX files describe the visual component hierarchy and event handler
 * bindings. They use a simple text format (object/end blocks) that we parse
 * with regex — no tree-sitter grammar exists for this format.
 *
 * Extracted information:
 * - Components as NodeKind `component`
 * - Nesting as EdgeKind `contains`
 * - Event handlers (OnClick = MethodName) as UnresolvedReference → EdgeKind `references`
 */
export class DfmExtractor {
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
   * Extract components and event handler references from DFM/FMX source
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const fileNode = this.createFileNode();
      this.parseComponents(fileNode);
    } catch (error) {
      this.errors.push({
        message: `DFM extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  /** Create a file node for the DFM form file */
  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);

    const fileNode: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'pascal',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      updatedAt: Date.now(),
    };

    this.nodes.push(fileNode);
    return fileNode;
  }

  /** Parse object/end blocks and extract components + event handlers */
  private parseComponents(fileNode: Node): void {
    const lines = this.source.split('\n');
    const stack: Node[] = [fileNode];

    const objectPattern = /^\s*(object|inherited|inline)\s+(\w+)\s*:\s*(\w+)/;
    const eventPattern = /^\s*(On\w+)\s*=\s*(\w+)\s*$/;
    const endPattern = /^\s*end\s*$/;
    const multiLineStart = /=\s*\(\s*$/;
    const multiLineItemStart = /=\s*<\s*$/;
    let inMultiLine = false;
    let multiLineEndChar = ')';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNum = i + 1;

      // Skip multi-line properties
      if (inMultiLine) {
        if (line.trimEnd().endsWith(multiLineEndChar)) inMultiLine = false;
        continue;
      }
      if (multiLineStart.test(line)) {
        inMultiLine = true;
        multiLineEndChar = ')';
        continue;
      }
      if (multiLineItemStart.test(line)) {
        inMultiLine = true;
        multiLineEndChar = '>';
        continue;
      }

      // Component declaration
      const objMatch = line.match(objectPattern);
      if (objMatch) {
        const [, , name, typeName] = objMatch;
        const nodeId = generateNodeId(this.filePath, 'component', name!, lineNum);
        const node: Node = {
          id: nodeId,
          kind: 'component',
          name: name!,
          qualifiedName: `${this.filePath}#${name}`,
          filePath: this.filePath,
          language: 'pascal',
          startLine: lineNum,
          endLine: lineNum,
          startColumn: 0,
          endColumn: line.length,
          signature: typeName,
          updatedAt: Date.now(),
        };
        this.nodes.push(node);
        this.edges.push({
          source: stack[stack.length - 1]!.id,
          target: nodeId,
          kind: 'contains',
        });
        stack.push(node);
        continue;
      }

      // Event handler
      const eventMatch = line.match(eventPattern);
      if (eventMatch) {
        const [, , methodName] = eventMatch;
        this.unresolvedReferences.push({
          fromNodeId: stack[stack.length - 1]!.id,
          referenceName: methodName!,
          referenceKind: 'references',
          line: lineNum,
          column: 0,
        });
        continue;
      }

      // Block end
      if (endPattern.test(line)) {
        if (stack.length > 1) {
          const node = stack.pop()!;
          node.endLine = lineNum;
          node.endColumn = line.length;
        }
      }
    }
  }
}
