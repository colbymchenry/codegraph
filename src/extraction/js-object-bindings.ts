import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from './tree-sitter-helpers';

const FUNCTIONS = new Set(['function_declaration', 'generator_function_declaration', 'function_expression', 'generator_function', 'arrow_function', 'method_definition']);
const SCOPES = new Set(['program', 'statement_block', 'catch_clause', 'for_statement', 'for_in_statement']);
const GLOBALS = new Set(['window', 'globalThis', 'self']);

export interface JsObjectInfo {
  path: string;
  binding: string;
  /** AST lexical provenance: 1-based lines and 0-based UTF-16 columns. */
  scope: [number, number, number, number];
  ownerId?: string;
}

/** Only static dotted member paths; dynamic subscripts and call-result receivers stay opaque. */
export function jsMemberPath(node: SyntaxNode | null, source: string): string | null {
  if (!node) return null;
  if (node.type === 'identifier') return getNodeText(node, source);
  if (node.type !== 'member_expression') return null;
  const object = jsMemberPath(getChildByField(node, 'object'), source);
  const property = getChildByField(node, 'property');
  return object && property?.type === 'property_identifier' ? `${object}.${getNodeText(property, source)}` : null;
}

/** Per-extraction AST binding oracle, including anonymous IIFEs and same-line scopes. */
export class JsObjectBindings {
  private readonly scopes = new Map<string, Map<string, string>>();
  private writes: Map<string, Set<string>> | null = null;
  constructor(private readonly source: string) {}

  private point(node: SyntaxNode): string {
    return `binding:${node.startPosition.row + 1}:${node.startPosition.column}`;
  }

  private names(pattern: SyntaxNode | null): string[] {
    if (!pattern) return [];
    if (pattern.type === 'identifier' || pattern.type === 'shorthand_property_identifier_pattern') return [getNodeText(pattern, this.source)];
    if (pattern.type === 'pair_pattern') return this.names(getChildByField(pattern, 'value'));
    if (pattern.type === 'assignment_pattern' || pattern.type === 'object_assignment_pattern') return this.names(getChildByField(pattern, 'left'));
    if (pattern.type === 'required_parameter' || pattern.type === 'optional_parameter') return this.names(getChildByField(pattern, 'pattern') ?? getChildByField(pattern, 'name'));
    if (['formal_parameters', 'object_pattern', 'array_pattern', 'rest_pattern'].includes(pattern.type)) return pattern.namedChildren.flatMap(child => this.names(child));
    return [];
  }

