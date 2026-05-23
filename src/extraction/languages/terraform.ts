/**
 * Terraform / HCL extractor.
 *
 * Terraform is a configuration language built from *blocks* — there are no
 * functions, classes, or imports in the traditional sense. Almost everything
 * is `block_type "label1" "label2" { attribute = expression ... }`. The
 * grammar (vendored from @tree-sitter-grammars/tree-sitter-hcl, ABI 14)
 * emits a uniform `block` node for every declaration, distinguished only by
 * its leading `identifier`.
 *
 * Because of this, we drive extraction entirely through the `visitNode` hook
 * rather than the usual node-type → kind dispatch tables. Mappings:
 *
 *   resource "T" "N"  → class      qualified: resource.T.N
 *   data     "T" "N"  → class      qualified: data.T.N
 *   module   "N"      → module     qualified: module.N
 *   variable "N"      → variable   qualified: var.N
 *   output   "N"      → export     qualified: output.N
 *   provider "N"      → namespace  qualified: provider.N
 *   terraform { ... } → namespace  qualified: terraform
 *   locals  { K=… }   → constant per K, qualified: local.K
 *
 * Inside each block body we walk attribute expressions to find references —
 * `var.X`, `local.X`, `module.X`, `data.T.N`, and bare `T.N.attr` chains —
 * and emit them as unresolved references for the resolver to wire up later.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

/** Strip surrounding quotes from a `string_lit` text — `"foo"` → `foo`. */
function stripQuotes(s: string): string {
  return s.replace(/^"+|"+$/g, '');
}

/** Read the string content of a `string_lit` node (the label form). */
function stringLitText(node: SyntaxNode, source: string): string {
  // Prefer the inner `template_literal` for cleaner text (no quotes).
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === 'template_literal') {
      return getNodeText(child, source);
    }
  }
  return stripQuotes(getNodeText(node, source));
}

/**
 * Read the block-type identifier and any string labels.
 * In tree-sitter-hcl a `block` is: identifier (string_lit | identifier)* body
 */
function readBlockHeader(node: SyntaxNode, source: string): { type: string; labels: string[] } {
  let type = '';
  const labels: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)!;
    if (child.type === 'identifier' && !type) {
      type = getNodeText(child, source);
    } else if (child.type === 'string_lit') {
      labels.push(stringLitText(child, source));
    } else if (child.type === 'identifier' && type) {
      // Some block forms use a bare identifier as a label.
      labels.push(getNodeText(child, source));
    } else if (child.type === 'body') {
      break;
    }
  }
  return { type, labels };
}

/** Find the `body` child of a block (where attributes/nested blocks live). */
function getBlockBody(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)!;
    if (child.type === 'body') return child;
  }
  return null;
}

/**
 * Walk an expression subtree and collect references. Terraform expression
 * shapes we care about:
 *
 *   variable_expr(identifier "var") + get_attr(identifier "region")
 *       → reference to var.region
 *   variable_expr(identifier "local") + get_attr "common_tags"
 *       → reference to local.common_tags
 *   variable_expr(identifier "module") + get_attr "vpc" [+ get_attr "out"]
 *       → reference to module.vpc
 *   variable_expr(identifier "data") + get_attr "aws_ami" + get_attr "ubuntu"
 *       → reference to data.aws_ami.ubuntu
 *   variable_expr(identifier "aws_instance") + get_attr "web" [+ ...]
 *       → reference to resource.aws_instance.web (best-effort; the resolver
 *         decides if the prefix matches a known resource type).
 */
