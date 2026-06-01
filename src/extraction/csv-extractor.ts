import { Edge, ExtractionError, ExtractionResult, Node, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * CsvExtractor — parses CSV files with symbol-level extraction.
 *
 * Two modes depending on content detection:
 *
 * 1. Odoo ir.model.access.csv — detected by the canonical header:
 *    `id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink`
 *    Each data row is emitted as a `method` node:
 *      qualifiedName = `ir.model.access::<id>`
 *      signature     = `model=<model> group=<group> r=<r> w=<w> c=<c> d=<d>`
 *    This lets `codegraph_search("access_account_move")` find the rule and
 *    `codegraph_callers` surface which groups can write to a given model.
 *
 * 2. Generic CSV — any other file: just a file node (no symbols). The file
 *    is still tracked so the watcher can detect changes.
 */
export class CsvExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private lineStarts: number[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
    this.computeLineStarts();
  }

  isOdooAccessFile(): boolean {
    const firstLine = this.source.slice(0, 200).split('\n')[0]?.trim() ?? '';
    // Normalize whitespace/quotes for loose matching
    const normalized = firstLine.replace(/["'\s]/g, '').toLowerCase();
    return normalized.startsWith('id,name,model_id:id,group_id:id,perm_read');
  }

  /** T2-A: Detect model data CSV by filename (e.g. tipo.detraccion.csv → model tipo.detraccion) */
  isModelDataFile(): boolean {
    const basename = this.filePath.replace(/\\/g, '/').split('/').pop() ?? '';
    if (!basename.endsWith('.csv')) return false;
    const stem = basename.slice(0, -4);
    return stem.includes('.') && stem !== 'ir.model.access' && /^[a-z][a-z0-9.]+$/.test(stem);
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    const fileNode = this.createFileNode();

    try {
      if (this.isOdooAccessFile()) {
        this.extractOdooAccessRules(fileNode.id);
      } else if (this.isModelDataFile()) {
        this.extractModelDataFile(fileNode.id);
      }
      // Non-Odoo CSV: file node only — no symbols
    } catch (error) {
      this.errors.push({
        message: `CSV extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
      language: 'csv',
      startLine: 1,
      endLine: lines.length || 1,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  private extractModelDataFile(fileNodeId: string): void {
    const basename = this.filePath.replace(/\\/g, '/').split('/').pop() ?? '';
    const modelName = basename.slice(0, -4); // e.g. 'tipo.detraccion'
    // Emit ref to the model this file populates
    this.unresolvedReferences.push({
      fromNodeId: fileNodeId,
      referenceName: modelName,
      referenceKind: 'references',
      line: 1,
      column: 0,
    });
    // Emit field refs from header columns (skip id, :id, /id suffixes)
    const firstLine = this.source.split('\n')[0]?.trim() ?? '';
    const headers = this.parseCsvLine(firstLine);
    for (const header of headers) {
      const clean = header.replace(/['"]/g, '').trim();
      if (!clean || clean === 'id' || clean.endsWith(':id') || clean.endsWith('/id')) continue;
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: clean,
        referenceKind: 'references',
        line: 1,
        column: 0,
      });
    }
  }

  private extractOdooAccessRules(fileNodeId: string): void {
    const lines = this.source.split('\n');
    // Skip header row (index 0)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      const cols = this.parseCsvLine(line);
      // Expected columns: id, name, model_id:id, group_id:id, perm_read, perm_write, perm_create, perm_unlink
      if (cols.length < 5) continue;
      const [xmlId, name, modelId, groupId, permRead, permWrite, permCreate, permUnlink] = cols as [string, string, string, string, string, string, string, string];
      if (!xmlId) continue;

      const qualified = `ir.model.access::${xmlId}`;
      const nodeId = generateNodeId(this.filePath, 'method', qualified, i + 1);
      const sig = [
        modelId && `model=${modelId}`,
        groupId && `group=${groupId}`,
        `r=${permRead || '0'}`,
        `w=${permWrite || '0'}`,
        `c=${permCreate || '0'}`,
        `d=${permUnlink || '0'}`,
      ]
        .filter(Boolean)
        .join(' ');

      const node: Node = {
        id: nodeId,
        kind: 'method',
        name: name || xmlId,
        qualifiedName: qualified,
        filePath: this.filePath,
        language: 'csv',
        signature: sig,
        startLine: i + 1,
        endLine: i + 1,
        startColumn: 0,
        endColumn: line.length,
        updatedAt: Date.now(),
      };
      this.nodes.push(node);
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });

      // Emit reference to the model so callers can trace access → model
      if (modelId) {
        this.unresolvedReferences.push({
          fromNodeId: nodeId,
          referenceName: modelId,
          referenceKind: 'references',
          line: i + 1,
          column: 0,
        });
      }
    }
  }

  private parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  }

  private computeLineStarts(): void {
    this.lineStarts = [0];
    for (let i = 0; i < this.source.length; i++) {
      if (this.source.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }
}
