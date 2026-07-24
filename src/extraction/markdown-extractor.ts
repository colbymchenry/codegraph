import * as path from 'path';
import {
  Edge,
  ExtractionError,
  ExtractionResult,
  Node,
  UnresolvedReference,
} from '../types';
import { generateNodeId } from './tree-sitter-helpers';

const MAX_DOCSTRING_LENGTH = 4096;

interface Heading {
  level: number;
  title: string;
  slug: string;
  line: number;
  contentStartLine: number;
  startColumn: number;
  endLine: number;
  id: string;
  qualifiedName: string;
  parentId: string;
}

interface InternalTarget {
  filePath: string;
  fragment?: string;
}

/**
 * Dependency-free structural Markdown extraction.
 *
 * This intentionally parses only the subset needed by the repository graph:
 * headings, local links, and high-signal inline-code symbol mentions. It does
 * not try to render Markdown or replace a full CommonMark parser.
 */
export class MarkdownExtractor {
  private readonly filePath: string;
  private readonly lines: string[];
  private readonly fencedLines: boolean[];
  private readonly headingLines = new Set<number>();
  private readonly nodes: Node[] = [];
  private readonly edges: Edge[] = [];
  private readonly unresolvedReferences: UnresolvedReference[] = [];
  private readonly errors: ExtractionError[] = [];
  private readonly sectionIdsBySlug = new Map<string, string>();
  private headings: Heading[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath.replace(/\\/g, '/');
    this.lines = source.split(/\r?\n/);
    this.fencedLines = this.markFencedLines();
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const fileNode = this.createFileNode();
      this.headings = this.extractHeadings(fileNode.id);
      this.attachDocstrings(fileNode);
      this.extractReferences(fileNode.id);
    } catch (error) {
      this.errors.push({
        message: `Markdown extraction error: ${
          error instanceof Error ? error.message : String(error)
        }`,
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
    const lastLine = this.lines[this.lines.length - 1] ?? '';
    const node: Node = {
      id: `file:${this.filePath}`,
      kind: 'file',
      name: path.posix.basename(this.filePath),
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'markdown',
      startLine: 1,
      endLine: Math.max(1, this.lines.length),
      startColumn: 0,
      endColumn: lastLine.length,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  private markFencedLines(): boolean[] {
    const marked = new Array<boolean>(this.lines.length).fill(false);
    let open: { marker: string; length: number } | null = null;

    for (let index = 0; index < this.lines.length; index++) {
      const line = this.lines[index] ?? '';
      if (open) {
        marked[index] = true;
        const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
        if (
          close &&
          close[1]![0] === open.marker &&
          close[1]!.length >= open.length
        ) {
          open = null;
        }
        continue;
      }

      const start = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (start) {
        marked[index] = true;
        open = { marker: start[1]![0]!, length: start[1]!.length };
      }
    }

    return marked;
  }

  private extractHeadings(fileNodeId: string): Heading[] {
    const headings: Heading[] = [];
    const slugCounts = new Map<string, number>();

    for (let index = 0; index < this.lines.length; index++) {
      if (this.fencedLines[index]) continue;
      const line = this.lines[index] ?? '';
      const atx = /^(\s{0,3})(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);

      let level: number;
      let rawTitle: string;
      let startColumn: number;
      let contentStartLine: number;

      if (atx) {
        level = atx[2]!.length;
        rawTitle = atx[3]!;
        startColumn = atx[1]!.length;
        contentStartLine = index + 2;
        this.headingLines.add(index + 1);
      } else {
        const underline = this.lines[index + 1];
        const setext =
          underline !== undefined &&
          !this.fencedLines[index + 1] &&
          /^\s{0,3}(=+|-+)\s*$/.exec(underline);
        if (!setext || line.trim().length === 0) continue;
        level = setext[1]![0] === '=' ? 1 : 2;
        rawTitle = line.trim();
        startColumn = line.indexOf(rawTitle);
        contentStartLine = index + 3;
        this.headingLines.add(index + 1);
        this.headingLines.add(index + 2);
        index++;
      }

      const title = this.cleanHeading(rawTitle);
      if (!title) continue;
      const baseSlug = this.slugify(title) || 'section';
      const count = slugCounts.get(baseSlug) ?? 0;
      slugCounts.set(baseSlug, count + 1);
      const slug = count === 0 ? baseSlug : `${baseSlug}-${count}`;
      const lineNumber = index + (atx ? 1 : 0);
      const qualifiedName = `${this.filePath}#${slug}`;
      const id = generateNodeId(this.filePath, 'section', qualifiedName, lineNumber);

      headings.push({
        level,
        title,
        slug,
        line: lineNumber,
        contentStartLine,
        startColumn,
        endLine: this.lines.length,
        id,
        qualifiedName,
        parentId: fileNodeId,
      });
    }

    const stack: Heading[] = [];
    for (const heading of headings) {
      while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) {
        stack.pop()!.endLine = Math.max(1, heading.line - 1);
      }
      heading.parentId = stack[stack.length - 1]?.id ?? fileNodeId;
      stack.push(heading);
    }

    for (const heading of headings) {
      const endLine = Math.max(heading.line, heading.endLine);
      const endColumn = (this.lines[endLine - 1] ?? '').length;
      this.nodes.push({
        id: heading.id,
        kind: 'section',
        name: heading.title,
        qualifiedName: heading.qualifiedName,
        filePath: this.filePath,
        language: 'markdown',
        startLine: heading.line,
        endLine,
        startColumn: heading.startColumn,
        endColumn,
        updatedAt: Date.now(),
      });
      this.sectionIdsBySlug.set(heading.slug, heading.id);
      this.edges.push({
        source: heading.parentId,
        target: heading.id,
        kind: 'contains',
        line: heading.line,
        column: heading.startColumn,
        provenance: 'heuristic',
      });
    }

    return headings;
  }

  private attachDocstrings(fileNode: Node): void {
    const firstHeadingLine = this.headings[0]?.line ?? this.lines.length + 1;
    fileNode.docstring = this.extractProse(1, firstHeadingLine - 1);
    const nodesById = new Map(this.nodes.map((node) => [node.id, node]));

    for (let index = 0; index < this.headings.length; index++) {
      const heading = this.headings[index]!;
      const nextHeadingLine = this.headings[index + 1]?.line ?? this.lines.length + 1;
      const node = nodesById.get(heading.id);
      if (node) {
        node.docstring = this.extractProse(
          heading.contentStartLine,
          nextHeadingLine - 1
        );
      }
    }
  }

  private extractProse(startLine: number, endLine: number): string | undefined {
    if (endLine < startLine) return undefined;
    const prose: string[] = [];

    for (
      let lineNumber = Math.max(1, startLine);
      lineNumber <= Math.min(endLine, this.lines.length);
      lineNumber++
    ) {
      if (this.fencedLines[lineNumber - 1] || this.headingLines.has(lineNumber)) {
        continue;
      }
      const raw = this.lines[lineNumber - 1] ?? '';
      if (/^\s{0,3}\[[^\]]+\]:\s*\S+/.test(raw)) continue;
      const cleaned = raw
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\[([^\]]+)\]\[[^\]]+\]/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/^\s{0,3}>\s?/, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned) prose.push(cleaned);
    }

