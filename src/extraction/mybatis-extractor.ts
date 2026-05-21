/**
 * MyBatis Mapper XML Extractor
 *
 * Extracts SQL statement ids from mapper XML files as method-like nodes so
 * Java mapper interfaces can link to their backing SQL statements.
 */

import * as path from 'path';
import { Edge, ExtractionError, ExtractionResult, Node } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

const STATEMENT_TAGS = new Set(['select', 'insert', 'update', 'delete']);

export class MyBatisExtractor {
  constructor(
    private filePath: string,
    private source: string
  ) {}

  extract(): ExtractionResult {
    const startTime = Date.now();
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const errors: ExtractionError[] = [];
    const now = Date.now();
    const lineCount = this.source.split('\n').length;

    const fileNode: Node = {
      id: `file:${this.filePath}`,
      kind: 'file',
      name: path.basename(this.filePath),
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'java',
      startLine: 1,
      endLine: lineCount,
      startColumn: 0,
      endColumn: 0,
      isExported: false,
      updatedAt: now,
    };
    nodes.push(fileNode);

    const namespace = extractMapperNamespace(this.source);
    if (!namespace) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [],
        durationMs: Date.now() - startTime,
      };
    }

    const cleaned = stripXmlComments(this.source);
    const statementRegex = /<(select|insert|update|delete)\b([^>]*)>/gi;
    let match: RegExpExecArray | null;

    while ((match = statementRegex.exec(cleaned)) !== null) {
      const tag = match[1]!.toLowerCase();
      if (!STATEMENT_TAGS.has(tag)) continue;

      const attrs = parseAttributes(match[2] ?? '');
      const id = attrs.get('id');
      if (!id) continue;

      const line = lineAt(cleaned, match.index);
      const col = columnAt(cleaned, match.index);
      const statementNode: Node = {
        id: generateNodeId(this.filePath, 'method', id, line),
        kind: 'method',
        name: id,
        qualifiedName: `${namespace}.${id}`,
        filePath: this.filePath,
        language: 'java',
        startLine: line,
        endLine: line,
        startColumn: col,
        endColumn: col + match[0].length,
        signature: buildStatementSignature(tag, attrs),
        updatedAt: now,
      };
      nodes.push(statementNode);
      edges.push({
        source: fileNode.id,
        target: statementNode.id,
        kind: 'contains',
      });
    }

    return {
      nodes,
      edges,
      unresolvedReferences: [],
      errors,
      durationMs: Date.now() - startTime,
    };
  }
}

export function looksLikeMyBatisMapper(filePath: string, source: string): boolean {
  return filePath.toLowerCase().endsWith('.xml') && /<mapper\b[^>]*\bnamespace\s*=/.test(source);
}

function extractMapperNamespace(source: string): string | null {
  const match = source.match(/<mapper\b[^>]*\bnamespace\s*=\s*(['"])(.*?)\1/i);
  const namespace = match?.[2]?.trim();
  return namespace || null;
}

function stripXmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, (comment) =>
    comment.replace(/[^\r\n]/g, ' ')
  );
}

function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const attrRegex = /([\w:-]+)\s*=\s*(['"])(.*?)\2/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(raw)) !== null) {
    attrs.set(match[1]!, match[3]!);
  }
  return attrs;
}

function buildStatementSignature(tag: string, attrs: Map<string, string>): string {
  const parts = [`<${tag}`];
  for (const key of ['id', 'parameterType', 'resultType', 'resultMap']) {
    const value = attrs.get(key);
    if (value) parts.push(`${key}="${value}"`);
  }
  return `${parts.join(' ')}>`;
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function columnAt(source: string, index: number): number {
  const lastNl = source.lastIndexOf('\n', index);
  return lastNl === -1 ? index : index - lastNl - 1;
}
