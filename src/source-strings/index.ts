/**
 * Source-string extraction.
 *
 * This indexes only compact code-like string literals: route paths, config keys,
 * event names, collection names, and similar cross-boundary contracts. Plain
 * prose strings are intentionally ignored so the table remains a code lookup
 * surface rather than a general text/secret enumeration surface.
 */

import { createHash } from 'crypto';
import { Language, Node, SourceStringRef } from '../types';

const MAX_SOURCE_STRING_LENGTH = 160;

export function extractSourceStrings(
  filePath: string,
  source: string,
  language: Language,
  nodes: Node[]
): SourceStringRef[] {
  const refs: SourceStringRef[] = [];
  let i = 0;
  let line = 1;
  let column = 0;

  const advance = (ch: string): void => {
    if (ch === '\n') {
      line++;
      column = 0;
    } else {
      column++;
    }
    i++;
  };

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') advance(source[i]!);
      continue;
    }

    if (ch === '/' && next === '*') {
      advance(ch);
      advance(next);
      while (i < source.length) {
        const c = source[i]!;
        const n = source[i + 1];
        advance(c);
        if (c === '*' && n === '/') {
          advance(n);
          break;
        }
      }
      continue;
    }

    if (ch !== '\'' && ch !== '"' && ch !== '`') {
      advance(ch);
      continue;
    }

    const quote = ch;
    const startLine = line;
    const startColumn = column;
    advance(ch);

    let literal = '';
    let closed = false;
    while (i < source.length) {
      const c = source[i]!;
      if (c === '\\') {
        const escaped = source[i + 1];
        advance(c);
        if (escaped !== undefined) {
          literal += escaped;
          advance(escaped);
        }
        continue;
      }
      if (c === quote) {
        closed = true;
        advance(c);
        break;
      }
      literal += c;
      advance(c);
    }

    if (!closed || (quote === '`' && literal.includes('${')) || !isCodeLikeSourceString(literal)) continue;

    const node = pickEnclosingNode(nodes, startLine);
    refs.push({
      id: sourceStringId(filePath, startLine, startColumn, literal),
      literal,
      filePath,
      line: startLine,
      column: startColumn,
      language,
      nodeId: node?.id,
      nodeName: node?.name,
      nodeKind: node?.kind,
    });
  }

  return refs;
}

export function isCodeLikeSourceString(value: string): boolean {
  const cleaned = value.trim();
  if (cleaned !== value) return false;
  if (cleaned.length < 3 || cleaned.length > MAX_SOURCE_STRING_LENGTH) return false;
  if (!/[A-Za-z0-9]/.test(cleaned)) return false;
  if (/\s/.test(cleaned)) return false;
  return /[-_./:@]/.test(cleaned);
}

function pickEnclosingNode(nodes: Node[], line: number): Node | null {
  const candidates = nodes
    .filter((node) => node.kind !== 'file')
    .filter((node) => node.startLine <= line && line <= node.endLine)
    .sort((a, b) => {
      const aRange = a.endLine - a.startLine;
      const bRange = b.endLine - b.startLine;
      return aRange - bRange || a.startLine - b.startLine;
    });

  return candidates[0] ?? nodes.find((node) => node.kind === 'file') ?? null;
}

function sourceStringId(
  filePath: string,
  line: number,
  column: number,
  literal: string
): string {
  const hash = createHash('sha1')
    .update(filePath)
    .update('\0')
    .update(String(line))
    .update('\0')
    .update(String(column))
    .update('\0')
    .update(literal)
    .digest('hex')
    .slice(0, 24);
  return `source-string:${hash}`;
}
