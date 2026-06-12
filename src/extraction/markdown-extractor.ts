import * as path from 'path';
import { Edge, ExtractionError, ExtractionResult, Node, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * Lightweight extractor for Markdown documentation.
 *
 * Markdown has useful project structure even when it is not "code": headings
 * are navigable sections, and local links often point at related source/docs.
 * This extractor keeps the full file searchable via a capped docstring while
 * emitting heading nodes and local-link references.
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

    try {
      const fileNode = this.createFileNode();
      this.extractHeadingsAndLinks(fileNode.id);
    } catch (error) {
      this.errors.push({
        message: `Markdown extraction error: ${error instanceof Error ? error.message : String(error)}`,
        filePath: this.filePath,
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
    const node: Node = {
      id: `file:${this.filePath}`,
      kind: 'file',
      name: path.basename(this.filePath),
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'markdown',
      startLine: 1,
      endLine: lines.length || 1,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      docstring: this.source.slice(0, 12_000),
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  private extractHeadingsAndLinks(fileNodeId: string): void {
    const lines = this.source.split('\n');
    const headingStack: Array<{ level: number; nodeId: string; slug: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNumber = i + 1;

      const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (headingMatch) {
        const level = headingMatch[1]!.length;
        const title = headingMatch[2]!.trim();
        const slug = slugify(title);
        const parent = findHeadingParent(headingStack, level)?.nodeId ?? fileNodeId;
        const nodeId = generateNodeId(this.filePath, 'module', `${level}:${title}`, lineNumber);

        this.nodes.push({
          id: nodeId,
          kind: 'module',
          name: title,
          qualifiedName: `${this.filePath}#${slug}`,
          filePath: this.filePath,
          language: 'markdown',
          startLine: lineNumber,
          endLine: lineNumber,
          startColumn: 0,
          endColumn: line.length,
          signature: `${'#'.repeat(level)} ${title}`,
          updatedAt: Date.now(),
        });
        this.edges.push({ source: parent, target: nodeId, kind: 'contains' });

        while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
          headingStack.pop();
        }
        headingStack.push({ level, nodeId, slug });
      }

      this.extractLocalLinks(line, lineNumber, headingStack[headingStack.length - 1]?.nodeId ?? fileNodeId);
    }
  }

  private extractLocalLinks(line: string, lineNumber: number, fromNodeId: string): void {
    const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let match: RegExpExecArray | null;

    while ((match = linkPattern.exec(line)) !== null) {
      const target = match[1]!;
      if (!isLocalLinkTarget(target)) continue;

      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: target,
        referenceKind: 'references',
        line: lineNumber,
        column: match.index,
        filePath: this.filePath,
        language: 'markdown',
      });
    }
  }
}

function findHeadingParent(
  stack: Array<{ level: number; nodeId: string; slug: string }>,
  level: number
): { level: number; nodeId: string; slug: string } | undefined {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]!.level < level) return stack[i];
  }
  return undefined;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function isLocalLinkTarget(target: string): boolean {
  if (target.startsWith('#')) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  if (target.startsWith('//')) return false;
  return true;
}
