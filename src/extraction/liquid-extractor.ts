import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * LiquidExtractor - Extracts relationships from Liquid template files
 *
 * Liquid is a templating language (used by Shopify, Jekyll, etc.) that doesn't
 * have traditional functions or classes. Instead, we extract:
 * - Section references ({% section 'name' %})
 * - Snippet references ({% render 'name' %} and {% include 'name' %})
 * - Schema blocks ({% schema %}...{% endschema %})
 */
export class LiquidExtractor {
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

  /**
   * Extract from Liquid source
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      // Create file node
      const fileNode = this.createFileNode();

      // Shopify OS 2.0 JSON template / section group: link each section `type`
      // to its `sections/<type>.liquid` file. (No symbol nodes are emitted — the
      // JSON file just carries the references — so it stays out of any
      // symbol-bearing-file metric while its sections still get their dependents.)
      if (this.filePath.endsWith('.json')) {
        this.extractShopifyJsonSections(fileNode.id);
      } else {
        // Extract render/include statements (snippet references)
        this.extractSnippetReferences(fileNode.id);

        // Extract section references
        this.extractSectionReferences(fileNode.id);

        // Extract schema block
        this.extractSchema(fileNode.id);

        // Extract assign statements as variables
        this.extractAssignments(fileNode.id);
      }
    } catch (error) {
      this.errors.push({
        message: `Liquid extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  /**
   * Create a file node for the Liquid template
   */
  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);

    const fileNode: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'liquid',
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
   * Shopify OS 2.0 JSON template / section group. Both have a `sections` object
   * mapping an id → `{ "type": "<section-name>", ... }`; the `type` names a
   * `sections/<type>.liquid` file. Emit a `references` edge to each, so a section
   * used only from a JSON template (the OS 2.0 norm) is no longer orphaned.
   */
  private extractShopifyJsonSections(fromNodeId: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.source);
    } catch {
      return; // not valid JSON (or a partial) — nothing to link
    }
    const sections = (parsed as { sections?: Record<string, { type?: unknown }> })?.sections;
    if (!sections || typeof sections !== 'object') return;
    const seen = new Set<string>();
    for (const key of Object.keys(sections)) {
      const type = sections[key]?.type;
      if (typeof type !== 'string' || seen.has(type)) continue;
      seen.add(type);
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: `sections/${type}.liquid`,
        referenceKind: 'references',
        line: 1,
        column: 0,
      });
    }
  }

  /**
   * Every occurrence of a Liquid tag, in BOTH spellings it can be written in.
   *
   * Inside a `{% liquid %}` tag, each line of the body is a tag
   * WITHOUT braces of its own:
   *
   *   {% liquid
   *     assign heading = section.settings.title
   *     render 'card', title: heading
   *   %}
   *
   * A pattern anchored on `{%` misses these references and assignments.
   *
   * Returns real offsets into `this.source`, so callers keep using
   * getLineNumber/getLineStart unchanged.
   */
  private findTagOccurrences(
    tagPattern: string,
    argPattern: string,
  ): Array<{ fullMatch: string; groups: string[]; index: number }> {
    const found: Array<{ fullMatch: string; groups: string[]; index: number }> = [];

    /* `{% liquid ... %}` bodies, so the braced pass can skip them. Without this
       a body that itself contains `{%` (inside a string, say) could be counted
       twice. */
    const blocks: Array<{ start: number; end: number; bodyStart: number; body: string }> = [];
    const liquidTag = /\{%[-]?\s*liquid\b([\s\S]*?)[-]?%\}/g;
    let block;
    while ((block = liquidTag.exec(this.source)) !== null) {
      blocks.push({
        start: block.index,
        end: block.index + block[0].length,
        bodyStart: block.index + block[0].indexOf(block[1]!),
        body: block[1]!,
      });
    }

    const braced = new RegExp(`\\{%[-]?\\s*(${tagPattern})\\s+${argPattern}`, 'g');
    let match;
    while ((match = braced.exec(this.source)) !== null) {
      if (blocks.some((b) => match!.index >= b.start && match!.index < b.end)) continue;
      found.push({ fullMatch: match[0], groups: match.slice(1) as string[], index: match.index });
    }

    /* Inside a `{% liquid %}` body each tag starts its own line. Anchoring on
       the line start is what keeps `render` in `{{ product | render_as }}` or
       in an inline `#` comment from being read as a tag. */
    const bare = new RegExp(`^[ \\t]*(${tagPattern})\\s+${argPattern}`, 'gm');
    for (const b of blocks) {
      let inner;
      const re = new RegExp(bare.source, 'gm');
      while ((inner = re.exec(b.body)) !== null) {
        found.push({
          fullMatch: inner[0].trimStart(),
          groups: inner.slice(1) as string[],
          index: b.bodyStart + inner.index + (inner[0].length - inner[0].trimStart().length),
        });
      }
    }

    return found.sort((a, b) => a.index - b.index);
  }

  /**
   * Extract {% render 'snippet' %} and {% include 'snippet' %} references
   */
  private extractSnippetReferences(fileNodeId: string): void {
    // Both spellings: {% render 'name' %} and a bare `render 'name'` line
    // inside a {% liquid %} block.
    for (const match of this.findTagOccurrences('render|include', `['"]([^'"]+)['"]`)) {
      const fullMatch = match.fullMatch;
      const [tagType, snippetName] = match.groups;
      const line = this.getLineNumber(match.index);

      // Create an import node for searchability
      const importNodeId = generateNodeId(this.filePath, 'import', snippetName!, line);
      const importNode: Node = {
        id: importNodeId,
        kind: 'import',
        name: snippetName!,
        qualifiedName: `${this.filePath}::import:${snippetName}`,
        filePath: this.filePath,
        language: 'liquid',
        signature: fullMatch,
        startLine: line,
        endLine: line,
        startColumn: match.index - this.getLineStart(line),
        endColumn: match.index - this.getLineStart(line) + fullMatch.length,
        updatedAt: Date.now(),
      };
      this.nodes.push(importNode);

      // Add containment edge from file to import
      this.edges.push({
        source: fileNodeId,
        target: importNodeId,
        kind: 'contains',
      });

      // Create a component node for the snippet reference
      const nodeId = generateNodeId(this.filePath, 'component', `${tagType}:${snippetName}`, line);

      const node: Node = {
        id: nodeId,
        kind: 'component',
        name: snippetName!,
        qualifiedName: `${this.filePath}::${tagType}:${snippetName}`,
        filePath: this.filePath,
        language: 'liquid',
        startLine: line,
        endLine: line,
        startColumn: match.index - this.getLineStart(line),
        endColumn: match.index - this.getLineStart(line) + fullMatch.length,
        updatedAt: Date.now(),
      };

      this.nodes.push(node);

      // Add containment edge from file
      this.edges.push({
        source: fileNodeId,
        target: nodeId,
        kind: 'contains',
      });

      // Add unresolved reference to the snippet file
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: `snippets/${snippetName}.liquid`,
        referenceKind: 'references',
        line,
        column: match.index - this.getLineStart(line),
      });
    }
  }

  /**
   * Extract {% section 'name' %} references
   */
  private extractSectionReferences(fileNodeId: string): void {
    // Both spellings, as for render/include above.
    for (const match of this.findTagOccurrences('section', `['"]([^'"]+)['"]`)) {
      const fullMatch = match.fullMatch;
      const sectionName = match.groups[1];
      const line = this.getLineNumber(match.index);

      // Create an import node for searchability
      const importNodeId = generateNodeId(this.filePath, 'import', sectionName!, line);
      const importNode: Node = {
        id: importNodeId,
        kind: 'import',
        name: sectionName!,
        qualifiedName: `${this.filePath}::import:${sectionName}`,
        filePath: this.filePath,
        language: 'liquid',
        signature: fullMatch,
        startLine: line,
        endLine: line,
        startColumn: match.index - this.getLineStart(line),
        endColumn: match.index - this.getLineStart(line) + fullMatch.length,
        updatedAt: Date.now(),
      };
      this.nodes.push(importNode);

      // Add containment edge from file to import
      this.edges.push({
        source: fileNodeId,
        target: importNodeId,
        kind: 'contains',
      });

      // Create a component node for the section reference
      const nodeId = generateNodeId(this.filePath, 'component', `section:${sectionName}`, line);

      const node: Node = {
        id: nodeId,
        kind: 'component',
        name: sectionName!,
        qualifiedName: `${this.filePath}::section:${sectionName}`,
        filePath: this.filePath,
        language: 'liquid',
        startLine: line,
        endLine: line,
        startColumn: match.index - this.getLineStart(line),
        endColumn: match.index - this.getLineStart(line) + fullMatch.length,
        updatedAt: Date.now(),
      };

      this.nodes.push(node);

      // Add containment edge from file
      this.edges.push({
        source: fileNodeId,
        target: nodeId,
        kind: 'contains',
      });

      // Add unresolved reference to the section file
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: `sections/${sectionName}.liquid`,
        referenceKind: 'references',
        line,
        column: match.index - this.getLineStart(line),
      });
    }
  }

  /**
   * Extract {% schema %}...{% endschema %} blocks
   */
  private extractSchema(fileNodeId: string): void {
    // Match {% schema %}...{% endschema %}
    const schemaRegex = /\{%[-]?\s*schema\s*[-]?%\}([\s\S]*?)\{%[-]?\s*endschema\s*[-]?%\}/g;
    let match;

    while ((match = schemaRegex.exec(this.source)) !== null) {
      const [fullMatch, schemaContent] = match;
      const startLine = this.getLineNumber(match.index);
      const endLine = this.getLineNumber(match.index + fullMatch.length);

      // Try to parse the schema JSON to get the name
      let schemaName = 'schema';
      try {
        const schemaJson = JSON.parse(schemaContent!);
        if (schemaJson.name) {
          // Shopify schema names can be translation objects like {"en": "...", "fr": "..."}
          schemaName = typeof schemaJson.name === 'string'
            ? schemaJson.name
            : schemaJson.name.en || Object.values(schemaJson.name)[0] as string || 'schema';
        }
      } catch {
        // Schema isn't valid JSON, use default name
      }

      // Create a node for the schema
      const nodeId = generateNodeId(this.filePath, 'constant', `schema:${schemaName}`, startLine);

      const node: Node = {
        id: nodeId,
        kind: 'constant',
        name: schemaName,
        qualifiedName: `${this.filePath}::schema:${schemaName}`,
        filePath: this.filePath,
        language: 'liquid',
        startLine,
        endLine,
        startColumn: match.index - this.getLineStart(startLine),
        endColumn: 0,
        // SECURITY (#383): don't dump the raw {% schema %} JSON (section settings
        // + default values) into the docstring — the schema name is already in
        // `name`, so the data block adds nothing but a potential leak of any
        // IDs/endpoints/keys a developer placed in setting defaults.
        updatedAt: Date.now(),
      };

      this.nodes.push(node);

      // Add containment edge from file
      this.edges.push({
        source: fileNodeId,
        target: nodeId,
        kind: 'contains',
      });
    }
  }

  /**
   * Extract {% assign var = value %} statements
   */
  private extractAssignments(fileNodeId: string): void {
    // Both spellings. Most of a modern theme's assigns are the bare kind.
    for (const match of this.findTagOccurrences('assign', `(\\w+)\\s*=`)) {
      const variableName = match.groups[1];
      const line = this.getLineNumber(match.index);

      // Create a variable node
      const nodeId = generateNodeId(this.filePath, 'variable', variableName!, line);

      const node: Node = {
        id: nodeId,
        kind: 'variable',
        name: variableName!,
        qualifiedName: `${this.filePath}::${variableName}`,
        filePath: this.filePath,
        language: 'liquid',
        startLine: line,
        endLine: line,
        startColumn: match.index - this.getLineStart(line),
        endColumn: match.index - this.getLineStart(line) + match.fullMatch.length,
        updatedAt: Date.now(),
      };

      this.nodes.push(node);

      // Add containment edge from file
      this.edges.push({
        source: fileNodeId,
        target: nodeId,
        kind: 'contains',
      });
    }
  }

  /**
   * Get the line number for a character index
   */
  private getLineNumber(index: number): number {
    const substring = this.source.substring(0, index);
    return (substring.match(/\n/g) || []).length + 1;
  }

  /**
   * Get the character index of the start of a line
   */
  private getLineStart(lineNumber: number): number {
    const lines = this.source.split('\n');
    let index = 0;
    for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
      index += lines[i]!.length + 1; // +1 for newline
    }
    return index;
  }
}
