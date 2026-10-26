import { parseTree, findNodeAtLocation, type ParseError } from 'jsonc-parser';
import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId, NodeIdAllocator } from './tree-sitter-helpers';

/**
 * LiquidExtractor - Extracts relationships from Liquid template files
 *
 * Liquid is a templating language (used by Shopify, Jekyll, etc.) that doesn't
 * have traditional functions or classes. Instead, we extract:
 * - Section references ({% section 'name' %}) and section group references
 *   ({% sections 'header-group' %} → `sections/header-group.json`)
 * - Snippet references ({% render 'name' %} and {% include 'name' %})
 * - Schema blocks ({% schema %}...{% endschema %})
 * - Variables declared with {% assign %} and {% capture %}
 * - The sections a Shopify JSON template or section group lists
 */
export class LiquidExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private nodeIds = new NodeIdAllocator();
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  /** Where Liquid runs nothing — see `silentRegions`. Computed once per file. */
  private silent?: Array<[start: number, end: number]>;

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

        // Extract assign and capture declarations as variables
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
   *
   * The theme editor writes a block comment ("IMPORTANT: The contents of this
   * file are auto-generated…") at the top of every template and section group
   * it saves, and Shopify's theme JSON allows comments and trailing commas.
   * Anything else that is not JSON, like a file cut off partway, links nothing.
   * Each reference sits where its `type` value is written.
   */
  private extractShopifyJsonSections(fromNodeId: string): void {
    const errors: ParseError[] = [];
    const root = parseTree(this.source, errors, { allowTrailingComma: true });
    if (errors.length > 0 || root?.type !== 'object') return;
    const sections = findNodeAtLocation(root, ['sections']);
    if (sections?.type !== 'object') return;
    const seen = new Set<string>();
    for (const section of sections.children ?? []) {
      const value = section.children?.[1];
      const type = value?.type === 'object' ? findNodeAtLocation(value, ['type']) : undefined;
      if (type?.type !== 'string' || typeof type.value !== 'string' || seen.has(type.value)) continue;
      seen.add(type.value);
      const line = this.getLineNumber(type.offset);
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: `sections/${type.value}.liquid`,
        referenceKind: 'references',
        line,
        column: type.offset - this.getLineStart(line),
      });
    }
  }

  /**
   * The regions Liquid runs nothing in: `{% comment %}…{% endcomment %}` and
   * `{% raw %}…{% endraw %}`, each from its opening tag to the end of its
   * closing one (or to the end of the file, when it is never closed). The tags,
   * schemas and declarations written inside one are examples, not code.
   */
  private silentRegions(): Array<[start: number, end: number]> {
    if (this.silent) return this.silent;
    const regions: Array<[number, number]> = [];
    const tags = /\{%[-]?\s*(\w+|#)([\s\S]*?)[-]?%\}/g;
    let open: { name: string; start: number } | undefined;
    let tag;
    while ((tag = tags.exec(this.source)) !== null) {
      const name = tag[1]!;
      if (open) {
        if (name === `end${open.name}`) {
          regions.push([open.start, tags.lastIndex]);
          open = undefined;
        }
      } else if (name === 'comment' || name === 'raw') {
        open = { name, start: tag.index };
      }
    }
    if (open) regions.push([open.start, this.source.length]);
    return (this.silent = regions);
  }

  /** The silent region (see `silentRegions`) holding `index`, if any. */
  private silentRegionAt(index: number): [start: number, end: number] | undefined {
    return this.silentRegions().find(([start, end]) => index >= start && index < end);
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

    // Consume complete braced tags so strings and comments cannot start a
    // second match inside the same tag. Skip non-executing regions entirely.
    const blocks: Array<{ bodyStart: number; body: string }> = [];
    const tags = /\{%[-]?\s*(\w+|#)([\s\S]*?)[-]?%\}/g;
    const braced = new RegExp(`^\\{%[-]?\\s*(${tagPattern})\\s+${argPattern}`);
    let tag;
    while ((tag = tags.exec(this.source)) !== null) {
      const silent = this.silentRegionAt(tag.index);
      if (silent) {
        tags.lastIndex = silent[1];
        continue;
      }
      const name = tag[1]!;
      if (name === 'liquid') {
        blocks.push({
          bodyStart: tag.index + tag[0].indexOf(name) + name.length,
          body: tag[2]!,
        });
        continue;
      }
      const match = braced.exec(tag[0]);
      if (match) {
        found.push({ fullMatch: match[0], groups: match.slice(1) as string[], index: tag.index });
      }
    }

    /* Inside a `{% liquid %}` body each tag starts its own line. Anchoring on
       the line start keeps prose, filters and inline `#` comments out. */
    const bare = new RegExp(`^[ \\t]*(${tagPattern})[ \\t]+${argPattern}`);
    for (const b of blocks) {
      let offset = b.bodyStart;
      let suppressed: string | undefined;
      for (const line of b.body.split('\n')) {
        const name = /^[ \t]*(\w+)/.exec(line)?.[1];
        if (suppressed) {
          if (name === `end${suppressed}`) suppressed = undefined;
        } else if (name === 'comment' || name === 'raw') {
          suppressed = name;
        } else {
          const inner = bare.exec(line);
          if (inner) {
            found.push({
              fullMatch: inner[0].trimStart(),
              groups: inner.slice(1) as string[],
              index: offset + (inner[0].length - inner[0].trimStart().length),
            });
          }
        }
        offset += line.length + 1;
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
      const importNodeId = this.nodeIds.generate(this.filePath, 'import', snippetName!, line, match.index - this.getLineStart(line));
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
      const nodeId = this.nodeIds.generate(this.filePath, 'component', `${tagType}:${snippetName}`, line, match.index - this.getLineStart(line));

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
   * Extract {% section 'name' %} and {% sections 'group' %} references. A
   * section is `sections/<name>.liquid`; a section group, which a layout renders
   * with the plural tag, is the JSON file `sections/<group>.json` that lists its
   * sections.
   */
  private extractSectionReferences(fileNodeId: string): void {
    // Both spellings, as for render/include above.
    for (const match of this.findTagOccurrences('sections?', `['"]([^'"]+)['"]`)) {
      const fullMatch = match.fullMatch;
      const [tagType, sectionName] = match.groups;
      const line = this.getLineNumber(match.index);

      // Create an import node for searchability
      const importNodeId = this.nodeIds.generate(this.filePath, 'import', sectionName!, line, match.index - this.getLineStart(line));
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
      const nodeId = this.nodeIds.generate(this.filePath, 'component', `${tagType}:${sectionName}`, line, match.index - this.getLineStart(line));

      const node: Node = {
        id: nodeId,
        kind: 'component',
        name: sectionName!,
        qualifiedName: `${this.filePath}::${tagType}:${sectionName}`,
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

      // Add unresolved reference to the section file, or the group's JSON
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: `sections/${sectionName}.${tagType === 'sections' ? 'json' : 'liquid'}`,
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
      // A schema inside {% comment %} or {% raw %} is an example, not the
      // section's: look again after that region ends.
      const silent = this.silentRegionAt(match.index);
      if (silent) {
        schemaRegex.lastIndex = silent[1];
        continue;
      }
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
      const nodeId = this.nodeIds.generate(this.filePath, 'constant', `schema:${schemaName}`, startLine, match.index - this.getLineStart(startLine));

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
   * Extract {% assign var = value %} and {% capture var %}…{% endcapture %}
   * declarations as variables
   */
  private extractAssignments(fileNodeId: string): void {
    // Both spellings. Most of a modern theme's assigns are the bare kind.
    for (const match of this.findTagOccurrences('assign', `(\\w+)\\s*=`)) {
      this.addVariable(fileNodeId, match.groups[1]!, match);
    }
    // A capture declares its name as an assign does, and Liquid reads a quoted
    // name (`{% capture 'title' %}`) as the name inside the quotes. A name that
    // goes on with `-` or `.`, which the assign rule doesn't read either, gets
    // no node rather than a cut-short one. Captures come after assigns, so an
    // assign keeps its id when a capture of the same name shares its line.
    for (const match of this.findTagOccurrences('capture', `(?:'(\\w+)'|"(\\w+)"|(\\w+))(?=\\s|-?%\\}|$)`)) {
      const [, singleQuoted, doubleQuoted, bare] = match.groups;
      this.addVariable(fileNodeId, (singleQuoted ?? doubleQuoted ?? bare)!, match);
    }
  }

  /** A `variable` node, contained by the file, for a declaration that `findTagOccurrences` found. */
  private addVariable(fileNodeId: string, variableName: string, match: { fullMatch: string; index: number }): void {
    const line = this.getLineNumber(match.index);
    const column = match.index - this.getLineStart(line);
    const nodeId = this.nodeIds.generate(this.filePath, 'variable', variableName, line, column);

    const node: Node = {
      id: nodeId,
      kind: 'variable',
      name: variableName,
      qualifiedName: `${this.filePath}::${variableName}`,
      filePath: this.filePath,
      language: 'liquid',
      startLine: line,
      endLine: line,
      startColumn: column,
      endColumn: column + match.fullMatch.length,
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
