/**
 * Tree-sitter Parser Wrapper
 *
 * Handles parsing source code and extracting structural information.
 */

import { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import * as path from 'path';
import {
  Language,
  Node,
  Edge,
  NodeKind,
  ExtractionResult,
  ExtractionError,
  UnresolvedReference,
} from '../types';
import { getParser, detectLanguage, isLanguageSupported, isFileLevelOnlyLanguage } from './grammars';
import { generateNodeId, getNodeText, getChildByField, getPrecedingDocstring } from './tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from './tree-sitter-types';
import { EXTRACTORS } from './languages';
import { LiquidExtractor } from './liquid-extractor';
import { RazorExtractor } from './razor-extractor';
import { SvelteExtractor } from './svelte-extractor';
import { DfmExtractor } from './dfm-extractor';
import { VueExtractor } from './vue-extractor';
import { MyBatisExtractor } from './mybatis-extractor';
import {
  getAllFrameworkResolvers,
  getApplicableFrameworks,
} from '../resolution/frameworks';

// Re-export for backward compatibility
export { generateNodeId } from './tree-sitter-helpers';

/**
 * Extract the name from a node based on language
 */
function extractName(node: SyntaxNode, source: string, extractor: LanguageExtractor): string {
  const hookName = extractor.resolveName?.(node, source);
  if (hookName) return hookName;

  // Try field name first
  const nameNode = getChildByField(node, extractor.nameField);
  if (nameNode) {
    // Unwrap pointer_declarator(s) for C/C++ pointer return types
    let resolved = nameNode;
    while (resolved.type === 'pointer_declarator') {
      const inner = getChildByField(resolved, 'declarator') || resolved.namedChild(0);
      if (!inner) break;
      resolved = inner;
    }
    // Handle complex declarators (C/C++)
    if (resolved.type === 'function_declarator' || resolved.type === 'declarator') {
      const innerName = getChildByField(resolved, 'declarator') || resolved.namedChild(0);
      return innerName ? getNodeText(innerName, source) : getNodeText(resolved, source);
    }
    // Lua: `function t.f()` / `function t:m()` — the name node is a dot/method
    // index expression; the simple name is the trailing field/method (the table
    // receiver is captured separately via getReceiverType).
    if (resolved.type === 'dot_index_expression') {
      const field = getChildByField(resolved, 'field');
      if (field) return getNodeText(field, source);
    }
    if (resolved.type === 'method_index_expression') {
      const method = getChildByField(resolved, 'method');
      if (method) return getNodeText(method, source);
    }
    return getNodeText(resolved, source);
  }

  // For Dart method_signature, look inside inner signature types
  if (node.type === 'method_signature') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (
        child.type === 'function_signature' ||
        child.type === 'getter_signature' ||
        child.type === 'setter_signature' ||
        child.type === 'constructor_signature' ||
        child.type === 'factory_constructor_signature'
      )) {
        // Find identifier inside the inner signature
        for (let j = 0; j < child.namedChildCount; j++) {
          const inner = child.namedChild(j);
          if (inner?.type === 'identifier') {
            return getNodeText(inner, source);
          }
        }
      }
    }
  }

  // Arrow/function expressions get their name from the parent variable_declarator,
  // not from identifiers in their body. Without this, single-expression arrow
  // functions like `const fn = () => someIdentifier` get named "someIdentifier"
  // instead of "fn", because the fallback below finds the body identifier.
  if (node.type === 'arrow_function' || node.type === 'function_expression') {
    return '<anonymous>';
  }

  // Fall back to first identifier child
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (
      child &&
      (child.type === 'identifier' ||
        child.type === 'type_identifier' ||
        child.type === 'simple_identifier' ||
        child.type === 'constant')
    ) {
      return getNodeText(child, source);
    }
  }

  return '<anonymous>';
}

/**
 * Resolve a Scala type node to its base type NAME for name-matching — unwrapping
 * `generic_type` (`Monoid[Int]` → `Monoid`), taking the last segment of a
 * qualified `stable_type_identifier` (`cats.Functor` → `Functor`), and falling
 * back to a descendant `type_identifier`. Returns null for non-type nodes.
 * Shared by Scala inheritance and type-reference extraction.
 */
function scalaBaseTypeName(node: SyntaxNode | null, source: string): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'type_identifier':
    case 'identifier':
      return getNodeText(node, source);
    case 'generic_type':
      // `<base> type_arguments` — the base type is the first named child.
      return scalaBaseTypeName(node.namedChild(0), source);
    case 'stable_type_identifier':
    case 'stable_identifier': {
      // Qualified `a.b.C` — match on the simple (last) segment.
      const ids = node.namedChildren.filter(
        (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'identifier'
      );
      const last = ids[ids.length - 1];
      return last ? getNodeText(last, source) : null;
    }
    default: {
      const id = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      return id ? getNodeText(id, source) : null;
    }
  }
}

/**
 * PHP type-position wrapper node kinds (a type-hint is `named_type`,
 * `?Foo` is `optional_type`, `A|B` is `union_type`, `A&B` is
 * `intersection_type`). Used to find the type subtree inside a parameter /
 * property / return position before walking it for class references.
 */
const PHP_TYPE_NODES: ReadonlySet<string> = new Set([
  'named_type', 'optional_type', 'nullable_type',
  'union_type', 'intersection_type', 'disjunctive_normal_form_type',
  'primitive_type',
]);

/**
 * Member-access node kinds whose receiver, when it's a capitalized
 * type/enum/class name, is a real dependency — `Enum.value`, `Type.CONST`,
 * `Foo::BAR`. These VALUE reads (as opposed to `Type.method()` calls, already
 * handled) produced no edge, so a type used only via a static member or enum
 * value looked like nothing depended on it. See {@link extractStaticMemberRef}.
 */
const MEMBER_ACCESS_TYPES: ReadonlySet<string> = new Set([
  'field_access',                       // java (`Foo.BAR`)
  'member_access_expression',           // c#  (`Foo.Bar`)
  'navigation_expression',              // kotlin / swift (`Foo.bar`)
  'field_expression',                   // scala (`Foo.bar`)
  'class_constant_access_expression',   // php (`Foo::CONST`, `Foo::class`)
  'scoped_property_access_expression',  // php (`Foo::$bar`)
  'qualified_identifier',               // c++ (`Foo::bar`)
]);

/**
 * Languages whose types are Capitalized by convention, so a capitalized
 * member-access receiver is reliably a type (not a local/variable). The
 * static-member/value-read pass is gated to these — the ones where it was the
 * confirmed residual frontier (enum-value / static-field reads). TS/JS/Python
 * are deliberately excluded, and a measured A/B confirms the call: extending the
 * pass to them adds ZERO coverage — in import-based languages you must `import` a
 * type before any `Type.MEMBER` read, so the import edge already covers it (the
 * static read is pure duplication) — while adding real graph noise (+1813 edges /
 * +2448 `references` on excalidraw, the retrieval-perf benchmark, all pointing at
 * already-covered types). Don't re-add `member_expression`/`attribute` here.
 */
const STATIC_MEMBER_LANGS: ReadonlySet<string> = new Set([
  'java', 'csharp', 'kotlin', 'swift', 'scala', 'dart', 'php', 'cpp',
]);

/**
 * Tree-sitter node kinds that represent constructor invocations
 * (`new Foo()` and friends). Used by extractInstantiation to emit
 * an `instantiates` reference targeting the class name.
 */
const INSTANTIATION_KINDS: ReadonlySet<string> = new Set([
  'new_expression',                  // typescript / javascript / tsx / jsx
  'object_creation_expression',      // java / c#
  'instance_creation_expression',    // some grammars
  'composite_literal',               // go — `Widget{...}` / `pkga.Widget{...}`
  'struct_expression',               // rust — `Widget { n: 1 }` / `m::Widget { .. }`
  'instance_expression',             // scala — `new Monoid[Int] { ... }`
]);

/**
 * TreeSitterExtractor - Main extraction class
 */
export class TreeSitterExtractor {
  private filePath: string;
  private language: Language;
  private source: string;
  private tree: Tree | null = null;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private extractor: LanguageExtractor | null = null;
  private nodeStack: string[] = []; // Stack of parent node IDs
  private methodIndex: Map<string, string> | null = null; // lookup key → node ID for Pascal defProc lookup

  constructor(filePath: string, source: string, language?: Language) {
    this.filePath = filePath;
    this.source = source;
    this.language = language || detectLanguage(filePath, source);
    this.extractor = EXTRACTORS[this.language] || null;
  }

