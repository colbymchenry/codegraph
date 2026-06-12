import * as path from 'path';
import { Edge, ExtractionError, ExtractionResult, Node, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * Lightweight extractor for shell scripts.
 *
 * Full Bash parsing is expensive to load in the existing `loadAllGrammars()`
 * test path. For CodeGraph's practical shell use case, function declarations
 * and command references provide the useful graph surface without loading an
 * additional WASM grammar.
 */
export class ShellExtractor {
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
      this.extractFunctionsAndCommands(fileNode.id);
    } catch (error) {
      this.errors.push({
        message: `Shell extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
      language: 'shell',
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

  private extractFunctionsAndCommands(fileNodeId: string): void {
    const lines = this.source.split('\n');
    let currentFunctionId = fileNodeId;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i]!;
      const lineNumber = i + 1;
      const line = stripTrailingComment(rawLine).trim();
      if (!line) continue;

      const functionName = matchFunctionName(line);
      if (functionName) {
        const functionId = generateNodeId(this.filePath, 'function', functionName, lineNumber);
        this.nodes.push({
          id: functionId,
          kind: 'function',
          name: functionName,
          qualifiedName: `${this.filePath}::${functionName}`,
          filePath: this.filePath,
          language: 'shell',
          startLine: lineNumber,
          endLine: lineNumber,
          startColumn: rawLine.indexOf(functionName),
          endColumn: rawLine.length,
          signature: `${functionName}()`,
          updatedAt: Date.now(),
        });
        this.edges.push({ source: fileNodeId, target: functionId, kind: 'contains' });
        currentFunctionId = functionId;
        braceDepth = countBraceDelta(line);
        continue;
      }

      for (const command of extractCommands(line)) {
        this.unresolvedReferences.push({
          fromNodeId: currentFunctionId,
          referenceName: command,
          referenceKind: 'calls',
          line: lineNumber,
          column: rawLine.indexOf(command),
          filePath: this.filePath,
          language: 'shell',
        });
      }

      if (currentFunctionId !== fileNodeId) {
        braceDepth += countBraceDelta(line);
        if (braceDepth <= 0) {
          currentFunctionId = fileNodeId;
          braceDepth = 0;
        }
      }
    }
  }
}

function matchFunctionName(line: string): string | null {
  const functionKeyword = /^function\s+([A-Za-z_][A-Za-z0-9_-]*)\s*(?:\(\s*\))?\s*\{?/.exec(line);
  if (functionKeyword) return functionKeyword[1]!;

  const posixFunction = /^([A-Za-z_][A-Za-z0-9_-]*)\s*\(\s*\)\s*\{?/.exec(line);
  return posixFunction?.[1] ?? null;
}

function extractCommands(line: string): string[] {
  const commands: string[] = [];
  for (const segment of line.split(/[|;&]+/)) {
    const command = firstCommandToken(segment.trim());
    if (command) commands.push(command);
  }
  return commands;
}

function firstCommandToken(segment: string): string | null {
  if (!segment || segment === '{' || segment === '}') return null;
  if (/^(then|do|done|else|elif|fi|esac|case|if|for|while|until)\b/.test(segment)) return null;

  let remaining = segment;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(remaining)) {
    remaining = remaining.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s*/, '');
  }

  const match = /^([A-Za-z_./][A-Za-z0-9_./:-]*)/.exec(remaining);
  if (!match) return null;
  return path.basename(match[1]!);
}

function stripTrailingComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function countBraceDelta(line: string): number {
  let delta = 0;
  for (const ch of line) {
    if (ch === '{') delta++;
    if (ch === '}') delta--;
  }
  return delta;
}
