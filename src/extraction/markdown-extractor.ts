import { Edge, ExtractionError, ExtractionResult, Node, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * MarkdownExtractor — parses Markdown and MDX files generically.
 *
 * Extracts ATX headings (# … through ######) as symbol nodes so that
 * documentation sections are searchable via `codegraph_search` and navigable
 * with `codegraph_node`. Works for any project — no framework detection needed.
 *
 * Node mapping:
 *   # H1  → kind='class'    (top-level document section)
 *   ## H2 → kind='method'   (sub-section)
 *   ###+  → kind='variable' (deep sections — typically supplementary content)
 *
 * qualifiedName = `<filePath>::<heading-text-slugified>`
 * signature     = `h<level>`
 *
 * Setext headings (underline style) are intentionally skipped — they are
 * uncommon in technical documentation and ambiguous near code blocks.
 */
export class MarkdownExtractor {
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
    const fileNode = this.createFileNode();

    try {
      this.extractHeadings(fileNode.id);
    } catch (error) {
      this.errors.push({
        message: `Markdown extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    const node: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'markdown',
      startLine: 1,
      endLine: lines.length || 1,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  private extractHeadings(fileNodeId: string): void {
    const lines = this.source.split('\n');
    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';

      // Track fenced code blocks to skip headings inside them
      if (/^```|^~~~/.test(line.trimStart())) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      const match = /^(#{1,6})\s+(.+)$/.exec(line);
      if (!match) continue;

      const level = match[1]!.length;
      const text = match[2]!.trim();
      const slug = this.slugify(text);
      const qualified = `${this.filePath}::${slug}`;
      const lineNum = i + 1;
      const kind = level === 1 ? 'class' : level === 2 ? 'method' : 'variable';

      const nodeId = generateNodeId(this.filePath, kind, qualified, lineNum);
      const node: Node = {
        id: nodeId,
        kind,
        name: text,
        qualifiedName: qualified,
        filePath: this.filePath,
        language: 'markdown',
        signature: `h${level}`,
        startLine: lineNum,
        endLine: lineNum,
        startColumn: 0,
        endColumn: line.length,
        updatedAt: Date.now(),
      };
      this.nodes.push(node);
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
    }
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[`*_[\]()]/g, '')   // strip markdown inline syntax
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-');
  }
}
