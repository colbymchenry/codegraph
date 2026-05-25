import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * HugoMarkdownExtractor — Extracts navigable structure from Hugo content files.
 *
 * Indexed:
 *   - Front matter fields (YAML, TOML, JSON) → property nodes
 *   - Markdown headings (#–######)          → class (h1) / function (h2+) nodes
 *
 * Front matter formats:
 *   --- ... ---   YAML  (default Hugo)
 *   +++ ... +++   TOML
 *   --- { ... } --- JSON (rare)
 *
 * Spec: docs/04-HUGO-CONTENT.md
 */

const YAML_FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\s*\r?\n/;
const TOML_FM_RE = /^\+\+\+\r?\n([\s\S]*?)\r?\n\+\+\+\s*\r?\n/;
const JSON_FM_RE = /^---\r?\n(\{[\s\S]*?\})\r?\n---\s*\r?\n/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/gm;

// Front matter fields surfaced as standalone nodes. Other fields are still
// parsed (and available via the file node) but don't get their own node.
const RECOGNIZED_FIELDS = new Set([
  'title', 'date', 'draft', 'tags', 'categories',
  'description', 'slug', 'url', 'weight',
  'author', 'series', 'lastmod', 'expirydate',
  'publishdate', 'type', 'layout', 'aliases',
]);

export class HugoMarkdownExtractor {
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
      const { frontMatter, bodyOffset } = this.parseFrontMatter();

      if (frontMatter) {
        this.extractFrontMatterFields(fileNode.id, frontMatter);
      }

      this.extractHeadings(fileNode.id, bodyOffset);
    } catch (error) {
      this.errors.push({
        message: `Hugo Markdown extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
    const name = (this.filePath.split(/[/\\]/).pop() || this.filePath).replace(/\.(md|markdown)$/, '');

    const fileNode: Node = {
      id,
      kind: 'file',
      name,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'markdown',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      updatedAt: Date.now(),
    };

    this.nodes.push(fileNode);
    return fileNode;
  }

  /**
   * Detects and parses front matter. Returns the parsed object and the
   * character offset where the markdown body begins (used for heading line
   * numbers).
   */
  private parseFrontMatter(): { frontMatter: Record<string, unknown> | null; bodyOffset: number } {
    // YAML
    const yamlMatch = this.source.match(YAML_FM_RE);
    if (yamlMatch && !yamlMatch[1]!.trim().startsWith('{')) {
      try {
        // js-yaml is a transitive dep via the existing CodeGraph deps.
        // If not available, install: npm install --save js-yaml
        const yaml = require('js-yaml');
        const parsed = yaml.load(yamlMatch[1]!) as Record<string, unknown> ?? {};
        return { frontMatter: parsed, bodyOffset: yamlMatch[0]!.length };
      } catch (err) {
        this.errors.push({
          message: `YAML front matter parse failed: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'warning',
          code: 'frontmatter_parse_error',
        });
      }
    }

    // JSON (embedded in --- delimiters)
    const jsonMatch = this.source.match(JSON_FM_RE);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]!) as Record<string, unknown>;
        return { frontMatter: parsed, bodyOffset: jsonMatch[0]!.length };
      } catch (err) {
        this.errors.push({
          message: `JSON front matter parse failed: ${err instanceof Error ? err.message : String(err)}`,
          severity: 'warning',
          code: 'frontmatter_parse_error',
        });
      }
    }

    // TOML — requires optional @iarna/toml dep
    const tomlMatch = this.source.match(TOML_FM_RE);
    if (tomlMatch) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const toml = require('@iarna/toml');
        const parsed = toml.parse(tomlMatch[1]!) as Record<string, unknown>;
        return { frontMatter: parsed, bodyOffset: tomlMatch[0]!.length };
      } catch {
        // @iarna/toml not installed — silently skip TOML parsing, still extract headings
      }
    }

    return { frontMatter: null, bodyOffset: 0 };
  }

  private extractFrontMatterFields(fileNodeId: string, frontMatter: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(frontMatter)) {
      if (!RECOGNIZED_FIELDS.has(key)) continue;

      const nodeId = generateNodeId(this.filePath, 'property', `fm:${key}`, 1);
      const signature = this.serialiseValue(value);

      this.nodes.push({
        id: nodeId,
        kind: 'property',
        name: key,
        qualifiedName: `${this.filePath}::${key}`,
        filePath: this.filePath,
        language: 'markdown',
        signature,
        docstring: key === 'title' && typeof value === 'string' ? value : undefined,
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      });

      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
    }
  }

  private extractHeadings(fileNodeId: string, bodyOffset: number): void {
    const body = this.source.substring(bodyOffset);
    // Pre-compute the number of newlines before the body so headings get
    // correct line numbers relative to the whole file.
    const linesBeforeBody = (this.source.substring(0, bodyOffset).match(/\n/g) || []).length;

    HEADING_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = HEADING_RE.exec(body)) !== null) {
      const level = match[1]!.length;
      const text = match[2]!.trim();
      const lineInBody = (body.substring(0, match.index).match(/\n/g) || []).length + 1;
      const line = linesBeforeBody + lineInBody;

      const kind = level === 1 ? 'class' : 'function';
      const nodeId = generateNodeId(this.filePath, kind, `h${level}:${text}`, line);

      this.nodes.push({
        id: nodeId,
        kind,
        name: text,
        qualifiedName: `${this.filePath}::h${level}:${text}`,
        filePath: this.filePath,
        language: 'markdown',
        signature: `${'#'.repeat(level)} ${text}`,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0]!.length,
        updatedAt: Date.now(),
      });

      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
    }
  }

  private serialiseValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.substring(0, 120);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(v => String(v)).join(', ').substring(0, 120);
    try {
      return JSON.stringify(value).substring(0, 120);
    } catch {
      return String(value).substring(0, 120);
    }
  }
}