  /**
   * Parse and extract from the source code
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    if (!isLanguageSupported(this.language)) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Unsupported language: ${this.language}`,
            filePath: this.filePath,
            severity: 'error',
            code: 'unsupported_language',
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }

    const parser = getParser(this.language);
    if (!parser) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to get parser for language: ${this.language}`,
            filePath: this.filePath,
            severity: 'error',
            code: 'parser_error',
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }

    try {
      // Optional pre-parse source transform (offset-preserving) to work around
      // grammar gaps — e.g. C# blanks conditional-compilation directive lines
      // the grammar mis-parses inside enum bodies (#237). We reassign
      // this.source so downstream getNodeText reads the same bytes the parser
      // saw (identical outside the blanked directive lines).
      if (this.extractor?.preParse) {
        this.source = this.extractor.preParse(this.source);
      }
      this.tree = parser.parse(this.source) ?? null;
      if (!this.tree) {
        throw new Error('Parser returned null tree');
      }

      // Create file node representing the source file
      const fileNode: Node = {
        id: `file:${this.filePath}`,
        kind: 'file',
        name: path.basename(this.filePath),
        qualifiedName: this.filePath,
        filePath: this.filePath,
        language: this.language,
        startLine: 1,
        endLine: this.source.split('\n').length,
        startColumn: 0,
        endColumn: 0,
        isExported: false,
        updatedAt: Date.now(),
      };
      this.nodes.push(fileNode);

      // Push file node onto stack so top-level declarations get contains edges
      this.nodeStack.push(fileNode.id);

      // File-level package declaration (Kotlin/Java). Creates an implicit
      // `namespace` node wrapping every top-level declaration so their
      // qualifiedName carries the FQN — required for cross-file import
      // resolution on JVM languages where filename ≠ class name.
      const packageNodeId = this.extractFilePackage(this.tree.rootNode);
      if (packageNodeId) this.nodeStack.push(packageNodeId);

      this.visitNode(this.tree.rootNode);

      if (packageNodeId) this.nodeStack.pop();
      this.nodeStack.pop();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      // WASM memory errors leave the module in a corrupted state — all subsequent
      // parses would also fail. Re-throw so the worker can detect and crash,
      // forcing a clean restart with a fresh heap.
      if (msg.includes('memory access out of bounds') || msg.includes('out of memory')) {
        throw error;
      }

      this.errors.push({
        message: `Parse error: ${msg}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    } finally {
      // Free tree-sitter WASM memory immediately — trees hold native heap memory
      // invisible to V8's GC that accumulates across thousands of files.
      if (this.tree) {
        this.tree.delete();
        this.tree = null;
      }
      // Release source string to reduce GC pressure
      this.source = '';
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
   * Visit a node and extract information
   */
  private visitNode(node: SyntaxNode): void {
    if (!this.extractor) return;

    const nodeType = node.type;
    let skipChildren = false;

    // Language-specific custom visitor hook
    if (this.extractor.visitNode) {
      const ctx = this.makeExtractorContext();
      const handled = this.extractor.visitNode(node, ctx);
      if (handled) return;
    }

    // Pascal-specific AST handling
    if (this.language === 'pascal') {
      skipChildren = this.visitPascalNode(node);
      if (skipChildren) return;
    }

    // Check for function declarations
    // For Python/Ruby, function_definition inside a class should be treated as method
    if (this.extractor.functionTypes.includes(nodeType)) {
      if (this.isInsideClassLikeNode() && this.extractor.methodTypes.includes(nodeType)) {
        // Inside a class - treat as method
        this.extractMethod(node);
        skipChildren = true; // extractMethod visits children via visitFunctionBody
      } else {
        this.extractFunction(node);
        skipChildren = true; // extractFunction visits children via visitFunctionBody
      }
    }
    // Check for class declarations
    else if (this.extractor.classTypes.includes(nodeType)) {
      // Some languages reuse class_declaration for structs/enums (e.g. Swift)
      const classification = this.extractor.classifyClassNode?.(node) ?? 'class';
      if (classification === 'struct') {
        this.extractStruct(node);
      } else if (classification === 'enum') {
        this.extractEnum(node);
      } else if (classification === 'interface') {
        this.extractInterface(node);
      } else if (classification === 'trait') {
        this.extractClass(node, 'trait');
      } else {
        this.extractClass(node);
      }
      skipChildren = true; // extractClass visits body children
    }
    // Extra class node types (e.g. Dart mixin_declaration, extension_declaration)
    else if (this.extractor.extraClassNodeTypes?.includes(nodeType)) {
      this.extractClass(node);
      skipChildren = true;
    }
    // Check for method declarations (only if not already handled by functionTypes)
    else if (this.extractor.methodTypes.includes(nodeType)) {
      this.extractMethod(node);
      skipChildren = true; // extractMethod visits children via visitFunctionBody
    }
    // Check for interface/protocol/trait declarations
    else if (this.extractor.interfaceTypes.includes(nodeType)) {
      this.extractInterface(node);
      skipChildren = true; // extractInterface visits body children
    }
    // Check for struct declarations
    else if (this.extractor.structTypes.includes(nodeType)) {
      this.extractStruct(node);
      skipChildren = true; // extractStruct visits body children
    }
    // Check for enum declarations
    else if (this.extractor.enumTypes.includes(nodeType)) {
      this.extractEnum(node);
      skipChildren = true; // extractEnum visits body children
    }
    // Check for type alias declarations (e.g. `type X = ...` in TypeScript)
    // For Go, type_spec wraps struct/interface definitions — resolveTypeAliasKind
    // detects these and extractTypeAlias creates the correct node kind.
    else if (this.extractor.typeAliasTypes.includes(nodeType)) {
      skipChildren = this.extractTypeAlias(node);
    }
    // Check for class properties (e.g. C# property_declaration)
    else if (this.extractor.propertyTypes?.includes(nodeType) && this.isInsideClassLikeNode()) {
      this.extractProperty(node);
      skipChildren = true;
    }
    // Check for class fields (e.g. Java field_declaration, C# field_declaration)
    else if (this.extractor.fieldTypes?.includes(nodeType) && this.isInsideClassLikeNode()) {
      this.extractField(node);
      skipChildren = true;
    }
    // Check for variable declarations (const, let, var, etc.)
    // Only extract top-level variables (not inside functions/methods)
    else if (this.extractor.variableTypes.includes(nodeType) && !this.isInsideClassLikeNode()) {
      this.extractVariable(node);
      skipChildren = true; // extractVariable handles children
    }
    // Swift stored properties inside a type. Swift instance properties aren't
    // extracted as their own nodes, but a property's PROPERTY WRAPPER
    // (`@Argument`/`@Published`/`@State`/custom) and declared type ARE
    // dependencies — attribute them to the enclosing type so the wrapper/type
    // files get dependents. Don't skipChildren: an initializer's calls still
    // matter. (Other languages extract properties via property/field types.)
    else if (
      this.language === 'swift' &&
      nodeType === 'property_declaration' &&
      this.isInsideClassLikeNode()
    ) {
      const ownerId = this.nodeStack[this.nodeStack.length - 1];
      if (ownerId) {
        this.extractDecoratorsFor(node, ownerId);
        this.extractVariableTypeAnnotation(node, ownerId);
        // Fluent / SwiftUI property-wrapper attributes often reference a model or
        // type by metatype in their ARGUMENTS — `@Siblings(through: Pivot.self,
        // …)`, `@Group(…)`. extractDecoratorsFor captures the wrapper type
        // (`Siblings`); this pulls the TYPE out of the argument expressions
        // (`Pivot.self` → a dependency on Pivot), so a model reached ONLY through
        // a relationship (a many-to-many pivot/join model) isn't left orphaned.
        // extractStaticMemberRef self-filters to `Type.member` navigation, so the
        // `\.$keypath` arguments and the wrapper `user_type` are skipped.
        const modifiers = node.namedChildren.find((c: SyntaxNode) => c.type === 'modifiers');
        if (modifiers) {
          const walkAttrArgs = (n: SyntaxNode): void => {
            this.extractStaticMemberRef(n);
            for (let i = 0; i < n.namedChildCount; i++) {
              const c = n.namedChild(i);
              if (c) walkAttrArgs(c);
            }
          };
          walkAttrArgs(modifiers);
        }
      }
    }
    // `export_statement` itself is not extracted — the walker descends
    // into children, where the inner declaration (lexical_declaration,
    // function_declaration, class_declaration, etc.) is dispatched to
    // its own extractor. `isExported` walks the parent chain, so the
    // exported flag is preserved automatically.
    //
    // Calling extractExportedVariables here AND descending caused every
    // `export const X = ...` to produce two nodes for the same symbol —
    // one kind:'variable' from extractExportedVariables and one
    // kind:'constant' from extractVariable. The dedicated dispatch is
    // the correct one (it picks kind from isConst, captures the
    // initializer signature, and walks type annotations); the
    // export-statement helper was redundant.
    // Check for imports
    else if (this.extractor.importTypes.includes(nodeType)) {
      this.extractImport(node);
    }
    // Re-export from another module — `export { X } from './y'` (TS/JS). A
    // re-export is a dependency on the source module just like an import, but
    // the export_statement is otherwise only descended into (no declaration to
    // extract), so a barrel that ONLY re-exports produced zero edges and showed
    // 0 dependents. Link each re-exported name to its definition. Children are
    // still visited (a non-re-export `export const X = …` has no `source` and
    // falls through to its normal declaration extraction).
    else if (
      nodeType === 'export_statement' &&
      (this.language === 'typescript' || this.language === 'tsx' ||
       this.language === 'javascript' || this.language === 'jsx') &&
      getChildByField(node, 'source')
    ) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      if (parentId) this.emitReExportRefs(node, parentId);
    }
    // Check for function calls
    else if (this.extractor.callTypes.includes(nodeType)) {
      this.extractCall(node);
    }
    // `new Foo(...)` / `Foo::new(...)` / object_creation_expression —
    // produce an `instantiates` reference. Children still walked so
    // nested calls inside the constructor args (`new Foo(bar())`) get
    // their own `calls` refs.
    else if (INSTANTIATION_KINDS.has(nodeType)) {
      this.extractInstantiation(node);
      // Java/C# `new T(...) { ... }` — anonymous class with body. Without
      // extracting it as a class node + its methods, the interface→impl
      // synthesizer (Phase 5.5) can't bridge T's abstract methods to the
      // anonymous overrides, and an agent investigating a call through T
      // (`strategy.iterator(...)` where strategy is a Strategy lambda body)
      // has to Read the file to find the actual implementation.
      const anonBody = this.findAnonymousClassBody(node);
      if (anonBody) {
        this.extractAnonymousClass(node, anonBody);
        skipChildren = true;
      }
    }
    // (Decorator handling lives inside the symbol-creating extractors
    // — extractClass / extractFunction / extractProperty — because the
    // decorator node sits BEFORE the symbol in the AST and the walker
    // would otherwise see the wrong nodeStack head.)
    // Rust: `impl Trait for Type { ... }` — creates implements edge from Type to Trait
    else if (nodeType === 'impl_item') {
      this.extractRustImplItem(node);
    }
    // TypeScript interface members: property_signature (`foo: T`, `foo?: T`)
    // and method_signature (`foo(arg: A): R`) both carry type annotations the
    // interface walker would otherwise drop. Extract them as `references`
    // edges from the interface so resolvers can wire callers/impact for
    // types that only appear in interface members.
    else if (
      (nodeType === 'property_signature' || nodeType === 'method_signature') &&
      this.isInsideClassLikeNode() &&
      this.TYPE_ANNOTATION_LANGUAGES.has(this.language)
    ) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      if (parentId) {
        this.extractTypeAnnotations(node, parentId);
      }
      // don't skipChildren — nested signatures still need traversal
    }

    // Visit children (unless the extract method already visited them)
    if (!skipChildren) {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) {
          this.visitNode(child);
        }
      }
    }
  }

  /**
   * Create a Node object
   */
  private createNode(
    kind: NodeKind,
    name: string,
    node: SyntaxNode,
    extra?: Partial<Node>
  ): Node | null {
    // Skip nodes with empty/missing names — they are not meaningful symbols
    // and would cause FK violations when edges reference them (see issue #42)
    if (!name) {
      return null;
    }

    const id = generateNodeId(this.filePath, kind, name, node.startPosition.row + 1);

    // Some grammars (e.g. Dart) model a function/method body as a *sibling* of
    // the signature node, so the declaration node's own range is just the
    // signature line. Extend endLine to the resolved body when it sits beyond
    // the node so the node spans its body — required for any body-level analysis
    // (callees, the callback synthesizer's body scan, context slices). Guarded to
    // only ever extend: for child-body grammars the body is within range (no-op).
    let endLine = node.endPosition.row + 1;
    if (kind === 'function' || kind === 'method') {
      const body = this.extractor?.resolveBody?.(node, this.extractor.bodyField);
      if (body && body.endPosition.row + 1 > endLine) {
        endLine = body.endPosition.row + 1;
      }
    }

    const newNode: Node = {
      id,
      kind,
      name,
      qualifiedName: this.buildQualifiedName(name),
      filePath: this.filePath,
      language: this.language,
      startLine: node.startPosition.row + 1,
      endLine,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      updatedAt: Date.now(),
      ...extra,
    };

    // Persist extra symbol-level modifiers (e.g. Kotlin `expect`/`actual`) onto
    // the node's decorators list so the resolver can pair multiplatform
    // declarations with their implementations. Merged, not overwritten, so a
    // language that also captures real annotations keeps both.
    const mods = this.extractor?.extractModifiers?.(node);
    if (mods && mods.length > 0) {
      newNode.decorators = [...(newNode.decorators ?? []), ...mods];
    }

    this.nodes.push(newNode);

    // Add containment edge from parent
    if (this.nodeStack.length > 0) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      if (parentId) {
        this.edges.push({
          source: parentId,
          target: id,
          kind: 'contains',
        });
      }
    }

    return newNode;
  }

  /**
   * Find first named child whose type is in the given list.
   * Used to locate inner type nodes (e.g. enum_specifier inside a typedef).
   */
  private findChildByTypes(node: SyntaxNode, types: string[]): SyntaxNode | null {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && types.includes(child.type)) return child;
    }
    return null;
  }

  /**
   * Find a `packageTypes` child under the root, create a `namespace` node
   * for it, and return its id so the caller can scope top-level
   * declarations underneath. Returns null when no package header is
   * present (script files, .kts without a package).
   */
  private extractFilePackage(rootNode: SyntaxNode): string | null {
    const types = this.extractor?.packageTypes;
    if (!types || types.length === 0 || !this.extractor?.extractPackage) return null;

    let pkgNode: SyntaxNode | null = null;
    for (let i = 0; i < rootNode.namedChildCount; i++) {
      const child = rootNode.namedChild(i);
      if (child && types.includes(child.type)) {
        pkgNode = child;
        break;
      }
    }
    if (!pkgNode) return null;

    const pkgName = this.extractor.extractPackage(pkgNode, this.source);
    if (!pkgName) return null;

    const ns = this.createNode('namespace', pkgName, pkgNode);
    return ns?.id ?? null;
  }

  /**
   * Build qualified name from node stack
   */
  private buildQualifiedName(name: string): string {
    // Build a qualified name from the semantic hierarchy only (no file path).
    // The file path is stored separately in filePath and pollutes FTS if included here.
    const parts: string[] = [];
    for (const nodeId of this.nodeStack) {
      const node = this.nodes.find((n) => n.id === nodeId);
      if (node && node.kind !== 'file') {
        parts.push(node.name);
      }
    }
    parts.push(name);
    return parts.join('::');
  }

  /**
   * Build an ExtractorContext for passing to language-specific visitNode hooks.
   */
  private makeExtractorContext(): ExtractorContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      createNode: (kind, name, node, extra) => self.createNode(kind, name, node, extra),
      visitNode: (node) => self.visitNode(node),
      visitFunctionBody: (body, functionId) => self.visitFunctionBody(body, functionId),
      addUnresolvedReference: (ref) => self.unresolvedReferences.push(ref),
      pushScope: (nodeId) => self.nodeStack.push(nodeId),
      popScope: () => self.nodeStack.pop(),
      get filePath() { return self.filePath; },
      get source() { return self.source; },
      get nodeStack() { return self.nodeStack; },
      get nodes() { return self.nodes; },
    };
  }

  /**
   * Check if the current node stack indicates we are inside a class-like node
   * (class, struct, interface, trait). File nodes do not count as class-like.
   */
  private isInsideClassLikeNode(): boolean {
    if (this.nodeStack.length === 0) return false;
    const parentId = this.nodeStack[this.nodeStack.length - 1];
    if (!parentId) return false;
    const parentNode = this.nodes.find((n) => n.id === parentId);
    if (!parentNode) return false;
    return (
      parentNode.kind === 'class' ||
      parentNode.kind === 'struct' ||
      parentNode.kind === 'interface' ||
      parentNode.kind === 'trait' ||
      parentNode.kind === 'enum' ||
      parentNode.kind === 'module'
    );
  }

  /**
   * Extract a function
   */
  private extractFunction(node: SyntaxNode, nameOverride?: string): void {
    if (!this.extractor) return;

    // If the language provides getReceiverType and this function has a receiver
    // (e.g., Rust function_item inside an impl block), extract as method instead
    if (this.extractor.getReceiverType?.(node, this.source)) {
      this.extractMethod(node);
      return;
    }

    // nameOverride is supplied only for explicitly-named anonymous functions the
    // caller resolved itself (e.g. arrow values of exported-const object members
    // — SvelteKit actions). Inline-object arrows reached by the general walker
    // get no override, so they still fall through to the <anonymous> skip below.
    let name = nameOverride ?? extractName(node, this.source, this.extractor);
    // For arrow functions and function expressions assigned to variables,
    // resolve the name from the parent variable_declarator.
    // e.g. `export const useAuth = () => { ... }` — the arrow_function node
    // has no `name` field; the name lives on the variable_declarator.
    if (
      !nameOverride &&
      name === '<anonymous>' &&
      (node.type === 'arrow_function' || node.type === 'function_expression')
    ) {
      const parent = node.parent;
      if (parent?.type === 'variable_declarator') {
        const varName = getChildByField(parent, 'name');
        if (varName) {
          name = getNodeText(varName, this.source);
        }
      }
    }
    if (name === '<anonymous>') {
      // Don't emit a node for the anonymous wrapper itself, but still visit its
      // body: AMD/RequireJS and CommonJS module wrappers (`define([], function(){…})`,
      // `(function(){…})()`) hold named inner functions and calls that would
      // otherwise be lost — the dispatcher set skipChildren, so nothing else
      // descends into this subtree. (#528)
      const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
        ?? getChildByField(node, this.extractor.bodyField);
      if (body) {
        this.visitFunctionBody(body, '');
      }
      return;
    }

    // Check for misparse artifacts (e.g. C++ macros causing "namespace detail" functions)
    // Skip the node but still visit the body for calls and structural nodes
    if (this.extractor.isMisparsedFunction?.(name, node)) {
      const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
        ?? getChildByField(node, this.extractor.bodyField);
      if (body) {
        this.visitFunctionBody(body, '');
      }
      return;
    }

    const docstring = getPrecedingDocstring(node, this.source);
    const signature = this.extractor.getSignature?.(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);
    const isAsync = this.extractor.isAsync?.(node);
    const isStatic = this.extractor.isStatic?.(node);
    const returnType = this.extractor.getReturnType?.(node, this.source);

    const funcNode = this.createNode('function', name, node, {
      docstring,
      signature,
      visibility,
      isExported,
      isAsync,
      isStatic,
      returnType,
    });
    if (!funcNode) return;

    // Extract type annotations (parameter types and return type)
    this.extractTypeAnnotations(node, funcNode.id);

    // Extract decorators applied to the function (rare in JS/TS but
    // present in Python `@decorator def f():` and Java/Kotlin
    // annotations on free functions).
    this.extractDecoratorsFor(node, funcNode.id);

    // Push to stack and visit body
    this.nodeStack.push(funcNode.id);
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.visitFunctionBody(body, funcNode.id);
    }
    this.nodeStack.pop();
  }

  /**
   * Extract a class
   */
  private extractClass(node: SyntaxNode, kind: NodeKind = 'class'): void {
    if (!this.extractor) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const classNode = this.createNode(kind, name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!classNode) return;

    // Extract extends/implements
    this.extractInheritance(node, classNode.id);

    // C# primary-constructor parameter dependencies (`class Svc(IRepo r, …)`).
    this.extractCsharpPrimaryCtorParamRefs(node, classNode.id);

    // Extract decorators applied to the class (`@Foo class X {}`).
    this.extractDecoratorsFor(node, classNode.id);

    // Push to stack and visit body
    this.nodeStack.push(classNode.id);
    let body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (!body) body = node;

    // Visit all children for methods and properties
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract a method
   */
  private extractMethod(node: SyntaxNode): void {
    if (!this.extractor) return;

    // For languages with receiver types (Go, Rust), include receiver in qualified name
    // so FTS can match "scrapeLoop.run" → qualified_name "...::scrapeLoop::run"
    const receiverType = this.extractor.getReceiverType?.(node, this.source);

    // For most languages, only extract as method if inside a class-like node
    // Languages with methodsAreTopLevel (e.g. Go) always treat them as methods
    // Languages with getReceiverType (e.g. Rust) extract as method when receiver is found
    if (!this.isInsideClassLikeNode() && !this.extractor.methodsAreTopLevel && !receiverType) {
      // Skip method_definition nodes inside object literals (getters/setters/methods
      // in inline objects). These are ephemeral and create noise (e.g., Svelte context
      // objects: `ctx.set({ get view() { ... } })`).
      if (node.parent?.type === 'object' || node.parent?.type === 'object_expression') {
        const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
          ?? getChildByField(node, this.extractor.bodyField);
        if (body) {
          this.visitFunctionBody(body, '');
        }
        return;
      }
      // Not inside a class-like node and no receiver type, treat as function
      this.extractFunction(node);
      return;
    }

    const name = extractName(node, this.source, this.extractor);

    // Check for misparse artifacts (e.g. C++ "switch" inside macro-confused class body)
    if (this.extractor.isMisparsedFunction?.(name, node)) {
      const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
        ?? getChildByField(node, this.extractor.bodyField);
      if (body) {
        this.visitFunctionBody(body, '');
      }
      return;
    }

    const docstring = getPrecedingDocstring(node, this.source);
    const signature = this.extractor.getSignature?.(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isAsync = this.extractor.isAsync?.(node);
    const isStatic = this.extractor.isStatic?.(node);
    const returnType = this.extractor.getReturnType?.(node, this.source);
    const extraProps: Partial<Node> = {
      docstring,
      signature,
      visibility,
      isAsync,
      isStatic,
      returnType,
    };
    if (receiverType) {
      extraProps.qualifiedName = `${receiverType}::${name}`;
    }

    const methodNode = this.createNode('method', name, node, extraProps);
    if (!methodNode) return;

    // For methods with a receiver type but no class-like parent on the stack
    // (e.g., Rust impl blocks), add a contains edge from the owning struct/trait
    if (receiverType && !this.isInsideClassLikeNode()) {
      const ownerNode = this.nodes.find(
        (n) =>
          n.name === receiverType &&
          n.filePath === this.filePath &&
          (n.kind === 'struct' || n.kind === 'class' || n.kind === 'enum' || n.kind === 'trait')
      );
      if (ownerNode) {
        this.edges.push({
          source: ownerNode.id,
          target: methodNode.id,
          kind: 'contains',
        });
      }
    }

    // Extract type annotations (parameter types and return type)
    this.extractTypeAnnotations(node, methodNode.id);

    // Extract decorators (`@Get('/list') list() {}`).
    this.extractDecoratorsFor(node, methodNode.id);

    // Push to stack and visit body
    this.nodeStack.push(methodNode.id);
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.visitFunctionBody(body, methodNode.id);
    }
    this.nodeStack.pop();
  }

  /**
   * Extract an interface/protocol/trait
   */
  private extractInterface(node: SyntaxNode): void {
    if (!this.extractor) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source);

    const kind: NodeKind = this.extractor.interfaceKind ?? 'interface';

    const interfaceNode = this.createNode(kind, name, node, {
      docstring,
      isExported,
    });
    if (!interfaceNode) return;

    // Extract extends (interface inheritance)
    this.extractInheritance(node, interfaceNode.id);

    // Visit body children for interface methods and nested types
    this.nodeStack.push(interfaceNode.id);
    let body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (!body) body = node;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract a struct
   */
  private extractStruct(node: SyntaxNode): void {
    if (!this.extractor) return;

    // Skip forward declarations and type references (no body = not a definition)
    const body = getChildByField(node, this.extractor.bodyField);
    if (!body) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const structNode = this.createNode('struct', name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!structNode) return;

    // Extract inheritance (e.g. Swift: struct HTTPMethod: RawRepresentable)
    this.extractInheritance(node, structNode.id);

    // C# primary-constructor parameter dependencies (`struct P(int x)`, and
    // `record struct M(decimal Amount)` which the grammar nests here).
    this.extractCsharpPrimaryCtorParamRefs(node, structNode.id);

    // Push to stack for field extraction
    this.nodeStack.push(structNode.id);
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract an enum
   */
  private extractEnum(node: SyntaxNode): void {
    if (!this.extractor) return;

    // Skip forward declarations and type references (no body = not a definition)
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (!body) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const enumNode = this.createNode('enum', name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!enumNode) return;

    // Extract inheritance (e.g. Swift: enum AFError: Error)
    this.extractInheritance(node, enumNode.id);

    // Push to stack and visit body children (enum members, nested types, methods)
    this.nodeStack.push(enumNode.id);

    const memberTypes = this.extractor.enumMemberTypes;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (!child) continue;

      if (memberTypes?.includes(child.type)) {
        this.extractEnumMembers(child);
      } else {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract enum member names from an enum member node.
   * Handles multi-case declarations (Swift: `case put, delete`) and single-case patterns.
   */
  private extractEnumMembers(node: SyntaxNode): void {
    // Try field-based name first (e.g. Rust enum_variant has a 'name' field)
    const nameNode = getChildByField(node, 'name');
    if (nameNode) {
      this.createNode('enum_member', getNodeText(nameNode, this.source), node);
      return;
    }

    // Check for identifier-like children (Swift: simple_identifier, TS: property_identifier)
    let found = false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (child.type === 'simple_identifier' || child.type === 'identifier' || child.type === 'property_identifier')) {
        this.createNode('enum_member', getNodeText(child, this.source), child);
        found = true;
      }
    }

    // If the node itself IS the identifier (e.g. TS property_identifier directly in enum body)
    if (!found && node.namedChildCount === 0) {
      this.createNode('enum_member', getNodeText(node, this.source), node);
    }
  }

  /**
   * Extract a class property declaration (e.g. C# `public string Name { get; set; }`).
   * Extracts as 'property' kind node inside the owning class.
   */
  private extractProperty(node: SyntaxNode): void {
    if (!this.extractor) return;

    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isStatic = this.extractor.isStatic?.(node) ?? false;

    const hookName = this.extractor.extractPropertyName?.(node, this.source);
    const nameNode = hookName
      ? null
      : getChildByField(node, 'name') || node.namedChildren.find(c => c.type === 'identifier');
    const name = hookName ?? (nameNode ? getNodeText(nameNode, this.source) : null);
    if (!name) return;

    // Get property type from the type child (first named child that isn't modifier or identifier)
    const typeNode = node.namedChildren.find(
      c => c.type !== 'modifier' && c.type !== 'modifiers'
        && c.type !== 'identifier' && c.type !== 'accessor_list'
        && c.type !== 'accessors' && c.type !== 'equals_value_clause'
    );
    const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;
    const signature = typeText ? `${typeText} ${name}` : name;

    const propNode = this.createNode('property', name, node, {
      docstring,
      signature,
      visibility,
      isStatic,
    });

    // `@Inject() private svc: Foo` and similar — capture the
    // decorator->target relationship for class properties too.
    if (propNode) {
      this.extractDecoratorsFor(node, propNode.id);
      // Emit `references` edges from the property to types named in its
      // type annotation (#381). The generic walker handles TS-style
      // `type_annotation` children; the C# branch walks the `type` field.
      this.extractTypeAnnotations(node, propNode.id);
    }
  }

  /**
   * Extract a class field declaration (e.g. Java field_declaration, C# field_declaration).
   * Extracts each declarator as a 'field' kind node inside the owning class.
   */
  private extractField(node: SyntaxNode): void {
    if (!this.extractor) return;

    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isStatic = this.extractor.isStatic?.(node) ?? false;

    // Java field_declaration: "private final String name = value;" → variable_declarator(s) are direct children
    // C# field_declaration: wraps in variable_declaration → variable_declarator(s)
    let declarators = node.namedChildren.filter(
      c => c.type === 'variable_declarator'
    );
    // C#: look inside variable_declaration wrapper
    if (declarators.length === 0) {
      const varDecl = node.namedChildren.find(c => c.type === 'variable_declaration');
      if (varDecl) {
        declarators = varDecl.namedChildren.filter(c => c.type === 'variable_declarator');
      }
    }

    // PHP property_declaration: property_element → variable_name → name
    if (declarators.length === 0) {
      const propElements = node.namedChildren.filter(c => c.type === 'property_element');
      if (propElements.length > 0) {
        // Get type annotation if present (e.g. "string", "int", "?Foo")
        const typeNode = node.namedChildren.find(
          c => c.type !== 'visibility_modifier' && c.type !== 'static_modifier'
            && c.type !== 'readonly_modifier' && c.type !== 'property_element'
            && c.type !== 'var_modifier'
        );
        const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;

        for (const elem of propElements) {
          const varName = elem.namedChildren.find(c => c.type === 'variable_name');
          const nameNode = varName?.namedChildren.find(c => c.type === 'name');
          if (!nameNode) continue;
          const name = getNodeText(nameNode, this.source);
          const signature = typeText ? `${typeText} $${name}` : `$${name}`;
          this.createNode('field', name, elem, {
            docstring,
            signature,
            visibility,
            isStatic,
          });
        }
        return;
      }
    }

    if (declarators.length > 0) {
      // Get field type from the type child
      // Java: type is a direct child of field_declaration
      // C#: type is inside variable_declaration wrapper
      const varDecl = node.namedChildren.find(c => c.type === 'variable_declaration');
      const typeSearchNode = varDecl ?? node;
      const typeNode = typeSearchNode.namedChildren.find(
        c => c.type !== 'modifiers' && c.type !== 'modifier' && c.type !== 'variable_declarator'
          && c.type !== 'variable_declaration' && c.type !== 'marker_annotation' && c.type !== 'annotation'
      );
      const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;

      for (const decl of declarators) {
        const nameNode = getChildByField(decl, 'name')
          || decl.namedChildren.find(c => c.type === 'identifier');
        if (!nameNode) continue;
        const name = getNodeText(nameNode, this.source);
        const signature = typeText ? `${typeText} ${name}` : name;
        const fieldNode = this.createNode('field', name, decl, {
          docstring,
          signature,
          visibility,
          isStatic,
        });
        // Java/Kotlin annotations / TS field decorators sit on the
        // outer field_declaration, not on the individual declarator.
        if (fieldNode) {
          this.extractDecoratorsFor(node, fieldNode.id);
          // Same as properties: emit `references` to the field's annotated
          // type. The outer `field_declaration` is the right scope to
          // search from — C# carries the `type` inside `variable_declaration`
          // and the language-aware path in `extractTypeAnnotations` descends
          // into that wrapper (#381).
          this.extractTypeAnnotations(node, fieldNode.id);
        }
      }
    } else {
      // Fallback: try to find an identifier child directly
      const nameNode = getChildByField(node, 'name')
        || node.namedChildren.find(c => c.type === 'identifier');
      if (nameNode) {
        const name = getNodeText(nameNode, this.source);
        this.createNode('field', name, node, {
          docstring,
          visibility,
          isStatic,
        });
      }
    }
  }

  /**
   * Extract function-valued properties of an object literal as named function
   * nodes (named by their property key). Shared by the two object-of-functions
   * shapes in extractVariable: the object as a direct const value, and the
   * object returned by a store-initializer call. Handles both `key: () => {}` /
   * `key: function() {}` pairs and method shorthand `key() {}`.
   */
  private extractObjectLiteralFunctions(obj: SyntaxNode): void {
    for (let i = 0; i < obj.namedChildCount; i++) {
      const member = obj.namedChild(i);
      if (!member) continue;
      if (member.type === 'pair') {
        const key = getChildByField(member, 'key');
        const value = getChildByField(member, 'value');
        if (key && value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
          this.extractFunction(value, this.objectKeyName(key));
        }
      } else if (member.type === 'method_definition') {
        // Method shorthand: `{ fetchUser() {...} }`. extractMethod deliberately
        // skips object-literal methods, so route through extractFunction with an
        // explicit name (method_definition exposes a `body` field, so resolveBody
        // falls through to it and the node spans the full method).
        const key = getChildByField(member, 'name');
        if (key) this.extractFunction(member, this.objectKeyName(key));
      }
    }
  }

  /** Property-key text with surrounding quotes stripped (`'foo'` → `foo`). */
  private objectKeyName(key: SyntaxNode): string {
    return getNodeText(key, this.source).replace(/^['"`]|['"`]$/g, '');
  }

  /**
   * Given a `call_expression` initializer (`create((set, get) => ({...}))`),
   * find the object literal RETURNED by a function argument — descending through
   * nested call_expression arguments so middleware wrappers are unwrapped
   * (`create(persist((set, get) => ({...}), {...}))`, devtools, immer,
   * subscribeWithSelector). Returns null when no such object is found — the
   * common case for ordinary call initializers — so this stays cheap and silent
   * rather than guessing. Keyed purely on AST shape; no library names.
   */
  private findInitializerReturnedObject(callNode: SyntaxNode, depth = 0): SyntaxNode | null {
    if (depth > 4) return null;
    const args = getChildByField(callNode, 'arguments');
    if (!args) return null;
    for (let i = 0; i < args.namedChildCount; i++) {
      const arg = args.namedChild(i);
      if (!arg) continue;
      if (arg.type === 'arrow_function' || arg.type === 'function_expression') {
        const obj = this.functionReturnedObject(arg);
        if (obj) return obj;
      } else if (arg.type === 'call_expression') {
        const obj = this.findInitializerReturnedObject(arg, depth + 1);
        if (obj) return obj;
      }
    }
    return null;
  }

  /**
   * The object literal a function expression returns — either the `=> ({...})`
   * arrow form (a parenthesized_expression wrapping an object) or a
   * `=> { return {...} }` block. Returns null for any other body shape.
   */
  private functionReturnedObject(fnNode: SyntaxNode): SyntaxNode | null {
    const body = getChildByField(fnNode, 'body');
    if (!body) return null;
    const asObject = (n: SyntaxNode | null): SyntaxNode | null => {
      if (!n) return null;
      if (n.type === 'object' || n.type === 'object_expression') return n;
      if (n.type === 'parenthesized_expression') {
        for (let i = 0; i < n.namedChildCount; i++) {
          const inner = asObject(n.namedChild(i));
          if (inner) return inner;
        }
      }
      return null;
    };
    // `(set, get) => ({...})` — body is the (parenthesized) object directly.
    const direct = asObject(body);
    if (direct) return direct;
    // `(set, get) => { return {...} }` — scan top-level return statements.
    if (body.type === 'statement_block') {
      for (let i = 0; i < body.namedChildCount; i++) {
        const stmt = body.namedChild(i);
        if (stmt?.type !== 'return_statement') continue;
        for (let j = 0; j < stmt.namedChildCount; j++) {
          const obj = asObject(stmt.namedChild(j));
          if (obj) return obj;
        }
      }
    }
    return null;
  }

  /**
   * Extract a variable declaration (const, let, var, etc.)
   *
   * Extracts top-level and module-level variable declarations.
   * Captures the variable name and first 100 chars of initializer in signature for searchability.
   */
  private extractVariable(node: SyntaxNode): void {
    if (!this.extractor) return;

    // Different languages have different variable declaration structures
    // TypeScript/JavaScript: lexical_declaration contains variable_declarator children
    // Python: assignment has left (identifier) and right (value)
    // Go: var_declaration, short_var_declaration, const_declaration

    const isConst = this.extractor.isConst?.(node) ?? false;
    const kind: NodeKind = isConst ? 'constant' : 'variable';
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source) ?? false;

    // Extract variable declarators based on language
    if (this.language === 'typescript' || this.language === 'javascript' ||
        this.language === 'tsx' || this.language === 'jsx') {
      // Handle lexical_declaration and variable_declaration
      // These contain one or more variable_declarator children
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'variable_declarator') {
          const nameNode = getChildByField(child, 'name');
          const valueNode = getChildByField(child, 'value');

          if (nameNode) {
            // Skip destructured patterns (e.g., `let { x, y } = $props()` in Svelte)
            // These produce ugly multi-line names like "{ class: className }"
            if (nameNode.type === 'object_pattern' || nameNode.type === 'array_pattern') {
              continue;
            }
            const name = getNodeText(nameNode, this.source);
            // Arrow functions / function expressions: extract as function instead of variable
            if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')) {
              this.extractFunction(valueNode);
              continue;
            }

            // Capture first 100 chars of initializer for context (stored in signature for searchability)
            const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
            const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

            const varNode = this.createNode(kind, name, child, {
              docstring,
              signature: initSignature,
              isExported,
            });

            // Extract type annotation references (e.g., const x: ITextModel = ...)
            if (varNode) {
              this.extractVariableTypeAnnotation(child, varNode.id);
            }

            // Exported const object-of-functions — extract each function-valued
            // property as a function named by its key + walk its body so its
            // calls are captured. Two shapes, both keyed on AST shape (not on any
            // library name):
            //   `export const actions = { default: async () => {} }` — object is
            //     the DIRECT value (SvelteKit form actions / handler maps / route
            //     tables).
            //   `export const useStore = create((set, get) => ({ fetchUser:
            //     async () => {} }))` — object is RETURNED by an initializer call,
            //     possibly through middleware wrappers (persist/devtools/immer).
            //     Covers Zustand/Redux/Pinia/MobX stores generically. Without
            //     this, store actions exist only as object-literal properties —
            //     never nodes — so `node`/`callers` on `fetchUser` return "not
            //     found" and the agent Reads the store to reconstruct the flow.
            // Scoped to EXPORTED consts to exclude inline-object noise
            // (`ctx.set({...})`) the object-method skip deliberately avoids.
            const objectOfFns =
              valueNode && (valueNode.type === 'object' || valueNode.type === 'object_expression')
                ? valueNode
                : valueNode?.type === 'call_expression'
                  ? this.findInitializerReturnedObject(valueNode)
                  : null;
            const extractObjectMethods = isExported && !!objectOfFns;

            // Visit the initializer body for calls — EXCEPT object literals (their
            // function-valued properties are extracted below) and the store-factory
            // call whose returned object we extract method-by-method below (walking
            // the whole call would re-visit those method arrows and mis-attribute
            // their inner calls to the file/module scope).
            if (valueNode &&
                valueNode.type !== 'object' &&
                valueNode.type !== 'object_expression' &&
                !(extractObjectMethods && valueNode.type === 'call_expression')) {
              this.visitFunctionBody(valueNode, '');
            }

            if (extractObjectMethods && objectOfFns) {
              this.extractObjectLiteralFunctions(objectOfFns);
            }
          }
        }
      }
    } else if (this.language === 'python' || this.language === 'ruby') {
      // Python/Ruby assignment: left = right
      const left = getChildByField(node, 'left') || node.namedChild(0);
      const right = getChildByField(node, 'right') || node.namedChild(1);

      if (left && left.type === 'identifier') {
        const name = getNodeText(left, this.source);
        // Skip if name starts with lowercase and looks like a function call result
        // Python constants are usually UPPER_CASE
        const initValue = right ? getNodeText(right, this.source).slice(0, 100) : undefined;
        const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

        this.createNode(kind, name, node, {
          docstring,
          signature: initSignature,
        });
      }
    } else if (this.language === 'go') {
      // Go: var_declaration, short_var_declaration, const_declaration
      // These can have multiple identifiers on the left
      const specs = node.namedChildren.filter(c =>
        c.type === 'var_spec' || c.type === 'const_spec'
      );

      for (const spec of specs) {
        const nameNode = spec.namedChild(0);
        let varNode: Node | null = null;
        if (nameNode && nameNode.type === 'identifier') {
          const name = getNodeText(nameNode, this.source);
          const valueNode = spec.namedChildCount > 1 ? spec.namedChild(spec.namedChildCount - 1) : null;
          const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
          const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

          varNode = this.createNode(node.type === 'const_declaration' ? 'constant' : 'variable', name, spec, {
            docstring,
            signature: initSignature,
          });
        }
        // Walk the initializer so composite literals and calls in a
        // package-level `var Query Binding = queryBinding{}` (a registry of
        // implementations) or `var c = pkg.New()` are extracted as
        // instantiates/calls dependencies — the body walker only covers
        // initializers inside functions, not these top-level declarations.
        // Scope the walk to the declared symbol so a call inside an anonymous
        // func_literal initializer — a cobra `RunE: func(){…}` handler, a
        // goroutine or callback closure — attributes to the var instead of
        // leaking to the file node (which reads as "no caller"), issue #693.
        const valueField = getChildByField(spec, 'value');
        if (valueField) {
          if (varNode) this.nodeStack.push(varNode.id);
          this.visitFunctionBody(valueField, varNode?.id ?? '');
          if (varNode) this.nodeStack.pop();
        }
      }

      // Handle short_var_declaration (:=)
      if (node.type === 'short_var_declaration') {
        const left = getChildByField(node, 'left');
        const right = getChildByField(node, 'right');

        if (left) {
          // Can be expression_list with multiple identifiers
          const identifiers = left.type === 'expression_list'
            ? left.namedChildren.filter(c => c.type === 'identifier')
            : [left];

          for (const id of identifiers) {
            const name = getNodeText(id, this.source);
            const initValue = right ? getNodeText(right, this.source).slice(0, 100) : undefined;
            const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

            this.createNode('variable', name, node, {
              docstring,
              signature: initSignature,
            });
          }
        }
      }
    } else if (this.language === 'lua' || this.language === 'luau') {
      // Lua/Luau: variable_declaration → assignment_statement → variable_list
      //      (name: identifier...) = expression_list. `local x, y = 1, 2`
      //      declares multiple names; only plain identifiers are locals.
      const assign = node.namedChildren.find((c) => c.type === 'assignment_statement') ?? node;
      const varList = assign.namedChildren.find((c) => c.type === 'variable_list');
      const exprList = assign.namedChildren.find((c) => c.type === 'expression_list');
      const values = exprList ? exprList.namedChildren : [];
      const names = varList ? varList.namedChildren.filter((c) => c.type === 'identifier') : [];
      names.forEach((nameNode, i) => {
        const name = getNodeText(nameNode, this.source);
        if (!name) return;
        const valueNode = values[i];
        const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
        const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;
        this.createNode(kind, name, nameNode, { docstring, signature: initSignature, isExported });
      });
    } else {
      // Generic fallback for other languages
      // Try to find identifier children
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'identifier' || child?.type === 'variable_declarator') {
          const name = child.type === 'identifier'
            ? getNodeText(child, this.source)
            : extractName(child, this.source, this.extractor);

          if (name && name !== '<anonymous>') {
            this.createNode(kind, name, child, {
              docstring,
              isExported,
            });
          }
        }
      }
    }
  }

  /**
   * Extract a type alias (e.g. `export type X = ...` in TypeScript).
   * For languages like Go, resolveTypeAliasKind detects when the type_spec
   * wraps a struct or interface definition and creates the correct node kind.
   * Returns true if children should be skipped (struct/interface handled body visiting).
   */
  private extractTypeAlias(node: SyntaxNode): boolean {
    if (!this.extractor) return false;

    const name = extractName(node, this.source, this.extractor);
    if (name === '<anonymous>') return false;
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source);

    // Check if this type alias is actually a struct or interface definition
    // (e.g. Go: `type Foo struct { ... }` is a type_spec wrapping struct_type)
    const resolvedKind = this.extractor.resolveTypeAliasKind?.(node, this.source);

    if (resolvedKind === 'struct') {
      const structNode = this.createNode('struct', name, node, { docstring, isExported });
      if (!structNode) return true;
      // Visit body children for field extraction
      this.nodeStack.push(structNode.id);
      // Try Go-style 'type' field first, then find inner struct child (C typedef struct)
      const typeChild = getChildByField(node, 'type')
        || this.findChildByTypes(node, this.extractor.structTypes);
      if (typeChild) {
        // Extract struct embedding (e.g. Go: `type DB struct { *Head; Queryable }`)
        this.extractInheritance(typeChild, structNode.id);
        const body = getChildByField(typeChild, this.extractor.bodyField) || typeChild;
        for (let i = 0; i < body.namedChildCount; i++) {
          const child = body.namedChild(i);
          if (child) this.visitNode(child);
        }
      }
      this.nodeStack.pop();
      return true;
    }

    if (resolvedKind === 'enum') {
      const enumNode = this.createNode('enum', name, node, { docstring, isExported });
      if (!enumNode) return true;
      this.nodeStack.push(enumNode.id);
      // Find the inner enum type child (e.g. C: typedef enum { ... } name)
      const innerEnum = this.findChildByTypes(node, this.extractor.enumTypes);
      if (innerEnum) {
        this.extractInheritance(innerEnum, enumNode.id);
        const body = this.extractor.resolveBody?.(innerEnum, this.extractor.bodyField)
          ?? getChildByField(innerEnum, this.extractor.bodyField);
        if (body) {
          const memberTypes = this.extractor.enumMemberTypes;
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i);
            if (!child) continue;
            if (memberTypes?.includes(child.type)) {
              this.extractEnumMembers(child);
            } else {
              this.visitNode(child);
            }
          }
        }
      }
      this.nodeStack.pop();
      return true;
    }

    if (resolvedKind === 'interface') {
      const kind: NodeKind = this.extractor.interfaceKind ?? 'interface';
      const interfaceNode = this.createNode(kind, name, node, { docstring, isExported });
      if (!interfaceNode) return true;
      // Extract interface inheritance from the inner type node
      const typeChild = getChildByField(node, 'type');
      if (typeChild) this.extractInheritance(typeChild, interfaceNode.id);
      // Go: extract the interface's method specs as `method` nodes so implicit
      // interface satisfaction (a struct's method set ⊇ the interface's) and
      // impl-navigation can see the contract. Go has no `implements` keyword, so
      // without the interface's method set there's nothing to match against.
      if (this.language === 'go' && typeChild) {
        this.extractGoInterfaceMethods(typeChild, interfaceNode.id);
      }
      return true;
    }

    const typeAliasNode = this.createNode('type_alias', name, node, {
      docstring,
      isExported,
    });

    // Extract type references from the alias value (e.g., `type X = ITextModel | null`)
    if (typeAliasNode && this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) {
      // The value is everything after the `=`, which is typically the last named child
      // In tree-sitter TS: type_alias_declaration has name + value children
      const value = getChildByField(node, 'value');
      if (value) {
        this.extractTypeRefsFromSubtree(value, typeAliasNode.id);
        // `type X = { foo: T; bar(): T }` — make the members first-class
        // property/method nodes under the type alias so `recorder.stop()`
        // can attach the call edge to `RecorderHandle.stop` instead of
        // an unrelated class method picked by path-proximity (#359).
        if (this.language === 'typescript' || this.language === 'tsx') {
          this.extractTsTypeAliasMembers(value, typeAliasNode);
          // `type List = [ Service<'name', Req, Resp>, … ]` — surface each
          // entry's string-literal name as a searchable member (issue #634).
          this.extractTsTupleContractNames(value, typeAliasNode);
        }
      }
    }
    return false;
  }

  /**
   * Extract the method specs of a Go `interface_type` body as `method` nodes
   * contained by the interface (e.g. `Marshal`, `Unmarshal` of a `Core`
   * interface). tree-sitter-go names these `method_elem` (newer) or
   * `method_spec` (older). Embedded interfaces (`Reader` inside `ReadWriter`)
   * are `type_identifier`s, not methods, and are left to inheritance extraction.
   */
  private extractGoInterfaceMethods(interfaceType: SyntaxNode, ifaceId: string): void {
    this.nodeStack.push(ifaceId);
    for (let i = 0; i < interfaceType.namedChildCount; i++) {
      const m = interfaceType.namedChild(i);
      if (!m || (m.type !== 'method_elem' && m.type !== 'method_spec')) continue;
      const nameNode = getChildByField(m, 'name') ?? m.namedChild(0);
      if (!nameNode) continue;
      const mname = getNodeText(nameNode, this.source);
      if (mname) {
        this.createNode('method', mname, m, {
          signature: this.extractor?.getSignature?.(m, this.source),
        });
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Surface the members of a TypeScript `type X = { ... }` (or intersection
   * thereof) as `property` / `method` nodes under the type-alias node. Only
   * walks the immediate object_type / intersection operands so anonymous
   * nested object types inside generic arguments (`Promise<{ ok: true }>`)
   * don't produce phantom members.
   */
  private extractTsTypeAliasMembers(value: SyntaxNode, typeAliasNode: Node): void {
    const objectTypes: SyntaxNode[] = [];
    if (value.type === 'object_type') {
      objectTypes.push(value);
    } else if (value.type === 'intersection_type') {
      for (let i = 0; i < value.namedChildCount; i++) {
        const op = value.namedChild(i);
        if (op && op.type === 'object_type') objectTypes.push(op);
      }
    } else {
      return;
    }

    this.nodeStack.push(typeAliasNode.id);
    for (const objType of objectTypes) {
      for (let i = 0; i < objType.namedChildCount; i++) {
        const child = objType.namedChild(i);
        if (!child) continue;
        if (child.type !== 'property_signature' && child.type !== 'method_signature') continue;

        const nameNode = getChildByField(child, 'name');
        const memberName = nameNode ? getNodeText(nameNode, this.source) : '';
        if (!memberName) continue;

        // `foo: () => T` and `foo(): T` are functionally a method on the
        // type contract. Treat the property_signature with a function-typed
        // annotation as a method too so call sites can resolve to it.
        const memberKind: NodeKind = child.type === 'method_signature'
          ? 'method'
          : this.isTsFunctionTypedProperty(child) ? 'method' : 'property';

        const docstring = getPrecedingDocstring(child, this.source);
        const signature = getNodeText(child, this.source);
        this.createNode(memberKind, memberName, child, {
          docstring,
          signature,
          qualifiedName: `${typeAliasNode.name}::${memberName}`,
        });

        // Emit `references` edges from the type alias to types named in the
        // member's signature, matching the interface-member behavior added in
        // #432. We attach refs to the type-alias parent (consistent with
        // interface property_signature treatment).
        this.extractTypeAnnotations(child, typeAliasNode.id);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Surface the string-literal "names" of a TypeScript service/contract
   * registry written as a tuple of generic instantiations:
   *
   *   type MyServiceList = [
   *     Service<'query_apply_record', Req, Resp>,
   *     Service<'apply_confirm', Req, Resp>,
   *   ];
   *
   * Each `Service<'name', …>` tags an entry with a string-literal name that a
   * dynamic factory (`createService<MyServiceList>()`) turns into a callable
   * property (`api.query_apply_record(…)`). Static extraction otherwise never
   * sees that name — it's a type argument, not a declaration — so
   * `codegraph query query_apply_record` returned nothing (issue #634). We emit
   * each name as a `method` node under the type alias (qualifiedName
   * `MyServiceList::query_apply_record`) so it's searchable and resolvable as a
   * symbol. (A call through the proxy, `api.query_apply_record(…)`, still
   * resolves to the imported `api` binding — the receiver's type isn't known —
   * so this fixes discoverability, not the per-method call edge.)
   *
   * Scope is deliberately narrow to avoid noise: only a string literal that is
   * a DIRECT type argument of a `generic_type` that is itself a DIRECT element
   * of a `tuple_type`. This excludes utility types (`Pick`/`Omit`/`Record` are
   * never written as tuples) and string args nested deeper
   * (`Service<'a', Pick<U, 'id'>>` yields only `a`, never `id`). Names must be
   * valid identifiers, which also rules out route paths / arbitrary strings.
   */
  private extractTsTupleContractNames(value: SyntaxNode, typeAliasNode: Node): void {
    const tuples: SyntaxNode[] = [];
    const collectTuples = (n: SyntaxNode, depth: number): void => {
      if (depth > 6) return; // a type expression is shallow; cap defensively
      if (n.type === 'tuple_type') tuples.push(n);
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c) collectTuples(c, depth + 1);
      }
    };
    collectTuples(value, 0);
    if (tuples.length === 0) return;

    this.nodeStack.push(typeAliasNode.id);
    for (const tuple of tuples) {
      for (let i = 0; i < tuple.namedChildCount; i++) {
        const entry = tuple.namedChild(i);
        if (!entry || entry.type !== 'generic_type') continue;
        const typeArgs = getChildByField(entry, 'type_arguments');
        if (!typeArgs) continue;
        for (let j = 0; j < typeArgs.namedChildCount; j++) {
          const arg = typeArgs.namedChild(j);
          if (!arg || arg.type !== 'literal_type') continue;
          // literal_type wraps the actual literal; only a string is a name.
          const strNode = arg.namedChild(0);
          if (!strNode || strNode.type !== 'string') continue;
          const name = getNodeText(strNode, this.source)
            .trim()
            .replace(/^['"`]/, '')
            .replace(/['"`]$/, '');
          if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) continue;
          const signature = getNodeText(entry, this.source).replace(/\s+/g, ' ').trim().slice(0, 120);
          this.createNode('method', name, entry, {
            signature,
            qualifiedName: `${typeAliasNode.name}::${name}`,
          });
        }
      }
    }
    this.nodeStack.pop();
  }

  /**
   * `foo: () => T` → property_signature whose type_annotation contains a
   * `function_type`. Treat that as a method-shaped contract member, since
   * the call site `obj.foo()` has identical semantics to `bar(): T`.
   */
  private isTsFunctionTypedProperty(propertySignature: SyntaxNode): boolean {
    const typeAnno = getChildByField(propertySignature, 'type');
    if (!typeAnno) return false;
    for (let i = 0; i < typeAnno.namedChildCount; i++) {
      const inner = typeAnno.namedChild(i);
      if (inner && inner.type === 'function_type') return true;
    }
    return false;
  }

  // extractExportedVariables removed — the walker now descends into
  // export_statement children and the inner declaration's dedicated
  // extractor (extractVariable, extractFunction, extractClass, etc.)
  // handles the symbol with isExported=true via parent-walk in the
  // language extractor's isExported predicate.

  /**
   * Extract an import
   *
   * Creates an import node with the full import statement stored in signature for searchability.
   * Also creates unresolved references for resolution purposes.
   */
  private extractImport(node: SyntaxNode): void {
    if (!this.extractor) return;

    const importText = getNodeText(node, this.source).trim();

    // Try language-specific hook first
    if (this.extractor.extractImport) {
      const info = this.extractor.extractImport(node, this.source);
      if (info) {
        this.createNode('import', info.moduleName, node, {
          signature: info.signature,
        });
        // Create unresolved reference unless the hook handled it
        if (!info.handledRefs && info.moduleName && this.nodeStack.length > 0) {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) {
            this.unresolvedReferences.push({
              fromNodeId: parentId,
              referenceName: info.moduleName,
              referenceKind: 'imports',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
        // Link each imported binding to its definition so imported-but-not-
        // called/typed symbols still record a cross-file dependency (TS/JS only).
        if (
          this.language === 'typescript' || this.language === 'tsx' ||
          this.language === 'javascript' || this.language === 'jsx'
        ) {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) this.emitImportBindingRefs(node, parentId);
        }
        // Python `from module import X, Y` — link each imported name to its
        // definition (covers `__init__.py` re-export barrels, which are just
        // `from .sub import X`). Same recall gap as TS: a name imported and
        // used in a non-call position created no dependency edge.
        if (this.language === 'python' && node.type === 'import_from_statement') {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) this.emitPyFromImportRefs(node, parentId);
        }
        // Rust `use crate::m::Item;` / `pub use self::sub::Item;` — link each
        // imported leaf to its definition. Covers `pub use` re-export hubs
        // (a `mod.rs` re-exporting submodule items, e.g. tokio's `fs/mod.rs`)
        // and items imported but used in non-call/non-type positions.
        if (this.language === 'rust' && node.type === 'use_declaration') {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) this.emitRustUseBindingRefs(node, parentId);
        }
        // PHP `use Foo\Bar\Baz;` — link to the namespace-qualified definition so
        // an imported-but-DI-injected contract (Laravel's pattern) records a
        // cross-file dependency. Grouped imports are handled in their own branch.
        if (this.language === 'php' && node.type === 'namespace_use_declaration') {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) this.emitPhpUseRefs(node, parentId);
        }
        // Ruby `require "lib/foo"` / `require_relative "../foo"` — resolve to the
        // required FILE so a file pulled in only by `require` (config-loaded
        // components, gems that don't autoload) records a cross-file dependency.
        if (this.language === 'ruby' && node.type === 'call') {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) this.emitRubyRequireRefs(node, parentId);
        }
        return;
      }
      // Hook returned null — fall through to multi-import inline handlers only
      // (hook returning null means "I didn't handle this" for multi-import cases,
      // NOT "use generic fallback" — the hook already declined)
    }

    // Multi-import cases that create multiple nodes (can't be expressed with single-return hook)

    // Python import_statement: import os, sys (creates one import per module)
    if (this.language === 'python' && node.type === 'import_statement') {
      const importParentId = this.nodeStack[this.nodeStack.length - 1];
      // A bare `import a.b.c` of an internal module (the standard Django
      // `AppConfig.ready(): import myapp.signals` registration pattern, and any
      // `import pkg.mod` used for its side effects) had no edge to the module
      // file — only `from x import y` was linked. Push an `imports` ref (like
      // Go) so the resolver maps the dotted path to its file. Stdlib/external
      // modules naturally don't resolve (no `os.py` file node in the repo).
      const pushModuleRef = (dotted: SyntaxNode): void => {
        if (!importParentId) return;
        this.unresolvedReferences.push({
          fromNodeId: importParentId,
          referenceName: getNodeText(dotted, this.source),
          referenceKind: 'imports',
          line: dotted.startPosition.row + 1,
          column: dotted.startPosition.column,
        });
      };
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'dotted_name') {
          this.createNode('import', getNodeText(child, this.source), node, {
            signature: importText,
          });
          pushModuleRef(child);
        } else if (child?.type === 'aliased_import') {
          const dottedName = child.namedChildren.find(c => c.type === 'dotted_name');
          if (dottedName) {
            this.createNode('import', getNodeText(dottedName, this.source), node, {
              signature: importText,
            });
            pushModuleRef(dottedName);
          }
        }
      }
      return;
    }

    // Go imports: single or grouped (creates one import per spec)
    if (this.language === 'go') {
      const parentId = this.nodeStack.length > 0 ? this.nodeStack[this.nodeStack.length - 1] : null;
      const extractFromSpec = (spec: SyntaxNode): void => {
        const stringLiteral = spec.namedChildren.find(c => c.type === 'interpreted_string_literal');
        if (stringLiteral) {
          const importPath = getNodeText(stringLiteral, this.source).replace(/['"]/g, '');
          if (importPath) {
            this.createNode('import', importPath, spec, {
              signature: getNodeText(spec, this.source).trim(),
            });
            // Create unresolved reference so the resolver can create imports edges
            if (parentId) {
              this.unresolvedReferences.push({
                fromNodeId: parentId,
                referenceName: importPath,
                referenceKind: 'imports',
                line: spec.startPosition.row + 1,
                column: spec.startPosition.column,
              });
            }
          }
        }
      };

      const importSpecList = node.namedChildren.find(c => c.type === 'import_spec_list');
      if (importSpecList) {
        for (const spec of importSpecList.namedChildren.filter(c => c.type === 'import_spec')) {
          extractFromSpec(spec);
        }
      } else {
        const importSpec = node.namedChildren.find(c => c.type === 'import_spec');
        if (importSpec) {
          extractFromSpec(importSpec);
        }
      }
      return;
    }

    // PHP grouped imports: use X\{A, B} (creates one import per item)
    if (this.language === 'php') {
      const namespacePrefix = node.namedChildren.find(c => c.type === 'namespace_name');
      const useGroup = node.namedChildren.find(c => c.type === 'namespace_use_group');
      if (namespacePrefix && useGroup) {
        const prefix = getNodeText(namespacePrefix, this.source);
        const useClauses = useGroup.namedChildren.filter((c: SyntaxNode) =>
          c.type === 'namespace_use_group_clause' || c.type === 'namespace_use_clause'
        );
        for (const clause of useClauses) {
          const nsName = clause.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_name');
          const name = nsName
            ? nsName.namedChildren.find((c: SyntaxNode) => c.type === 'name')
            : clause.namedChildren.find((c: SyntaxNode) => c.type === 'name');
          if (name) {
            const fullPath = `${prefix}\\${getNodeText(name, this.source)}`;
            this.createNode('import', fullPath, node, {
              signature: importText,
            });
            const parentId = this.nodeStack[this.nodeStack.length - 1];
            if (parentId) this.pushPhpUseRef(fullPath, parentId, node);
          }
        }
        return;
      }
    }

    // If a hook exists but returned null, it intentionally declined this node — don't create fallback
    if (this.extractor.extractImport) return;

    // Generic fallback for languages without hooks
    this.createNode('import', importText, node, {
      signature: importText,
    });
  }

  /**
   * Emit one `imports` reference per named/default import binding (TS/JS family),
   * attributed to the file node — so the resolver links each imported symbol to
   * the file that DEFINES it.
   *
   * Importing a symbol IS a dependency, but extraction only emits references for
   * calls, instantiations, type annotations, and inheritance. A symbol that's
   * imported and then only re-exported (`export { X } from './x'`), placed in a
   * registry array (`[expressResolver, …]`), passed as an argument, or used in
   * JSX produced NO cross-file edge at all — so the providing file showed a
   * false "0 dependents" and was invisible to blast-radius / `affected`. The
   * resolver maps the local name (alias-aware) to the provider's definition and
   * creates a cross-file `imports` edge; `getFileDependents` picks it up, while
   * `getImpactRadius` keeps it as a bounded leaf (the importing file node).
   *
   * Namespace imports (`import * as NS`) bind a whole module: `NS.member` calls
   * resolve on their own, but a namespace used ONLY via a value-member read
   * (`NS.SOME_CONST`) would leave no edge — so we also emit the namespace local
   * name, which the resolver links to the module FILE as a dependency backstop.
   */
  private emitImportBindingRefs(node: SyntaxNode, fromNodeId: string): void {
    const clause = node.namedChildren.find((c) => c.type === 'import_clause');
    if (!clause) return; // side-effect import (`import './x'`) — no bindings

    const pushRef = (nameNode: SyntaxNode | null | undefined): void => {
      if (!nameNode) return;
      const name = getNodeText(nameNode, this.source);
      if (!name) return;
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: name,
        referenceKind: 'imports',
        line: nameNode.startPosition.row + 1,
        column: nameNode.startPosition.column,
      });
    };

    for (const child of clause.namedChildren) {
      if (child.type === 'identifier') {
        // default import: `import Foo from './x'`
        pushRef(child);
      } else if (child.type === 'named_imports') {
        // `import { A, B as C } from './x'` — link the LOCAL name (alias if any)
        for (const spec of child.namedChildren) {
          if (spec.type !== 'import_specifier') continue;
          pushRef(getChildByField(spec, 'alias') ?? getChildByField(spec, 'name') ?? spec.namedChild(0));
        }
      } else if (child.type === 'namespace_import') {
        // `import * as NS from './x'` — emit NS so the module-import backstop can
        // record the file dependency even if NS is only used by value-member read.
        pushRef(child.namedChildren.find((c) => c.type === 'identifier') ?? child.namedChild(0));
      }
    }
  }

  /**
   * Emit one `imports` reference per re-exported binding of a
   * `export { A, B as C } from './y'` statement, attributed to the file node —
   * so a barrel that re-exports from another module records a dependency on it.
   *
   * Links the SOURCE-side name (`A`, the `name` field — not the local alias
   * `C`), since that is what the source module defines. `export * from './y'`
   * has no named bindings to attribute and `export { default as X }` can't be
   * name-matched, so both are skipped.
   */
  private emitReExportRefs(node: SyntaxNode, fromNodeId: string): void {
    const clause = node.namedChildren.find((c) => c.type === 'export_clause');
    if (!clause) return; // `export * from './y'` — no named bindings
    for (const spec of clause.namedChildren) {
      if (spec.type !== 'export_specifier') continue;
      const nameNode = getChildByField(spec, 'name') ?? spec.namedChild(0);
      if (!nameNode) continue;
      const name = getNodeText(nameNode, this.source);
      if (!name || name === 'default') continue;
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: name,
        referenceKind: 'imports',
        line: nameNode.startPosition.row + 1,
        column: nameNode.startPosition.column,
      });
    }
  }

  /**
   * Emit one `imports` reference per binding of a Rust `use` declaration —
   * `use crate::m::Item`, `use crate::m::{A, B as C}`, `pub use self::sub::Item`.
   * Emits the FULL path (e.g. `self::sub::Item`, not just `Item`) so the resolver
   * can resolve the module prefix to a file and find the leaf symbol there —
   * disambiguating common-name re-exports (`pub use self::read::read`, where the
   * leaf `read` collides with many same-named symbols). Falls back to name-match
   * on the leaf when the path can't be resolved. `use ...::*` has no leaf binding.
   */
  private emitRustUseBindingRefs(node: SyntaxNode, fromNodeId: string): void {
    const paths: { text: string; node: SyntaxNode }[] = [];
    const join = (prefix: string, seg: string): string => (prefix ? `${prefix}::${seg}` : seg);
    const collect = (n: SyntaxNode, prefix: string): void => {
      switch (n.type) {
        case 'identifier':
          paths.push({ text: join(prefix, getNodeText(n, this.source)), node: n });
          break;
        case 'scoped_identifier': {
          // Full scoped path (`a::b::C`); combine with any outer group prefix.
          const full = getNodeText(n, this.source).trim();
          paths.push({ text: prefix ? `${prefix}::${full}` : full, node: n });
          break;
        }
        case 'scoped_use_list': {
          // `path::{ ... }` — the group's path becomes the prefix for each item.
          const pathNode = getChildByField(n, 'path');
          const seg = pathNode ? getNodeText(pathNode, this.source).trim() : '';
          const newPrefix = seg ? join(prefix, seg) : prefix;
          const list = getChildByField(n, 'list') ?? n.namedChildren.find((c) => c.type === 'use_list');
          if (list) collect(list, newPrefix);
          break;
        }
        case 'use_list':
          for (let i = 0; i < n.namedChildCount; i++) {
            const c = n.namedChild(i);
            if (c) collect(c, prefix);
          }
          break;
        case 'use_as_clause': {
          // `Path as Alias` → link the source path (the definition), not the alias.
          const p = getChildByField(n, 'path') ?? n.namedChild(0);
          if (p) collect(p, prefix);
          break;
        }
        // use_wildcard → no specific binding to link.
      }
    };
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) collect(c, '');
    }
    for (const p of paths) {
      // The leaf must be a real name (skip a path that is only `self`/`super`/`crate`).
      const leaf = p.text.split('::').pop();
      if (!leaf || leaf === 'self' || leaf === 'super' || leaf === 'crate' || leaf === '*') continue;
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: p.text,
        referenceKind: 'imports',
        line: p.node.startPosition.row + 1,
        column: p.node.startPosition.column,
      });
    }
  }

  /**
   * Emit an `imports` reference for a single PHP `use Foo\Bar\Baz;` (grouped
   * imports `use Foo\{A, B}` are handled where their per-item nodes are created).
   * The reference targets the namespace-qualified `Foo\Bar::Baz` form classes are
   * stored under (see the PHP `namespace` capture), so it resolves to the RIGHT
   * definition — Laravel has many same-named contracts (`Factory`, `Dispatcher`,
   * `Guard`) across namespaces that a bare-name match can't disambiguate.
   */
  private emitPhpUseRefs(node: SyntaxNode, fromNodeId: string): void {
    const clause = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_use_clause');
    if (!clause) return;
    const qn = clause.namedChildren.find((c: SyntaxNode) => c.type === 'qualified_name')
      ?? clause.namedChildren.find((c: SyntaxNode) => c.type === 'name');
    if (qn) this.pushPhpUseRef(getNodeText(qn, this.source), fromNodeId, node);
  }

  /**
   * Ruby `require`/`require_relative` → an `imports` ref to the required FILE.
   * `require "sidekiq/fetch"` is load-path-relative (matched by file-path suffix
   * via {@link matchByFilePath}); `require_relative "../foo"` is resolved against
   * this file's directory. Bare gem/stdlib requires (`require "json"`, no slash)
   * are skipped — they're external. The path form (a `/` + `.rb`) makes the ref
   * resolve to the file node, so a file pulled in only by `require` — not by a
   * resolved constant/call — still records a cross-file dependency.
   */
  private emitRubyRequireRefs(node: SyntaxNode, fromNodeId: string): void {
    const method = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    const mname = method ? getNodeText(method, this.source) : '';
    if (mname !== 'require' && mname !== 'require_relative') return;
    const argList = node.namedChildren.find((c: SyntaxNode) => c.type === 'argument_list');
    const str = argList?.namedChildren.find((c: SyntaxNode) => c.type === 'string');
    const content = str?.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
    if (!content) return;
    const req = getNodeText(content, this.source).trim();
    if (!req) return;

    let refPath: string;
    if (mname === 'require_relative') {
      const slash = this.filePath.lastIndexOf('/');
      const dir = slash >= 0 ? this.filePath.slice(0, slash) : '';
      refPath = path.posix.normalize(dir ? `${dir}/${req}` : req);
    } else {
      refPath = req; // load-path require — suffix-matched against the file path
    }
    if (!refPath.includes('/')) return; // bare gem/stdlib require — external
    if (!refPath.endsWith('.rb')) refPath += '.rb';
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName: refPath,
      referenceKind: 'imports',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }

  /** Convert a PHP FQN `Foo\Bar\Baz` to the stored `Foo\Bar::Baz` and emit an `imports` ref. */
  private pushPhpUseRef(fqn: string, fromNodeId: string, node: SyntaxNode): void {
    const clean = fqn.replace(/^\\/, '');
    const lastSep = clean.lastIndexOf('\\');
    if (lastSep < 0) return; // global-namespace class — already matches by simple name
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName: `${clean.slice(0, lastSep)}::${clean.slice(lastSep + 1)}`,
      referenceKind: 'imports',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }

  /**
   * Emit one `imports` reference per name imported in a Python
   * `from module import A, B as C` statement, attributed to the file node — so
   * the resolver links each imported name to the module that DEFINES it.
   *
   * Same recall gap as TS: extraction only emitted references for calls,
   * instantiations, and inheritance, so a name imported and then used in a
   * non-call position (a list/dict literal, a default argument, a decorator
   * target, or simply re-exported through an `__init__.py` barrel) produced no
   * cross-file edge — the providing module showed a false "0 dependents". Links
   * the LOCAL name (alias when present, since that's what the resolver's import
   * mapping keys on); `from module import *` has no names to attribute.
   */
  private emitPyFromImportRefs(node: SyntaxNode, fromNodeId: string): void {
    const moduleNameNode = getChildByField(node, 'module_name');
    for (const child of node.namedChildren) {
      // Skip the `from <module>` part itself and `import *`.
      if (moduleNameNode &&
          child.startIndex === moduleNameNode.startIndex &&
          child.endIndex === moduleNameNode.endIndex) continue;
      if (child.type === 'wildcard_import') continue;

      let nameNode: SyntaxNode | null | undefined = null;
      if (child.type === 'aliased_import') {
        nameNode = getChildByField(child, 'alias') ?? getChildByField(child, 'name') ?? child.namedChild(0);
      } else if (child.type === 'dotted_name') {
        nameNode = child;
      }
      if (!nameNode) continue;

      const raw = getNodeText(nameNode, this.source);
      // Imported names are simple identifiers; defensively take the last segment.
      const local = raw.includes('.') ? raw.split('.').pop()! : raw;
      if (!local) continue;
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: local,
        referenceKind: 'imports',
        line: nameNode.startPosition.row + 1,
        column: nameNode.startPosition.column,
      });
    }
  }

  /**
   * Extract a function call
   */
  private extractCall(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;

    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    // Get the function/method being called
    let calleeName = '';

    // Java/Kotlin method_invocation has 'object' + 'name' fields instead of 'function'
    // PHP member_call_expression has 'object' + 'name', scoped_call_expression has 'scope' + 'name'
    const nameField = getChildByField(node, 'name');
    const objectField = getChildByField(node, 'object') || getChildByField(node, 'scope');

    if (nameField && objectField && (node.type === 'method_invocation' || node.type === 'member_call_expression' || node.type === 'scoped_call_expression')) {
      // Method call with explicit receiver: receiver.method() / $receiver->method() / ClassName::method()
      const methodName = getNodeText(nameField, this.source);
      // Java `this.userbo.toLogin2()` parses as method_invocation(object=field_access(this, userbo)).
      // Without unwrapping, receiverName is `this.userbo` and the name-matcher's
      // single-dot receiver regex fails. Pull out the immediate field after `this.`
      // so the receiver is the field name (`userbo`), which the resolver can then
      // look up in the enclosing class's field declarations.
      // PHP static-factory fluent chain: `Cls::for($x)->method()` — the receiver
      // is itself a static call, so resolution must infer the method's class
      // from what `Cls::for` RETURNS (its `: self` / `: static` / `: Type`),
      // #608 (mirrors the C++ chain fix in #645). Encode `<Cls::factory>().<method>`;
      // the `().` marker lets the PHP resolver split it. The receiver text
      // (`Cls::for('x')`) carries the args, so without this it degrades to an
      // unresolvable string and the call edge is dropped.
      if (methodName && this.language === 'php' && objectField.type === 'scoped_call_expression') {
        const innerScope = getChildByField(objectField, 'scope');
        const innerName = getChildByField(objectField, 'name');
        if (innerScope && innerName) {
          calleeName = `${getNodeText(innerScope, this.source)}::${getNodeText(innerName, this.source)}().${methodName}`;
        } else {
          calleeName = methodName;
        }
        if (calleeName) {
          this.unresolvedReferences.push({
            fromNodeId: callerId,
            referenceName: calleeName,
            referenceKind: 'calls',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
        return;
      }

      // Java static-factory / fluent chain: `Foo.getInstance().bar()` — the
      // receiver is itself a method call, so resolution must infer bar's class
      // from what `Foo.getInstance` RETURNS (its declared return type), the
      // #645/#608 mechanism. Encode `<inner-receiver>.<inner-method>().<method>`;
      // the `().` marker lets the Java chain resolver split it, and normalizing to
      // empty parens drops any factory args (`Foo.create(cfg).bar()`) that would
      // otherwise leave a `(cfg)` in the receiver text and break the split.
      if (
        methodName &&
        this.language === 'java' &&
        objectField.type === 'method_invocation'
      ) {
        const innerObj = getChildByField(objectField, 'object');
        const innerName = getChildByField(objectField, 'name');
        if (innerObj && innerName) {
          calleeName = `${getNodeText(innerObj, this.source)}.${getNodeText(innerName, this.source)}().${methodName}`;
          this.unresolvedReferences.push({
            fromNodeId: callerId,
            referenceName: calleeName,
            referenceKind: 'calls',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
          return;
        }
      }

      let receiverName: string;
      if (objectField.type === 'field_access') {
        const inner = getChildByField(objectField, 'object');
        const fld = getChildByField(objectField, 'field');
        if (inner && fld && (inner.type === 'this' || inner.type === 'this_expression')) {
          receiverName = getNodeText(fld, this.source);
        } else {
          receiverName = getNodeText(objectField, this.source);
        }
      } else {
        receiverName = getNodeText(objectField, this.source);
      }
      // Strip PHP $ prefix from variable names
      receiverName = receiverName.replace(/^\$/, '');

      if (methodName) {
        // Skip self/this/parent/static receivers — they don't aid resolution
        const SKIP_RECEIVERS = new Set(['self', 'this', 'cls', 'super', 'parent', 'static']);
        if (SKIP_RECEIVERS.has(receiverName)) {
          calleeName = methodName;
        } else {
          calleeName = `${receiverName}.${methodName}`;
        }
      }
    } else if (node.type === 'message_expression') {
      // ObjC message expressions emit one `method` field child per selector
      // keyword: `[obj a:1 b:2 c:3]` has three `method=identifier` siblings.
      // Joining them with `:` reconstructs the full selector and matches the
      // multi-part selector names produced by the ObjC method_definition
      // extractor (`extractObjcMethodName` in languages/objc.ts). Without this
      // join, multi-keyword call sites only emitted the first keyword and never
      // resolved to their target methods (e.g. `GET:parameters:headers:...` had
      // zero callers despite obviously being called).
      const methodKeywords: string[] = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        if (node.fieldNameForNamedChild(i) === 'method') {
          const kw = node.namedChild(i);
          if (kw) methodKeywords.push(getNodeText(kw, this.source));
        }
      }
      if (methodKeywords.length > 0) {
        // A selector keyword takes a `:` when it has an argument. A SINGLE
        // keyword can be unary (`[c reset]` → `reset`) OR take one argument
        // (`[c storeImage:k]` → `storeImage:`) — distinguished by whether the
        // message has a `:` token. Without this, every single-argument message
        // (the most common form: `addObject:`, `storeImage:`, …) was named
        // without the colon and never matched its `storeImage:` method.
        let hasColon = false;
        for (let i = 0; i < node.childCount; i++) {
          if (node.child(i)?.type === ':') { hasColon = true; break; }
        }
        const methodName: string = hasColon
          ? methodKeywords.map((k) => `${k}:`).join('')
          : (methodKeywords[0] as string);
        const receiverField = getChildByField(node, 'receiver');
        const SKIP_RECEIVERS = new Set(['self', 'super']);
        if (receiverField && receiverField.type !== 'message_expression') {
          const receiverName = getNodeText(receiverField, this.source);
          if (receiverName && !SKIP_RECEIVERS.has(receiverName)) {
            calleeName = `${receiverName}.${methodName}`;
            // A CLASS-message receiver (`[SDImageCache alloc]`,
            // `[SDImageCache sharedCache]`) is a capitalized class name. The
            // call resolves the method (`alloc`/`sharedCache`), but the CLASS
            // itself — whose @interface lives in the header — would otherwise
            // never be referenced. Emit a `references` edge to it so a class
            // used only via class messages (alloc/init, singletons, factories)
            // and its header record a dependent.
            if (/^[A-Z][A-Za-z0-9_]*$/.test(receiverName)) {
              this.unresolvedReferences.push({
                fromNodeId: callerId,
                referenceName: receiverName,
                referenceKind: 'references',
                line: receiverField.startPosition.row + 1,
                column: receiverField.startPosition.column,
              });
            }
          } else {
            calleeName = methodName;
          }
        } else if (receiverField && receiverField.type === 'message_expression' && /^\w+$/.test(methodName)) {
          // Chained message send `[[Foo create] doIt]` — the receiver is itself a
          // class message. Recover the inner `Class.selector` and encode
          // `Class.selector().doIt` so resolution infers doIt's class from what
          // `Class.selector` RETURNS (#645/#608). Only a CLASS-factory chain
          // (capitalized inner receiver); a unary outer selector is required
          // because the chain resolver's method part is `\w+` (no `:`). An
          // instance chain (`[[obj foo] bar]`, lowercase inner) stays bare.
          const innerRecv = getChildByField(receiverField, 'receiver');
          const innerRecvName = innerRecv ? getNodeText(innerRecv, this.source) : '';
          if (innerRecv?.type === 'identifier' && /^[A-Z]/.test(innerRecvName)) {
            const innerKw: string[] = [];
            for (let i = 0; i < receiverField.namedChildCount; i++) {
              if (receiverField.fieldNameForNamedChild(i) === 'method') {
                const kw = receiverField.namedChild(i);
                if (kw) innerKw.push(getNodeText(kw, this.source));
              }
            }
            let innerColon = false;
            for (let i = 0; i < receiverField.childCount; i++) {
              if (receiverField.child(i)?.type === ':') { innerColon = true; break; }
            }
            const innerSelector = innerColon ? innerKw.map((k) => `${k}:`).join('') : innerKw[0];
            calleeName = innerSelector ? `${innerRecvName}.${innerSelector}().${methodName}` : methodName;
          } else {
            calleeName = methodName;
          }
        } else {
          calleeName = methodName;
        }
      }
    } else {
      const func = getChildByField(node, 'function') || node.namedChild(0);

      if (func) {
        if (func.type === 'member_expression' || func.type === 'attribute' || func.type === 'selector_expression' || func.type === 'navigation_expression' || func.type === 'field_expression') {
          // Method call: obj.method() or obj.field.method()
          // Go uses selector_expression with 'field', JS/TS uses member_expression with 'property'
          // Kotlin uses navigation_expression with navigation_suffix > simple_identifier
          // C/C++ use field_expression for both `obj.method()` and `ptr->method()`
          let property = getChildByField(func, 'property') || getChildByField(func, 'field');
          if (!property) {
            const child1 = func.namedChild(1);
            // Kotlin: navigation_suffix wraps the method name — extract simple_identifier from it
            if (child1?.type === 'navigation_suffix') {
              property = child1.namedChildren.find((c: SyntaxNode) => c.type === 'simple_identifier') ?? child1;
            } else {
              property = child1;
            }
          }
          if (property) {
            const methodName = getNodeText(property, this.source);
            // Include receiver name for qualified resolution (e.g., console.print → "console.print")
            // This helps the resolver distinguish method calls from bare function calls
            // (e.g., Python's console.print() vs builtin print())
            // Skip self/this/cls as they don't aid resolution
            const receiver =
              getChildByField(func, 'object') ||
              getChildByField(func, 'operand') ||
              getChildByField(func, 'argument') ||
              func.namedChild(0);
            const SKIP_RECEIVERS = new Set(['self', 'this', 'cls', 'super']);
            if (receiver && (receiver.type === 'identifier' || receiver.type === 'simple_identifier' || receiver.type === 'field_identifier')) {
              const receiverName = getNodeText(receiver, this.source);
              if (!SKIP_RECEIVERS.has(receiverName)) {
                calleeName = `${receiverName}.${methodName}`;
              } else {
                calleeName = methodName;
              }
            } else if (
              (this.language === 'cpp' ||
                this.language === 'c' ||
                this.language === 'kotlin' ||
                this.language === 'swift' ||
                this.language === 'rust' ||
                this.language === 'go' ||
                this.language === 'scala') &&
              receiver &&
              receiver.type === 'call_expression'
            ) {
              // Receiver that is itself a call — `Foo::instance().bar()`,
              // `openSession()->run()`, `mgr.view().render()` (C/C++),
              // `Foo.getInstance().bar()` (Kotlin) / `Foo.make().draw()` (Swift),
              // `Foo::new().bar()` (Rust), or `New().Method()` (Go). Keep the inner
              // call so resolution can infer bar()'s class from what the inner call
              // RETURNS (#645/#608). Encode as `<innerCallee>().<method>`; the `().`
              // marker never appears in an ordinary ref, so the resolver can detect
              // and split it. Other languages keep the bare-name behavior below.
              let innerCallee: string;
              let reencode: boolean;
              if (this.language === 'kotlin' || this.language === 'swift') {
                // tree-sitter-kotlin/swift expose the inner callee as the
                // call_expression's first named child (a navigation_expression
                // `Foo.getInstance`, or a bare identifier for a free/constructor call).
                const innerNav = receiver.namedChild(0);
                innerCallee = innerNav ? getNodeText(innerNav, this.source).replace(/\s+/g, '') : '';
                // Only re-encode a CLASS / companion-factory / constructor chain,
                // whose receiver chain starts with a capitalized type
                // (`Foo.getInstance().bar()`, `Foo().bar()`). An instance chain
                // (`list.filter{}.map{}`) has a lowercase receiver whose type we
                // can't recover here — re-encoding it would only drop the edge (no
                // chain resolution, no bare-name fallback), regressing recall in
                // fluent codebases. Leave those to the bare-name path.
                reencode = /^[A-Z]/.test(innerCallee);
              } else {
                const innerFn = getChildByField(receiver, 'function');
                innerCallee = innerFn
                  ? getNodeText(innerFn, this.source).replace(/->/g, '.').replace(/\s+/g, '')
                  : '';
                // Rust: only re-encode an associated-function chain
                // (`Foo::new().bar()`), whose inner callee is a path/`scoped_identifier`.
                // Go: only a bare package-level factory chain (`New().Method()`),
                // whose inner callee is an `identifier`. An instance chain
                // (`x.foo().bar()` Rust, `obj.Method().Other()` Go) keeps bare-name —
                // the resolver can't recover a variable's type, so re-encoding would
                // only drop the edge. C/C++ re-encode any inner.
                if (this.language === 'rust') reencode = innerFn?.type === 'scoped_identifier';
                else if (this.language === 'go') reencode = innerFn?.type === 'identifier';
                // Scala: only a companion-factory / case-class-apply chain whose
                // receiver chain starts with a capitalized type (`Foo.create().bar()`,
                // `Foo(args).bar()`). An instance chain (`list.map().filter()`) has a
                // lowercase receiver whose type we can't recover — leave it bare.
                else if (this.language === 'scala') reencode = /^[A-Z]/.test(innerCallee);
                else reencode = !!innerCallee;
              }
              calleeName = reencode ? `${innerCallee}().${methodName}` : methodName;
            } else {
              calleeName = methodName;
            }
          }
        } else if (func.type === 'scoped_identifier' || func.type === 'scoped_call_expression') {
          // Scoped call: Module::function()
          calleeName = getNodeText(func, this.source);
        } else if (this.language === 'csharp' && func.type === 'member_access_expression') {
          // C# member call `recv.Method(...)`. When the receiver is itself a call
          // — a chained factory `Foo.Create(args).Bar()` — encode `inner().Bar`
          // with normalized empty parens so resolution can infer Bar's class from
          // what `Foo.Create` RETURNS (#645/#608). A non-call receiver keeps the
          // full member-access text (the existing `recv.Method` behavior).
          const recv = getChildByField(func, 'expression');
          const nameNode = getChildByField(func, 'name');
          const methodName = nameNode ? getNodeText(nameNode, this.source) : '';
          if (recv && recv.type === 'invocation_expression' && methodName) {
            const innerFunc = getChildByField(recv, 'function');
            const innerCallee = innerFunc ? getNodeText(innerFunc, this.source).replace(/\s+/g, '') : '';
            calleeName = innerCallee ? `${innerCallee}().${methodName}` : methodName;
          } else {
            calleeName = getNodeText(func, this.source);
          }
        } else {
          calleeName = getNodeText(func, this.source);
        }
      }
    }

    // Parenthesized type conversions — Go `(*T)(x)` / `(T)(x)` (and a
    // parenthesized callee generally) parse as a call whose "function" is a
    // parenthesized type/expression, so the callee text is the un-resolvable
    // literal `(*T)`. Normalize to the inner name so it resolves to `T` (a real
    // dependency on the converted-to type) instead of dropping on the floor.
    if (calleeName) {
      const conv = calleeName.match(/^\(\s*\*?\s*([A-Za-z_][\w.]*)\s*\)$/);
      if (conv && conv[1]) calleeName = conv[1];
    }

    if (calleeName) {
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: calleeName,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }

  /**
   * `new Foo(...)` / `Foo::new(...)` / object_creation_expression —
   * emit an `instantiates` reference to the class name. The resolver
   * then links it to the class node, producing the `instantiates`
   * edge that powers "what creates instances of X" queries.
   *
   * Children are still walked so nested calls inside the constructor
   * arguments (`new Foo(bar())`) get their own `calls` references.
   */
  private extractInstantiation(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const fromId = this.nodeStack[this.nodeStack.length - 1];
    if (!fromId) return;

    // The class name is in the `constructor`/`type`/first-named-child
    // depending on grammar.
    const ctor =
      getChildByField(node, 'constructor') ||
      getChildByField(node, 'type') ||
      getChildByField(node, 'name') ||
      node.namedChild(0);
    if (!ctor) return;

    // Go composite literals: `Widget{...}` (same package) and `pkga.Widget{...}`
    // (cross-package). Only a directly-named struct type is a meaningful
    // instantiation target — skip slice/map/array literals (`[]T{}`,
    // `map[K]V{}`) whose `type` field is a composite type, not a named type.
    // Unlike `new ns.Foo()`, KEEP the package qualifier (`pkga.Widget`) so the
    // Go cross-package resolver can disambiguate it to the right package's type.
    if (node.type === 'composite_literal') {
      if (ctor.type !== 'type_identifier' && ctor.type !== 'qualified_type') return;
      let goType = getNodeText(ctor, this.source).trim();
      const brIdx = goType.indexOf('['); // strip Go generic args: `Box[T]{}` -> `Box`
      if (brIdx > 0) goType = goType.slice(0, brIdx).trim();
      if (goType) {
        this.unresolvedReferences.push({
          fromNodeId: fromId,
          referenceName: goType,
          referenceKind: 'instantiates',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return;
    }

    // Scala: `new Monoid[Int] { ... }` — the constructor is a `generic_type`
    // (or qualified `stable_type_identifier`) using `[...]` type args, which the
    // generic `<...>` strip below misses. Unwrap to the base type name.
    if (node.type === 'instance_expression') {
      const name = scalaBaseTypeName(ctor, this.source);
      if (name) {
        this.unresolvedReferences.push({
          fromNodeId: fromId,
          referenceName: name,
          referenceKind: 'instantiates',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return;
    }

    let className = getNodeText(ctor, this.source);
    // Strip type-argument suffix first: `new Map<K, V>()` would
    // otherwise produce className 'Map<K, V>' (the constructor
    // field is a `generic_type` node) and resolution would fail
    // because no class is named with the angle-bracket suffix.
    const ltIdx = className.indexOf('<');
    if (ltIdx > 0) className = className.slice(0, ltIdx);
    // For namespaced/qualified constructors (`new ns.Foo()`,
    // `new ns::Foo()`) keep the trailing identifier — that's what
    // matches a class node in the index.
    const lastDot = Math.max(
      className.lastIndexOf('.'),
      className.lastIndexOf('::')
    );
    if (lastDot >= 0) className = className.slice(lastDot + 1).replace(/^[:.]/, '');
    className = className.trim();

    if (className) {
      this.unresolvedReferences.push({
        fromNodeId: fromId,
        referenceName: className,
        referenceKind: 'instantiates',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }

  /**
   * Static-member / value-read pass. A type/enum/class used only via a member
   * VALUE — `Enum.value`, `Type.CONST`, `Colors.red`, `Foo::BAR` — recorded no
   * edge, because the body walker only handled CALLS (`Type.method()`). So a
   * type referenced only by an enum value or a static field looked like nothing
   * depended on it (the residual frontier across Dart/Java/C#/Swift/Kotlin/PHP).
   * Emit a `references` edge to the capitalized receiver. Gated to languages
   * where types are Capitalized by convention, and skipped when the access is a
   * call's callee (the call extractor already links the method).
   */
  private extractStaticMemberRef(node: SyntaxNode): void {
    if (!STATIC_MEMBER_LANGS.has(this.language)) return;
    if (this.nodeStack.length === 0) return;
    const ownerId = this.nodeStack[this.nodeStack.length - 1];
    if (!ownerId) return;

    // Dart structures member access as an `identifier` + a sibling `selector`,
    // not a single node. A value-read selector (no `argument_part`) whose
    // previous sibling is a capitalized identifier is `Enum.value`.
    if (this.language === 'dart') {
      if (node.type !== 'selector') return;
      if (node.namedChildren.some((c: SyntaxNode) => c.type === 'argument_part')) return;
      const prev = node.previousNamedSibling;
      if (prev?.type === 'identifier' && /^[A-Z][A-Za-z0-9_]*$/.test(prev.text)) {
        this.pushStaticMemberRef(prev.text, ownerId, prev);
      }
      return;
    }

    if (!MEMBER_ACCESS_TYPES.has(node.type)) return;

    // Skip `Type.method()` — the access is the callee of a call, already linked.
    const parent = node.parent;
    if (parent && this.extractor!.callTypes.includes(parent.type)) {
      const callee =
        getChildByField(parent, 'function') ??
        getChildByField(parent, 'method') ??
        parent.namedChild(0);
      if (callee && callee.startIndex === node.startIndex) return;
    }

    // The receiver must be a SIMPLE capitalized identifier — `Type.X`, not the
    // nested `a.B.c` (whose own head member-access is visited separately) nor a
    // lowercase `obj.field` / `pkg.func`.
    const recv =
      getChildByField(node, 'object') ??
      getChildByField(node, 'expression') ??
      getChildByField(node, 'scope') ??
      node.namedChild(0);
    if (!recv) return;
    const t = recv.type;
    if (
      t === 'identifier' || t === 'type_identifier' || t === 'simple_identifier' ||
      t === 'name' || t === 'scoped_type_identifier'
    ) {
      const text = getNodeText(recv, this.source);
      if (/^[A-Z][A-Za-z0-9_]*$/.test(text)) this.pushStaticMemberRef(text, ownerId, recv);
    }
  }

  private pushStaticMemberRef(name: string, ownerId: string, node: SyntaxNode): void {
    this.unresolvedReferences.push({
      fromNodeId: ownerId,
      referenceName: name,
      referenceKind: 'references',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }

  /**
   * Find a `class_body` child of an `object_creation_expression` — the
   * marker for an anonymous class (`new T() { ... }`). Returns the body
   * node so the caller can walk it as the anon class's members.
   */
  private findAnonymousClassBody(node: SyntaxNode): SyntaxNode | null {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      // Java: `class_body`. C# uses the same node kind.
      if (child && (child.type === 'class_body' || child.type === 'declaration_list')) {
        return child;
      }
    }
    return null;
  }

  /**
   * Extract a Java/C# anonymous class — `new T() { ...members }`. Emits a
   * `class` node named `<T$anon@line>`, an `extends` reference to T (so
   * Phase 5.5 interface-impl can bridge), and walks the body so its
   * `method_declaration` members become method nodes under the anon class.
   *
   * Why this matters: without anon-class extraction, the overrides inside
   * a lambda-returned `new T() { @Override int foo(){...} }` are not nodes,
   * so a call through T.foo (the abstract parent method) has no static
   * target — the agent has to Read the file to find the implementation.
   */
  private extractAnonymousClass(node: SyntaxNode, body: SyntaxNode): void {
    if (!this.extractor) return;

    // The instantiated type sits in the same field/position that
    // extractInstantiation reads from. Use the same lookup so the anon
    // class's `extends` target matches the `instantiates` edge.
    const typeNode =
      getChildByField(node, 'constructor') ||
      getChildByField(node, 'type') ||
      getChildByField(node, 'name') ||
      node.namedChild(0);
    let typeName = typeNode ? getNodeText(typeNode, this.source) : 'Object';
    const ltIdx = typeName.indexOf('<');
    if (ltIdx > 0) typeName = typeName.slice(0, ltIdx);
    const lastDot = Math.max(typeName.lastIndexOf('.'), typeName.lastIndexOf('::'));
    if (lastDot >= 0) typeName = typeName.slice(lastDot + 1).replace(/^[:.]/, '');
    typeName = typeName.trim() || 'Object';

    const anonName = `<${typeName}$anon@${node.startPosition.row + 1}>`;
    const classNode = this.createNode('class', anonName, node, {});
    if (!classNode) return;

    // The anonymous class implicitly extends/implements the named type.
    // We can't tell at extraction time whether T is a class or an interface,
    // so emit `extends`. Resolution will still bind T to whatever it is, and
    // Phase 5.5 (which already handles both `extends` and `implements`) will
    // bridge T's methods to the override names found in the anon body.
    this.unresolvedReferences.push({
      fromNodeId: classNode.id,
      referenceName: typeName,
      referenceKind: 'extends',
      line: typeNode?.startPosition.row ?? node.startPosition.row,
      column: typeNode?.startPosition.column ?? node.startPosition.column,
    });

    // Walk the body's children so method_declaration nodes inside become
    // method nodes scoped to the anon class.
    this.nodeStack.push(classNode.id);
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) this.visitNode(child);
    }
    this.nodeStack.pop();
  }

  /**
   * Scan `declNode` and its preceding siblings (within the parent's
   * named children) for decorator nodes, emitting a `decorates`
   * reference from `decoratedId` to each decorator's function name.
   *
   * Why preceding siblings: in TypeScript, `@Foo class Bar {}` parses
   * as an `export_statement` (or top-level wrapper) with the
   * `decorator` as a child *before* the `class_declaration` — so the
   * decorator isn't a child of the class itself. For methods/
   * properties, the decorator IS a direct child of the declaration,
   * so we also scan declNode.namedChildren.
   *
   * Idempotent across grammars: if neither location yields decorators
   * (most non-decorator-using languages), the function is a no-op.
   */
  private extractDecoratorsFor(declNode: SyntaxNode, decoratedId: string): void {
    const consider = (n: SyntaxNode | null): void => {
      if (!n) return;
      // `marker_annotation` is Java's grammar for arg-less annotations
      // (`@Override`, `@Deprecated`); `attribute` is Swift's grammar for
      // attributes and PROPERTY WRAPPERS (`@objc`, `@Argument`, `@Published`,
      // `@State`). Without these, those usages would be silently skipped.
      if (
        n.type !== 'decorator' &&
        n.type !== 'annotation' &&
        n.type !== 'marker_annotation' &&
        n.type !== 'attribute'
      ) {
        return;
      }
      // Find the leading identifier: skip the `@` punct, unwrap
      // a call_expression if the decorator is invoked with args.
      let target: SyntaxNode | null = null;
      for (let i = 0; i < n.namedChildCount; i++) {
        const child = n.namedChild(i);
        if (!child) continue;
        if (child.type === 'call_expression') {
          const fn = getChildByField(child, 'function') ?? child.namedChild(0);
          if (fn) target = fn;
          if (target) break;
        }
        if (
          child.type === 'identifier' ||
          child.type === 'member_expression' ||
          child.type === 'scoped_identifier' ||
          child.type === 'navigation_expression' ||
          child.type === 'user_type' ||      // swift attribute → user_type (`@Argument`)
          child.type === 'type_identifier'
        ) {
          target = child;
          break;
        }
      }
      if (!target) return;
      let name = getNodeText(target, this.source);
      const lt = name.indexOf('<'); // strip generic args: `@Argument<T>` → `Argument`
      if (lt > 0) name = name.slice(0, lt);
      const lastDot = Math.max(name.lastIndexOf('.'), name.lastIndexOf('::'));
      if (lastDot >= 0) name = name.slice(lastDot + 1).replace(/^[:.]/, '');
      name = name.trim();
      if (!name) return;
      this.unresolvedReferences.push({
        fromNodeId: decoratedId,
        referenceName: name,
        referenceKind: 'decorates',
        line: n.startPosition.row + 1,
        column: n.startPosition.column,
      });
    };

    // 1. Decorators that are direct children of the declaration
    //    (method/property style, also some grammars for class).
    for (let i = 0; i < declNode.namedChildCount; i++) {
      const child = declNode.namedChild(i);
      consider(child);
      // Java/Kotlin/C# put annotations INSIDE a `modifiers` node
      // (`@MyAnno public class X` → class_declaration → modifiers → annotation),
      // so descend into it — otherwise every annotation usage is silently
      // dropped and annotation types show zero dependents.
      if (child && child.type === 'modifiers') {
        for (let j = 0; j < child.namedChildCount; j++) {
          consider(child.namedChild(j));
        }
      }
    }

    // 2. Decorators that are PRECEDING siblings of the declaration
    //    inside the parent's children (TypeScript class style).
    //    Walk BACKWARDS from the declaration and stop at the first
    //    non-decorator sibling — without that stop, decorators
    //    belonging to an EARLIER unrelated declaration leak in
    //    (e.g. `@A class Foo {} @B class Bar {}` would otherwise
    //    attribute @A to Bar).
    //
    //    Note on identity: tree-sitter web bindings return fresh JS
    //    wrapper objects from `parent`/`namedChild` navigation, so
    //    `sibling === declNode` is unreliable — `startIndex` does
    //    the matching instead.
    const parent = declNode.parent;
    if (parent) {
      const declStart = declNode.startIndex;
      let declIdx = -1;
      for (let i = 0; i < parent.namedChildCount; i++) {
        const sibling = parent.namedChild(i);
        if (sibling && sibling.startIndex === declStart) {
          declIdx = i;
          break;
        }
      }
      if (declIdx > 0) {
        for (let j = declIdx - 1; j >= 0; j--) {
          const sibling = parent.namedChild(j);
          if (!sibling) continue;
          if (sibling.type !== 'decorator' && sibling.type !== 'annotation' && sibling.type !== 'marker_annotation') {
            break; // non-decorator separator → stop consuming
          }
          consider(sibling);
        }
      }
    }
  }

  /**
   * Visit function body and extract calls (and structural nodes).
   *
   * In addition to call expressions, this also detects class/struct/enum
   * definitions inside function bodies. This handles two cases:
   *   1. Local class/struct/enum definitions (valid in C++, Java, etc.)
   *   2. C++ macro misparsing — macros like NLOHMANN_JSON_NAMESPACE_BEGIN cause
   *      tree-sitter to interpret the namespace block as a function_definition,
   *      hiding real class/struct/enum nodes inside the "function body".
   */
  /**
   * Rocket route-registration macros — `routes![a::b::handler, c::d::other]`
   * and `catchers![not_found]`. Tree-sitter leaves a macro body as a flat
   * `token_tree` of raw tokens (`identifier`, `::`, `,`), so the handler paths
   * are never seen as references and each handler fn looks like it has no caller
   * — it's mounted by Rocket at runtime, not called by in-repo code, so its file
   * shows 0 dependents. Walk the token tree, reconstruct each comma-separated
   * path, and emit a `references` edge; the Rust path resolver
   * (`resolveRustPathReference`) then links it to the handler fn. The handler
   * names are explicit in source, so this is precise static extraction, not a
   * heuristic — no false edges (resolution still validates each path).
   */
  private extractRustRouteMacro(node: SyntaxNode): void {
    if (this.language !== 'rust') return;
    const macroName = node.namedChild(0);
    if (!macroName) return;
    const name = getNodeText(macroName, this.source);
    if (name !== 'routes' && name !== 'catchers') return;
    const tokenTree = node.namedChildren.find((c: SyntaxNode) => c.type === 'token_tree');
    if (!tokenTree) return;
    const fromId = this.nodeStack[this.nodeStack.length - 1];
    if (!fromId) return;

    // The token tree is a flat stream: `[ id :: id :: id , id … ]`. Group runs
    // of `identifier` tokens (the `::` joiners are anonymous) into one path; a
    // `,` (or the closing `]`) ends a path.
    let parts: string[] = [];
    let line = 0;
    let column = 0;
    const flush = (): void => {
      if (parts.length > 0) {
        this.unresolvedReferences.push({
          fromNodeId: fromId,
          referenceName: parts.join('::'),
          referenceKind: 'references',
          line,
          column,
        });
        parts = [];
      }
    };
    for (let i = 0; i < tokenTree.childCount; i++) {
      const t = tokenTree.child(i);
      if (!t) continue;
      if (t.type === 'identifier') {
        if (parts.length === 0) {
          line = t.startPosition.row + 1;
          column = t.startPosition.column;
        }
        parts.push(getNodeText(t, this.source));
      } else if (t.type === ',') {
        flush();
      }
    }
    flush();
  }

  private visitFunctionBody(body: SyntaxNode, _functionId: string): void {
    if (!this.extractor) return;

    const visitForCallsAndStructure = (node: SyntaxNode): void => {
      const nodeType = node.type;

      // Rocket route-registration macros (`routes![…]` / `catchers![…]`): the
      // handler paths live in a raw token tree the call walker can't see.
      if (nodeType === 'macro_invocation') this.extractRustRouteMacro(node);

      if (this.extractor!.callTypes.includes(nodeType)) {
        this.extractCall(node);
      } else if (INSTANTIATION_KINDS.has(nodeType)) {
        // `new Foo()` inside a function body — emit an `instantiates`
        // reference. Without this branch the body walker only knew
        // about `call_expression`, so constructor invocations
        // produced no graph edges at all.
        this.extractInstantiation(node);
        // Anonymous class with body: `new T() { ... }` (Java/C#). Extract as
        // a class so interface-impl synthesis (Phase 5.5) can bridge T's
        // methods to the overrides — same rationale as in visitNode.
        const anonBody = this.findAnonymousClassBody(node);
        if (anonBody) {
          this.extractAnonymousClass(node, anonBody);
          return;
        }
      } else if (this.extractor!.extractBareCall) {
        const calleeName = this.extractor!.extractBareCall(node, this.source);
        if (calleeName && this.nodeStack.length > 0) {
          const callerId = this.nodeStack[this.nodeStack.length - 1];
          if (callerId) {
            this.unresolvedReferences.push({
              fromNodeId: callerId,
              referenceName: calleeName,
              referenceKind: 'calls',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
      }

      // Static-member / value-read: `Enum.value`, `Type.CONST`, `Foo::BAR`.
      this.extractStaticMemberRef(node);

      // Local variable type annotations inside a body — `const items: Foo[] = []`,
      // `const x: SomeType = svc.load()`. We deliberately do NOT create nodes for
      // locals (that would explode the graph — the data-flow frontier we leave
      // uncovered), but the TYPE a local is annotated with is a real dependency of
      // the enclosing function, so attribute a `references` edge to it. Without
      // this, a function that uses a type ONLY in its body (very common — e.g. a
      // resolver building `const nodes: Node[] = []`) produced no edge to that
      // type, so impact / `affected` missed the dependency entirely. We fall
      // through to the default recursion below so the initializer's calls (and any
      // nested declarators) are still walked.
      if (
        nodeType === 'variable_declarator' &&
        this.TYPE_ANNOTATION_LANGUAGES.has(this.language)
      ) {
        const ownerId = this.nodeStack[this.nodeStack.length - 1];
        if (ownerId) this.extractVariableTypeAnnotation(node, ownerId);
      }

      // Nested NAMED functions inside a body — function declarations and named
      // function expressions like `.on('mount', function onmount(){})` — become
      // their own nodes so the graph can link to them (callback handlers, local
      // helpers). Anonymous arrows/expressions fall through to the default
      // recursion below, keeping their inner calls attributed to the enclosing
      // function: this bounds the new nodes to NAMED functions only (no explosion,
      // no lost edges). extractFunction walks the nested body itself, so we return.
      if (this.extractor!.functionTypes.includes(nodeType)) {
        const nestedName = extractName(node, this.source, this.extractor!);
        if (nestedName && nestedName !== '<anonymous>') {
          this.extractFunction(node);
          return;
        }
      }

      // Extract structural nodes found inside function bodies.
      // Each extract method visits its own children, so we return after extracting.
      if (this.extractor!.classTypes.includes(nodeType)) {
        const classification = this.extractor!.classifyClassNode?.(node) ?? 'class';
        if (classification === 'struct') this.extractStruct(node);
        else if (classification === 'enum') this.extractEnum(node);
        else if (classification === 'interface') this.extractInterface(node);
        else if (classification === 'trait') this.extractClass(node, 'trait');
        else this.extractClass(node);
        return;
      }
      if (this.extractor!.structTypes.includes(nodeType)) {
        this.extractStruct(node);
        return;
      }
      if (this.extractor!.enumTypes.includes(nodeType)) {
        this.extractEnum(node);
        return;
      }
      if (this.extractor!.interfaceTypes.includes(nodeType)) {
        this.extractInterface(node);
        return;
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) {
          visitForCallsAndStructure(child);
        }
      }
    };

    visitForCallsAndStructure(body);
  }

  /**
   * Extract inheritance relationships
   */
  private extractInheritance(node: SyntaxNode, classId: string): void {
    // Objective-C @interface MyClass : NSObject <ProtoA, ProtoB>
    if (node.type === 'class_interface') {
      const superclass = getChildByField(node, 'superclass');
      if (superclass) {
        const name = getNodeText(superclass, this.source);
        this.unresolvedReferences.push({
          fromNodeId: classId,
          referenceName: name,
          referenceKind: 'extends',
          line: superclass.startPosition.row + 1,
          column: superclass.startPosition.column,
        });
      }
      for (let j = 0; j < node.namedChildCount; j++) {
        const argList = node.namedChild(j);
        if (argList?.type !== 'parameterized_arguments') continue;
        for (let k = 0; k < argList.namedChildCount; k++) {
          const typeName = argList.namedChild(k);
          if (!typeName) continue;
          const typeId = typeName.namedChildren.find(
            (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'identifier'
          );
          if (!typeId) continue;
          const protocolName = getNodeText(typeId, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: protocolName,
            referenceKind: 'implements',
            line: typeId.startPosition.row + 1,
            column: typeId.startPosition.column,
          });
        }
      }
      return;
    }

    // Look for extends/implements clauses
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;

      if (
        child.type === 'extends_clause' ||
        child.type === 'superclass' ||
        child.type === 'base_clause' || // PHP class extends
        child.type === 'extends_interfaces' // Java interface extends
      ) {
        // Scala: `extends A[X] with B with C` packs EVERY supertype into the
        // one extends_clause (separated by `with`), each a `generic_type` /
        // `type_identifier` / `stable_type_identifier`. The generic path below
        // takes only namedChild(0) and keeps the full text (`A[X]`), so a
        // parameterized supertype — every typeclass in cats/algebra — never
        // matched and `with`-mixed traits past the first were dropped. Iterate
        // all supertypes and unwrap each to its base type name.
        if (this.language === 'scala') {
          for (const target of child.namedChildren) {
            const name = scalaBaseTypeName(target, this.source);
            if (name) {
              this.unresolvedReferences.push({
                fromNodeId: classId,
                referenceName: name,
                referenceKind: 'extends',
                line: target.startPosition.row + 1,
                column: target.startPosition.column,
              });
            }
          }
          continue;
        }
        // Dart: `class C extends Base with M1, M2` — the `superclass` node holds
        // the extends type as a direct `type_identifier` AND a `mixins` child
        // listing the `with` mixins (and `class C with M` has ONLY mixins, no
        // extends type). The generic `namedChild(0)` path would read the
        // `mixins` node itself as the superclass and drop every mixin — yet
        // mixins are Dart's core composition mechanism (Flutter is built on
        // them). Emit `extends` for the base and `implements` for each mixin.
        if (this.language === 'dart' && child.type === 'superclass') {
          for (const t of child.namedChildren) {
            if (t.type === 'mixins') {
              for (const m of t.namedChildren) {
                if (m.type === 'type_identifier') {
                  this.unresolvedReferences.push({
                    fromNodeId: classId,
                    referenceName: getNodeText(m, this.source),
                    referenceKind: 'implements',
                    line: m.startPosition.row + 1,
                    column: m.startPosition.column,
                  });
                }
              }
            } else if (t.type === 'type_identifier') {
              this.unresolvedReferences.push({
                fromNodeId: classId,
                referenceName: getNodeText(t, this.source),
                referenceKind: 'extends',
                line: t.startPosition.row + 1,
                column: t.startPosition.column,
              });
            }
          }
          continue;
        }
        // Extract parent class/interface names
        // Java uses type_list wrapper: superclass -> type_identifier, extends_interfaces -> type_list -> type_identifier
        const typeList = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_list');
        const targets = typeList ? typeList.namedChildren : [child.namedChild(0)];
        for (const target of targets) {
          if (target) {
            const name = getNodeText(target, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'extends',
              line: target.startPosition.row + 1,
              column: target.startPosition.column,
            });
          }
        }
      }

      // C++ base classes: `class Derived : public Base, private Other` →
      // base_class_clause holds access specifiers + base type(s). Emit an extends
      // ref per base type (skip the public/private/protected keywords).
      if (child.type === 'base_class_clause') {
        for (const t of child.namedChildren) {
          if (
            t.type === 'type_identifier' ||
            t.type === 'qualified_identifier' ||
            t.type === 'template_type'
          ) {
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: getNodeText(t, this.source),
              referenceKind: 'extends',
              line: t.startPosition.row + 1,
              column: t.startPosition.column,
            });
          }
        }
      }

      if (
        child.type === 'implements_clause' ||
        child.type === 'class_interface_clause' ||
        child.type === 'super_interfaces' || // Java class implements
        child.type === 'interfaces' // Dart
      ) {
        // Extract implemented interfaces
        // Java uses type_list wrapper: super_interfaces -> type_list -> type_identifier
        const typeList = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_list');
        const targets = typeList ? typeList.namedChildren : child.namedChildren;
        for (const iface of targets) {
          if (iface) {
            const name = getNodeText(iface, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'implements',
              line: iface.startPosition.row + 1,
              column: iface.startPosition.column,
            });
          }
        }
      }

      // Python superclass list: `class Flask(Scaffold, Mixin):`
      // argument_list contains identifier children for each parent class
      if (child.type === 'argument_list' && node.type === 'class_definition') {
        for (const arg of child.namedChildren) {
          if (arg.type === 'identifier' || arg.type === 'attribute') {
            const name = getNodeText(arg, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'extends',
              line: arg.startPosition.row + 1,
              column: arg.startPosition.column,
            });
          }
        }
      }

      // Go interface embedding: `type Querier interface { LabelQuerier; ... }`
      // constraint_elem wraps the embedded interface type identifier
      if (child.type === 'constraint_elem') {
        const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
        if (typeId) {
          const name = getNodeText(typeId, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'extends',
            line: typeId.startPosition.row + 1,
            column: typeId.startPosition.column,
          });
        }
      }

      // Go struct embedding: field_declaration without field_identifier
      // e.g. `type DB struct { *Head; Queryable }` — no field name means embedded type
      if (child.type === 'field_declaration') {
        const hasFieldIdentifier = child.namedChildren.some((c: SyntaxNode) => c.type === 'field_identifier');
        if (!hasFieldIdentifier) {
          const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
          if (typeId) {
            const name = getNodeText(typeId, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'extends',
              line: typeId.startPosition.row + 1,
              column: typeId.startPosition.column,
            });
          }
        }
      }

      // Rust trait supertraits: `trait SubTrait: SuperTrait + Display { ... }`
      // trait_bounds contains type_identifier, generic_type, or higher_ranked_trait_bound children
      if (child.type === 'trait_bounds') {
        for (const bound of child.namedChildren) {
          let typeName: string | undefined;
          let posNode: SyntaxNode | undefined;

          if (bound.type === 'type_identifier') {
            typeName = getNodeText(bound, this.source);
            posNode = bound;
          } else if (bound.type === 'generic_type') {
            // e.g. `Deserialize<'de>`
            const inner = bound.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
            if (inner) { typeName = getNodeText(inner, this.source); posNode = inner; }
          } else if (bound.type === 'higher_ranked_trait_bound') {
            // e.g. `for<'de> Deserialize<'de>`
            const generic = bound.namedChildren.find((c: SyntaxNode) => c.type === 'generic_type');
            const typeId = generic?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
              ?? bound.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
            if (typeId) { typeName = getNodeText(typeId, this.source); posNode = typeId; }
          }

          if (typeName && posNode) {
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: typeName,
              referenceKind: 'extends',
              line: posNode.startPosition.row + 1,
              column: posNode.startPosition.column,
            });
          }
        }
      }

      // C#: `class Movie : BaseItem, IPlugin` → base_list with identifier children
      // base_list combines both base class and interfaces in a single colon-separated list.
      // We emit all as 'extends' since the syntax doesn't distinguish them.
      if (child.type === 'base_list') {
        for (const baseType of child.namedChildren) {
          if (baseType) {
            // For generic base types like `ClientBase<T>`, extract just the type name
            const name = baseType.type === 'generic_name'
              ? getNodeText(baseType.namedChildren.find((c: SyntaxNode) => c.type === 'identifier') ?? baseType, this.source)
              : getNodeText(baseType, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'extends',
              line: baseType.startPosition.row + 1,
              column: baseType.startPosition.column,
            });
          }
        }
      }

      // Kotlin: `class Foo : Bar, Baz` → delegation_specifier > user_type > type_identifier
      // Also handles `class Foo : Bar()` → delegation_specifier > constructor_invocation > user_type
      if (child.type === 'delegation_specifier') {
        const userType = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type');
        const constructorInvocation = child.namedChildren.find((c: SyntaxNode) => c.type === 'constructor_invocation');
        const target = userType ?? constructorInvocation;
        if (target) {
          const typeId = target.type === 'user_type'
            ? target.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier') ?? target
            : target.namedChildren.find((c: SyntaxNode) => c.type === 'user_type')?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
              ?? target.namedChildren.find((c: SyntaxNode) => c.type === 'user_type') ?? target;
          const name = getNodeText(typeId, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'extends',
            line: typeId.startPosition.row + 1,
            column: typeId.startPosition.column,
          });
        }
      }

      // Swift: inheritance_specifier > user_type > type_identifier
      // Used for class inheritance, protocol conformance, and protocol inheritance
      if (child.type === 'inheritance_specifier') {
        const userType = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type');
        const typeId = userType?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
        if (typeId) {
          const name = getNodeText(typeId, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'extends',
            line: typeId.startPosition.row + 1,
            column: typeId.startPosition.column,
          });
        }
      }

      // JavaScript class_heritage has bare identifier without extends_clause wrapper
      // e.g. `class Foo extends Bar {}` → class_heritage → identifier("Bar")
      if (
        (child.type === 'identifier' || child.type === 'type_identifier') &&
        node.type === 'class_heritage'
      ) {
        const name = getNodeText(child, this.source);
        this.unresolvedReferences.push({
          fromNodeId: classId,
          referenceName: name,
          referenceKind: 'extends',
          line: child.startPosition.row + 1,
          column: child.startPosition.column,
        });
      }

      // Recurse into container nodes (e.g. field_declaration_list in Go structs,
      // class_heritage in TypeScript which wraps extends_clause/implements_clause)
      if (child.type === 'field_declaration_list' || child.type === 'class_heritage') {
        this.extractInheritance(child, classId);
      }
    }
  }

  /**
   * Rust `impl Trait for Type` — creates an implements edge from Type to Trait.
   * For plain `impl Type { ... }` (no trait), no inheritance edge is needed.
   */
  private extractRustImplItem(node: SyntaxNode): void {
    // Check if this is `impl Trait for Type` by looking for a `for` keyword
    const hasFor = node.children.some(
      (c: SyntaxNode) => c.type === 'for' && !c.isNamed
    );
    if (!hasFor) return;

    // In `impl Trait for Type`, the type_identifiers are:
    // first = Trait name, last = implementing Type name
    // Also handle generic types like `impl<T> Trait for MyStruct<T>`
    const typeIdents = node.namedChildren.filter(
      (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'generic_type' || c.type === 'scoped_type_identifier'
    );
    if (typeIdents.length < 2) return;

    const traitNode = typeIdents[0]!;
    const typeNode = typeIdents[typeIdents.length - 1]!;

    // Get the trait name (handle scoped paths like std::fmt::Display)
    const traitName = traitNode.type === 'scoped_type_identifier'
      ? this.source.substring(traitNode.startIndex, traitNode.endIndex)
      : getNodeText(traitNode, this.source);

    // Get the implementing type name (extract inner type_identifier for generics)
    let typeName: string;
    if (typeNode.type === 'generic_type') {
      const inner = typeNode.namedChildren.find(
        (c: SyntaxNode) => c.type === 'type_identifier'
      );
      typeName = inner ? getNodeText(inner, this.source) : getNodeText(typeNode, this.source);
    } else {
      typeName = getNodeText(typeNode, this.source);
    }

    // Find the struct/type node for the implementing type
    const typeNodeId = this.findNodeByName(typeName);
    if (typeNodeId) {
      this.unresolvedReferences.push({
        fromNodeId: typeNodeId,
        referenceName: traitName,
        referenceKind: 'implements',
        line: traitNode.startPosition.row + 1,
        column: traitNode.startPosition.column,
      });
    }
  }

  /**
   * Find a previously-extracted node by name (used for back-references like impl blocks)
   */
  private findNodeByName(name: string): string | undefined {
    for (const node of this.nodes) {
      if (node.name === name && (node.kind === 'struct' || node.kind === 'enum' || node.kind === 'class')) {
        return node.id;
      }
    }
    return undefined;
  }

  /**
   * Languages that support type annotations (TypeScript, etc.)
   */
  private readonly TYPE_ANNOTATION_LANGUAGES = new Set([
    'typescript', 'tsx', 'dart', 'kotlin', 'swift', 'rust', 'go', 'java', 'csharp', 'scala', 'php',
  ]);

  /**
   * PHP pseudo-types and `self`/`static`/`parent` that aren't project symbols.
   * (Scalar primitives parse as `primitive_type` and are skipped structurally.)
   */
  private readonly PHP_PSEUDO_TYPES = new Set([
    'self', 'static', 'parent', 'mixed', 'object', 'iterable', 'callable', 'void',
    'null', 'false', 'true', 'never', 'array', 'int', 'float', 'string', 'bool',
  ]);

  /**
   * Built-in/primitive type names that shouldn't create references
   */
  private readonly BUILTIN_TYPES = new Set([
    'string', 'number', 'boolean', 'void', 'null', 'undefined', 'never', 'any', 'unknown',
    'object', 'symbol', 'bigint', 'true', 'false',
    // Rust
    'str', 'bool', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
    'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'f32', 'f64', 'char',
    // Java/C#
    'int', 'long', 'short', 'byte', 'float', 'double', 'char',
    // Go
    'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64',
    'float32', 'float64', 'complex64', 'complex128', 'rune', 'error',
    // Scala (capitalized primitives + ubiquitous stdlib aliases)
    'Int', 'Long', 'Short', 'Byte', 'Float', 'Double', 'Boolean', 'Char', 'Unit',
    'String', 'Any', 'AnyRef', 'AnyVal', 'Nothing', 'Null',
  ]);

  /**
   * Extract type references from type annotations on a function/method/field node.
   * Creates 'references' edges for parameter types, return types, and field types.
   */
  private extractTypeAnnotations(node: SyntaxNode, nodeId: string): void {
    if (!this.extractor) return;
    if (!this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) return;

    // C# tree-sitter doesn't produce `type_identifier` leaves — it uses
    // `identifier`, `predefined_type`, `qualified_name`, `generic_name`,
    // etc. — so the generic walker below emits zero references for it.
    // Dispatch to a C#-aware path that only walks type-position subtrees
    // (the `type` field of a parameter/method/property/field), so
    // parameter NAMES never accidentally surface as type refs (#381).
    if (this.language === 'csharp') {
      this.extractCsharpTypeRefs(node, nodeId);
      return;
    }

    // PHP type-hints are `named_type`/`optional_type`/`union_type` wrapping a
    // `name`/`qualified_name` — never `type_identifier` — so the generic walker
    // below emits nothing for them. Dispatch to a PHP-aware path that walks only
    // type positions (parameter / return / property types), so type-hinted
    // dependencies (the constructor-injected contracts that dominate Laravel) are
    // recorded and a `variable_name` like `$events` never mis-emits as a ref.
    if (this.language === 'php') {
      this.extractPhpTypeRefs(node, nodeId);
      return;
    }

    // Dart: a `method_signature` wraps the real `function_signature` (where the
    // params and return type live), and the return type is a bare
    // `type_identifier` child, not a `type` field — so getChildByField below
    // finds neither. Walk the inner signature: param names / the method name are
    // `identifier` (not `type_identifier`), so only types surface.
    if (this.language === 'dart') {
      let sig: SyntaxNode | undefined = node;
      if (node.type === 'method_signature') {
        sig = node.namedChildren.find(
          (c: SyntaxNode) =>
            c.type === 'function_signature' ||
            c.type === 'getter_signature' ||
            c.type === 'setter_signature' ||
            c.type === 'constructor_signature' ||
            c.type === 'factory_constructor_signature'
        ) ?? node;
      }
      this.extractTypeRefsFromSubtree(sig, nodeId);
      return;
    }

    // Extract parameter type annotations. Scala curries — `def f(a)(implicit
    // M: TC)` has MULTIPLE `parameters` siblings, and the typeclass is almost
    // always in the trailing implicit list — so walk every parameter list, not
    // just getChildByField's first match.
    if (this.language === 'scala') {
      for (const pc of node.namedChildren) {
        if (pc.type === 'parameters') this.extractTypeRefsFromSubtree(pc, nodeId);
      }
    } else {
      const params = getChildByField(node, this.extractor.paramsField || 'parameters');
      if (params) {
        this.extractTypeRefsFromSubtree(params, nodeId);
      }
    }

    // Extract return type annotation
    const returnType = getChildByField(node, this.extractor.returnField || 'return_type');
    if (returnType) {
      this.extractTypeRefsFromSubtree(returnType, nodeId);
    }

    // Scala context bounds / type-parameter bounds: `def f[A: Monoid]`,
    // `[F[_]: Monad]`, `[A <: Foo]` carry the bound type inside `type_parameters`.
    // This is THE pervasive way a typeclass is required in Scala, yet the bound
    // never appears in the value parameters. Param NAMES are `identifier` (not
    // `type_identifier`), so only the bound types surface. Scala-only: in other
    // languages a `type_parameters` child holds declaration names as
    // `type_identifier` (TS `<T>`), which would wrongly surface as refs.
    if (this.language === 'scala') {
      const typeParams = node.namedChildren.find(
        (c: SyntaxNode) => c.type === 'type_parameters'
      );
      if (typeParams) {
        this.extractTypeRefsFromSubtree(typeParams, nodeId);
      }
    }

    // Extract direct type annotation (for class fields like `model: ITextModel`)
    const typeAnnotation = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type_annotation'
    );
    if (typeAnnotation) {
      this.extractTypeRefsFromSubtree(typeAnnotation, nodeId);
    }
  }

  /**
   * Extract C# type references from a node that owns a type position —
   * a method/constructor declaration, a property declaration, or a
   * field declaration (which wraps `variable_declaration → type`).
   *
   * Walks ONLY into known type fields, so parameter names like
   * `request` in `Build(UserDto request)` are never mis-emitted as
   * type references. Once inside a type subtree, `walkCsharpTypePosition`
   * recognizes C#'s actual type-leaf node kinds (`identifier`,
   * `qualified_name`, `generic_name`, `array_type`, `nullable_type`,
   * `tuple_type`, …) — none of which are `type_identifier`. Closes #381.
   */
  private extractCsharpTypeRefs(node: SyntaxNode, nodeId: string): void {
    // A property's type is under the `type` field; a method/constructor's RETURN
    // type is under `returns` (tree-sitter-c-sharp 0.23.x — older builds used
    // `type` for both). A node carries only one of the two, so checking both
    // covers return types and property types without conflating them.
    const directType = getChildByField(node, 'type') ?? getChildByField(node, 'returns');
    if (directType) this.walkCsharpTypePosition(directType, nodeId);

    // Field declarations wrap declarators in a `variable_declaration`
    // whose `type` field carries the type. The outer `field_declaration`
    // has no `type` field of its own, so the call above is a no-op here
    // and we descend one level.
    const varDecl = node.namedChildren.find((c: SyntaxNode) => c.type === 'variable_declaration');
    if (varDecl) {
      const vdType = getChildByField(varDecl, 'type');
      if (vdType) this.walkCsharpTypePosition(vdType, nodeId);
    }

    // Method / constructor parameters. The field name on
    // `method_declaration` is `parameters`; it points at a
    // `parameter_list` whose `parameter` children each have their own
    // `type` field. Walking ONLY the type field skips parameter NAMES,
    // which would otherwise mis-emit as type references.
    const params = getChildByField(node, 'parameters');
    if (params) {
      for (let i = 0; i < params.namedChildCount; i++) {
        const child = params.namedChild(i);
        if (!child || child.type !== 'parameter') continue;
        const paramType = getChildByField(child, 'type');
        if (paramType) this.walkCsharpTypePosition(paramType, nodeId);
      }
    }
  }

  /**
   * Record the dependencies declared by a C# PRIMARY CONSTRUCTOR
   * (`class Svc(IRepo repo, [FromKeyedServices("k")] ICache cache) { … }`,
   * C# 12+). The parameter list hangs off the class/struct/record declaration
   * as an unnamed-field `parameter_list` child (not the `parameters` field a
   * method uses), so it's found by node type. Each parameter's declared type
   * becomes a `references` edge from the owning type — these are exactly the
   * services a DI-registered type depends on, so impact/blast-radius and
   * "who depends on this contract" now see them. No-op when there's no primary
   * constructor. (#237)
   */
  private extractCsharpPrimaryCtorParamRefs(node: SyntaxNode, ownerId: string): void {
    if (this.language !== 'csharp') return;
    const paramList = node.namedChildren.find((c: SyntaxNode) => c.type === 'parameter_list');
    if (!paramList) return;
    for (let i = 0; i < paramList.namedChildCount; i++) {
      const param = paramList.namedChild(i);
      if (!param || param.type !== 'parameter') continue;
      const paramType = getChildByField(param, 'type');
      if (paramType) this.walkCsharpTypePosition(paramType, ownerId);
    }
  }

  /**
   * Walk a C# subtree that is KNOWN to be in a type position
   * (return type, parameter type, property type, field type, generic
   * argument). Identifiers here are type names, not parameter names.
   */
  private walkCsharpTypePosition(node: SyntaxNode, fromNodeId: string): void {
    // `predefined_type` is int/string/bool/etc. — never a project ref.
    if (node.type === 'predefined_type') return;

    // Bare type name: `Foo` in `Foo bar`, or the `Foo` inside `List<Foo>`.
    if (node.type === 'identifier') {
      const name = getNodeText(node, this.source);
      if (name && !this.BUILTIN_TYPES.has(name)) {
        this.unresolvedReferences.push({
          fromNodeId,
          referenceName: name,
          referenceKind: 'references',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return;
    }

    // `Namespace.Foo` → the rightmost identifier is the type. Emit the
    // full qualified name as the reference; the resolver can still match
    // on the trailing simple name when needed.
    if (node.type === 'qualified_name') {
      const text = getNodeText(node, this.source);
      const last = text.split('.').pop() ?? text;
      if (last && !this.BUILTIN_TYPES.has(last)) {
        this.unresolvedReferences.push({
          fromNodeId,
          referenceName: last,
          referenceKind: 'references',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return;
    }

    // `(int Code, Foo Payload)` — tuple element has BOTH a `type` and a
    // `name` field; descending into all named children would mis-emit
    // the element name (`Code`, `Payload`) as a type ref. Walk only the
    // type field.
    if (node.type === 'tuple_element') {
      const t = getChildByField(node, 'type');
      if (t) this.walkCsharpTypePosition(t, fromNodeId);
      return;
    }

    // Composite type nodes — recurse into named children. Covers
    // `generic_name` (head identifier + `type_argument_list`),
    // `nullable_type`, `array_type`, `pointer_type`, `tuple_type`,
    // `ref_type`, and any newer wrapping shapes the grammar adds.
    // Identifiers reached here are all type-positional (parameter/field
    // names are gated out before we descend).
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) this.walkCsharpTypePosition(child, fromNodeId);
    }
  }

  /**
   * Extract PHP type references from a method/function/property declaration.
   * Walks ONLY type positions: each parameter's type child (inside
   * `formal_parameters`), the return type, and a property's type — all
   * `named_type` / `optional_type` / `union_type` / … direct children. Parameter
   * and property NAMES are `variable_name` (`$x`), never type nodes, so they
   * can't be mis-emitted.
   */
  private extractPhpTypeRefs(node: SyntaxNode, nodeId: string): void {
    const params = node.namedChildren.find((c: SyntaxNode) => c.type === 'formal_parameters');
    if (params) {
      for (const p of params.namedChildren) {
        // simple_parameter / property_promotion_parameter / variadic_parameter
        for (const c of p.namedChildren) {
          if (PHP_TYPE_NODES.has(c.type)) this.walkPhpTypePosition(c, nodeId);
        }
      }
    }
    // Return type (method/function) and property type are TYPE nodes that are
    // DIRECT children of the declaration.
    for (const c of node.namedChildren) {
      if (PHP_TYPE_NODES.has(c.type)) this.walkPhpTypePosition(c, nodeId);
    }
  }

  /** Walk a PHP subtree KNOWN to be in a type position; emit class/interface refs. */
  private walkPhpTypePosition(node: SyntaxNode, fromNodeId: string): void {
    if (node.type === 'primitive_type') return; // int/string/void/…
    if (node.type === 'name') {
      const name = getNodeText(node, this.source);
      if (name && !this.PHP_PSEUDO_TYPES.has(name)) {
        this.unresolvedReferences.push({
          fromNodeId, referenceName: name, referenceKind: 'references',
          line: node.startPosition.row + 1, column: node.startPosition.column,
        });
      }
      return;
    }
    if (node.type === 'qualified_name') {
      // `App\Contracts\Logger` → match on the trailing simple name (what the
      // class node is stored as, and what a `use` import brings into scope).
      const last = getNodeText(node, this.source).split('\\').pop() ?? '';
      if (last && !this.PHP_PSEUDO_TYPES.has(last)) {
        this.unresolvedReferences.push({
          fromNodeId, referenceName: last, referenceKind: 'references',
          line: node.startPosition.row + 1, column: node.startPosition.column,
        });
      }
      return;
    }
    // optional_type / nullable_type / union_type / intersection_type / named_type → recurse
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) this.walkPhpTypePosition(child, fromNodeId);
    }
  }

  /**
   * Extract type references from a variable's type annotation.
   */
  private extractVariableTypeAnnotation(node: SyntaxNode, nodeId: string): void {
    if (!this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) return;

    // Find type_annotation child (covers TS `: Type`, Rust `: Type`, etc.)
    const typeAnnotation = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type_annotation'
    );
    if (typeAnnotation) {
      this.extractTypeRefsFromSubtree(typeAnnotation, nodeId);
    }
  }

  /**
   * Recursively walk a subtree and extract all type_identifier references.
   * Handles unions, intersections, generics, arrays, etc.
   */
  private extractTypeRefsFromSubtree(node: SyntaxNode, fromNodeId: string): void {
    if (node.type === 'type_identifier') {
      const typeName = getNodeText(node, this.source);
      if (typeName && !this.BUILTIN_TYPES.has(typeName)) {
        this.unresolvedReferences.push({
          fromNodeId,
          referenceName: typeName,
          referenceKind: 'references',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return; // type_identifier is a leaf
    }

    // Recurse into children (handles union_type, intersection_type, generic_type, etc.)
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) {
        this.extractTypeRefsFromSubtree(child, fromNodeId);
      }
    }
  }

  /**
   * Handle Pascal-specific AST structures.
   * Returns true if the node was fully handled and children should be skipped.
   */
  private visitPascalNode(node: SyntaxNode): boolean {
    const nodeType = node.type;

    // Unit/Program/Library → module node
    if (nodeType === 'unit' || nodeType === 'program' || nodeType === 'library') {
      const moduleNameNode = node.namedChildren.find(
        (c: SyntaxNode) => c.type === 'moduleName'
      );
      const name = moduleNameNode ? getNodeText(moduleNameNode, this.source) : '';
      // Fallback to filename without extension if module name is empty
      const moduleName = name || path.basename(this.filePath).replace(/\.[^.]+$/, '');
      this.createNode('module', moduleName, node);
      // Continue visiting children (interface/implementation sections)
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // declType wraps declClass/declIntf/declEnum/type-alias
    // The name lives on declType, the inner node determines the kind
    if (nodeType === 'declType') {
      this.extractPascalDeclType(node);
      return true;
    }

    // declUses → import nodes for each unit name
    if (nodeType === 'declUses') {
      this.extractPascalUses(node);
      return true;
    }

    // declConsts → container; visit children for individual declConst
    if (nodeType === 'declConsts') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'declConst') {
          this.extractPascalConst(child);
        }
      }
      return true;
    }

    // declConst at top level (outside declConsts)
    if (nodeType === 'declConst') {
      this.extractPascalConst(node);
      return true;
    }

    // declTypes → container for type declarations
    if (nodeType === 'declTypes') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // declVars → container for variable declarations
    if (nodeType === 'declVars') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'declVar') {
          const nameNode = getChildByField(child, 'name');
          if (nameNode) {
            const name = getNodeText(nameNode, this.source);
            this.createNode('variable', name, child);
          }
        }
      }
      return true;
    }

    // defProc in implementation section → extract calls but don't create duplicate nodes
    if (nodeType === 'defProc') {
      this.extractPascalDefProc(node);
      return true;
    }

    // declProp → property node
    if (nodeType === 'declProp') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        const name = getNodeText(nameNode, this.source);
        const visibility = this.extractor!.getVisibility?.(node);
        this.createNode('property', name, node, { visibility });
      }
      return true;
    }

    // declField → field node
    if (nodeType === 'declField') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        const name = getNodeText(nameNode, this.source);
        const visibility = this.extractor!.getVisibility?.(node);
        this.createNode('field', name, node, { visibility });
      }
      return true;
    }

    // declSection → visit children (propagates visibility via getVisibility)
    if (nodeType === 'declSection') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // exprCall → extract function call reference
    if (nodeType === 'exprCall') {
      this.extractPascalCall(node);
      return true;
    }

    // interface/implementation sections → visit children
    if (nodeType === 'interface' || nodeType === 'implementation') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // block (begin..end) → visit for calls
    if (nodeType === 'block') {
      this.visitPascalBlock(node);
      return true;
    }

    return false;
  }

  /**
   * Extract a Pascal declType node (class, interface, enum, or type alias)
   */
  private extractPascalDeclType(node: SyntaxNode): void {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return;
    const name = getNodeText(nameNode, this.source);

    // Find the inner type declaration
    const declClass = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declClass'
    );
    const declIntf = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declIntf'
    );
    const typeChild = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type'
    );

    if (declClass) {
      const classNode = this.createNode('class', name, node);
      if (classNode) {
        // Extract inheritance from typeref children of declClass
        this.extractPascalInheritance(declClass, classNode.id);
        // Visit class body
        this.nodeStack.push(classNode.id);
        for (let i = 0; i < declClass.namedChildCount; i++) {
          const child = declClass.namedChild(i);
          if (child) this.visitNode(child);
        }
        this.nodeStack.pop();
      }
    } else if (declIntf) {
      const ifaceNode = this.createNode('interface', name, node);
      if (ifaceNode) {
        // Visit interface members
        this.nodeStack.push(ifaceNode.id);
        for (let i = 0; i < declIntf.namedChildCount; i++) {
          const child = declIntf.namedChild(i);
          if (child) this.visitNode(child);
        }
        this.nodeStack.pop();
      }
    } else if (typeChild) {
      // Check if it contains a declEnum
      const declEnum = typeChild.namedChildren.find(
        (c: SyntaxNode) => c.type === 'declEnum'
      );
      if (declEnum) {
        const enumNode = this.createNode('enum', name, node);
        if (enumNode) {
          // Extract enum members
          this.nodeStack.push(enumNode.id);
          for (let i = 0; i < declEnum.namedChildCount; i++) {
            const child = declEnum.namedChild(i);
            if (child?.type === 'declEnumValue') {
              const memberName = getChildByField(child, 'name');
              if (memberName) {
                this.createNode('enum_member', getNodeText(memberName, this.source), child);
              }
            }
          }
          this.nodeStack.pop();
        }
      } else {
        // Simple type alias: type TFoo = string / type TFoo = Integer
        this.createNode('type_alias', name, node);
      }
    } else {
      // Fallback: could be a forward declaration or simple alias
      this.createNode('type_alias', name, node);
    }
  }

  /**
   * Extract Pascal uses clause into individual import nodes
   */
  private extractPascalUses(node: SyntaxNode): void {
    const importText = getNodeText(node, this.source).trim();
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'moduleName') {
        const unitName = getNodeText(child, this.source);
        this.createNode('import', unitName, child, {
          signature: importText,
        });
        // Create unresolved reference for resolution
        if (this.nodeStack.length > 0) {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) {
            this.unresolvedReferences.push({
              fromNodeId: parentId,
              referenceName: unitName,
              referenceKind: 'imports',
              line: child.startPosition.row + 1,
              column: child.startPosition.column,
            });
          }
        }
      }
    }
  }

  /**
   * Extract a Pascal constant declaration
   */
  private extractPascalConst(node: SyntaxNode): void {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return;
    const name = getNodeText(nameNode, this.source);
    const defaultValue = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'defaultValue'
    );
    const sig = defaultValue ? getNodeText(defaultValue, this.source) : undefined;
    this.createNode('constant', name, node, { signature: sig });
  }

  /**
   * Extract Pascal inheritance (extends/implements) from declClass typeref children
   */
  private extractPascalInheritance(declClass: SyntaxNode, classId: string): void {
    const typerefs = declClass.namedChildren.filter(
      (c: SyntaxNode) => c.type === 'typeref'
    );
    for (let i = 0; i < typerefs.length; i++) {
      const ref = typerefs[i]!;
      const name = getNodeText(ref, this.source);
      this.unresolvedReferences.push({
        fromNodeId: classId,
        referenceName: name,
        referenceKind: i === 0 ? 'extends' : 'implements',
        line: ref.startPosition.row + 1,
        column: ref.startPosition.column,
      });
    }
  }

  /**
   * Extract calls and resolve method context from a Pascal defProc (implementation body).
   * Does not create a new node — the declaration was already captured from the interface section.
   */
  private extractPascalDefProc(node: SyntaxNode): void {
    // Find the matching declaration node by name to use as call parent
    const declProc = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declProc'
    );
    if (!declProc) return;

    const nameNode = getChildByField(declProc, 'name');
    if (!nameNode) return;
    const fullName = getNodeText(nameNode, this.source).trim();
    // fullName is like "TAuthService.Create"
    const shortName = fullName.includes('.') ? fullName.split('.').pop()! : fullName;
    const fullNameKey = fullName.toLowerCase();
    const shortNameKey = shortName.toLowerCase();

    // Build method index on first use (O(n) once, then O(1) per lookup)
    if (!this.methodIndex) {
      this.methodIndex = new Map();
      for (const n of this.nodes) {
        if (n.kind === 'method' || n.kind === 'function') {
          const nameKey = n.name.toLowerCase();
          // Keep first seen short-name mapping to avoid silently overwriting earlier entries.
          if (!this.methodIndex.has(nameKey)) {
            this.methodIndex.set(nameKey, n.id);
          }

          // For Pascal methods, also index qualified forms (e.g. TAuthService.Create).
          if (n.kind === 'method') {
            const qualifiedParts = n.qualifiedName.split('::');
            if (qualifiedParts.length >= 2) {
              // Create suffix keys so both "Module.Class.Method" and "Class.Method" can resolve.
              for (let i = 0; i < qualifiedParts.length - 1; i++) {
                const scopedName = qualifiedParts.slice(i).join('.').toLowerCase();
                this.methodIndex.set(scopedName, n.id);
              }
            }
          }
        }
      }
    }

    const parentId =
      this.methodIndex.get(fullNameKey) ||
      this.methodIndex.get(shortNameKey) ||
      this.nodeStack[this.nodeStack.length - 1];
    if (!parentId) return;

    // Visit the block for calls
    const block = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'block'
    );
    if (block) {
      this.nodeStack.push(parentId);
      this.visitPascalBlock(block);
      this.nodeStack.pop();
    }
  }

  /**
   * Extract function calls from a Pascal expression
   */
  private extractPascalCall(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    // Get the callee name — first child is typically the identifier or exprDot
    const firstChild = node.namedChild(0);
    if (!firstChild) return;

    let calleeName = '';
    if (firstChild.type === 'exprDot') {
      // Chained static-factory call: `TFoo.GetInstance().DoIt()` — the exprDot's
      // receiver is itself an `exprCall`, so the bare identifier list would
      // collapse to just `DoIt` and mis-resolve to a same-named method on an
      // unrelated class. Encode `TFoo.GetInstance().DoIt` so resolution infers
      // DoIt's class from what `TFoo.GetInstance` RETURNS (#645/#608). Only a
      // capitalized class-factory chain; a unary outer method.
      const innerCall = firstChild.namedChildren.find((c: SyntaxNode) => c.type === 'exprCall');
      const outerId = firstChild.namedChildren.filter((c: SyntaxNode) => c.type === 'identifier').pop();
      const method = outerId ? getNodeText(outerId, this.source) : '';
      if (innerCall && method && /^\w+$/.test(method)) {
        const innerFirst = innerCall.namedChild(0);
        let innerCallee = '';
        if (innerFirst?.type === 'exprDot') {
          innerCallee = innerFirst.namedChildren
            .filter((c: SyntaxNode) => c.type === 'identifier')
            .map((id: SyntaxNode) => getNodeText(id, this.source))
            .join('.');
        } else if (innerFirst?.type === 'identifier') {
          innerCallee = getNodeText(innerFirst, this.source);
        }
        // Gate on the Delphi type-naming convention — `TFoo` classes / `IFoo`
        // interfaces — so a class-factory chain re-encodes but a capitalized
        // VARIABLE/parameter chain (Pascal capitalizes locals too: `Curve.X().Y()`,
        // `Self.X().Y()`) stays bare and keeps its existing bare-name resolution.
        calleeName = innerCallee && /^[TI][A-Z]/.test(innerCallee)
          ? `${innerCallee}().${method}`
          : method;
      } else {
        // Qualified call: Obj.Method(...)
        const identifiers = firstChild.namedChildren.filter(
          (c: SyntaxNode) => c.type === 'identifier'
        );
        if (identifiers.length > 0) {
          calleeName = identifiers.map((id: SyntaxNode) => getNodeText(id, this.source)).join('.');
        }
      }
    } else if (firstChild.type === 'identifier') {
      calleeName = getNodeText(firstChild, this.source);
    }

    if (calleeName) {
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: calleeName,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }

    // Also visit arguments for nested calls
    const args = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'exprArgs'
    );
    if (args) {
      this.visitPascalBlock(args);
    }
  }

  /**
   * Extract a PAREN-LESS Pascal method/procedure call (`Obj.Method;`,
   * `TFoo.GetInstance.DoIt;`). Pascal lets a no-arg method drop its parens, so it
   * parses as a bare `exprDot` (not an `exprCall`). A bare `exprDot` is
   * syntactically identical to a field/property access, so this is only ever
   * called for a STATEMENT-level exprDot (caller-gated): a bare `Obj.Field;`
   * statement is a no-op, so a statement-level dot expression is a call. (An
   * exprDot in assignment LHS/RHS or a condition is left alone — there it really
   * can be a field/property read.)
   */
  private extractPascalParenlessCall(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    const receiver = node.namedChild(0);
    const outerId = node.namedChildren.filter((c: SyntaxNode) => c.type === 'identifier').pop();
    const method = outerId ? getNodeText(outerId, this.source) : '';
    if (!method) return;

    let calleeName = '';
    // Chained: the receiver is itself a call — a paren-less `TFoo.GetInstance` (an
    // inner exprDot) or a paren'd `TFoo.GetInstance()` (an exprCall). Encode the
    // chain `TFoo.GetInstance().DoIt` so resolution infers DoIt's class from what
    // the factory RETURNS (#645/#608), gated on the Delphi `TFoo`/`IFoo` type
    // convention; a capitalized VARIABLE chain stays a bare method name.
    if ((receiver?.type === 'exprDot' || receiver?.type === 'exprCall') && /^\w+$/.test(method)) {
      const innerCalleeNode = receiver.type === 'exprCall' ? receiver.namedChild(0) : receiver;
      const innerCallee = !innerCalleeNode
        ? ''
        : innerCalleeNode.type === 'identifier'
          ? getNodeText(innerCalleeNode, this.source)
          : innerCalleeNode.namedChildren
              .filter((c: SyntaxNode) => c.type === 'identifier')
              .map((id: SyntaxNode) => getNodeText(id, this.source))
              .join('.');
      if (innerCallee && /^[TI][A-Z]/.test(innerCallee)) {
        calleeName = `${innerCallee}().${method}`;
        // The T/I-prefixed inner is itself a real call — record it too.
        if (receiver.type === 'exprCall') this.extractPascalCall(receiver);
        else this.extractPascalParenlessCall(receiver);
      } else {
        calleeName = method; // non-class receiver: a bare method ref (no field-access ref)
      }
    } else {
      // Simple: `Obj.Method` → the dotted name (resolves via the receiver / bare name).
      calleeName = node.namedChildren
        .filter((c: SyntaxNode) => c.type === 'identifier')
        .map((id: SyntaxNode) => getNodeText(id, this.source))
        .join('.');
    }

    if (calleeName) {
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: calleeName,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }

  /**
   * Recursively visit a Pascal block/statement tree for call expressions
   */
  private visitPascalBlock(node: SyntaxNode): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'exprCall') {
        this.extractPascalCall(child);
      } else if (child.type === 'exprDot') {
        // A STATEMENT-level bare exprDot is a paren-less call (`Obj.Free;`,
        // `TFoo.GetInstance.DoIt;`). Anywhere else (assignment side, condition,
        // expression) a bare exprDot is ambiguous with a field/property access,
        // so there we only descend for paren'd inner calls.
        if (node.type === 'statement') {
          this.extractPascalParenlessCall(child);
        } else {
          for (let j = 0; j < child.namedChildCount; j++) {
            const grandchild = child.namedChild(j);
            if (grandchild?.type === 'exprCall') {
              this.extractPascalCall(grandchild);
            }
          }
        }
      } else {
        this.visitPascalBlock(child);
      }
    }
  }
}


