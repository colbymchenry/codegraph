import * as path from 'path';
import { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import {
  Edge,
  ExtractionError,
  ExtractionResult,
  Node,
  NodeKind,
  UnresolvedReference,
} from '../types';
import { getParser } from './grammars';
import { generateNodeId, getChildByField, getNodeText } from './tree-sitter-helpers';

type ScopeFrame =
  | { type: 'namespace'; nodeId: string; qualifiedName: string; opens: string[] }
  | { type: 'section'; nodeId: string | null; name: string; opens: string[] };

const DECLARATION_TYPES = new Set([
  'def',
  'theorem',
  'abbrev',
  'instance',
  'axiom',
  'opaque',
  'constant',
  'structure',
  'inductive',
]);

const DECL_NAME_NODE_TYPES = new Set([
  'def',
  'theorem',
  'abbrev',
  'instance',
  'axiom',
  'opaque',
  'constant',
  'structure',
  'inductive',
  'field',
  'ctor',
  'ctor_alt',
  'struct_field',
  'namespace',
  'import',
  'open',
  'export',
]);

const BINDER_NODE_TYPES = new Set([
  'binders',
  'explicit_binder',
  'implicit_binder',
  'strict_implicit_binder',
  'inst_implicit_binder',
  'tuple_binder',
  'anon_ctor_binder',
  'binder_predicate',
]);

/**
 * Lean 4 extractor backed by tree-sitter-lean.
 *
 * The Lean grammar deliberately represents `namespace` / `section` / `end`
 * as flat top-level commands. This extractor reconstructs namespace scope
 * while using the AST for declarations, fields, constructors, and references.
 */
export class LeanExtractor {
  private filePath: string;
  private source: string;
  private tree: Tree | null = null;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private scopeStack: ScopeFrame[] = [];
  private moduleOpenNamespaces: string[] = [];
  private importedModules: string[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    const parser = getParser('lean');
    if (!parser) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: 'Failed to get parser for language: lean',
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
      if (!this.tree) throw new Error('Parser returned null tree');

      const fileNode = this.createFileNode();
      this.visitModule(fileNode.id, this.tree.rootNode);
      this.closeOpenNamespaces(fileNode.endLine);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('memory access out of bounds') || msg.includes('out of memory')) {
        throw error;
      }
      this.errors.push({
        message: `Lean extraction error: ${msg}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    } finally {
      if (this.tree) {
        this.tree.delete();
        this.tree = null;
      }
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
    const fileNode: Node = {
      id: `file:${this.filePath}`,
      kind: 'file',
      name: path.basename(this.filePath),
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'lean',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      isExported: false,
      updatedAt: Date.now(),
    };
    this.nodes.push(fileNode);
    return fileNode;
  }

  private visitModule(fileNodeId: string, root: SyntaxNode): void {
    for (let i = 0; i < root.namedChildCount; i++) {
      const child = root.namedChild(i);
      if (!child) continue;

      if (child.type === 'import') {
        this.extractImport(fileNodeId, child);
      } else if (child.type === 'open') {
        this.extractOpen(fileNodeId, child);
      } else if (child.type === 'export') {
        this.extractExport(fileNodeId, child);
      } else if (child.type === 'namespace') {
        this.enterNamespace(fileNodeId, child);
      } else if (child.type === 'section') {
        this.enterSection(fileNodeId, child);
      } else if (child.type === 'end') {
        this.exitScope(child);
      } else if (child.type === 'declaration') {
        this.extractDeclaration(fileNodeId, child);
      }
    }
  }

  private extractImport(fileNodeId: string, node: SyntaxNode): void {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return;
    const moduleName = getNodeText(nameNode, this.source);
    this.importedModules.push(moduleName);
    const importNode = this.createNode(fileNodeId, 'import', moduleName, node, {
      qualifiedName: `${this.filePath}::import:${moduleName}`,
      signature: getNodeText(node, this.source).trim(),
      isExported: false,
    });
    if (!importNode) return;

    this.unresolvedReferences.push({
      fromNodeId: fileNodeId,
      referenceName: moduleName,
      referenceKind: 'imports',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
      filePath: this.filePath,
      language: 'lean',
    });
  }

  private extractOpen(fileNodeId: string, node: SyntaxNode): void {
    const openedNamespaces: string[] = [];
    const openedScopes: string[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child || child.type !== 'identifier') continue;
      const field = node.fieldNameForNamedChild(i);
      const text = getNodeText(child, this.source);
      if (field === 'namespace') {
        openedNamespaces.push(text);
      } else if (field === 'scoped') {
        openedScopes.push(text);
      }
    }

    if (openedNamespaces.length === 0 && openedScopes.length === 0) return;

    const name = [...openedNamespaces, ...openedScopes.map((scope) => `scoped ${scope}`)].join(', ');
    const parentId = this.currentContainerNodeId() ?? fileNodeId;
    const openNode = this.createNode(parentId, 'import', `open ${name}`, node, {
      qualifiedName: `${this.filePath}::open:${node.startPosition.row + 1}:${name}`,
      signature: getNodeText(node, this.source).trim(),
      isExported: false,
    });

    if (!openNode) return;
    for (const namespaceName of openedNamespaces) {
      this.unresolvedReferences.push({
        fromNodeId: openNode.id,
        referenceName: namespaceName,
        referenceKind: 'references',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        filePath: this.filePath,
        language: 'lean',
        candidates: this.candidatesFor(namespaceName),
      });
    }
    this.addOpenNamespaces(openedNamespaces);
  }

  private extractExport(fileNodeId: string, node: SyntaxNode): void {
    const namespaceNode = this.namedChildrenWithField(node, 'namespace')[0];
    if (!namespaceNode) return;

    const namespaceName = getNodeText(namespaceNode, this.source);
    const exportedNames = this.namedChildrenWithField(node, 'only')
      .map((child) => getNodeText(child, this.source));
    const name = exportedNames.length > 0
      ? `${namespaceName} (${exportedNames.join(', ')})`
      : namespaceName;
    const parentId = this.currentContainerNodeId() ?? fileNodeId;
    const exportNode = this.createNode(parentId, 'export', name, node, {
      qualifiedName: `${this.filePath}::export:${node.startPosition.row + 1}:${name}`,
      signature: getNodeText(node, this.source).trim(),
      isExported: true,
    });
    if (!exportNode) return;

    const targets = exportedNames.length > 0
      ? exportedNames.map((exportedName) => `${namespaceName}.${exportedName}`)
      : [namespaceName];
    for (const target of targets) {
      this.unresolvedReferences.push({
        fromNodeId: exportNode.id,
        referenceName: target,
        referenceKind: 'exports',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        filePath: this.filePath,
        language: 'lean',
        candidates: this.candidatesFor(target),
      });
    }
  }

  private enterNamespace(fileNodeId: string, node: SyntaxNode): void {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return;

    const rawName = getNodeText(nameNode, this.source);
    const parentNamespace = this.currentNamespaceQualifiedName();
    const qualifiedName = parentNamespace ? `${parentNamespace}.${rawName}` : rawName;
    const parentId = this.currentContainerNodeId() ?? fileNodeId;
    const namespaceNode = this.createNode(parentId, 'namespace', rawName, node, {
      qualifiedName,
      signature: getNodeText(node, this.source).trim(),
      isExported: true,
    });
    if (!namespaceNode) return;

    this.scopeStack.push({
      type: 'namespace',
      nodeId: namespaceNode.id,
      qualifiedName,
      opens: [],
    });
  }

  private enterSection(fileNodeId: string, node: SyntaxNode): void {
    const nameNode = getChildByField(node, 'name');
    const sectionName = nameNode
      ? getNodeText(nameNode, this.source)
      : `section@${node.startPosition.row + 1}`;
    const parentId = this.currentContainerNodeId() ?? fileNodeId;
    const sectionNode = this.createNode(parentId, 'module', sectionName, node, {
      qualifiedName: `${this.filePath}::section:${sectionName}:${node.startPosition.row + 1}`,
      signature: getNodeText(node, this.source).trim(),
      isExported: false,
    });
    this.scopeStack.push({
      type: 'section',
      nodeId: sectionNode?.id ?? null,
      name: sectionName,
      opens: [],
    });
  }

  private exitScope(node: SyntaxNode): void {
    const frame = this.scopeStack.pop();
    if (!frame) return;

    if (frame.nodeId) {
      const scopeNode = this.nodes.find((n) => n.id === frame.nodeId);
      if (scopeNode) {
        scopeNode.endLine = node.endPosition.row + 1;
        scopeNode.endColumn = node.endPosition.column;
      }
    }
  }

  private closeOpenNamespaces(endLine: number): void {
    for (const frame of this.scopeStack) {
      if (!frame.nodeId) continue;
      const node = this.nodes.find((n) => n.id === frame.nodeId);
      if (node) node.endLine = Math.max(node.endLine, endLine);
    }
    this.scopeStack = [];
  }

  private extractDeclaration(fileNodeId: string, declaration: SyntaxNode): void {
    const decl = this.findDeclarationPayload(declaration);
    if (!decl) return;

    const kind = this.declarationKind(decl);
    if (!kind) return;

    const nameNode = getChildByField(decl, 'name');
    const rawName = nameNode
      ? getNodeText(nameNode, this.source)
      : decl.type === 'instance'
        ? this.anonymousInstanceName(decl)
        : null;
    if (!rawName) return;

    const simpleName = this.simpleName(rawName);
    const parentNamespace = this.currentNamespaceQualifiedName();
    const qualifiedName = parentNamespace ? `${parentNamespace}.${rawName}` : rawName;
    const parentId = this.currentContainerNodeId() ?? fileNodeId;
    const visibility = this.visibilityForDeclaration(declaration);

    const declNode = this.createNode(parentId, kind, simpleName, decl, {
      qualifiedName,
      signature: getNodeText(decl, this.source).trim().slice(0, 300),
      docstring: this.getLeanDocstring(declaration),
      visibility,
      isExported: visibility !== 'private',
      decorators: this.extractAttributes(declaration),
    });
    if (!declNode) return;

    this.extractInheritanceReferences(decl, declNode.id);

    if (decl.type === 'structure') {
      this.extractStructureMembers(declNode, decl);
    } else if (decl.type === 'inductive') {
      this.extractInductiveConstructors(declNode, decl);
    }

    this.extractReferencesFromDeclaration(decl, declNode.id, rawName);
  }

  private findDeclarationPayload(declaration: SyntaxNode): SyntaxNode | null {
    for (let i = 0; i < declaration.namedChildCount; i++) {
      const child = declaration.namedChild(i);
      if (child && DECLARATION_TYPES.has(child.type)) return child;
    }
    return null;
  }

  private declarationKind(node: SyntaxNode): NodeKind | null {
    switch (node.type) {
      case 'def':
      case 'theorem':
      case 'opaque':
        return 'function';
      case 'abbrev':
        return 'type_alias';
      case 'axiom':
      case 'constant':
      case 'instance':
        return 'constant';
      case 'structure':
        return this.leadingKeyword(node) === 'class' ? 'class' : 'struct';
      case 'inductive':
        return 'enum';
      default:
        return null;
    }
  }

  private extractStructureMembers(parent: Node, node: SyntaxNode): void {
    this.walkDescendants(node, (child) => {
      if (child.type === 'ctor') {
        this.createMember(parent, 'enum_member', child);
        return false;
      }
      if (child.type === 'field') {
        this.createMember(parent, 'field', child);
        return false;
      }
      return true;
    });
  }

  private extractInductiveConstructors(parent: Node, node: SyntaxNode): void {
    this.walkDescendants(node, (child) => {
      if (child.type !== 'ctor_alt') return true;
      this.createMember(parent, 'enum_member', child);
      return false;
    });
  }

  private createMember(parent: Node, kind: NodeKind, node: SyntaxNode): Node | null {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return null;
    const rawName = getNodeText(nameNode, this.source);
    const simpleName = this.simpleName(rawName);
    return this.createNode(parent.id, kind, simpleName, node, {
      qualifiedName: `${parent.qualifiedName}.${rawName}`,
      signature: getNodeText(node, this.source).trim().slice(0, 300),
      docstring: this.getLeanDocstring(node),
      visibility: this.visibilityForDeclaration(node),
      isExported: this.visibilityForDeclaration(node) !== 'private',
    });
  }

  private extractReferencesFromDeclaration(declaration: SyntaxNode, fromNodeId: string, declarationName: string): void {
    const locals = new Set<string>([declarationName, this.simpleName(declarationName)]);
    this.collectLocalNames(declaration, locals);
    this.collectDeclaredNames(declaration, locals);

    const emitted = new Set<string>();

    this.walkDescendants(declaration, (node) => {
      if (node.type !== 'app') return true;
      if (this.isInsideNodeType(node, 'attributes') || this.isInInheritancePosition(node)) return true;
      const fn = getChildByField(node, 'fn');
      if (!fn) return true;
      const referenceName = this.identifierLikeText(fn);
      if (!referenceName || locals.has(referenceName) || locals.has(this.simpleName(referenceName))) {
        return true;
      }
      this.addReference(fromNodeId, referenceName, 'calls', fn, emitted);
      return true;
    });

    this.walkDescendants(declaration, (node) => {
      if (node.type !== 'identifier') return true;
      const name = getNodeText(node, this.source);
      if (!name || name === '_' || locals.has(name) || locals.has(this.simpleName(name))) {
        return true;
      }
      if (
        this.isIdentifierNamePosition(node) ||
        this.isBinderName(node) ||
        this.isAppFunction(node) ||
        this.isInsideNodeType(node, 'attributes') ||
        this.isInInheritancePosition(node)
      ) {
        return true;
      }
      this.addReference(fromNodeId, name, 'references', node, emitted);
      return true;
    });
  }

  private addReference(
    fromNodeId: string,
    referenceName: string,
    referenceKind: 'calls' | 'references',
    node: SyntaxNode,
    emitted: Set<string>
  ): void {
    const key = `${referenceKind}:${referenceName}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName,
      referenceKind,
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
      filePath: this.filePath,
      language: 'lean',
      candidates: this.candidatesFor(referenceName),
    });
  }

  private extractInheritanceReferences(decl: SyntaxNode, fromNodeId: string): void {
    if (decl.type !== 'structure') return;

    const emitted = new Set<string>();
    for (let i = 0; i < decl.namedChildCount; i++) {
      const child = decl.namedChild(i);
      if (!child) continue;
      if (!this.isInheritanceChild(child, decl)) continue;

      const referenceName = this.identifierLikeText(child);
      if (!referenceName || emitted.has(referenceName)) continue;
      emitted.add(referenceName);
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName,
        referenceKind: 'extends',
        line: child.startPosition.row + 1,
        column: child.startPosition.column,
        filePath: this.filePath,
        language: 'lean',
        candidates: this.candidatesFor(referenceName),
      });
    }
  }

  private collectLocalNames(node: SyntaxNode, out: Set<string>): void {
    this.walkDescendants(node, (child) => {
      if (!BINDER_NODE_TYPES.has(child.type)) return true;

      for (let i = 0; i < child.namedChildCount; i++) {
        const named = child.namedChild(i);
        if (!named) continue;
        const field = child.fieldNameForNamedChild(i);
        if (field === 'name' || (child.type === 'binders' && named.type === 'identifier')) {
          const text = getNodeText(named, this.source);
          out.add(text);
          out.add(this.simpleName(text));
        }
      }

      return true;
    });
  }

  private collectDeclaredNames(node: SyntaxNode, out: Set<string>): void {
    this.walkDescendants(node, (child) => {
      if (!DECL_NAME_NODE_TYPES.has(child.type)) return true;
      const nameNode = getChildByField(child, 'name');
      if (nameNode) {
        const text = getNodeText(nameNode, this.source);
        out.add(text);
        out.add(this.simpleName(text));
      }
      return true;
    });
  }

  private createNode(
    parentId: string,
    kind: NodeKind,
    name: string,
    syntaxNode: SyntaxNode,
    extra: Partial<Node> = {}
  ): Node | null {
    if (!name) return null;
    const qualifiedName = extra.qualifiedName ?? name;
    const node: Node = {
      id: generateNodeId(this.filePath, kind, qualifiedName, syntaxNode.startPosition.row + 1),
      kind,
      name,
      qualifiedName,
      filePath: this.filePath,
      language: 'lean',
      startLine: syntaxNode.startPosition.row + 1,
      endLine: syntaxNode.endPosition.row + 1,
      startColumn: syntaxNode.startPosition.column,
      endColumn: syntaxNode.endPosition.column,
      updatedAt: Date.now(),
      ...extra,
    };

    this.nodes.push(node);
    this.edges.push({
      source: parentId,
      target: node.id,
      kind: 'contains',
    });
    return node;
  }

  private currentNamespaceQualifiedName(): string | null {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const frame = this.scopeStack[i]!;
      if (frame.type === 'namespace') return frame.qualifiedName;
    }
    return null;
  }

  private currentContainerNodeId(): string | null {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const frame = this.scopeStack[i]!;
      if (frame.nodeId) return frame.nodeId;
    }
    return null;
  }

  private visibilityForDeclaration(node: SyntaxNode): 'public' | 'private' | 'protected' | undefined {
    const text = getNodeText(node, this.source);
    if (/\b(?:private|local)\b/.test(text)) return 'private';
    if (/\bprotected\b/.test(text)) return 'protected';
    return 'public';
  }

  private leadingKeyword(node: SyntaxNode): string {
    return getNodeText(node, this.source).trimStart().split(/\s+/, 1)[0] ?? node.type;
  }

  private simpleName(name: string): string {
    const parts = name.split('.').filter(Boolean);
    return parts[parts.length - 1] ?? name;
  }

  private anonymousInstanceName(node: SyntaxNode): string {
    const typeNode = this.namedChildrenWithField(node, 'type')[0] ?? getChildByField(node, 'type');
    const typeParts = typeNode
      ? getNodeText(typeNode, this.source)
          .split(/[^A-Za-z0-9_]+/)
          .filter(Boolean)
      : [];
    return `inst${typeParts.join('') || 'anonymous'}@${node.startPosition.row + 1}`;
  }

  private identifierLikeText(node: SyntaxNode): string | null {
    if (node.type === 'identifier') return getNodeText(node, this.source);
    if (node.type === 'app') {
      const fn = getChildByField(node, 'fn');
      return fn ? this.identifierLikeText(fn) : null;
    }
    const name = getChildByField(node, 'name') ?? getChildByField(node, 'field');
    return name && name.type === 'identifier' ? getNodeText(name, this.source) : null;
  }

  private extractAttributes(node: SyntaxNode): string[] | undefined {
    const attributes = node.namedChildren.find((child) => child.type === 'attributes');
    if (!attributes) return undefined;

    const names: string[] = [];
    for (let i = 0; i < attributes.namedChildCount; i++) {
      const child = attributes.namedChild(i);
      if (!child || child.type !== 'identifier') continue;
      if (attributes.fieldNameForNamedChild(i) !== 'name') continue;
      names.push(getNodeText(child, this.source));
    }
    return names.length > 0 ? names : undefined;
  }

  private isIdentifierNamePosition(node: SyntaxNode): boolean {
    const parent = node.parent;
    if (!parent || !DECL_NAME_NODE_TYPES.has(parent.type)) return false;
    return this.fieldNameInParent(node) === 'name';
  }

  private isBinderName(node: SyntaxNode): boolean {
    const parent = node.parent;
    if (!parent) return false;
    return BINDER_NODE_TYPES.has(parent.type) && (
      this.fieldNameInParent(node) === 'name' ||
      (parent.type === 'binders' && this.fieldNameInParent(node) === null)
    );
  }

  private isAppFunction(node: SyntaxNode): boolean {
    return node.parent?.type === 'app' && this.fieldNameInParent(node) === 'fn';
  }

  private isInsideNodeType(node: SyntaxNode, type: string): boolean {
    let current: SyntaxNode | null = node.parent;
    while (current) {
      if (current.type === type) return true;
      current = current.parent;
    }
    return false;
  }

  private isInInheritancePosition(node: SyntaxNode): boolean {
    let current: SyntaxNode | null = node;
    while (current?.parent) {
      const parent: SyntaxNode = current.parent;
      if (parent.type === 'structure') {
        return this.isInheritanceChild(current, parent);
      }
      current = parent;
    }
    return false;
  }

  private isInheritanceChild(child: SyntaxNode, parent: SyntaxNode): boolean {
    if (parent.type !== 'structure') return false;
    if (child.type !== 'identifier' && child.type !== 'app') return false;
    if (this.fieldNameInParent(child) === 'name') return false;

    for (let i = 0; i < parent.namedChildCount; i++) {
      const candidate = parent.namedChild(i);
      if (!candidate) continue;
      if (candidate.id === child.id) return true;
      if (
        candidate.type === 'field' ||
        candidate.type === 'struct_field' ||
        candidate.type === 'where_struct'
      ) {
        return false;
      }
    }
    return false;
  }

  private fieldNameInParent(node: SyntaxNode): string | null {
    const parent = node.parent;
    if (!parent) return null;
    for (let i = 0; i < parent.namedChildCount; i++) {
      if (parent.namedChild(i)?.id === node.id) {
        return parent.fieldNameForNamedChild(i);
      }
    }
    return null;
  }

  private namedChildrenWithField(node: SyntaxNode, fieldName: string): SyntaxNode[] {
    const children: SyntaxNode[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && node.fieldNameForNamedChild(i) === fieldName) {
        children.push(child);
      }
    }
    return children;
  }

  private addOpenNamespaces(namespaces: string[]): void {
    if (namespaces.length === 0) return;
    const frame = this.scopeStack[this.scopeStack.length - 1];
    const target = frame ? frame.opens : this.moduleOpenNamespaces;
    for (const namespaceName of namespaces) {
      if (!target.includes(namespaceName)) target.push(namespaceName);
    }
  }

  private currentOpenNamespaces(): string[] {
    const namespaces: string[] = [...this.moduleOpenNamespaces];
    for (const frame of this.scopeStack) {
      namespaces.push(...frame.opens);
    }
    return namespaces;
  }

  private currentNamespacePrefixes(): string[] {
    const qualifiedName = this.currentNamespaceQualifiedName();
    if (!qualifiedName) return [];
    const parts = qualifiedName.split('.').filter(Boolean);
    const prefixes: string[] = [];
    for (let i = parts.length; i >= 1; i--) {
      prefixes.push(parts.slice(0, i).join('.'));
    }
    return prefixes;
  }

  private candidatesFor(referenceName: string): string[] | undefined {
    const cleanName = referenceName.replace(/^_root_\./, '');
    if (!cleanName || cleanName === '_') return undefined;

    const candidates: string[] = [];
    const add = (candidate: string) => {
      if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
    };

    if (cleanName.includes('.')) {
      add(cleanName);
      for (const namespaceName of this.currentNamespacePrefixes()) {
        add(`${namespaceName}.${cleanName}`);
      }
      for (const namespaceName of this.currentOpenNamespaces()) {
        add(`${namespaceName}.${cleanName}`);
      }
      return candidates.length > 0 ? candidates : undefined;
    }

    for (const namespaceName of this.currentNamespacePrefixes()) {
      add(`${namespaceName}.${cleanName}`);
    }
    for (const namespaceName of this.currentOpenNamespaces()) {
      add(`${namespaceName}.${cleanName}`);
    }
    for (const moduleName of this.importedModules) {
      const parts = moduleName.split('.').filter(Boolean);
      for (let i = parts.length; i >= 1; i--) {
        add(`${parts.slice(0, i).join('.')}.${cleanName}`);
      }
    }
    add(cleanName);

    return candidates.length > 0 ? candidates : undefined;
  }

  private getLeanDocstring(node: SyntaxNode): string | undefined {
    const comments: string[] = [];
    let sibling = node.previousNamedSibling;
    while (sibling && (sibling.type === 'doc_comment' || sibling.type === 'module_doc_comment')) {
      comments.unshift(getNodeText(sibling, this.source));
      sibling = sibling.previousNamedSibling;
    }
    if (comments.length === 0) return undefined;
    const cleaned = comments
      .map((comment) => comment
        .replace(/^\/-!/, '')
        .replace(/^\/--?/, '')
        .replace(/-\/$/, '')
        .replace(/^--!? ?/gm, '')
        .replace(/^\s*\* ?/gm, '')
        .trim())
      .filter(Boolean)
      .join('\n')
      .trim();
    return cleaned || undefined;
  }

  private walkDescendants(node: SyntaxNode, visit: (node: SyntaxNode) => boolean): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      const shouldDescend = visit(child);
      if (shouldDescend) this.walkDescendants(child, visit);
    }
  }
}
