import type { Node as SyntaxNode } from 'web-tree-sitter';
import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, Language } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';
import { getParser } from './grammars';

/**
 * CfmlExtractor - Extracts code relationships from CFML source (.cfc/.cfm).
 *
 * tree-sitter-cfml splits CFML into two related grammars: `cfml` (tag-based —
 * `<cfcomponent>`/`<cffunction>`/HTML) and `cfscript` (modern bare-script
 * `component { ... }` syntax). The `cfml` grammar's own injections.scm treats
 * bare-script content as an opaque blob meant to be re-parsed by `cfscript` —
 * that re-parsing only happens at the editor/highlighting layer, not in the
 * raw AST, so this extractor replicates it: a file whose first real token
 * isn't `<` is delegated wholesale to the cfscript grammar (the dominant
 * modern style); otherwise the file is walked tag-by-tag with the cfml
 * grammar, delegating any `<cfscript>` tag bodies the same way.
 */
export class CfmlExtractor {
  private filePath: string;
  private source: string;
  private language: Language;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  /** `language` is the file's detected language — `'cfml'` for `.cfc`/`.cfm`, `'cfscript'` for `.cfs`. Both dialect-switch internally; this only controls the language tag stamped onto emitted nodes/refs. */
  constructor(filePath: string, source: string, language: Language = 'cfml') {
    this.filePath = filePath;
    this.source = source;
    this.language = language;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      if (isBareScriptCfml(this.source)) {
        this.extractBareScript();
      } else {
        this.extractTagBased();
      }
    } catch (error) {
      this.errors.push({
        message: `CFML extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  /** Modern bare-script `.cfc`/`.cfm`: delegate the whole file to the cfscript grammar. */
  private extractBareScript(): void {
    const extractor = new TreeSitterExtractor(this.filePath, this.source, 'cfscript');
    const result = extractor.extract();

    // cfscript's `component`/`interface` node has no `name` field — a CFC's
    // component name is always implicit from its file name, never declared
    // in source — so the generic extractor names it '<anonymous>'.
    const componentName = this.componentNameFromPath();
    for (const node of result.nodes) {
      node.language = this.language;
      if (node.name === '<anonymous>' && (node.kind === 'class' || node.kind === 'interface')) {
        node.name = componentName;
        node.qualifiedName = `${this.filePath}::${componentName}`;
      } else if (node.qualifiedName === '<anonymous>' || node.qualifiedName.startsWith('<anonymous>::')) {
        // Members were scoped under the anonymous component (`<anonymous>::save`)
        // — carry the rename into their scope chains so type-validated method
        // resolution (which wants `UserService::save`, see resolveMethodOnType)
        // can match them. Inner genuinely-anonymous segments are untouched.
        node.qualifiedName = componentName + node.qualifiedName.slice('<anonymous>'.length);
      }
      this.nodes.push(node);
    }
    this.edges.push(...result.edges);
    for (const ref of result.unresolvedReferences) {
      ref.language = this.language;
      this.unresolvedReferences.push(ref);
    }
    this.errors.push(...result.errors);
  }

  /** Legacy tag-based CFML: walk `<cfcomponent>`/`<cffunction>`, delegating `<cfscript>` bodies. */
  private extractTagBased(): void {
    const parser = getParser('cfml');
    if (!parser) {
      this.errors.push({
        message: 'cfml grammar not loaded',
        severity: 'error',
        code: 'unsupported_language',
      });
      return;
    }

    const tree = parser.parse(this.source);
    if (!tree) {
      this.errors.push({
        message: 'Failed to parse CFML source',
        severity: 'error',
        code: 'parse_error',
      });
      return;
    }

    const fileNode = this.createFileNode();
    this.walkProgram(tree.rootNode, fileNode.id);
  }

  /** Build the file's own `kind:'file'` node, spanning the whole source. Tag-based files need this explicitly — unlike `extractBareScript` (which delegates the whole file to `TreeSitterExtractor` and inherits its file node), `extractTagBased` walks the tree itself and has no other source of one. */
  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    const fileNode: Node = {
      id,
      kind: 'file',
      name: this.filePath.split(/[/\\]/).pop() || this.filePath,
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
   * Walks `program`'s named children with a single forward cursor (not an
   * index loop) — `extractComponent` consumes a variable run of FOLLOWING
   * siblings as the component body (see its doc comment), so this must
   * resume from whatever it last consumed rather than revisiting those same
   * cffunction/cfscript siblings a second time as bogus top-level symbols.
   */
  private walkProgram(root: SyntaxNode, fileNodeId: string): void {
    let child: SyntaxNode | null = root.namedChild(0);
    while (child) {
      if (child.type === 'cf_component_open_tag') {
        child = this.extractComponent(child, fileNodeId).nextSibling;
        continue;
      } else if (child.type === 'cf_function_tag') {
        // A cffunction outside any cfcomponent wrapper (rare, but legal in a
        // .cfm template) — extract as a top-level function, contained by the file.
        this.extractFunctionTag(child, undefined, fileNodeId);
      } else if (child.type === 'cf_script_tag') {
        this.delegateScriptTag(child, fileNodeId);
      } else if (child.type === 'cf_query_tag') {
        this.delegateQueryTag(child, fileNodeId);
      } else {
        this.delegateNestedTags(child, fileNodeId);
      }
      child = child.nextSibling;
    }
  }

  /**
   * `<cfcomponent extends="Base" implements="IFoo,IBar">...</cfcomponent>`.
   * The grammar's implicit-end-tag scanner means component body content
   * (cffunction tags, cfscript tags, etc.) appears as the open tag's FOLLOWING
   * siblings in `program`, not nested children — walk forward to the matching
   * cf_component_close_tag.
   */
  private extractComponent(openTag: SyntaxNode, containerId: string | undefined): SyntaxNode {
    const name = this.tagAttr(openTag, 'name') ?? this.componentNameFromPath();
    const id = generateNodeId(this.filePath, 'class', name, openTag.startPosition.row + 1);

    const classNode: Node = {
      id,
      kind: 'class',
      name,
      qualifiedName: `${this.filePath}::${name}`,
      filePath: this.filePath,
      language: this.language,
      startLine: openTag.startPosition.row + 1,
      endLine: openTag.startPosition.row + 1, // extended below once the close tag is found
      startColumn: openTag.startPosition.column,
      endColumn: openTag.endPosition.column,
      isExported: true,
      updatedAt: Date.now(),
    };
    this.nodes.push(classNode);
    if (containerId) {
      this.edges.push({ source: containerId, target: classNode.id, kind: 'contains' });
    }

    const extendsName = this.tagAttr(openTag, 'extends');
    if (extendsName) {
      this.unresolvedReferences.push({
        fromNodeId: classNode.id,
        referenceName: extendsName,
        referenceKind: 'extends',
        filePath: this.filePath,
        line: openTag.startPosition.row + 1,
        column: openTag.startPosition.column,
        language: this.language,
      });
    }
    const implementsAttr = this.tagAttr(openTag, 'implements');
    if (implementsAttr) {
      for (const iface of implementsAttr.split(',').map((s) => s.trim()).filter(Boolean)) {
        this.unresolvedReferences.push({
          fromNodeId: classNode.id,
          referenceName: iface,
          referenceKind: 'implements',
          filePath: this.filePath,
          line: openTag.startPosition.row + 1,
          column: openTag.startPosition.column,
          language: this.language,
        });
      }
    }

    // Walk siblings between the open tag and its close tag.
    let sibling = openTag.nextSibling;
    let lastNode: SyntaxNode = openTag;
    while (sibling) {
      if (sibling.type === 'cf_component_close_tag') {
        lastNode = sibling;
        break;
      }
      if (sibling.type === 'cf_function_tag') {
        this.extractFunctionTag(sibling, classNode.id, classNode.id, classNode.name);
      } else if (sibling.type === 'cf_script_tag') {
        this.delegateScriptTag(sibling, classNode.id, classNode.name);
      } else if (sibling.type === 'cf_query_tag') {
        this.delegateQueryTag(sibling, classNode.id);
      } else {
        this.delegateNestedTags(sibling, classNode.id, classNode.name);
      }
      lastNode = sibling;
      sibling = sibling.nextSibling;
    }
    classNode.endLine = lastNode.endPosition.row + 1;
    return lastNode;
  }

  /**
   * `<cffunction name="..." access="..." returntype="...">...</cffunction>`.
   * `parentClassId` decides `method` vs top-level `function`; `containerId` is
   * the `contains`-edge target (the class when inside one, otherwise the file
   * node for a bare top-level cffunction) — kept separate so a top-level
   * function still gets a containment edge without being misclassified as a
   * method of the file. A method's qualifiedName is scoped under
   * `parentClassName` (`TagService::save`, the same `Class::member` shape the
   * generic extractor produces) so type-validated method resolution can match.
   */
  private extractFunctionTag(tag: SyntaxNode, parentClassId: string | undefined, containerId: string | undefined, parentClassName?: string): void {
    const name = this.tagAttr(tag, 'name');
    if (!name) return;

    const kind = parentClassId ? 'method' : 'function';
    const id = generateNodeId(this.filePath, kind, name, tag.startPosition.row + 1);
    const access = this.tagAttr(tag, 'access');
    const visibility = access === 'private' ? 'private'
      : access === 'package' ? 'internal'
      : access ? 'public'
      : undefined;

    const fnNode: Node = {
      id,
      kind,
      name,
      qualifiedName: parentClassName ? `${parentClassName}::${name}` : `${this.filePath}::${name}`,
      filePath: this.filePath,
      language: this.language,
      startLine: tag.startPosition.row + 1,
      endLine: tag.endPosition.row + 1,
      startColumn: tag.startPosition.column,
      endColumn: tag.endPosition.column,
      visibility,
      returnType: this.tagAttr(tag, 'returntype'),
      updatedAt: Date.now(),
    };
    this.nodes.push(fnNode);

    if (containerId) {
      this.edges.push({ source: containerId, target: fnNode.id, kind: 'contains' });
    }

    // Delegate any <cfscript>/<cfquery> bodies nested inside this function, at
    // any depth (e.g. inside <cfif>/<cfloop>/<cftry> control-flow tags).
    this.delegateNestedTags(tag, fnNode.id);
  }

  /**
   * Recursively delegates any `cf_script_tag`/`cf_query_tag` found within
   * `node`'s subtree — e.g. a `<cfscript>`/`<cfquery>` nested inside
   * `<cfif>`/`<cfloop>`/`<cftry>` control-flow tags, which (unlike
   * `<cfcomponent>`'s body — see the implicit-end-tag note on `extractComponent`)
   * ARE normal children, just possibly several levels deep, so a direct-children
   * check misses them. Does not descend into a nested `cf_function_tag` — that
   * has its own scope and is walked separately. `parentClassName` rides along
   * so a `<cfscript>` at component scope classifies its functions as methods
   * scoped under the component.
   */
  private delegateNestedTags(node: SyntaxNode, containerId: string | undefined, parentClassName?: string): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'cf_script_tag') {
        this.delegateScriptTag(child, containerId, parentClassName);
      } else if (child.type === 'cf_query_tag') {
        this.delegateQueryTag(child, containerId);
      } else if (child.type === 'cf_function_tag') {
        continue;
      } else {
        this.delegateNestedTags(child, containerId, parentClassName);
      }
    }
  }

  /**
   * Delegate a `<cfscript>...</cfscript>` tag body to the cfscript grammar.
   * With `parentClassName` set (the block sits at component scope), functions
   * declared at the script's top level are the component's methods
   * (`<cfcomponent><cfscript>function configure(){}` — the standard ColdBox
   * ModuleConfig shape): they're re-kinded `function` → `method`, and every
   * merged symbol's qualifiedName is prefixed with the component scope
   * (`configure` → `ModuleConfig::configure`) so type-validated method
   * resolution can match them. Functions nested inside another function
   * (closures) keep kind `function`.
   */
  private delegateScriptTag(scriptTag: SyntaxNode, parentId: string | undefined, parentClassName?: string): void {
    const content = scriptTag.namedChildren.find((c: SyntaxNode) => c.type === 'cf_script_content');
    if (!content) return;

    const inner = this.source.substring(content.startIndex, content.endIndex);
    const startLine = content.startPosition.row;

    const extractor = new TreeSitterExtractor(this.filePath, inner, 'cfscript');
    const result = extractor.extract();

    // The inner TreeSitterExtractor always synthesizes its own `file`-kind
    // node scoped to just this snippet — drop it (and any edges touching it)
    // since this tag-based file already owns one correctly-ranged file node
    // (see createFileNode); the per-node `parentId` contains-edge below
    // already links every emitted symbol into the real tree.
    const innerFileNodeId = result.nodes.find((n) => n.kind === 'file')?.id;
    // Snippet-top-level symbols are the ones the inner extractor attached
    // directly to its (dropped) snippet file node — as opposed to closures
    // nested inside another function.
    const topLevelIds = new Set(
      result.edges
        .filter((e) => e.kind === 'contains' && e.source === innerFileNodeId)
        .map((e) => e.target)
    );
    for (const node of result.nodes) {
      if (node.kind === 'file') continue;
      node.startLine += startLine;
      node.endLine += startLine;
      node.language = this.language;
      if (parentClassName) {
        if (node.kind === 'function' && topLevelIds.has(node.id)) {
          node.kind = 'method';
        }
        node.qualifiedName = `${parentClassName}::${node.qualifiedName}`;
      }
      this.nodes.push(node);
      if (parentId) {
        this.edges.push({ source: parentId, target: node.id, kind: 'contains' });
      }
    }
    for (const edge of result.edges) {
      if (edge.source === innerFileNodeId || edge.target === innerFileNodeId) continue;
      if (edge.line) edge.line += startLine;
      this.edges.push(edge);
    }
    for (const ref of result.unresolvedReferences) {
      ref.line += startLine;
      ref.filePath = this.filePath;
      ref.language = this.language;
      // Calls inside a <cfscript> body with no enclosing function (rare — a
      // top-level script in a .cfm template, or any statement directly in
      // the snippet body) attribute to the filtered-out snippet file node by
      // default — redirect those (and any genuinely unset ones) to parentId.
      if ((!ref.fromNodeId || ref.fromNodeId === innerFileNodeId) && parentId) ref.fromNodeId = parentId;
      this.unresolvedReferences.push(ref);
    }
    for (const error of result.errors) {
      if (error.line) error.line += startLine;
      this.errors.push(error);
    }
  }

  /**
   * Delegate a `<cfquery>...</cfquery>` tag's SQL body to the `cfquery` grammar.
   * `#hash#` expressions inside the SQL (e.g. `#getCurrentUser().getId()#` in a
   * WHERE clause) are real CFML calls/references — tree-sitter-cfml's `cfquery`
   * grammar parses them structurally (same `call_expression`/`member_expression`
   * shape as cfscript), so without this delegation they're silently dropped as
   * opaque SQL text. The grammar models no other symbols, so only call/reference
   * extraction is relevant here — unlike `delegateScriptTag`, there are no nodes
   * or contains-edges to merge.
   */
  private delegateQueryTag(queryTag: SyntaxNode, parentId: string | undefined): void {
    const content = queryTag.namedChildren.find((c: SyntaxNode) => c.type === 'cf_query_content');
    if (!content) return;

    const sql = this.source.substring(content.startIndex, content.endIndex);
    const startLine = content.startPosition.row;

    const extractor = new TreeSitterExtractor(this.filePath, sql, 'cfquery');
    const result = extractor.extract();

    const innerFileNodeId = result.nodes.find((n) => n.kind === 'file')?.id;
    for (const ref of result.unresolvedReferences) {
      ref.line += startLine;
      ref.filePath = this.filePath;
      ref.language = this.language;
      if ((!ref.fromNodeId || ref.fromNodeId === innerFileNodeId) && parentId) ref.fromNodeId = parentId;
      this.unresolvedReferences.push(ref);
    }
    for (const error of result.errors) {
      if (error.line) error.line += startLine;
      this.errors.push(error);
    }
  }

  /** Read a `cf_attribute`'s value by name from a tag node's direct `cf_attribute`/`cf_tag_attributes` children. */
  private tagAttr(tag: SyntaxNode, attrName: string): string | undefined {
    const attrs: SyntaxNode[] = [];
    for (let i = 0; i < tag.namedChildCount; i++) {
      const child = tag.namedChild(i);
      if (!child) continue;
      if (child.type === 'cf_attribute') attrs.push(child);
      else if (child.type === 'cf_tag_attributes') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const inner = child.namedChild(j);
          if (inner?.type === 'cf_attribute') attrs.push(inner);
        }
      }
    }
    for (const attr of attrs) {
      const nameNode = attr.namedChildren.find((c: SyntaxNode) => c.type === 'cf_attribute_name');
      if (!nameNode) continue;
      const text = this.source.substring(nameNode.startIndex, nameNode.endIndex);
      if (text.toLowerCase() !== attrName.toLowerCase()) continue;
      // Values come wrapped as `quoted_cf_attribute_value` (name="init") or bare
      // `cf_attribute_value` (name=init — legal and common in older CFML).
      const valueWrapper = attr.namedChildren.find(
        (c: SyntaxNode) => c.type === 'quoted_cf_attribute_value' || c.type === 'cf_attribute_value'
      );
      const valueNode = valueWrapper?.namedChildren.find((c: SyntaxNode) => c.type === 'attribute_value');
      if (!valueNode) return '';
      return this.source.substring(valueNode.startIndex, valueNode.endIndex);
    }
    return undefined;
  }

  private componentNameFromPath(): string {
    const fileName = this.filePath.split(/[/\\]/).pop() || this.filePath;
    return fileName.replace(/\.(cfc|cfm|cfs)$/i, '');
  }
}

/**
 * Sniff whether CFML source is bare-script (`component { ... }`, modern style)
 * vs tag-based (`<cfcomponent>`, `<cfif>`, HTML). Skips a leading UTF-8 BOM
 * (endemic in CFML's Windows-editor history — 17% of ColdBox's files carry
 * one; both grammars parse fine with it once routed correctly), whitespace,
 * and `//`/`/* *\/` comments to find the first real token; tag-based files
 * start with `<`, script-based files don't.
 */
export function isBareScriptCfml(source: string): boolean {
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\uFEFF') {
      i++;
    } else if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? len : nl + 1;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? len : end + 2;
    } else {
      return ch !== '<';
    }
  }
  return true; // empty/whitespace-only file — treat as script (no-op extraction either way)
}