/**
 * Extract nodes and edges from source code.
 *
 * If `frameworkNames` is provided, framework-specific extractors matching
 * those names and the file's language are run after the tree-sitter pass.
 * Their nodes/references/errors are merged into the returned result.
 */
export function extractFromSource(
  filePath: string,
  source: string,
  language?: Language,
  frameworkNames?: string[]
): ExtractionResult {
  const detectedLanguage = language || detectLanguage(filePath, source);
  const fileExtension = path.extname(filePath).toLowerCase();

  let result: ExtractionResult;

  // Use custom extractor for Svelte
  if (detectedLanguage === 'svelte') {
    const extractor = new SvelteExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'vue') {
    // Use custom extractor for Vue
    const extractor = new VueExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'liquid') {
    // Use custom extractor for Liquid
    const extractor = new LiquidExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'razor') {
    // Use custom extractor for ASP.NET Razor (.cshtml) / Blazor (.razor) markup
    const extractor = new RazorExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'xml') {
    // Custom extractor for MyBatis mapper XML. Non-mapper XML returns just a
    // file node so the watcher tracks it without emitting symbols.
    const extractor = new MyBatisExtractor(filePath, source);
    result = extractor.extract();
  } else if (isFileLevelOnlyLanguage(detectedLanguage)) {
    // No symbol extraction at this stage — files are tracked at the file-record
    // level only. Framework extractors (Drupal routing yml, Spring `@Value`
    // resolution against application.yml/application.properties) run later and
    // add per-file nodes/references when they apply.
    result = { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
  } else if (
    detectedLanguage === 'pascal' &&
    (fileExtension === '.dfm' || fileExtension === '.fmx')
  ) {
    // Use custom extractor for DFM/FMX form files
    const extractor = new DfmExtractor(filePath, source);
    result = extractor.extract();
  } else {
    const extractor = new TreeSitterExtractor(filePath, source, detectedLanguage);
    result = extractor.extract();
  }

  // Framework-specific extraction (routes, middleware, etc.)
  if (frameworkNames && frameworkNames.length > 0) {
    const allResolvers = getAllFrameworkResolvers();
    const applicable = getApplicableFrameworks(
      allResolvers.filter((r) => frameworkNames.includes(r.name)),
      detectedLanguage
    );
    for (const fw of applicable) {
      if (!fw.extract) continue;
      try {
        const fwResult = fw.extract(filePath, source);
        result.nodes.push(...fwResult.nodes);
        result.unresolvedReferences.push(...fwResult.references);
      } catch (err) {
        result.errors.push({
          message: `Framework extractor '${fw.name}' failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          filePath,
          severity: 'warning',
        });
      }
    }
  }

  return result;
}
