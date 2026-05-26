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
import { getParser, detectLanguage, isLanguageSupported } from './grammars';
import { generateNodeId, getNodeText, getChildByField, getPrecedingDocstring } from './tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from './tree-sitter-types';
import { EXTRACTORS } from './languages';
import { LiquidExtractor } from './liquid-extractor';
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
 * Tree-sitter node kinds that represent constructor invocations
 * (`new Foo()` and friends). Used by extractInstantiation to emit
 * an `instantiates` reference targeting the class name.
 */
const INSTANTIATION_KINDS: ReadonlySet<string> = new Set([
  'new_expression',                  // typescript / javascript / tsx / jsx
  'object_creation_expression',      // java / c#
  'instance_creation_expression',    // some grammars
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
      this.visitNode(this.tree.rootNode);
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
    }
    // (Decorator handling lives inside the symbol-creating extractors
    // — extractClass / extractFunction / extractProperty — because the
    // decorator node sits BEFORE the symbol in the AST and the walker
    // would otherwise see the wrong nodeStack head.)
    // Rust: `impl Trait for Type { ... }` — creates implements edge from Type to Trait
    else if (nodeType === 'impl_item') {
      this.extractRustImplItem(node);
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
    if (name === '<anonymous>') return; // Skip anonymous functions

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

    const funcNode = this.createNode('function', name, node, {
      docstring,
      signature,
      visibility,
      isExported,
      isAsync,
      isStatic,
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
    const extraProps: Partial<Node> = {
      docstring,
      signature,
      visibility,
      isAsync,
      isStatic,
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
        if (fieldNode) this.extractDecoratorsFor(node, fieldNode.id);
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

            // Exported const object-of-functions: `export const actions =
            // { default: async () => {} }` (SvelteKit form actions / handler maps
            // / route tables). Extract each function-valued property as a function
            // named by its key + walk its body so its calls (e.g. api.post) are
            // captured. Scoped to EXPORTED consts to exclude the inline-object
            // noise (`ctx.set({...})`) the object-method skip deliberately avoids.
            if (isExported && valueNode &&
                (valueNode.type === 'object' || valueNode.type === 'object_expression')) {
              for (let j = 0; j < valueNode.namedChildCount; j++) {
                const pair = valueNode.namedChild(j);
                if (pair?.type !== 'pair') continue;
                const v = getChildByField(pair, 'value');
                const k = getChildByField(pair, 'key');
                if (k && v && (v.type === 'arrow_function' || v.type === 'function_expression')) {
                  this.extractFunction(v, getNodeText(k, this.source).replace(/^['"`]|['"`]$/g, ''));
                }
              }
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
        if (nameNode && nameNode.type === 'identifier') {
          const name = getNodeText(nameNode, this.source);
          const valueNode = spec.namedChildCount > 1 ? spec.namedChild(spec.namedChildCount - 1) : null;
          const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
          const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

          this.createNode(node.type === 'const_declaration' ? 'constant' : 'variable', name, spec, {
            docstring,
            signature: initSignature,
          });
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
      }
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
        return;
      }
      // Hook returned null — fall through to multi-import inline handlers only
      // (hook returning null means "I didn't handle this" for multi-import cases,
      // NOT "use generic fallback" — the hook already declined)
    }

    // Multi-import cases that create multiple nodes (can't be expressed with single-return hook)

    // Python import_statement: import os, sys (creates one import per module)
    if (this.language === 'python' && node.type === 'import_statement') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'dotted_name') {
          this.createNode('import', getNodeText(child, this.source), node, {
            signature: importText,
          });
        } else if (child?.type === 'aliased_import') {
          const dottedName = child.namedChildren.find(c => c.type === 'dotted_name');
          if (dottedName) {
            this.createNode('import', getNodeText(dottedName, this.source), node, {
              signature: importText,
            });
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
        const methodName: string =
          methodKeywords.length === 1
            ? (methodKeywords[0] as string)
            : methodKeywords.map((k) => `${k}:`).join('');
        const receiverField = getChildByField(node, 'receiver');
        const SKIP_RECEIVERS = new Set(['self', 'super']);
        if (receiverField && receiverField.type !== 'message_expression') {
          const receiverName = getNodeText(receiverField, this.source);
          if (receiverName && !SKIP_RECEIVERS.has(receiverName)) {
            calleeName = `${receiverName}.${methodName}`;
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
            } else {
              calleeName = methodName;
            }
          }
        } else if (func.type === 'scoped_identifier' || func.type === 'scoped_call_expression') {
          // Scoped call: Module::function()
          calleeName = getNodeText(func, this.source);
        } else {
          calleeName = getNodeText(func, this.source);
        }
      }
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
      // (`@Override`, `@Deprecated`); without including it, every
      // such Java annotation would be silently skipped.
      if (
        n.type !== 'decorator' &&
        n.type !== 'annotation' &&
        n.type !== 'marker_annotation'
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
          child.type === 'navigation_expression'
        ) {
          target = child;
          break;
        }
      }
      if (!target) return;
      let name = getNodeText(target, this.source);
      const lastDot = Math.max(name.lastIndexOf('.'), name.lastIndexOf('::'));
      if (lastDot >= 0) name = name.slice(lastDot + 1).replace(/^[:.]/, '');
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
      consider(declNode.namedChild(i));
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
  private visitFunctionBody(body: SyntaxNode, _functionId: string): void {
    if (!this.extractor) return;

    const visitForCallsAndStructure = (node: SyntaxNode): void => {
      const nodeType = node.type;

      if (this.extractor!.callTypes.includes(nodeType)) {
        this.extractCall(node);
      } else if (INSTANTIATION_KINDS.has(nodeType)) {
        // `new Foo()` inside a function body — emit an `instantiates`
        // reference. Without this branch the body walker only knew
        // about `call_expression`, so constructor invocations
        // produced no graph edges at all.
        this.extractInstantiation(node);
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
    'typescript', 'tsx', 'dart', 'kotlin', 'swift', 'rust', 'go', 'java', 'csharp',
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
  ]);

  /**
   * Extract type references from type annotations on a function/method/field node.
   * Creates 'references' edges for parameter types, return types, and field types.
   */
  private extractTypeAnnotations(node: SyntaxNode, nodeId: string): void {
    if (!this.extractor) return;
    if (!this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) return;

    // Extract parameter type annotations
    const params = getChildByField(node, this.extractor.paramsField || 'parameters');
    if (params) {
      this.extractTypeRefsFromSubtree(params, nodeId);
    }

    // Extract return type annotation
    const returnType = getChildByField(node, this.extractor.returnField || 'return_type');
    if (returnType) {
      this.extractTypeRefsFromSubtree(returnType, nodeId);
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
      // Qualified call: Obj.Method(...)
      const identifiers = firstChild.namedChildren.filter(
        (c: SyntaxNode) => c.type === 'identifier'
      );
      if (identifiers.length > 0) {
        calleeName = identifiers.map((id: SyntaxNode) => getNodeText(id, this.source)).join('.');
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
   * Recursively visit a Pascal block/statement tree for call expressions
   */
  private visitPascalBlock(node: SyntaxNode): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'exprCall') {
        this.extractPascalCall(child);
      } else if (child.type === 'exprDot') {
        // Check if exprDot contains an exprCall
        for (let j = 0; j < child.namedChildCount; j++) {
          const grandchild = child.namedChild(j);
          if (grandchild?.type === 'exprCall') {
            this.extractPascalCall(grandchild);
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
  } else if (detectedLanguage === 'xml') {
    // Custom extractor for MyBatis mapper XML. Non-mapper XML returns just a
    // file node so the watcher tracks it without emitting symbols.
    const extractor = new MyBatisExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'yaml' || detectedLanguage === 'twig' || detectedLanguage === 'properties') {
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