  private bindings(scope: SyntaxNode): Map<string, string> {
    const key = `${scope.type}:${scope.startIndex}:${scope.endIndex}`;
    const cached = this.scopes.get(key);
    if (cached) return cached;
    const result = new Map<string, string>();
    const add = (name: string, proof: string) => {
      const old = result.get(name);
      result.set(name, old !== undefined && old !== proof ? 'unknown' : proof);
    };
    const visit = (node: SyntaxNode, direct: boolean): void => {
      if (node.type === 'export_statement') { for (const child of node.namedChildren) visit(child, direct); return; }
      if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
        if (direct || node.type === 'variable_declaration') for (const child of node.namedChildren) {
          if (child.type !== 'variable_declarator') continue;
          for (const name of this.names(getChildByField(child, 'name'))) add(name, this.point(child));
        }
        return;
      }
      if (FUNCTIONS.has(node.type) || node.type === 'class_declaration') {
        const name = getChildByField(node, 'name');
        if (direct && name) add(getNodeText(name, this.source), this.point(node));
        return; // another function's declarations never enter this scope.
      }
      if (node.type === 'import_statement') {
        const collect = (item: SyntaxNode): void => {
          if (item.type === 'import_specifier') {
            const name = getChildByField(item, 'alias') ?? getChildByField(item, 'name');
            if (name) add(getNodeText(name, this.source), 'import');
          } else if (item.type === 'namespace_import') {
            const name = item.namedChildren.at(-1);
            if (name) add(getNodeText(name, this.source), 'import');
          } else if (item.type === 'import_clause') {
            for (const child of item.namedChildren) {
              if (child.type === 'identifier') add(getNodeText(child, this.source), 'import');
              else collect(child);
            }
          } else for (const child of item.namedChildren) collect(child);
        };
        collect(node);
        return;
      }
      for (const child of node.namedChildren) visit(child, false); // function-scoped var hoists through blocks.
    };
    if (scope.type === 'catch_clause') {
      for (const name of this.names(getChildByField(scope, 'parameter'))) add(name, `parameter:${scope.startPosition.row + 1}:${scope.startPosition.column}`);
    } else if (FUNCTIONS.has(scope.type)) {
      for (const name of this.names(getChildByField(scope, 'parameters') ?? getChildByField(scope, 'parameter'))) add(name, `parameter:${scope.startPosition.row + 1}:${scope.startPosition.column}`);
      const name = scope.type === 'method_definition' ? null : getChildByField(scope, 'name');
      if (name && !result.has(getNodeText(name, this.source))) add(getNodeText(name, this.source), this.point(scope));
    } else for (const child of scope.namedChildren) visit(child, true);
    this.scopes.set(key, result);
    return result;
  }

  root(node: SyntaxNode, name: string): string {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!SCOPES.has(parent.type) && !FUNCTIONS.has(parent.type)) continue;
      const proof = this.bindings(parent).get(name);
      if (proof !== undefined) return proof;
    }
    return GLOBALS.has(name) ? `global:${name}` : 'unknown';
  }

  /** Proven explicit writes invalidate literal targets; this does not infer aliases or execution order. */
  isWritten(node: SyntaxNode, path: string): boolean {
    if (this.writes === null) {
      this.writes = new Map();
      const writes = this.writes;
      let program = node;
      while (program.parent) program = program.parent;
      const visit = (item: SyntaxNode): void => {
        const assignment = item.type === 'assignment_expression' || item.type === 'augmented_assignment_expression';
        const deletion = item.type === 'unary_expression' && /^delete\b/.test(getNodeText(item, this.source));
        const left = assignment ? getChildByField(item, 'left') : item.type === 'update_expression' || deletion ? getChildByField(item, 'argument') : null;
        if (left) {
          const written = jsMemberPath(left, this.source);
          const literalNamespace = item.type === 'assignment_expression' && written?.includes('.') && ['object', 'object_expression'].includes(getChildByField(item, 'right')?.type ?? '');
          if (!literalNamespace) {
            let root = left;
            while (root.type === 'member_expression' || root.type === 'subscript_expression') {
              const inner = getChildByField(root, 'object');
              if (!inner) break;
              root = inner;
            }
            if (root.type === 'identifier') {
              const name = getNodeText(root, this.source);
              const proof = this.root(item, name);
              if (proof !== 'unknown' && proof !== 'import') {
                const paths = writes.get(proof) ?? new Set<string>();
                paths.add(written === null ? '*' : written.slice(name.length));
                writes.set(proof, paths);
              }
            }
          }
        }
        for (const child of item.namedChildren) visit(child);
      };
      visit(program);
    }
    const name = path.split('.')[0]!;
    const suffix = path.slice(name.length);
    return [...(this.writes.get(this.root(node, name)) ?? [])].some(write => write === '*' || write === '' || suffix === write || suffix.startsWith(`${write}.`));
  }

  info(node: SyntaxNode, path: string, directBinding: boolean): JsObjectInfo {
    let scope = node.parent;
    const hoisted = directBinding && scope?.type === 'variable_declaration';
    while (scope?.parent && (hoisted ? !FUNCTIONS.has(scope.type) && scope.type !== 'program' : !SCOPES.has(scope.type))) scope = scope.parent;
    const range = hoisted && scope && FUNCTIONS.has(scope.type) ? getChildByField(scope, 'body') ?? scope : scope ?? node;
    return { path, binding: directBinding ? this.point(node) : this.root(node, path.split('.')[0]!),
      scope: [range.startPosition.row + 1, range.startPosition.column, range.endPosition.row + 1, range.endPosition.column] };
  }
}
