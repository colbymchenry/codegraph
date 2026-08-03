import * as path from 'path';
import type { ExtractionResult, Language, Node, NodeKind, UnresolvedReference } from '../types';
import { extractPowershellDependencies } from '../powershell-dependencies';
import { generateNodeId } from './tree-sitter-helpers';

const SHADER_PATH_RE = /\b[^\s"']+\.(?:glsl|vert|frag|comp|geom|tesc|tese|rgen|rmiss|rchit|rahit|rint|rcall|mesh|task|hlsl|hlsli|fx|fxh|spv)\b/gi;

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split(/\r?\n/).length;
}

function findMatchingBrace(source: string, open: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '#' && next === '>') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (quote === '"' && ch === '`') { i++; continue; }
      if (ch === quote) {
        if (quote === "'" && next === "'") { i++; continue; }
        quote = null;
      }
      continue;
    }
    if (ch === '<' && next === '#') { blockComment = true; i++; continue; }
    if (ch === '#') { lineComment = true; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return source.length;
}

function fileNode(filePath: string, source: string, language: Language): Node {
  const lines = source.split(/\r?\n/);
  return {
    id: generateNodeId(filePath, 'file', filePath, 1),
    kind: 'file',
    name: path.basename(filePath),
    qualifiedName: filePath,
    filePath,
    language,
    startLine: 1,
    endLine: lines.length,
    startColumn: 0,
    endColumn: lines.at(-1)?.length ?? 0,
    updatedAt: Date.now(),
  };
}

function createNode(filePath: string, language: Language, kind: NodeKind, name: string, line: number, signature?: string): Node {
  return {
    id: generateNodeId(filePath, kind, name, line),
    kind,
    name,
    qualifiedName: name,
    filePath,
    language,
    signature,
    startLine: line,
    endLine: line,
    startColumn: 0,
    endColumn: signature?.length ?? name.length,
    updatedAt: Date.now(),
  };
}

function addShaderReferences(filePath: string, language: Language, source: string, fromNodeId: string, refs: UnresolvedReference[]): void {
  for (const match of source.matchAll(SHADER_PATH_RE)) {
    const name = match[0];
    refs.push({
      fromNodeId,
      referenceName: name,
      referenceKind: 'references',
      line: lineOf(source, match.index ?? 0),
      column: 0,
      filePath,
      language,
    });
  }
}

