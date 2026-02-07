/**
 * SCIP JSON Import
 *
 * Adds high-confidence semantic reference edges from SCIP occurrence data.
 * This is additive and does not replace tree-sitter extraction.
 */

import * as fs from 'fs';
import * as path from 'path';
import { QueryBuilder } from '../db/queries';
import type {
  Edge,
  Node,
  ScipImportProgress,
  ScipImportResult,
  UnresolvedReference,
} from '../types';

const SCIP_SYMBOL_ROLE_DEFINITION = 1;
const SCIP_SYMBOL_ROLE_IMPORT = 2;
const MAX_TARGETS_PER_REFERENCE = 1;

interface ScipOccurrence {
  symbol: string;
  range: number[];
  symbol_roles?: number;
  symbolRoles?: number;
}

interface ScipDocument {
  relative_path?: string;
  relativePath?: string;
  occurrences?: ScipOccurrence[];
}

interface ScipIndexPayload {
  documents?: ScipDocument[];
}

interface ScipRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

type ProgressCallback = (progress: ScipImportProgress) => void;
type ResolveProgressPhase = 'mapping-definitions' | 'mapping-references' | 'done';
type ResolveProgressCallback = (progress: {
  phase: ResolveProgressPhase;
  current: number;
  total: number;
  detail?: string;
}) => void;

const LOCAL_SYMBOL_PREFIX = /^local\s+\d+$/;
const SCIP_RESOLUTION_COLUMN_WINDOW = 12;

interface ParsedScipDocuments {
  resolvedPath: string;
  fingerprint: string;
  documents: ScipDocument[];
}

export interface ScipResolvedReference {
  reference: UnresolvedReference;
  targetNodeId: string;
  confidence: number;
}

export interface ScipResolutionResult {
  resolved: ScipResolvedReference[];
  unresolved: UnresolvedReference[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeScipRange(range: number[]): ScipRange | null {
  if (range.length === 3) {
    const [startLine, startColumn, endColumn] = range;
    if (
      typeof startLine !== 'number' ||
      typeof startColumn !== 'number' ||
      typeof endColumn !== 'number'
    ) {
      return null;
    }
    return {
      startLine,
      startColumn,
      endLine: startLine,
      endColumn,
    };
  }

  if (range.length === 4) {
    const [startLine, startColumn, endLine, endColumn] = range;
    if (
      typeof startLine !== 'number' ||
      typeof startColumn !== 'number' ||
      typeof endLine !== 'number' ||
      typeof endColumn !== 'number'
    ) {
      return null;
    }
    return {
      startLine,
      startColumn,
      endLine,
      endColumn,
    };
  }

  return null;
}

function isDefinitionOccurrence(occurrence: ScipOccurrence): boolean {
  const roles = occurrence.symbol_roles ?? occurrence.symbolRoles ?? 0;
  return (roles & SCIP_SYMBOL_ROLE_DEFINITION) !== 0;
}

function isImportOccurrence(occurrence: ScipOccurrence): boolean {
  const roles = occurrence.symbol_roles ?? occurrence.symbolRoles ?? 0;
  return (roles & SCIP_SYMBOL_ROLE_IMPORT) !== 0;
}

function normalizeDocumentPath(projectRoot: string, rawPath: string): string {
  const withPosixSeparators = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!path.isAbsolute(withPosixSeparators)) {
    return withPosixSeparators;
  }

  const relative = path.relative(projectRoot, withPosixSeparators).replace(/\\/g, '/');
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }
  return withPosixSeparators;
}

function nodeContains(node: Node, range: ScipRange): boolean {
  const startLine = range.startLine + 1; // SCIP is 0-based line numbers
  const endLine = range.endLine + 1;

  if (startLine < node.startLine || endLine > node.endLine) return false;

  if (startLine === node.startLine && range.startColumn < node.startColumn) {
    return false;
  }
  if (endLine === node.endLine && range.endColumn > node.endColumn) {
    return false;
  }

  return true;
}

function pickBestContainingNode(nodes: Node[], range: ScipRange): Node | undefined {
  const candidates = nodes.filter((node) => nodeContains(node, range));
  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => {
    const aSpan = (a.endLine - a.startLine) * 10000 + (a.endColumn - a.startColumn);
    const bSpan = (b.endLine - b.startLine) * 10000 + (b.endColumn - b.startColumn);
    if (aSpan !== bSpan) return aSpan - bSpan;

    if (a.kind === 'file' && b.kind !== 'file') return 1;
    if (b.kind === 'file' && a.kind !== 'file') return -1;
    return 0;
  });

  return candidates[0];
}

