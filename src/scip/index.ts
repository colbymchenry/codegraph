/**
 * SCIP (Source Code Intelligence Protocol) Importer
 *
 * Imports SCIP JSON files to create precise cross-reference edges.
 * Uses two-pass processing: first collect definitions, then resolve references.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { QueryBuilder } from '../db/queries';
import { Edge, Node } from '../types';
import { logDebug, logWarn } from '../errors';
import { isPathWithinRoot } from '../utils';

interface SCIPDocument {
  relativePath: string;
  occurrences?: SCIPOccurrence[];
  symbols?: SCIPSymbolInfo[];
}

interface SCIPOccurrence {
  range: number[];
  symbol?: string;
  symbolRoles?: number;
}

interface SCIPSymbolInfo {
  symbol: string;
  documentation?: string[];
}

const SCIP_ROLE_DEFINITION = 1;

export class ScipImporter {
  private projectRoot: string;
  private queries: QueryBuilder;
  private symbolDefinitions: Map<string, Set<string>> = new Map();

  constructor(projectRoot: string, queries: QueryBuilder) {
    this.projectRoot = projectRoot;
    this.queries = queries;
  }

  /**
   * Parse a SCIP JSON file into documents
   */
  parseSCIPFile(filePath: string): SCIPDocument[] {
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.projectRoot, filePath);

    if (!isPathWithinRoot(fullPath, this.projectRoot)) {
      throw new Error('SCIP file path is outside the project root');
    }
    if (!fs.existsSync(fullPath)) {
      throw new Error(`SCIP file not found: ${fullPath}`);
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const data = JSON.parse(content);

    if (Array.isArray(data)) return data as SCIPDocument[];
    if (data.documents && Array.isArray(data.documents))
      return data.documents as SCIPDocument[];

    throw new Error(
      'Invalid SCIP format: expected {documents:[...]} or array of documents'
    );
  }

  /**
   * Build a map of symbol -> set of files where it's defined (pass 1)
   */
  buildSymbolDefinitions(
    documents: SCIPDocument[]
  ): Map<string, Set<string>> {
    const defs = new Map<string, Set<string>>();
    for (const doc of documents) {
      if (!doc.occurrences) continue;
      for (const occ of doc.occurrences) {
        if (!occ.symbol) continue;
        const isDefinition = (occ.symbolRoles ?? 0) & SCIP_ROLE_DEFINITION;
        if (isDefinition) {
          if (!defs.has(occ.symbol)) defs.set(occ.symbol, new Set());
          defs.get(occ.symbol)!.add(doc.relativePath);
        }
      }
    }
    return defs;
  }

  /**
   * Import a SCIP file, creating edges for cross-references (pass 2)
   */
  importSCIP(
    scipFilePath: string
  ): { edgesCreated: number; documentsProcessed: number } {
    const documents = this.parseSCIPFile(scipFilePath);

    // Content-hash fingerprinting for idempotent imports
    const fullPath = path.isAbsolute(scipFilePath)
      ? scipFilePath
      : path.join(this.projectRoot, scipFilePath);
    const contentHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(fullPath))
      .digest('hex');

    const lastHash = this.queries.getMetadata('scip_last_hash');
    if (lastHash === contentHash) {
      logDebug('SCIP file unchanged, skipping import', { scipFilePath });
      return { edgesCreated: 0, documentsProcessed: 0 };
    }

    // Pass 1: build definitions map
    this.symbolDefinitions = this.buildSymbolDefinitions(documents);

    let edgesCreated = 0;
    let documentsProcessed = 0;

    // Pass 2: resolve references
    for (const doc of documents) {
      if (!doc.occurrences) continue;

      if (!isPathWithinRoot(doc.relativePath, this.projectRoot)) {
        logWarn('SCIP document path outside project root', {
          path: doc.relativePath,
        });
        continue;
      }

      documentsProcessed++;
      const edges: Edge[] = [];

      for (const occ of doc.occurrences) {
        if (!occ.symbol) continue;

        const isDefinition = (occ.symbolRoles ?? 0) & SCIP_ROLE_DEFINITION;
        if (isDefinition) continue;

        const defFiles = this.symbolDefinitions.get(occ.symbol);
        if (!defFiles) continue;

        const line = occ.range[0] ?? 0;
        const sourceNodes = this.queries.getNodesByFile(doc.relativePath);
        const sourceNode = this.findBestSourceNode(sourceNodes, line);
        if (!sourceNode) continue;

        for (const defFile of defFiles) {
          if (defFile === doc.relativePath) continue;

          const targetNodes = this.queries.getNodesByFile(defFile);
          const symbolName = this.extractSymbolName(occ.symbol);
          const targetNode = targetNodes.find((n) => n.name === symbolName);
          if (!targetNode) continue;

          edges.push({
            source: sourceNode.id,
            target: targetNode.id,
            kind: 'references',
            line,
            column: occ.range[1],
            metadata: { confidence: 1.0, resolvedBy: 'scip' },
            provenance: 'scip',
          });
        }
      }

      if (edges.length > 0) {
        this.queries.insertEdges(edges);
        edgesCreated += edges.length;
      }
    }

    // Record import metadata
    this.queries.setMetadata('scip_last_hash', contentHash);
    this.queries.setMetadata(
      'scip_last_imported_at',
      new Date().toISOString()
    );
    this.queries.setMetadata('scip_edges_created', String(edgesCreated));

    return { edgesCreated, documentsProcessed };
  }

  /**
   * Find the closest node to a given line number in a file
   */
  private findBestSourceNode(nodes: Node[], line: number): Node | null {
    let best: Node | null = null;
    let bestDistance = Infinity;

    // Prefer nodes that contain the line
    for (const node of nodes) {
      if (node.startLine === undefined) continue;
      const distance = Math.abs(node.startLine - line);
      if (node.startLine <= line && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }

    // Fall back to nearest node
    if (!best) {
      for (const node of nodes) {
        if (node.startLine === undefined) continue;
        const distance = Math.abs(node.startLine - line);
        if (distance < bestDistance) {
          best = node;
          bestDistance = distance;
        }
      }
    }

    return best;
  }

  /**
   * Extract the symbol name from a SCIP symbol string
   */
  private extractSymbolName(symbol: string): string {
    const cleaned = symbol.replace(/[().#]+$/, '');
    const parts = cleaned.split(/[.\s#/]+/);
    return parts[parts.length - 1] || symbol;
  }

  /**
   * Auto-detect SCIP files in the project
   */
  static findSCIPFiles(projectRoot: string): string[] {
    const candidates = [
      'index.scip',
      'index.scip.json',
      'dump.scip',
      'dump.scip.json',
      'build/index.scip',
      'build/index.scip.json',
      'target/index.scip',
      'target/index.scip.json',
    ];
    const found: string[] = [];
    for (const c of candidates) {
      if (fs.existsSync(path.join(projectRoot, c))) found.push(c);
    }
    return found;
  }
}