function collectExpressionRefs(
  expr: SyntaxNode,
  source: string,
  fromNodeId: string,
  ctx: ExtractorContext,
): void {
  // Walk every variable_expr in the subtree; for each, capture the immediate
  // sibling get_attr chain that follows it within the same parent expression.
  const stack: SyntaxNode[] = [expr];
  const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'variable_expr') {
      const idChild = n.namedChild(0);
      if (!idChild || idChild.type !== 'identifier') continue;
      const head = getNodeText(idChild, source);

      // Collect following get_attr siblings within the same parent `expression`.
      // web-tree-sitter returns a fresh wrapper per namedChild() call, so we
      // can't compare nodes by reference — use the stable numeric `id`.
      const parent = n.parent;
      const attrs: string[] = [];
      if (parent) {
        let started = false;
        for (let i = 0; i < parent.namedChildCount; i++) {
          const sib = parent.namedChild(i)!;
          if (!started) {
            if (sib.id === n.id) started = true;
            continue;
          }
          if (sib.type === 'get_attr') {
            const aId = sib.namedChild(0);
            if (aId && aId.type === 'identifier') attrs.push(getNodeText(aId, source));
          } else if (sib.type === 'index') {
            // Skip — `foo[0]` doesn't add a name segment.
          } else {
            break;
          }
        }
      }

      let qname: string | null = null;
      if (head === 'var' && attrs[0]) qname = `var.${attrs[0]}`;
      else if (head === 'local' && attrs[0]) qname = `local.${attrs[0]}`;
      else if (head === 'module' && attrs[0]) qname = `module.${attrs[0]}`;
      else if (head === 'data' && attrs[0] && attrs[1]) qname = `data.${attrs[0]}.${attrs[1]}`;
      else if (head === 'each' || head === 'count' || head === 'self' || head === 'path' || head === 'terraform') {
        // built-in iterator / meta refs — skip
      } else if (/^[a-z][a-z0-9_]*_[a-z0-9_]+$/.test(head) && attrs[0]) {
        // Heuristic: `aws_instance.web` — provider-prefixed resource type.
        // Matches `<word>_<word>...` (e.g. `aws_instance`, `kubernetes_service`).
        qname = `resource.${head}.${attrs[0]}`;
      }

      if (qname && !seen.has(qname)) {
        seen.add(qname);
        ctx.addUnresolvedReference({
          fromNodeId,
          referenceName: qname,
          referenceKind: 'references',
          line: n.startPosition.row + 1,
          column: n.startPosition.column,
          filePath: ctx.filePath,
          language: 'terraform',
        });
      }
    }

    // Recurse — but don't descend back into the same variable_expr we just
    // consumed (cheap guard: only push non-variable_expr children, and the
    // attrs are siblings, not descendants).
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i)!;
      stack.push(child);
    }
  }
}

/**
 * Emit references for every attribute value inside a block body.
 * Also recurses into nested blocks' bodies so refs from e.g. a `filter` block
 * inside `data "aws_ami"` are still attributed to the data source.
 */
function visitBlockBodyForRefs(
  body: SyntaxNode,
  fromNodeId: string,
  source: string,
  ctx: ExtractorContext,
): void {
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i)!;
    if (child.type === 'attribute') {
      // `identifier = expression` — pull the expression value.
      for (let j = 0; j < child.namedChildCount; j++) {
        const c = child.namedChild(j)!;
        if (c.type === 'expression') {
          collectExpressionRefs(c, source, fromNodeId, ctx);
        }
      }
    } else if (child.type === 'block') {
      // Nested block (e.g. `filter { ... }` inside a data source). Its refs
      // belong to the same enclosing resource/data/etc.
      const nestedBody = getBlockBody(child);
      if (nestedBody) visitBlockBodyForRefs(nestedBody, fromNodeId, source, ctx);
    }
  }
}

/** Try to read the `source = "..."` attribute literal from a module body. */
function readModuleSource(body: SyntaxNode, source: string): string | null {
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i)!;
    if (child.type !== 'attribute') continue;
    const id = child.namedChild(0);
    if (!id || id.type !== 'identifier') continue;
    if (getNodeText(id, source) !== 'source') continue;
    // Walk to the inner template_literal.
    const expr = (() => {
      for (let j = 0; j < child.namedChildCount; j++) {
        const c = child.namedChild(j)!;
        if (c.type === 'expression') return c;
      }
      return null;
    })();
    if (!expr) return null;
    const stack: SyntaxNode[] = [expr];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.type === 'template_literal') return getNodeText(n, source);
      for (let k = 0; k < n.namedChildCount; k++) stack.push(n.namedChild(k)!);
    }
    return null;
  }
  return null;
}