function parseDocuments(input: unknown): ScipDocument[] {
  if (!isRecord(input)) return [];

  const direct = input.documents;
  if (Array.isArray(direct)) {
    return direct.filter((d): d is ScipDocument => isRecord(d));
  }

  if (Array.isArray(input)) {
    return input.filter((d): d is ScipDocument => isRecord(d));
  }

  return [];
}

function unresolvedReferenceKey(ref: UnresolvedReference): string {
  return `${ref.fromNodeId}|${ref.referenceName}|${ref.referenceKind}|${ref.line}|${ref.column}|${ref.filePath}`;
}

function simplifyReferenceName(name: string): string {
  const trimmed = name.trim();
  const token = trimmed.split(/\.|::|#/).pop() ?? trimmed;
  return token.replace(/\(\)$/g, '').trim();
}

function extractSymbolName(symbol: string): string | null {
  const trimmed = symbol.trim();
  if (!trimmed || LOCAL_SYMBOL_PREFIX.test(trimmed)) return null;

  let token = trimmed;
  const lastSlash = token.lastIndexOf('/');
  if (lastSlash >= 0) {
    token = token.slice(lastSlash + 1);
  } else if (token.includes(' ')) {
    token = token.split(/\s+/).pop() ?? token;
  }

  token = token
    .replace(/[#.;]+$/g, '')
    .replace(/\(\)$/g, '')
    .replace(/\.$/g, '')
    .trim();

  return token.length > 0 ? token : null;
}

function referenceKindCompatible(referenceKind: Edge['kind'], isImport: boolean): boolean {
  if (isImport) {
    return referenceKind === 'imports';
  }
  return referenceKind !== 'imports';
}

export function getScipFileFingerprint(indexPath: string): string {
  const stats = fs.statSync(indexPath);
  return `${stats.size}:${Math.trunc(stats.mtimeMs)}`;
}

export class ScipImporter {
  private static readonly MAX_DOCUMENT_CACHE_ENTRIES = 2;
  private static readonly documentCache = new Map<string, { fingerprint: string; documents: ScipDocument[] }>();

  private projectRoot: string;
  private queries: QueryBuilder;
  private nodesByFile = new Map<string, Node[]>();
  private nodesById = new Map<string, Node>();

  constructor(projectRoot: string, queries: QueryBuilder) {
    this.projectRoot = projectRoot;
    this.queries = queries;
  }

  importFromFile(indexPath: string, onProgress?: ProgressCallback): ScipImportResult {
    const { resolvedPath, documents } = this.loadDocuments(indexPath, onProgress);

    const symbolDefinitions = new Map<string, Set<string>>();
    let occurrencesScanned = 0;
    let definitionsMapped = 0;
    let referencesMapped = 0;

    // Pass 1: map definitions to concrete graph node IDs.
    for (let i = 0; i < documents.length; i++) {
      const document = documents[i]!;
      const rawPath = document.relative_path ?? document.relativePath;
      if (!rawPath || !Array.isArray(document.occurrences)) continue;
      const filePath = normalizeDocumentPath(this.projectRoot, rawPath);
      const nodes = this.getNodesForFile(filePath);

      for (const occurrence of document.occurrences) {
        occurrencesScanned++;
        if (!occurrence.symbol || !Array.isArray(occurrence.range)) continue;
        if (!isDefinitionOccurrence(occurrence)) continue;

        const range = normalizeScipRange(occurrence.range);
        if (!range) continue;

        const definitionNode = pickBestContainingNode(nodes, range);
        if (!definitionNode) continue;

        const symbolKey = this.symbolKeyForDocument(occurrence.symbol, filePath);
        const existing = symbolDefinitions.get(symbolKey) ?? new Set<string>();
        const before = existing.size;
        existing.add(definitionNode.id);
        symbolDefinitions.set(symbolKey, existing);
        if (existing.size > before) {
          definitionsMapped++;
        }
      }

      if ((i + 1) % 20 === 0 || i + 1 === documents.length) {
        onProgress?.({
          phase: 'mapping-definitions',
          current: i + 1,
          total: documents.length,
          detail: filePath,
        });
      }
    }

    // Pass 2: create semantic edges from references to mapped definitions.
    const importedEdgesByKey = new Map<string, Edge>();

    for (let i = 0; i < documents.length; i++) {
      const document = documents[i]!;
      const rawPath = document.relative_path ?? document.relativePath;
      if (!rawPath || !Array.isArray(document.occurrences)) continue;
      const filePath = normalizeDocumentPath(this.projectRoot, rawPath);
      const nodes = this.getNodesForFile(filePath);

      for (const occurrence of document.occurrences) {
        if (!occurrence.symbol || !Array.isArray(occurrence.range)) continue;
        if (isDefinitionOccurrence(occurrence)) continue;

        const symbolKey = this.symbolKeyForDocument(occurrence.symbol, filePath);
        const targets = symbolDefinitions.get(symbolKey);
        if (!targets || targets.size === 0) continue;

        const range = normalizeScipRange(occurrence.range);
        if (!range) continue;

        const sourceNode = pickBestContainingNode(nodes, range);
        if (!sourceNode) continue;
        const selectedTargets = this.selectTargets(sourceNode, targets);
        if (selectedTargets.length === 0) continue;
        referencesMapped++;

        const edgeKind: Edge['kind'] = isImportOccurrence(occurrence) ? 'imports' : 'references';
        const line = range.startLine + 1;
        const column = range.startColumn;

        for (const targetNodeId of selectedTargets) {
          if (targetNodeId === sourceNode.id) continue;
          const key = `${sourceNode.id}|${targetNodeId}|${edgeKind}`;
          const existing = importedEdgesByKey.get(key);
          if (existing) {
            const existingCount = Number((existing.metadata as Record<string, unknown> | undefined)?.scipOccurrences) || 1;
            existing.metadata = {
              ...(existing.metadata ?? {}),
              scipOccurrences: existingCount + 1,
            };
            continue;
          }

          importedEdgesByKey.set(key, {
            source: sourceNode.id,
            target: targetNodeId,
            kind: edgeKind,
            line,
            column,
            metadata: {
              source: 'scip',
              resolvedBy: 'scip',
              confidence: 0.98,
              scipOccurrences: 1,
            },
          });
        }
      }

      if ((i + 1) % 20 === 0 || i + 1 === documents.length) {
        onProgress?.({
          phase: 'mapping-references',
          current: i + 1,
          total: documents.length,
          detail: filePath,
        });
      }
    }

    const importedEdges = [...importedEdgesByKey.values()];

    // Replace previous SCIP-imported edges to keep repeated imports idempotent.
    onProgress?.({
      phase: 'writing-edges',
      current: 0,
      total: Math.max(importedEdges.length, 1),
      detail: 'Replacing prior SCIP edges',
    });
    this.queries.deleteEdgesByMetadataSource('scip');

    if (importedEdges.length > 0) {
      this.queries.insertEdges(importedEdges);
    }

    onProgress?.({
      phase: 'writing-edges',
      current: Math.max(importedEdges.length, 1),
      total: Math.max(importedEdges.length, 1),
      detail: `Inserted ${importedEdges.length} edges`,
    });
    onProgress?.({
      phase: 'done',
      current: 1,
      total: 1,
      detail: 'SCIP import complete',
    });

    return {
      indexPath: resolvedPath,
      documentsParsed: documents.length,
      occurrencesScanned,
      definitionsMapped,
      referencesMapped,
      importedEdges: importedEdges.length,
    };
  }

  resolveUnresolvedReferences(
    indexPath: string,
    unresolvedRefs: UnresolvedReference[],
    onProgress?: ResolveProgressCallback
  ): ScipResolutionResult {
    if (unresolvedRefs.length === 0) {
      return { resolved: [], unresolved: [] };
    }

    const { documents } = this.loadDocuments(indexPath);

    const symbolDefinitions = new Map<string, Set<string>>();

    // Pass 1: map definitions to concrete graph node IDs.
    for (let i = 0; i < documents.length; i++) {
      const document = documents[i]!;
      const rawPath = document.relative_path ?? document.relativePath;
      if (!rawPath || !Array.isArray(document.occurrences)) continue;
      const filePath = normalizeDocumentPath(this.projectRoot, rawPath);
      const nodes = this.getNodesForFile(filePath);

      for (const occurrence of document.occurrences) {
        if (!occurrence.symbol || !Array.isArray(occurrence.range)) continue;
        if (!isDefinitionOccurrence(occurrence)) continue;

        const range = normalizeScipRange(occurrence.range);
        if (!range) continue;

        const definitionNode = pickBestContainingNode(nodes, range);
        if (!definitionNode) continue;

        const symbolKey = this.symbolKeyForDocument(occurrence.symbol, filePath);
        const existing = symbolDefinitions.get(symbolKey) ?? new Set<string>();
        existing.add(definitionNode.id);
        symbolDefinitions.set(symbolKey, existing);
      }

      if ((i + 1) % 20 === 0 || i + 1 === documents.length) {
        onProgress?.({
          phase: 'mapping-definitions',
          current: i + 1,
          total: documents.length,
          detail: filePath,
        });
      }
    }

    const refsByFileLine = new Map<string, UnresolvedReference[]>();
    for (const ref of unresolvedRefs) {
      const key = `${ref.filePath}|${ref.line}`;
      const bucket = refsByFileLine.get(key) ?? [];
      bucket.push(ref);
      refsByFileLine.set(key, bucket);
    }

    const matched = new Set<string>();
    const resolved: ScipResolvedReference[] = [];

    // Pass 2: map occurrences to unresolved refs in the same file/line/source node.
    for (let i = 0; i < documents.length; i++) {
      const document = documents[i]!;
      const rawPath = document.relative_path ?? document.relativePath;
      if (!rawPath || !Array.isArray(document.occurrences)) continue;
      const filePath = normalizeDocumentPath(this.projectRoot, rawPath);
      const nodes = this.getNodesForFile(filePath);

      for (const occurrence of document.occurrences) {
        if (!occurrence.symbol || !Array.isArray(occurrence.range)) continue;
        if (isDefinitionOccurrence(occurrence)) continue;

        const range = normalizeScipRange(occurrence.range);
        if (!range) continue;
        const sourceNode = pickBestContainingNode(nodes, range);
        if (!sourceNode) continue;

        const symbolKey = this.symbolKeyForDocument(occurrence.symbol, filePath);
        const targets = symbolDefinitions.get(symbolKey);
        if (!targets || targets.size === 0) continue;
        const selectedTargets = this.selectTargets(sourceNode, targets);
        if (selectedTargets.length === 0) continue;
        const targetNodeId = selectedTargets[0]!;

        const line = range.startLine + 1;
        const column = range.startColumn;
        const lineBucket = refsByFileLine.get(`${filePath}|${line}`);
        if (!lineBucket || lineBucket.length === 0) continue;

        const symbolName = extractSymbolName(occurrence.symbol);
        const occurrenceIsImport = isImportOccurrence(occurrence);
        const candidates = lineBucket.filter((ref) => {
          if (matched.has(unresolvedReferenceKey(ref))) return false;
          if (ref.fromNodeId !== sourceNode.id) return false;
          if (!referenceKindCompatible(ref.referenceKind, occurrenceIsImport)) return false;
          if (Math.abs(ref.column - column) > SCIP_RESOLUTION_COLUMN_WINDOW) return false;
          if (!symbolName) return false;
          return simplifyReferenceName(ref.referenceName) === symbolName;
        });
        if (candidates.length === 0) continue;

        candidates.sort((a, b) => Math.abs(a.column - column) - Math.abs(b.column - column));
        const best = candidates[0]!;
        matched.add(unresolvedReferenceKey(best));
        resolved.push({
          reference: best,
          targetNodeId,
          confidence: 0.99,
        });
      }

      if ((i + 1) % 20 === 0 || i + 1 === documents.length) {
        onProgress?.({
          phase: 'mapping-references',
          current: i + 1,
          total: documents.length,
          detail: filePath,
        });
      }
    }

    const unresolved = unresolvedRefs.filter((ref) => !matched.has(unresolvedReferenceKey(ref)));
    onProgress?.({
      phase: 'done',
      current: 1,
      total: 1,
      detail: `Resolved ${resolved.length} references`,
    });
    return { resolved, unresolved };
  }

  private loadDocuments(indexPath: string, onProgress?: ProgressCallback): ParsedScipDocuments {
    const resolvedPath = path.isAbsolute(indexPath)
      ? indexPath
      : path.resolve(this.projectRoot, indexPath);
    const fingerprint = getScipFileFingerprint(resolvedPath);
    const cached = ScipImporter.documentCache.get(resolvedPath);

    if (cached && cached.fingerprint === fingerprint) {
      onProgress?.({
        phase: 'loading',
        current: 1,
        total: 1,
        detail: `Loaded ${cached.documents.length} documents (cache hit)`,
      });
      ScipImporter.touchDocumentCache(resolvedPath, cached);
      return {
        resolvedPath,
        fingerprint,
        documents: cached.documents,
      };
    }

    onProgress?.({
      phase: 'loading',
      current: 0,
      total: 1,
      detail: 'Reading SCIP JSON',
    });

    const raw = fs.readFileSync(resolvedPath, 'utf-8');
    const payload = JSON.parse(raw) as ScipIndexPayload | unknown;
    const documents = parseDocuments(payload);

    const entry = { fingerprint, documents };
    ScipImporter.touchDocumentCache(resolvedPath, entry);

    onProgress?.({
      phase: 'loading',
      current: 1,
      total: 1,
      detail: `Loaded ${documents.length} documents`,
    });

    return {
      resolvedPath,
      fingerprint,
      documents,
    };
  }

  private static touchDocumentCache(
    resolvedPath: string,
    entry: { fingerprint: string; documents: ScipDocument[] }
  ): void {
    if (ScipImporter.documentCache.has(resolvedPath)) {
      ScipImporter.documentCache.delete(resolvedPath);
    }
    ScipImporter.documentCache.set(resolvedPath, entry);
    while (ScipImporter.documentCache.size > ScipImporter.MAX_DOCUMENT_CACHE_ENTRIES) {
      const oldestKey = ScipImporter.documentCache.keys().next().value;
      if (!oldestKey) break;
      ScipImporter.documentCache.delete(oldestKey);
    }
  }

  private getNodesForFile(filePath: string): Node[] {
    if (!this.nodesByFile.has(filePath)) {
      this.nodesByFile.set(filePath, this.queries.getNodesByFile(filePath));
    }
    return this.nodesByFile.get(filePath) ?? [];
  }

  private getNodeById(nodeId: string): Node | undefined {
    if (!this.nodesById.has(nodeId)) {
      const node = this.queries.getNodeById(nodeId);
      if (node) {
        this.nodesById.set(nodeId, node);
      }
    }
    return this.nodesById.get(nodeId);
  }

  private symbolKeyForDocument(symbol: string, filePath: string): string {
    if (LOCAL_SYMBOL_PREFIX.test(symbol.trim())) {
      return `${filePath}::${symbol}`;
    }
    return symbol;
  }

  private selectTargets(sourceNode: Node, targets: Set<string>): string[] {
    if (targets.size === 0) return [];
    if (targets.size === 1) return [...targets];

    const targetNodes = [...targets]
      .map((nodeId) => this.getNodeById(nodeId))
      .filter((node): node is Node => Boolean(node));

    // Prefer same-file definitions for local/ambiguous references.
    const sameFile = targetNodes.filter((node) => node.filePath === sourceNode.filePath);
    if (sameFile.length === 1) return [sameFile[0]!.id];
    if (sameFile.length > 1) {
      sameFile.sort((a, b) => {
        const aSpan = (a.endLine - a.startLine) * 10000 + (a.endColumn - a.startColumn);
        const bSpan = (b.endLine - b.startLine) * 10000 + (b.endColumn - b.startColumn);
        return aSpan - bSpan;
      });
      return sameFile.slice(0, MAX_TARGETS_PER_REFERENCE).map((node) => node.id);
    }

    // Conservative default: choose only the best candidate to avoid edge explosions.
    targetNodes.sort((a, b) => {
      const aSpan = (a.endLine - a.startLine) * 10000 + (a.endColumn - a.startColumn);
      const bSpan = (b.endLine - b.startLine) * 10000 + (b.endColumn - b.startColumn);
      return aSpan - bSpan;
    });
    return targetNodes.slice(0, MAX_TARGETS_PER_REFERENCE).map((node) => node.id);
  }
}
