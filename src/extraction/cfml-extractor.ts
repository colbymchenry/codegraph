import type { Node as SyntaxNode } from 'web-tree-sitter';
import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, Language } from '../types';
import { generateNodeId, NodeIdAllocator } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';
import { getParser } from './grammars';

/** Tags whose own children include an expression: `<cfset …>`, `<cfif …>`, `<cfelseif …>`, `<cfreturn …>`, and `#…#`. */
const TAG_EXPRESSION_PARENTS: ReadonlySet<string> = new Set([
  'cf_set_tag',
  'cf_if_tag',
  'cf_elseif_tag',
  'cf_return_tag',
  'hash_expression',
]);

/**
 * The expression node types (shared with the cfscript grammar) that can
 * contain a call. A positive list, so a tag's markup — body content, its
 * `var` keyword, an ERROR — is never mistaken for an expression; a bare
 * identifier or literal can't call anything and is skipped.
 */
const TAG_EXPRESSION_TYPES: ReadonlySet<string> = new Set([
  'call_expression',
  'member_expression',
  'subscript_expression',
  'new_expression',
  'assignment_expression',
  'augmented_assignment_expression',
  'binary_expression',
  'unary_expression',
  'update_expression',
  'ternary_expression',
  'elvis_expression',
  'parenthesized_expression',
  'sequence_expression',
  'string',
  'array',
  'object',
  'ordered_struct',
  'function_expression',
  'arrow_function',
]);

/** An expression in tag markup and the scope (function, component or file node) that owns its calls. */
interface TagExpression {
  startIndex: number;
  endIndex: number;
  /** Where it starts in the file — the same line in the source extractTagExpressions synthesizes. */
  row: number;
  column: number;
  /** Its start column in the synthesized source. */
  textColumn: number;
  scopeId: string;
}

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
 * grammar, delegating any `<cfscript>` tag bodies the same way — and the
 * expressions written in tags themselves (`<cfset>`, `<cfif>`, `#hash#`, …)
 * through the same cfscript extraction (see extractTagExpressions).
 */
export class CfmlExtractor {
  private filePath: string;
  private source: string;
  private language: Language;
  private nodes: Node[] = [];
  private nodeIds = new NodeIdAllocator();
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private tagExpressions: TagExpression[] = [];

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
      // Same code as TreeSitterExtractor's missing parser, so a grammar that
      // failed to load is never stored as this file's index data (#2335).
      this.errors.push({
        message: 'cfml grammar not loaded',
        severity: 'error',
        code: 'parser_error',
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

    try {
      const fileNode = this.createFileNode();
      this.walkProgram(tree.rootNode, fileNode.id);
    } finally {
      // Trees hold wasm heap memory V8's GC never sees — free it per file.
      tree.delete();
    }
    this.extractTagExpressions();
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
      }
      // Template scope: a cffunction outside any cfcomponent wrapper (rare,
      // but legal in a .cfm template) is a top-level function contained by
      // the file, and template code's calls are the file's.
      this.visitTag(child, root.type, fileNodeId, undefined, true);
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
    const id = this.nodeIds.generate(this.filePath, 'class', name, openTag.startPosition.row + 1, openTag.startPosition.column);

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
    this.pushInheritanceRefs(classNode.id, this.tagAttr(openTag, 'implements'), 'implements', openTag);

    // Walk siblings between the open tag and its close tag.
    let sibling = openTag.nextSibling;
    let lastNode: SyntaxNode = openTag;
    while (sibling) {
      if (sibling.type === 'cf_component_close_tag') {
        lastNode = sibling;
        break;
      }
      // Component scope: cffunctions are its methods, pseudo-constructor
      // code's calls (a component-level `<cfset init()>`) are the component's.
      this.visitTag(sibling, openTag.parent?.type ?? '', classNode.id, classNode.name, true);
      lastNode = sibling;
      sibling = sibling.nextSibling;
    }
    classNode.endLine = lastNode.endPosition.row + 1;
    return lastNode;
  }