export const terraformExtractor: LanguageExtractor = {
  // None of the standard categories fit HCL's `block`-everything model — we
  // do all extraction in visitNode. The arrays must still be present.
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  /**
   * Custom block-driven walker. Returns true for nodes we've fully consumed
   * (so the core extractor doesn't descend into them again).
   */
  visitNode(node: SyntaxNode, ctx: ExtractorContext): boolean {
    if (node.type !== 'block') return false;

    const { type, labels } = readBlockHeader(node, ctx.source);
    const body = getBlockBody(node);

    // `locals { ... }` — each attribute becomes its own `local.<name>` constant.
    if (type === 'locals') {
      if (body) {
        // Find the file node ID (root scope) so locals are contained at file level.
        for (let i = 0; i < body.namedChildCount; i++) {
          const child = body.namedChild(i)!;
          if (child.type !== 'attribute') continue;
          const idChild = child.namedChild(0);
          if (!idChild || idChild.type !== 'identifier') continue;
          const name = getNodeText(idChild, ctx.source);
          const created = ctx.createNode('constant', name, child, {
            qualifiedName: `local.${name}`,
            signature: `local.${name}`,
          });
          if (created) {
            // Refs inside this local's value expression belong to it.
            for (let j = 0; j < child.namedChildCount; j++) {
              const c = child.namedChild(j)!;
              if (c.type === 'expression') {
                collectExpressionRefs(c, ctx.source, created.id, ctx);
              }
            }
          }
        }
      }
      return true;
    }

    let kind: 'class' | 'module' | 'variable' | 'export' | 'namespace' | null = null;
    let name = '';
    let qualifiedName = '';

    switch (type) {
      case 'resource':
        if (labels.length >= 2 && labels[0] && labels[1]) {
          kind = 'class';
          name = labels[1];
          qualifiedName = `resource.${labels[0]}.${labels[1]}`;
        }
        break;
      case 'data':
        if (labels.length >= 2 && labels[0] && labels[1]) {
          kind = 'class';
          name = labels[1];
          qualifiedName = `data.${labels[0]}.${labels[1]}`;
        }
        break;
      case 'module':
        if (labels[0]) {
          kind = 'module';
          name = labels[0];
          qualifiedName = `module.${labels[0]}`;
        }
        break;
      case 'variable':
        if (labels[0]) {
          kind = 'variable';
          name = labels[0];
          qualifiedName = `var.${labels[0]}`;
        }
        break;
      case 'output':
        if (labels[0]) {
          kind = 'export';
          name = labels[0];
          qualifiedName = `output.${labels[0]}`;
        }
        break;
      case 'provider':
        if (labels[0]) {
          kind = 'namespace';
          name = labels[0];
          qualifiedName = `provider.${labels[0]}`;
        }
        break;
      case 'terraform':
        kind = 'namespace';
        name = 'terraform';
        qualifiedName = 'terraform';
        break;
      default:
        // Nested / unknown block — let the core walker descend so refs in
        // attributes still get visited (we don't fully consume it).
        return false;
    }

    if (!kind) return false;

    const created = ctx.createNode(kind, name, node, {
      qualifiedName,
      signature: type + (labels.length ? ' ' + labels.map(l => `"${l}"`).join(' ') : ''),
      isExported: kind === 'export' || kind === 'variable',
    });

    if (created && body) {
      ctx.pushScope(created.id);
      visitBlockBodyForRefs(body, created.id, ctx.source, ctx);

      // Module source → record as `imports` reference (string target).
      if (type === 'module') {
        const src = readModuleSource(body, ctx.source);
        if (src) {
          ctx.addUnresolvedReference({
            fromNodeId: created.id,
            referenceName: src,
            referenceKind: 'imports',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
            filePath: ctx.filePath,
            language: 'terraform',
          });
        }
      }
      ctx.popScope();
    }

    return true;
  },
};
