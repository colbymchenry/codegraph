import { Edge, ExtractionError, ExtractionResult, Node, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * MarkdownExtractor — parses Markdown and MDX files.
 *
 * Two extraction passes:
 *
 * Pass 1 — ATX headings (# … ######) → symbol nodes
 *   # H1  → kind='class'    (document title)
 *   ## H2 → kind='method'   (section)
 *   ###+  → kind='variable' (subsection)
 *   qualifiedName = `<filePath>::<slug>`
 *
 * Pass 2 — Mermaid code blocks (```mermaid) → technical identifier nodes
 *   Supported diagram types:
 *     flowchart / graph  → node labels with snake_case or dotted identifiers
 *     erDiagram          → entity names + field names from property blocks
 *     sequenceDiagram    → participant / actor technical names + message endpoints
 *     stateDiagram-v2    → state names from transition lines
 *   kind='variable', qualifiedName='mermaid::<type>::<identifier>'
 *   Each Mermaid node carries a `references` edge to its enclosing heading node,
 *   enabling `codegraph_callers(heading)` to surface diagrams within that section.
 *
 * Identifier extraction strategy:
 *   flowchart/sequence: require underscore or dot (TECH_ID_RE) — avoids natural-language noise
 *   erDiagram entities: same TECH_ID_RE (entity names are always snake_case)
 *   erDiagram fields:   any identifier ≥ 3 chars not in MERMAID_KEYWORDS
 *   stateDiagram states: any lowercase identifier ≥ 3 chars (states can be single words)
 *
 * Deduplication: a Set<string> per file prevents duplicate nodes when the same
 * identifier appears in multiple Mermaid blocks.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface MermaidSymbol {
  identifier: string;
  line: number;
  diagramType: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MERMAID_KEYWORDS = new Set([
  // Diagram type declarations
  'flowchart', 'graph', 'subgraph', 'erdiagram', 'sequencediagram',
  'statediagram', 'classdiagram', 'gantt', 'pie', 'gitgraph', 'mindmap', 'timeline',
  // Direction tokens
  'td', 'tb', 'bt', 'lr', 'rl',
  // Sequence diagram keywords
  'participant', 'actor', 'activate', 'deactivate', 'loop', 'alt',
  'opt', 'par', 'break', 'rect', 'note', 'autonumber', 'end', 'else',
  // State diagram keywords
  'state', 'fork', 'join', 'choice',
  // Flowchart keywords
  'classdef', 'style', 'linkstyle', 'click',
  // CSS-like properties appearing in classDef lines
  'fill', 'stroke', 'color', 'width', 'height', 'padding', 'margin',
  // Boolean/null literals
  'true', 'false', 'null', 'none',
  // Common ER field type keywords
  'string', 'int', 'float', 'boolean', 'char', 'text', 'date', 'datetime',
  'monetary', 'selection', 'many2one', 'one2many', 'many2many',
  'html', 'binary', 'integer', 'reference',
  // Very common English words ≥ 3 chars that appear in diagram labels
  'the', 'and', 'for', 'not', 'are', 'was', 'has', 'had', 'can', 'may',
  'will', 'from', 'with', 'this', 'that', 'via', 'per', 'any', 'all',
]);

/**
 * Matches snake_case or dotted.notation identifiers.
 * Requires at least one underscore OR dot — filters out plain English words.
 * Examples: action_validate_detraction, pay_state, partial.reconcile.create
 */
const TECH_ID_RE = /\b([a-z][a-z0-9]*(?:[._][a-z][a-z0-9]*)+)\b/g;

// ─── Extractor ────────────────────────────────────────────────────────────────

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
    const fileNode = this.createFileNode();

    try {
      const headingMap = this.extractHeadings(fileNode.id);
      this.parseMermaidBlocks(fileNode.id, headingMap);
    } catch (error) {
      this.errors.push({
        message: `Markdown extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  // ── Pass 1: Headings ────────────────────────────────────────────────────────

  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    const node: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'markdown',
      startLine: 1,
      endLine: lines.length || 1,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  /** Returns Map<lineNum (1-indexed), nodeId> for use by parseMermaidBlocks. */
  private extractHeadings(fileNodeId: string): Map<number, string> {
    const headingMap = new Map<number, string>();
    const lines = this.source.split('\n');
    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';

      if (/^```|^~~~/.test(line.trimStart())) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      const match = /^(#{1,6})\s+(.+)$/.exec(line);
      if (!match) continue;

      const level = match[1]!.length;
      const text = match[2]!.trim();
      const slug = this.slugify(text);
      const qualified = `${this.filePath}::${slug}`;
      const lineNum = i + 1;
      const kind = level === 1 ? 'class' : level === 2 ? 'method' : 'variable';

      const nodeId = generateNodeId(this.filePath, kind, qualified, lineNum);
      const node: Node = {
        id: nodeId,
        kind,
        name: text,
        qualifiedName: qualified,
        filePath: this.filePath,
        language: 'markdown',
        signature: `h${level}`,
        startLine: lineNum,
        endLine: lineNum,
        startColumn: 0,
        endColumn: line.length,
        updatedAt: Date.now(),
      };
      this.nodes.push(node);
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
      headingMap.set(lineNum, nodeId);
    }

    return headingMap;
  }

  // ── Pass 2: Mermaid blocks ──────────────────────────────────────────────────

  private parseMermaidBlocks(fileNodeId: string, headingMap: Map<number, string>): void {
    const lines = this.source.split('\n');
    const emitted = new Set<string>(); // per-file deduplication
    let i = 0;

    while (i < lines.length) {
      const line = lines[i] ?? '';

      if (/^```mermaid\s*$/i.test(line.trim())) {
        const blockContentStart = i + 1; // 0-indexed index of first block line
        let blockEndIndex = lines.length;
        for (let j = blockContentStart; j < lines.length; j++) {
          if (/^```\s*$/.test((lines[j] ?? '').trim())) {
            blockEndIndex = j;
            break;
          }
        }

        const blockLines = lines.slice(blockContentStart, blockEndIndex);
        // Find the nearest heading that precedes this ```mermaid line (1-indexed)
        const nearestHeadingId = this.findNearestHeading(i + 1, headingMap);
        const symbols = this.dispatchDiagram(blockLines, blockContentStart);
        this.emitMermaidNodes(symbols, fileNodeId, nearestHeadingId, emitted);

        i = blockEndIndex + 1;
      } else {
        i++;
      }
    }
  }

  private dispatchDiagram(blockLines: string[], lineOffset: number): MermaidSymbol[] {
    const firstLine = (blockLines[0] ?? '').trim().toLowerCase();

    if (firstLine.startsWith('flowchart') || /^graph\s/.test(firstLine)) {
      return this.parseFlowchart(blockLines, lineOffset);
    }
    if (firstLine === 'erdiagram') {
      return this.parseErDiagram(blockLines, lineOffset);
    }
    if (firstLine === 'sequencediagram') {
      return this.parseSequenceDiagram(blockLines, lineOffset);
    }
    if (firstLine.startsWith('statediagram')) {
      return this.parseStateDiagram(blockLines, lineOffset);
    }
    return []; // pie, gantt, gitGraph, etc. — skip gracefully
  }

  // ── Diagram parsers ─────────────────────────────────────────────────────────

  /**
   * flowchart / graph — extract TECH_ID_RE matches from node label text.
   * Labels are the content inside [], (), {} after a node identifier.
   * classDef references (:::name) are stripped before parsing.
   */
  private parseFlowchart(blockLines: string[], lineOffset: number): MermaidSymbol[] {
    const symbols: MermaidSymbol[] = [];
    // Matches content inside bracket styles used by Mermaid nodes
    const labelRe = /\[{1,2}([^\[\]]+)\]{1,2}|\(+([^)]+)\)+|\{([^}]+)\}/g;

    for (let i = 1; i < blockLines.length; i++) { // i=0 is diagram-type line
      const raw = blockLines[i] ?? '';
      const line = raw.replace(/:::[a-zA-Z_]+/g, ''); // strip class annotations
      const lineNum = lineOffset + i + 1;

      let m: RegExpExecArray | null;
      labelRe.lastIndex = 0;
      while ((m = labelRe.exec(line)) !== null) {
        const label = m[1] ?? m[2] ?? m[3] ?? '';
        this.extractTechIds(label, lineNum, 'flowchart', symbols);
      }
    }
    return symbols;
  }

  /**
   * erDiagram — entity names from relationship lines + field names from property blocks.
   * Relationship format: EntityA ||--o| EntityB : "label"
   * Property block format: EntityName { type fieldName "description" }
   */
  private parseErDiagram(blockLines: string[], lineOffset: number): MermaidSymbol[] {
    const symbols: MermaidSymbol[] = [];
    let inEntityBlock = false;

    for (let i = 1; i < blockLines.length; i++) {
      const trimmed = (blockLines[i] ?? '').trim();
      if (!trimmed) continue;
      const lineNum = lineOffset + i + 1;

      if (!inEntityBlock) {
        // Relationship line: EntityA <cardinality>--<cardinality> EntityB : "label"
        const relRe = /^([a-z][a-z0-9_]+)\s+[\|o*+{}]{0,4}--[\|o*+{}]{0,4}\s+([a-z][a-z0-9_]+)/;
        const rel = relRe.exec(trimmed);
        if (rel) {
          if (!MERMAID_KEYWORDS.has(rel[1]!.toLowerCase()))
            symbols.push({ identifier: rel[1]!, line: lineNum, diagramType: 'erDiagram' });
          if (!MERMAID_KEYWORDS.has(rel[2]!.toLowerCase()))
            symbols.push({ identifier: rel[2]!, line: lineNum, diagramType: 'erDiagram' });
          // Extract technical identifiers from relationship label
          const labelMatch = /:\s*"([^"]+)"/.exec(trimmed);
          if (labelMatch) this.extractTechIds(labelMatch[1]!, lineNum, 'erDiagram', symbols);
          continue;
        }

        // Entity block open: EntityName {
        if (/^[a-z][a-z0-9_]+\s*\{/.test(trimmed)) {
          inEntityBlock = true;
          continue;
        }
      } else {
        if (trimmed === '}') { inEntityBlock = false; continue; }

        // Field declaration: <type> <fieldName> ["description"]
        const fieldRe = /^(\w+)\s+([a-z][a-z0-9_]+)/;
        const field = fieldRe.exec(trimmed);
        if (field && !MERMAID_KEYWORDS.has(field[2]!.toLowerCase()))
          symbols.push({ identifier: field[2]!, line: lineNum, diagramType: 'erDiagram' });
      }
    }
    return symbols;
  }

  /**
   * sequenceDiagram — participant/actor technical names + message endpoints.
   * participant account_move as Label  →  captures account_move
   * sender->>receiver: message         →  captures both sender and receiver
   */
  private parseSequenceDiagram(blockLines: string[], lineOffset: number): MermaidSymbol[] {
    const symbols: MermaidSymbol[] = [];

    for (let i = 1; i < blockLines.length; i++) {
      const trimmed = (blockLines[i] ?? '').trim();
      const lineNum = lineOffset + i + 1;

      // participant / actor declarations
      const partRe = /^(?:participant|actor)\s+([a-z][a-z0-9_]+)/i;
      const part = partRe.exec(trimmed);
      if (part && !MERMAID_KEYWORDS.has(part[1]!.toLowerCase())) {
        symbols.push({ identifier: part[1]!, line: lineNum, diagramType: 'sequenceDiagram' });
        continue;
      }

      // Message lines: sender ->> receiver : message
      const senderRe = /^([a-z][a-z0-9_]+)\s*(?:->>?|-->>?)/i;
      const sender = senderRe.exec(trimmed);
      if (sender && !MERMAID_KEYWORDS.has(sender[1]!.toLowerCase()))
        symbols.push({ identifier: sender[1]!, line: lineNum, diagramType: 'sequenceDiagram' });

      const receiverRe = /(?:->>?|-->>?)\s*([a-z][a-z0-9_]+)\s*:/i;
      const receiver = receiverRe.exec(trimmed);
      if (receiver && !MERMAID_KEYWORDS.has(receiver[1]!.toLowerCase()))
        symbols.push({ identifier: receiver[1]!, line: lineNum, diagramType: 'sequenceDiagram' });
    }
    return symbols;
  }

  /**
   * stateDiagram-v2 — state names from transition lines.
   * draft --> posted : label  →  captures draft and posted
   * [*] --> draft             →  captures draft (skips [*])
   */
  private parseStateDiagram(blockLines: string[], lineOffset: number): MermaidSymbol[] {
    const symbols: MermaidSymbol[] = [];
    // Matches: state1 --> state2, [*] --> state, state --> [*]
    const transRe = /^([a-z][a-z0-9_]*|\[\*\])\s*-->\s*([a-z][a-z0-9_]*|\[\*\])/;

    for (let i = 1; i < blockLines.length; i++) {
      const trimmed = (blockLines[i] ?? '').trim();
      if (!trimmed) continue;
      const lineNum = lineOffset + i + 1;

      const m = transRe.exec(trimmed);
      if (!m) continue;

      for (const raw of [m[1]!, m[2]!]) {
        const clean = raw.replace(/[\[\]*]/g, '').trim(); // remove [*] brackets
        if (clean.length >= 3 && !MERMAID_KEYWORDS.has(clean.toLowerCase()))
          symbols.push({ identifier: clean, line: lineNum, diagramType: 'stateDiagram' });
      }
    }
    return symbols;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Extract snake_case / dotted identifiers from arbitrary text into symbols[]. */
  private extractTechIds(text: string, line: number, diagramType: string, out: MermaidSymbol[]): void {
    TECH_ID_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TECH_ID_RE.exec(text)) !== null) {
      if (!MERMAID_KEYWORDS.has(m[1]!.toLowerCase()))
        out.push({ identifier: m[1]!, line, diagramType });
    }
  }

  /**
   * Emit Node + edges for each deduplicated MermaidSymbol.
   * Each node links back to the file (contains) and to the enclosing heading (references).
   */
  private emitMermaidNodes(
    symbols: MermaidSymbol[],
    fileNodeId: string,
    nearestHeadingId: string | null,
    emitted: Set<string>,
  ): void {
    for (const sym of symbols) {
      const key = `${sym.diagramType}::${sym.identifier}`;
      if (emitted.has(key)) continue;
      emitted.add(key);

      const qualified = `mermaid::${sym.diagramType}::${sym.identifier}`;
      const nodeId = generateNodeId(this.filePath, 'variable', qualified, sym.line);
      const node: Node = {
        id: nodeId,
        kind: 'variable',
        name: sym.identifier,
        qualifiedName: qualified,
        filePath: this.filePath,
        language: 'markdown',
        signature: `mermaid-${sym.diagramType}`,
        startLine: sym.line,
        endLine: sym.line,
        startColumn: 0,
        endColumn: sym.identifier.length,
        updatedAt: Date.now(),
      };
      this.nodes.push(node);
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
      if (nearestHeadingId)
        this.edges.push({ source: nodeId, target: nearestHeadingId, kind: 'references' });
    }
  }

  /** Returns the nodeId of the nearest heading at or before lineNum. */
  private findNearestHeading(lineNum: number, headingMap: Map<number, string>): string | null {
    let best: string | null = null;
    let bestLine = 0;
    for (const [hLine, hId] of headingMap) {
      if (hLine <= lineNum && hLine > bestLine) {
        bestLine = hLine;
        best = hId;
      }
    }
    return best;
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[`*_[\]()]/g, '')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-');
  }
}