export function extractCmake(filePath: string, source: string): ExtractionResult {
  const language: Language = 'cmake';
  const file = fileNode(filePath, source, language);
  const nodes: Node[] = [file];
  const edges: ExtractionResult['edges'] = [];
  const unresolvedReferences: UnresolvedReference[] = [];
  const add = (kind: NodeKind, name: string, line: number, signature?: string) => {
    const n = createNode(filePath, language, kind, name, line, signature);
    nodes.push(n);
    edges.push({ source: file.id, target: n.id, kind: 'contains' as const });
    return n;
  };

  for (const match of source.matchAll(/\b(function|macro)\s*\(\s*([A-Za-z_]\w*)/gi)) {
    add('function', match[2]!, lineOf(source, match.index ?? 0), match[0]);
  }
  for (const match of source.matchAll(/\b(?:set|option|set_property)\s*\(\s*([A-Za-z_]\w*)/gi)) {
    add('variable', match[1]!, lineOf(source, match.index ?? 0), match[0]);
  }
  addShaderReferences(filePath, language, source, file.id, unresolvedReferences);
  for (const match of source.matchAll(/\b(?:include|add_subdirectory|find_package)\s*\(\s*["']?([^\s"')]+)/gi)) {
    unresolvedReferences.push({
      fromNodeId: file.id,
      referenceName: match[1]!,
      referenceKind: 'imports',
      line: lineOf(source, match.index ?? 0),
      column: 0,
      filePath,
      language,
    });
  }
  return { nodes, edges, unresolvedReferences, errors: [], durationMs: 0 };
}

export function extractPowershell(filePath: string, source: string): ExtractionResult {
  const language: Language = 'powershell';
  const file = fileNode(filePath, source, language);
  const nodes: Node[] = [file];
  const edges: ExtractionResult['edges'] = [];
  const unresolvedReferences: UnresolvedReference[] = [];
  const importedScripts = new Set<string>();
  for (const dependency of extractPowershellDependencies(source)) {
    const dependencyPath = path.posix.normalize(path.posix.join(
      path.posix.dirname(filePath.replace(/\\/g, '/')),
      dependency.relativePath.replace(/\\/g, '/'),
    ));
    if (dependencyPath.startsWith('../') || importedScripts.has(dependencyPath.toLowerCase())) continue;
    importedScripts.add(dependencyPath.toLowerCase());
    const line = lineOf(source, dependency.index);
    const imported = createNode(filePath, language, 'import', dependency.kind === 'module' ? 'Import-Module' : 'dot-source', line, dependency.signature);
    nodes.push(imported);
    edges.push({ source: file.id, target: imported.id, kind: 'contains' as const });
    unresolvedReferences.push({
      fromNodeId: file.id,
      referenceName: dependencyPath,
      referenceKind: 'imports',
      line,
      column: 0,
      filePath,
      language,
    });
  }
  const functionNodes = new Map<string, Node>();
  const functionRanges = new Map<string, { start: number; end: number }>();
  for (const match of source.matchAll(/^[ \t]*function\s+([A-Za-z_]\w*(?:-[A-Za-z_]\w*)*)/gim)) {
    const start = match.index ?? 0;
    const name = match[1]!;
    const open = source.indexOf('{', start + match[0].length);
    const close = open >= 0 ? findMatchingBrace(source, open) : start + match[0].length;
    const n = createNode(filePath, language, 'function', name, lineOf(source, start + match[0].indexOf('function')), match[0].trim());
    n.endLine = lineOf(source, close);
    n.endColumn = close - source.lastIndexOf('\n', close) - 1;
    nodes.push(n);
    edges.push({ source: file.id, target: n.id, kind: 'contains' as const });
    functionNodes.set(name.toLowerCase(), n);
    functionRanges.set(n.id, { start: open, end: close });
  }
  const variables = new Set<string>();
  for (const match of source.matchAll(/(?:^|[;\r\n])[ \t]*\$([A-Za-z_]\w*)\s*=/g)) {
    const name = match[1]!;
    const tokenOffset = match[0].lastIndexOf(`$${name}`);
    const absolute = (match.index ?? 0) + Math.max(0, tokenOffset);
    if ([...functionRanges.values()].some((range) => absolute >= range.start && absolute <= range.end)) continue;
    if (variables.has(name.toLowerCase())) continue;
    variables.add(name.toLowerCase());
    const n = createNode(filePath, language, 'variable', name, lineOf(source, absolute), match[0].trim());
    nodes.push(n);
    edges.push({ source: file.id, target: n.id, kind: 'contains' as const });
  }
  // Resolve direct PowerShell command invocations against functions declared in
  // the same file. The resolver then extends this to same-language definitions
  // in included/project scripts without treating every external cmdlet as user code.
  for (const fn of functionNodes.values()) {
    const range = functionRanges.get(fn.id);
    const bodyStart = range?.start ?? -1;
    const bodyEnd = range?.end ?? source.length;
    const body = source.slice(bodyStart + 1, bodyEnd);
    for (const call of body.matchAll(/(?<![\w-])(?:&[ \t]*)?([A-Za-z_]\w*(?:-[A-Za-z_]\w*)*)\b/g)) {
      const target = functionNodes.get(call[1]!.toLowerCase());
      if ((!target && !call[1]!.includes('-')) || target?.id === fn.id || /^(?:Import-Module|Export-ModuleMember)$/i.test(call[1]!)) continue;
      const absolute = bodyStart + 1 + (call.index ?? 0) + call[0].lastIndexOf(call[1]!);
      unresolvedReferences.push({
        fromNodeId: fn.id,
        referenceName: call[1]!,
        referenceKind: 'calls',
        line: lineOf(source, absolute),
        column: 0,
        filePath,
        language,
      });
    }
  }
  // Script-scope invocations are executable PowerShell too. Keep them on the
  // file node so callers still shows the script entry point when no enclosing
  // function exists (the common orchestration-script layout).
  for (const call of source.matchAll(/(?<![\w-])(?:&[ \t]*)?([A-Za-z_]\w*(?:-[A-Za-z_]\w*)*)\b/g)) {
    const target = functionNodes.get(call[1]!.toLowerCase());
    if ((!target && !call[1]!.includes('-')) || /^(?:Import-Module|Export-ModuleMember)$/i.test(call[1]!)) continue;
    const absolute = (call.index ?? 0) + call[0].lastIndexOf(call[1]!);
    if ([...functionRanges.values()].some((range) => absolute >= range.start && absolute <= range.end)) continue;
    const lineStart = source.lastIndexOf('\n', absolute) + 1;
    if (/^[ \t]*function\s+/i.test(source.slice(lineStart, absolute))) continue;
    const lineEnd = source.indexOf('\n', absolute);
    const lineText = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
    if (/^[ \t]*Export-ModuleMember\b/i.test(lineText)) continue;
    unresolvedReferences.push({
      fromNodeId: file.id,
      referenceName: call[1]!,
      referenceKind: 'calls',
      line: lineOf(source, absolute),
      column: 0,
      filePath,
      language,
    });
  }
  addShaderReferences(filePath, language, source, file.id, unresolvedReferences);
  for (const match of source.matchAll(/(?:&|Start-Process|Invoke-Expression)\s+["']([^"']+)["']/gi)) {
    const invokedPath = match[1]!;
    if (invokedPath.includes('$') || /\.(?:exe|cmd|bat|com)$/i.test(invokedPath)) continue;
    if (!/\.(?:ps1|psm1)$/i.test(invokedPath)) continue;
    unresolvedReferences.push({
      fromNodeId: file.id,
      referenceName: invokedPath,
      referenceKind: 'references',
      line: lineOf(source, match.index ?? 0),
      column: 0,
      filePath,
      language,
    });
  }
  return { nodes, edges, unresolvedReferences, errors: [], durationMs: 0 };
}
