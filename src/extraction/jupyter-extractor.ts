import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';
import { isLanguageSupported } from './grammars';

/** IPython magic prefixes that are invalid Python syntax */
const MAGIC_PREFIXES = ['%%', '%', '!', '?'];

/**
 * Replace IPython magic lines with blank lines so tree-sitter doesn't
 * error on them. Blank lines preserve line-number offsets exactly.
 * Cell magics (`%%...`) on the first line skip the entire remaining
 * cell content — those are already single-statement cells, so
 * blanking just the first line is sufficient.
 */
function stripMagics(source: string): string {
  return source
    .split('\n')
    .map(line => {
      const trimmed = line.trimStart();
      if (MAGIC_PREFIXES.some(prefix => trimmed.startsWith(prefix))) {
        return '';
      }
      return line;
    })
    .join('\n');
}

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  metadata?: Record<string, unknown>;
}

interface NotebookFormat {
  nbformat?: number;
  metadata?: {
    kernelspec?: { language?: string };
    language_info?: { name?: string };
  };
  cells?: NotebookCell[];
}

/**
 * JupyterExtractor — indexes Python code cells in .ipynb notebooks.
 *
 * Each code cell is delegated to TreeSitterExtractor (python). Line numbers
 * are reported as virtual offsets: cell 0 starts at line 1, each subsequent
 * cell starts at (sum of lines in prior cells) + 1. This produces stable,
 * self-consistent line numbers even though they don't correspond to JSON
 * positions in the file.
 */
export class JupyterExtractor {
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

    let notebook: NotebookFormat;
    try {
      notebook = JSON.parse(this.source) as NotebookFormat;
    } catch (err) {
      this.errors.push({
        message: `Jupyter: failed to parse JSON — ${err instanceof Error ? err.message : String(err)}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
      return this.result(startTime);
    }

    // Only index Python kernels
    const kernelLang = (
      notebook.metadata?.kernelspec?.language ||
      notebook.metadata?.language_info?.name ||
      'python'
    ).toLowerCase();

    if (!kernelLang.includes('python')) {
      return this.result(startTime);
    }

    if (!isLanguageSupported('python')) {
      this.errors.push({
        message: 'Jupyter: Python grammar not available, cannot parse notebook cells',
        filePath: this.filePath,
        severity: 'warning',
      });
      return this.result(startTime);
    }

    // Module node representing the notebook file itself
    const cells = notebook.cells ?? [];
    const totalLines = cells.reduce((acc, cell) => {
      if (cell.cell_type !== 'code') return acc;
      const src = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
      return acc + src.split('\n').length;
    }, 0);

    const fileName = this.filePath.split(/[/\\]/).pop() ?? this.filePath;
    const moduleName = fileName.replace(/\.ipynb$/, '');
    const moduleId = generateNodeId(this.filePath, 'module', moduleName, 1);
    const moduleNode: Node = {
      id: moduleId,
      kind: 'module',
      name: moduleName,
      qualifiedName: `${this.filePath}::${moduleName}`,
      filePath: this.filePath,
      language: 'jupyter',
      startLine: 1,
      endLine: Math.max(1, totalLines),
      startColumn: 0,
      endColumn: 0,
      isExported: false,
      updatedAt: Date.now(),
    };
    this.nodes.push(moduleNode);

    // Process each code cell
    let virtualLineOffset = 0; // 0-indexed; startLine = virtualLineOffset + 1

    for (let cellIdx = 0; cellIdx < cells.length; cellIdx++) {
      const cell = cells[cellIdx]!;
      if (cell.cell_type !== 'code') continue;

      const rawSource = Array.isArray(cell.source)
        ? cell.source.join('')
        : (cell.source ?? '');

      if (!rawSource.trim()) {
        // Still advance the offset for blank cells to keep numbering stable
        virtualLineOffset += rawSource.split('\n').length;
        continue;
      }

      const cleanedSource = stripMagics(rawSource);
      this.processCell(cleanedSource, virtualLineOffset, moduleNode.id, cellIdx);

      virtualLineOffset += rawSource.split('\n').length;
    }

    return this.result(startTime);
  }

  private processCell(
    cellSource: string,
    lineOffset: number,
    moduleNodeId: string,
    cellIdx: number,
  ): void {
    const extractor = new TreeSitterExtractor(this.filePath, cellSource, 'python');
    const result = extractor.extract();

    for (const node of result.nodes) {
      node.startLine += lineOffset;
      node.endLine += lineOffset;
      node.language = 'jupyter';

      // Qualify name with cell index to avoid collisions when the same
      // variable name appears in multiple cells
      node.qualifiedName = `${this.filePath}::cell${cellIdx}::${node.name}`;

      this.nodes.push(node);
      this.edges.push({ source: moduleNodeId, target: node.id, kind: 'contains' });
    }

    for (const edge of result.edges) {
      if (edge.line !== undefined) {
        edge.line += lineOffset;
      }
      this.edges.push(edge);
    }

    for (const ref of result.unresolvedReferences) {
      ref.line += lineOffset;
      ref.filePath = this.filePath;
      ref.language = 'jupyter';
      this.unresolvedReferences.push(ref);
    }

    for (const error of result.errors) {
      if (error.line !== undefined) {
        error.line += lineOffset;
      }
      this.errors.push(error);
    }
  }

  private result(startTime: number): ExtractionResult {
    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }
}