  /**
   * `<cfinterface extends="IBase,IOther">...</cfinterface>` (#2091). Unlike
   * `<cfcomponent>` (see the implicit-end-tag note on `extractComponent`) the
   * grammar has no dedicated rule for it: it is a generic `cf_tag` whose body
   * — the `<cffunction>` signatures — is ordinary nested children. Named like
   * a component (the file name, unless a `name` attribute says otherwise), so
   * `<cfcomponent implements="ISearchable">` resolves to it. An interface may
   * extend several interfaces, comma-separated.
   */
  private extractInterfaceTag(tag: SyntaxNode, containerId: string): void {
    const startTag = this.cfStartTag(tag) ?? tag;
    const name = this.tagAttr(startTag, 'name') ?? this.componentNameFromPath();
    const id = this.nodeIds.generate(this.filePath, 'interface', name, tag.startPosition.row + 1, tag.startPosition.column);
    this.nodes.push({
      id,
      kind: 'interface',
      name,
      qualifiedName: `${this.filePath}::${name}`,
      filePath: this.filePath,
      language: this.language,
      startLine: tag.startPosition.row + 1,
      endLine: tag.endPosition.row + 1,
      startColumn: tag.startPosition.column,
      endColumn: tag.endPosition.column,
      isExported: true,
      updatedAt: Date.now(),
    });
    this.edges.push({ source: containerId, target: id, kind: 'contains' });
    this.pushInheritanceRefs(id, this.tagAttr(startTag, 'extends'), 'extends', startTag);
    this.delegateNestedTags(tag, id, name, true);
  }