    const value = prose.join('\n').trim();
    if (!value) return undefined;
    return value.length <= MAX_DOCSTRING_LENGTH
      ? value
      : `${value.slice(0, MAX_DOCSTRING_LENGTH - 1)}…`;
  }

  private extractReferences(fileNodeId: string): void {
    const referenceDefinitions = new Map<string, string>();
    for (let index = 0; index < this.lines.length; index++) {
      if (this.fencedLines[index]) continue;
      const definition =
        /^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/.exec(
          this.lines[index] ?? ''
        );
      if (definition) {
        referenceDefinitions.set(
          definition[1]!.trim().toLowerCase(),
          definition[2] ?? definition[3]!
        );
      }
    }

    let headingIndex = 0;
    let ownerId = fileNodeId;

    for (let index = 0; index < this.lines.length; index++) {
      const lineNumber = index + 1;
      while (
        headingIndex < this.headings.length &&
        this.headings[headingIndex]!.line <= lineNumber
      ) {
        ownerId = this.headings[headingIndex]!.id;
        headingIndex++;
      }
      if (this.fencedLines[index]) continue;
      const line = this.lines[index] ?? '';
      if (/^\s{0,3}\[[^\]]+\]:\s*\S+/.test(line)) continue;

      const inlineLink =
        /(!?)\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))(?:\s+["'][^"'\n]*["'])?\s*\)/g;
      let linkMatch: RegExpExecArray | null;
      while ((linkMatch = inlineLink.exec(line)) !== null) {
        if (linkMatch[1] === '!') continue;
        const target = linkMatch[3] ?? linkMatch[4];
        if (target) {
          this.emitLink(ownerId, target, lineNumber, linkMatch.index);
        }
      }

      const referenceLink = /(!?)\[([^\]\n]+)\]\[([^\]\n]+)\]/g;
      while ((linkMatch = referenceLink.exec(line)) !== null) {
        if (linkMatch[1] === '!') continue;
        const target = referenceDefinitions.get(linkMatch[3]!.trim().toLowerCase());
        if (target) {
          this.emitLink(ownerId, target, lineNumber, linkMatch.index);
        }
      }

      const inlineCode = /(`+)([^`\n]+?)\1/g;
      let codeMatch: RegExpExecArray | null;
      while ((codeMatch = inlineCode.exec(line)) !== null) {
        const candidate = this.normalizeSymbolCandidate(codeMatch[2]!);
        if (!candidate) continue;
        this.unresolvedReferences.push({
          fromNodeId: ownerId,
          referenceName: candidate,
          referenceKind: 'document_symbol',
          line: lineNumber,
          column: codeMatch.index,
          filePath: this.filePath,
          language: 'markdown',
        });
      }
    }
  }

  private emitLink(
    fromNodeId: string,
    rawTarget: string,
    line: number,
    column: number
  ): void {
    const target = this.normalizeInternalTarget(rawTarget);
    if (!target) return;

    const referenceName = target.fragment
      ? `${target.filePath}#${target.fragment}`
      : target.filePath;

    if (target.filePath === this.filePath) {
      const targetId = target.fragment
        ? this.sectionIdsBySlug.get(target.fragment)
        : `file:${this.filePath}`;
      if (targetId) {
        if (targetId !== fromNodeId) {
          this.edges.push({
            source: fromNodeId,
            target: targetId,
            kind: 'references',
            line,
            column,
            provenance: 'heuristic',
            metadata: {
              docRef: 'link',
              refName: referenceName,
              refKind: 'document_link',
            },
          });
        }
        return;
      }
    }

    this.unresolvedReferences.push({
      fromNodeId,
      referenceName,
      referenceKind: 'document_link',
      line,
      column,
      filePath: this.filePath,
      language: 'markdown',
    });
  }

  private normalizeInternalTarget(rawTarget: string): InternalTarget | null {
    let target = rawTarget.trim();
    if (!target || target.startsWith('//')) return null;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return null;

    try {
      target = decodeURIComponent(target);
    } catch {
      return null;
    }

    const hashIndex = target.indexOf('#');
    const rawPath = (hashIndex >= 0 ? target.slice(0, hashIndex) : target)
      .split('?', 1)[0]!
      .replace(/\\/g, '/');
    const rawFragment = hashIndex >= 0 ? target.slice(hashIndex + 1) : '';

    let targetPath: string;
    if (!rawPath) {
      targetPath = this.filePath;
    } else if (rawPath.startsWith('/')) {
      targetPath = path.posix.normalize(rawPath.slice(1));
    } else {
      targetPath = path.posix.normalize(
        path.posix.join(path.posix.dirname(this.filePath), rawPath)
      );
    }

    if (
      !targetPath ||
      targetPath === '..' ||
      targetPath.startsWith('../') ||
      path.posix.isAbsolute(targetPath)
    ) {
      return null;
    }

    const fragment = rawFragment ? this.slugify(rawFragment) : undefined;
    return fragment ? { filePath: targetPath, fragment } : { filePath: targetPath };
  }

  private normalizeSymbolCandidate(raw: string): string | null {
    const candidate = raw.trim();
    if (
      !/^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:::|\.|->)[A-Za-z_$][A-Za-z0-9_$]*)*(?:\(\))?$/.test(
        candidate
      )
    ) {
      return null;
    }

    const hasStrongSignal =
      /(?:::|\.|->)/.test(candidate) ||
      candidate.endsWith('()') ||
      /^[A-Z]/.test(candidate) ||
      /[A-Z]/.test(candidate.slice(1)) ||
      candidate.includes('_');
    if (!hasStrongSignal) return null;

    return candidate.replace(/\(\)$/, '').replace(/->/g, '.');
  }

  private cleanHeading(raw: string): string {
    return raw
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/`+([^`]+)`+/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[*_~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private slugify(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }
}
