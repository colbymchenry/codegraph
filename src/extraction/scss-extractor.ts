import { Node, ExtractionResult } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { CSSExtractor } from './css-extractor';

/**
 * SCSSExtractor — Extracts design-system symbols from SCSS/Sass files.
 *
 * Extends CSSExtractor to inherit CSS custom property handling, and adds:
 *   - $variables              → variable nodes (design tokens)
 *   - @mixin name()           → function nodes (reusable style blocks)
 *   - @function name()        → function nodes (value utilities)
 *   - %placeholder            → constant nodes (extend targets)
 *   - @use / @forward / @import → import edges (module graph)
 *   - @include name()         → call edges (mixin usage)
 *   - @extend %target         → reference edges
 *
 * Spec: docs/07-SCSS.md
 */
export class SCSSExtractor extends CSSExtractor {
  constructor(filePath: string, source: string, language: 'scss' | 'sass' = 'scss') {
    super(filePath, source);
    this.language = language;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const fileNode = this.createFileNode();
      this.extractVariables(fileNode.id);
      this.extractMixins(fileNode.id);
      this.extractFunctions(fileNode.id);
      this.extractPlaceholders(fileNode.id);
      this.extractModuleImports(fileNode.id);
      this.extractIncludes(fileNode.id);
      this.extractExtends(fileNode.id);
      // Inherit CSS custom property handling from base class
      this.extractCustomProperties(fileNode.id);
    } catch (error) {
      this.errors.push({
        message: `SCSS extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
   * Override file-node creation to use smart filename-based kind detection.
   *   _tokens.scss      → constant (pure data)
   *   _mixins.scss      → class (collection of callables)
   *   anything else     → file
   */
  protected createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    const name = this.filePath.split(/[/\\]/).pop() || this.filePath;
    const baseName = name.replace(/^_/, '').replace(/\.(scss|sass)$/, '');

    const kind = /^(tokens?|variables?|vars?|colors?|spacing|typography)$/.test(baseName)
      ? 'constant'
      : /^(mixins?|functions?|helpers?|utilities?)$/.test(baseName)
      ? 'class'
      : 'file';

    const fileNode: Node = {
      id,
      kind,
      name,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: this.language,
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
   * $variable: value [!default | !global];
   *   Multi-line maps are handled by matching across one logical declaration.
   */
  private extractVariables(fileNodeId: string): void {
    // Match $name: value; — value can span multiple lines for SCSS maps
    const varRegex = /^[ \t]*(\$[\w-]+)\s*:\s*([^;{]+?)(?:\s*!(default|global))?\s*;/gm;
    const seen = new Set<string>();
    let match: RegExpExecArray | null;

    while ((match = varRegex.exec(this.source)) !== null) {
      const [fullMatch, varName, rawValue] = match;
      if (seen.has(varName!)) continue;
      seen.add(varName!);

      const line = this.getLineNumber(match.index);
      const col = match.index - this.getLineStart(line);
      const value = rawValue!.trim().replace(/\s+/g, ' ').substring(0, 80);
      const nodeId = generateNodeId(this.filePath, 'variable', varName!, line);

      this.nodes.push({
        id: nodeId,
        kind: 'variable',
        name: varName!,
        qualifiedName: `${this.filePath}::${varName}`,
        filePath: this.filePath,
        language: this.language,
        signature: `${varName}: ${value}`,
        startLine: line,
        endLine: line,
        startColumn: col,
        endColumn: col + fullMatch.length,
        updatedAt: Date.now(),
      });
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
    }

    // $variable usages → references (for impact analysis)
    // Only match usages outside variable declarations to avoid self-reference noise
    const usageRegex = /(?<!:\s*)(\$[\w-]+)/g;
    while ((match = usageRegex.exec(this.source)) !== null) {
      const varName = match[1]!;
      // Skip if this position is inside a variable declaration line we already indexed
      const line = this.getLineNumber(match.index);
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: varName,
        referenceKind: 'references',
        line,
        column: match.index - this.getLineStart(line),
      });
    }
  }

  /**
   * @mixin name($params) { ... }
   */
  private extractMixins(fileNodeId: string): void {
    const mixinRegex = /@mixin\s+([\w-]+)\s*(\([^)]*\))?/g;
    let match: RegExpExecArray | null;

    while ((match = mixinRegex.exec(this.source)) !== null) {
      const [fullMatch, mixinName, params] = match;
      const line = this.getLineNumber(match.index);
      const col = match.index - this.getLineStart(line);
      const nodeId = generateNodeId(this.filePath, 'function', `mixin:${mixinName}`, line);

      this.nodes.push({
        id: nodeId,
        kind: 'function',
        name: mixinName!,
        qualifiedName: `${this.filePath}::mixin:${mixinName}`,
        filePath: this.filePath,
        language: this.language,
        signature: `@mixin ${mixinName}${params || '()'}`,
        startLine: line,
        endLine: line,
        startColumn: col,
        endColumn: col + fullMatch.length,
        updatedAt: Date.now(),
      });
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
    }
  }

  /**
   * @function name($params) { @return ...; }
   */
  private extractFunctions(fileNodeId: string): void {
    const funcRegex = /@function\s+([\w-]+)\s*(\([^)]*\))?/g;
    let match: RegExpExecArray | null;

    while ((match = funcRegex.exec(this.source)) !== null) {
      const [fullMatch, funcName, params] = match;
      const line = this.getLineNumber(match.index);
      const col = match.index - this.getLineStart(line);
      const nodeId = generateNodeId(this.filePath, 'function', `fn:${funcName}`, line);

      this.nodes.push({
        id: nodeId,
        kind: 'function',
        name: funcName!,
        qualifiedName: `${this.filePath}::function:${funcName}`,
        filePath: this.filePath,
        language: this.language,
        signature: `@function ${funcName}${params || '()'}`,
        startLine: line,
        endLine: line,
        startColumn: col,
        endColumn: col + fullMatch.length,
        updatedAt: Date.now(),
      });
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
    }
  }

  /**
   * %placeholder { ... }
   * Extend targets — abstract style blocks.
   */
  private extractPlaceholders(fileNodeId: string): void {
    const placeholderRegex = /%([\w-]+)\s*\{/g;
    let match: RegExpExecArray | null;

    while ((match = placeholderRegex.exec(this.source)) !== null) {
      const [fullMatch, placeholderName] = match;
      const line = this.getLineNumber(match.index);
      const col = match.index - this.getLineStart(line);
      const nodeId = generateNodeId(this.filePath, 'constant', `%${placeholderName}`, line);

      this.nodes.push({
        id: nodeId,
        kind: 'constant',
        name: `%${placeholderName}`,
        qualifiedName: `${this.filePath}::%${placeholderName}`,
        filePath: this.filePath,
        language: this.language,
        signature: `%${placeholderName}`,
        startLine: line,
        endLine: line,
        startColumn: col,
        endColumn: col + fullMatch.length,
        updatedAt: Date.now(),
      });
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
    }
  }

  /**
   * SCSS module system: @use, @forward, @import (legacy)
   */
  private extractModuleImports(fileNodeId: string): void {
    const importRegex = /@(use|forward|import)\s+['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(this.source)) !== null) {
      const [fullMatch, directive, importPath] = match;
      const line = this.getLineNumber(match.index);
      const col = match.index - this.getLineStart(line);
      const nodeId = generateNodeId(this.filePath, 'import', importPath!, line);

      this.nodes.push({
        id: nodeId,
        kind: 'import',
        name: importPath!,
        qualifiedName: `${this.filePath}::${directive}:${importPath}`,
        filePath: this.filePath,
        language: this.language,
        signature: fullMatch,
        startLine: line,
        endLine: line,
        startColumn: col,
        endColumn: col + fullMatch.length,
        updatedAt: Date.now(),
      });
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });

      // Resolve partial filenames: 'tokens' → '_tokens.scss'
      const lastSegment = importPath!.split('/').pop()!;
      const hasExtension = lastSegment.includes('.');
      const resolvedName = hasExtension
        ? importPath!
        : importPath!.replace(/([^/]+)$/, '_$1.scss');

      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: resolvedName,
        referenceKind: directive === 'forward' ? 'exports' : 'imports',
        line,
        column: col,
      });
    }
  }

  /**
   * @include mixin-name($args)
   * Most valuable edge type for design system impact analysis.
   * Strips namespace prefix (mix.flex-center → flex-center).
   */
  private extractIncludes(fileNodeId: string): void {
    const includeRegex = /@include\s+([\w.-]+)\s*(?:\([^)]*\))?/g;
    let match: RegExpExecArray | null;

    while ((match = includeRegex.exec(this.source)) !== null) {
      const [fullMatch, mixinRef] = match;
      const line = this.getLineNumber(match.index);
      const col = match.index - this.getLineStart(line);
      const mixinName = mixinRef!.includes('.') ? mixinRef!.split('.').pop()! : mixinRef!;
      const nodeId = generateNodeId(this.filePath, 'component', `include:${mixinRef}`, line);

      this.nodes.push({
        id: nodeId,
        kind: 'component',
        name: mixinName,
        qualifiedName: `${this.filePath}::include:${mixinRef}`,
        filePath: this.filePath,
        language: this.language,
        signature: fullMatch,
        startLine: line,
        endLine: line,
        startColumn: col,
        endColumn: col + fullMatch.length,
        updatedAt: Date.now(),
      });
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });

      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: mixinName,
        referenceKind: 'calls',
        line,
        column: col,
      });
    }
  }

  /**
   * @extend %placeholder | .class
   */
  private extractExtends(fileNodeId: string): void {
    const extendRegex = /@extend\s+([%.\w-]+)/g;
    let match: RegExpExecArray | null;

    while ((match = extendRegex.exec(this.source)) !== null) {
      const [, target] = match;
      const line = this.getLineNumber(match.index);
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: target!,
        referenceKind: 'references',
        line,
        column: match.index - this.getLineStart(line),
      });
    }
  }
}