  /** One unresolved `extends`/`implements` ref per name in a comma-separated tag attribute. */
  private pushInheritanceRefs(fromNodeId: string, list: string | undefined, kind: 'extends' | 'implements', tag: SyntaxNode): void {
    if (!list) return;
    for (const name of list.split(',').map((s) => s.trim()).filter(Boolean)) {
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: name,
        referenceKind: kind,
        filePath: this.filePath,
        line: tag.startPosition.row + 1,
        column: tag.startPosition.column,
        language: this.language,
      });
    }
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
    const id = this.nodeIds.generate(this.filePath, kind, name, tag.startPosition.row + 1, tag.startPosition.column);
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

    // Walk the body, at any depth (e.g. inside <cfif>/<cfloop>/<cftry>
    // control-flow tags): its <cfscript>/<cfquery> bodies and tag
    // expressions are this function's.
    this.delegateNestedTags(tag, fnNode.id);
  }

  /**
   * Visit one node of tag markup. `containerId` is the scope the node sits in
   * — the function whose body it is, else the component, else the file — and
   * owns whatever calls it makes. `declScope` is true outside function bodies
   * (component/interface/template scope), where a `<cffunction>` declares a
   * function of that scope; `parentClassName` is set at component/interface
   * scope, where those functions are methods.
   *
   * - `<cfscript>`/`<cfquery>` bodies go to their own grammars (see
   *   delegateScriptTag / delegateQueryTag).
   * - A `<cffunction>` is extracted when reached at declaration scope, at any
   *   depth: `<cfprocessingdirective>` around Application.cfc's handlers
   *   (#2091) or `<cfsilent>` around a template's helpers doesn't make them
   *   any less the scope's functions. Never through an ERROR node — at file
   *   scope that is typically a `<cfcomponent>` the parser lost (behind an
   *   unclosed `<cfsetting>`), whose methods must not be misfiled as
   *   top-level functions. Inside a function body a `<cffunction>` would be
   *   its own scope; CFML rejects that, so it is skipped.
   * - An expression in tag position — the value of `<cfset>`, the condition
   *   of `<cfif>`/`<cfelseif>`, the operand of `<cfreturn>`, a `#hash#`
   *   anywhere in markup, attributes and strings included — is recorded for
   *   extractTagExpressions. The grammar parses these structurally (the same
   *   expression rules as cfscript), so `parentType` (the node's parent) is
   *   enough to tell the expression from the tag around it.
   */
  private visitTag(node: SyntaxNode, parentType: string, containerId: string, parentClassName: string | undefined, declScope: boolean): void {
    switch (node.type) {
      case 'cf_script_tag':
        this.delegateScriptTag(node, containerId, parentClassName);
        return;
      case 'cf_query_tag':
        // The SQL body is opaque to this grammar; the walk below only reaches
        // the tag's attributes (`datasource="#dsn()#"`), never the body twice.
        this.delegateQueryTag(node, containerId);
        break;
      case 'cf_function_tag':
        if (declScope) this.extractFunctionTag(node, parentClassName ? containerId : undefined, containerId, parentClassName);
        return;
      case 'cf_tag': {
        const name = this.cfTagName(node);
        if (name === 'interface' && declScope && !parentClassName) {
          this.extractInterfaceTag(node, containerId);
          return;
        }
        // `<cfloop condition="hasNext()">` — the one common tag attribute whose
        // plain-text value is a CFML expression rather than a literal.
        if (name === 'loop') {
          const condition = this.tagAttrValueNode(this.cfStartTag(node) ?? node, 'condition');
          if (condition) this.addTagExpression(condition, containerId);
        }
        break;
      }
      default:
        if (TAG_EXPRESSION_PARENTS.has(parentType) && TAG_EXPRESSION_TYPES.has(node.type)) {
          this.addTagExpression(node, containerId);
          return;
        }
    }
    this.delegateNestedTags(node, containerId, parentClassName, declScope && node.type !== 'ERROR');
  }

  /**
   * Visit `node`'s children (see visitTag) — e.g. a `<cfscript>`/`<cfquery>`
   * nested inside `<cfif>`/`<cfloop>`/`<cftry>` control-flow tags, which
   * (unlike `<cfcomponent>`'s body — see the implicit-end-tag note on
   * `extractComponent`) ARE normal children, just possibly several levels
   * deep, so a direct-children check misses them. `parentClassName` rides
   * along so a `<cfscript>` at component scope classifies its functions as
   * methods scoped under the component.
   */
  private delegateNestedTags(node: SyntaxNode, containerId: string, parentClassName?: string, declScope = false): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) this.visitTag(child, node.type, containerId, parentClassName, declScope);
    }
  }

  /** Record an expression in tag markup, owned by `scopeId`, for extractTagExpressions. */
  private addTagExpression(node: SyntaxNode, scopeId: string): void {
    if (node.endIndex <= node.startIndex) return;
    this.tagExpressions.push({
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      row: node.startPosition.row,
      column: node.startPosition.column,
      textColumn: 0,
      scopeId,
    });
  }

  /**
   * Extract calls from the expressions visitTag recorded, through the same
   * cfscript extraction a `<cfscript>` body gets — one parse per file, not
   * one per expression: the expressions are copied out in order, each on its
   * own line (the line breaks between them are kept, so every line number is
   * the file's) and ended with a `;`, and the result is read with the
   * cfscript grammar. Each reference is handed back to the scope whose
   * expression contains it, its column shifted back to the file's. Only
   * references are kept: an expression declares nothing (`<cfset var x = …>`
   * is a function local, and its `var` isn't copied), so a closure written in
   * one is part of its scope's code.
   */
  private extractTagExpressions(): void {
    const exprs = this.tagExpressions;
    if (exprs.length === 0) return;
    exprs.sort((a, b) => a.startIndex - b.startIndex);

    const parts: string[] = [];
    let pos = 0;
    let column = 0; // column in the synthesized source
    for (const expr of exprs) {
      if (pos > 0) {
        parts.push(';');
        column++;
      }
      let breaks = 0;
      for (let at = this.source.indexOf('\n', pos); at !== -1 && at < expr.startIndex; at = this.source.indexOf('\n', at + 1)) breaks++;
      if (breaks > 0) {
        parts.push('\n'.repeat(breaks));
        column = 0;
      }
      expr.textColumn = column;
      const text = this.source.slice(expr.startIndex, expr.endIndex);
      parts.push(text);
      const lastBreak = text.lastIndexOf('\n');
      column = lastBreak === -1 ? column + text.length : text.length - lastBreak - 1;
      pos = expr.endIndex;
    }

    const result = new TreeSitterExtractor(this.filePath, parts.join(''), 'cfscript').extract();
    for (const ref of result.unresolvedReferences) {
      const expr = this.tagExpressionAt(ref.line - 1, ref.column);
      // Only an expression's first line moved; its later lines are verbatim.
      if (ref.line - 1 === expr.row) ref.column += expr.column - expr.textColumn;
      ref.fromNodeId = expr.scopeId;
      ref.filePath = this.filePath;
      ref.language = this.language;
      this.unresolvedReferences.push(ref);
    }
    // A broken expression is routine in hand-written markup and the file's
    // symbols came from the tag walk, so only a genuine failure is reported —
    // not the extractor's "no symbols" warning, which an expressions-only
    // source always earns.
    for (const error of result.errors) {
      if (error.severity === 'error') this.errors.push(error);
    }
  }

  /** The recorded expression containing a synthesized-source position: the last one starting at or before it. */
  private tagExpressionAt(row: number, column: number): TagExpression {
    const exprs = this.tagExpressions;
    let lo = 0;
    let hi = exprs.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = exprs[mid]!;
      if (e.row < row || (e.row === row && e.textColumn <= column)) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return exprs[found]!;
  }

  /** A generic `cf_tag`'s start tag — where its name and attributes live. */
  private cfStartTag(tag: SyntaxNode): SyntaxNode | undefined {
    return tag.namedChildren.find(
      (c: SyntaxNode) => c.type === 'cf_start_tag' || c.type === 'cf_start_tag_with_selfclose'
    );
  }

  /** A generic `cf_tag`'s name, lowercased, without the `cf` prefix (`<cfLoop>` → `loop`). */
  private cfTagName(tag: SyntaxNode): string | undefined {
    const nameNode = this.cfStartTag(tag)?.namedChildren.find((c: SyntaxNode) => c.type === 'cf_tag_name');
    return nameNode ? this.source.substring(nameNode.startIndex, nameNode.endIndex).toLowerCase() : undefined;
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
    // Snippet-top-level non-callables: `var x = …` locals of the enclosing
    // function that the fragment-as-module parse mints as declarations.
    const localVarIds = new Set(
      result.nodes
        .filter((n) => topLevelIds.has(n.id) && (n.kind === 'variable' || n.kind === 'constant'))
        .map((n) => n.id)
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
      // Same for a snippet-top-level `var x = helper()`: the inner extractor
      // parses the fragment as a whole module, so it mints a variable node and
      // attributes the initializer's calls to it — but this fragment is a
      // FUNCTION BODY, so `x` is a local and `helper` is the enclosing
      // function's callee. Snippet-top-level FUNCTIONS keep their own calls.
      if ((!ref.fromNodeId || ref.fromNodeId === innerFileNodeId || localVarIds.has(ref.fromNodeId)) && parentId) {
        ref.fromNodeId = parentId;
      }
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
    const valueNode = this.tagAttrValueNode(tag, attrName);
    if (valueNode === undefined) return undefined;
    if (!valueNode) return '';
    return this.source.substring(valueNode.startIndex, valueNode.endIndex);
  }

  /**
   * The `attribute_value` node of a tag attribute — `undefined` when the tag
   * has no such attribute, `null` when its value isn't plain text (empty, or
   * a `#hash#` expression).
   */
  private tagAttrValueNode(tag: SyntaxNode, attrName: string): SyntaxNode | null | undefined {
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
      return valueWrapper?.namedChildren.find((c: SyntaxNode) => c.type === 'attribute_value') ?? null;
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
