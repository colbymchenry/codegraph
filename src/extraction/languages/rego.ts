import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

/**
 * Rego (Open Policy Agent) extraction.
 *
 * The grammar (tree-sitter-rego) produces:
 *   module            = package { import } policy
 *   package           = "package" ref
 *   import            = "import" ref [ "as" var ]
 *   rule              = [ "default" ] rule-head { rule-body }
 *   rule_head         = var [ "contains" term | "[" term "]" | "(" rule-args ")" | "if" ]
 *   expr_call         = fn_name "(" [ func_arguments ] ")"
 *   ref               = (var | array | object | set | comprehension | expr_call) { ref_arg }
 *   ref_arg_dot       = "." var
 *
 * Every node-type array below is empty on purpose: the grammar's nodes carry no
 * `name`/`body`/`parameters` fields the generic dispatch could read, so all
 * symbols are emitted from `visitNode` (the nix.ts pattern).
 *
 * What becomes graph structure:
 *   - a rule head name   → a `function` node (bodies are the DEFUSE graph's leaf)
 *   - `expr_call`        → an unresolved `calls` ref — resolves to another rule
 *                          head, a `data.pkg.rule` reference, or a builtin name
 *   - `ref`              → an unresolved `references` ref for `data.` / `input.`
 *                          paths — the policy blast radius
 *   - `package`/`import` → import nodes + `imports` refs, so the module identity
 *                          is visible in the graph and `codegraph files` groups
 */

/** `package a.b.c` / `import data.lib.foo as bar` → the dotted path as written. */
function dottedRefText(node: SyntaxNode | null, source: string): string {
  if (!node) return '';
  const text = getNodeText(node, source).trim();
  // `ref` covers `var`, `a.b`, `a.b[k]`, `a[x]("...")` — keep only the leading
  // dotted identifier path, which is what a rule name is addressable by.
  const match = /^[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*/.exec(text);
  return match ? match[0] : text;
}

/** The `{ head part }` of a rule head, after the rule's `var` name. */
function ruleHeadKind(node: SyntaxNode): 'value' | 'set' | 'object' | 'function' {
  for (const child of node.namedChildren) {
    switch (child.type) {
      case 'contains':
        return 'set';
      case 'open_bracket':
        return 'object';
      case 'open_paren':
        return 'function';
      case 'if':
        return 'value';
      default:
        break;
    }
  }
  return 'value';
}

/** `rule_head` → the head's own name (`var`) plus, for v1, `x := 1 if`. */
function ruleHeadName(node: SyntaxNode, source: string): string | null {
  const first = node.namedChild(0);
  if (!first) return null;
  const text = getNodeText(first, source).trim();
  return /^[A-Za-z_]\w*$/.test(text) ? text : null;
}

/** `fn_name` = `var` [ "." var ] — local rule calls read `foo.bar(x)`. */
function callTargetName(node: SyntaxNode, source: string): string | null {
  const fn = node.childForFieldName('func_name') ?? node.namedChild(0);
  if (!fn) return null;
  const text = getNodeText(fn, source).trim();
  return text.length > 0 ? text : null;
}

function isPolicyKeyword(name: string): boolean {
  switch (name) {
    // Rego builtins and rule-body keywords — never graph nodes.
    case 'if':
    case 'every':
    case 'contains':
    case 'some':
    case 'with':
    case 'as':
    case 'in':
    case 'default':
    case 'package':
    case 'import':
    case 'else':
    case 'not':
    case 'true':
    case 'false':
    case 'null':
    case 'input':
    case 'data':
      return true;
    default:
      return false;
  }
}

function addRef(
  ctx: ExtractorContext,
  anchor: SyntaxNode,
  name: string,
  kind: 'calls' | 'references' | 'imports',
): void {
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fromNodeId) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: name,
    referenceKind: kind,
    line: anchor.startPosition.row + 1,
    column: anchor.startPosition.column,
  });
}

export const regoExtractor: LanguageExtractor = {
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
  nameField: '',
  bodyField: '',
  paramsField: '',

  visitNode: (node, ctx) => {
    const { source } = ctx;

    // ---- module ------------------------------------------------------------
    // `module = package {import} policy`. The grammar keeps `package` and
    // `import` as anonymous keyword tokens, so the module's named children are
    // the path refs themselves: the first `ref` is the package, every `ref`
    // before the `policy` node is an import (with an optional trailing `var`
    // alias, only when a `ref` immediately precedes it).
    if (node.type === 'module') {
      const named = node.namedChildren;
      const policyIndex = named.findIndex((child) => child.type === 'policy');

      for (let i = 0; i < named.length; i += 1) {
        const child = named[i];
        if (!child || child.type !== 'ref') continue;
        const isPackage = policyIndex === -1 ? i === 0 : i < policyIndex;

        const next = named[i + 1];
        const alias = !isPackage && next && next.type === 'var'
          ? getNodeText(next, source).trim()
          : '';
        const path = dottedRefText(child, source);
        if (!path) continue;

        const name = isPackage ? path : alias ? `${path} as ${alias}` : path;
        ctx.createNode('import', name, child, {
          signature: getNodeText(child, source).trim().slice(0, 120),
        });
        addRef(ctx, child, path, isPackage ? 'references' : 'imports');
        // Skip the alias var so it isn't mistaken for an import path.
        if (alias) i += 1;
      }

      // Return false: the walker descends into `policy` itself, and each `rule`
      // branch below handles its own scope. Returning true here would require
      // re-walking the policy subtree, which double-visits every rule.
      return false;
    }

    // ---- rule --------------------------------------------------------------
    // One node per rule head. `default` heads are the module's fallback and are
    // still rules, so they get a node under their own name.
    if (node.type === 'rule') {
      const head = node.namedChildren.find((child) => child.type === 'rule_head');
      if (!head) {
        // A `default` rule with no parsable head still describes a rule; skip
        // rather than invent a name.
        return true;
      }
      const name = ruleHeadName(head, source);
      if (!name) return true;

      // `default authorized := false` and `authorized := true if {...}` are the
      // same rule name with different semantics — the fallback and the real
      // body — so they must not collide on one node id. Keep the default's own
      // name distinct: a reader asking what can change a policy needs to see the
      // fallback separately from the rule that overrides it.
      const isDefault = node.namedChildren.some(
        (child) => child.type === 'default',
      );
      const nodeName = isDefault ? `${name} (default)` : name;

      const signature = getNodeText(head, source).trim();
      const shape = ruleHeadKind(head);
      // A rule head's shape (value / set / object / function) tells a reader
      // whether the rule takes arguments and what it yields — it is what
      // distinguishes `deny contains msg` from `approve(user)`. Fold it in ahead
      // of the head's text so `explore` shows it beside the rule's name.
      const headText = signature.length > 200 ? `${signature.slice(0, 200)}...` : signature;
      const ruleNode = ctx.createNode(
        'function',
        nodeName,
        node,
        {
          signature: shape === 'value' ? headText : `${shape}: ${headText}`,
          isExported: true,
        },
      );
      // Rule bodies: walk them under the rule's scope so a call inside the body
      // is attributed to the rule, and mark them walked so the caller's
      // function-as-value scan doesn't walk them again at the file scope (which
      // would attribute those refs to the file instead of the rule).
      const bodyStart = node.namedChildren.indexOf(head) + 1;
      const bodies = node.namedChildren.slice(bodyStart);

      for (const body of bodies) {
        if (ruleNode) ctx.pushScope(ruleNode.id);
        ctx.visitNode(body);
        if (ruleNode) ctx.popScope();
      }

      return true;
    }

    // ---- call and reference ----------------------------------------------
    // The grammar wraps a call in a `ref` (`ref = (var | … | expr_call) {ref_arg}`),
    // so `helper(x)` and `data.lib.helper(x)` both arrive as a `ref` whose child
    // is an `expr_call`. A `ref` without one is a plain path: `input.metadata.x`,
    // `data.pkg.rule[k]`. Both matter — the call is the rule→rule dependency
    // edge, the path is what the policy reads.
    if (node.type === 'expr_call' || node.type === 'ref') {
      // A call-shaped ref: emit the callee, then let the walker descend so the
      // call's own arguments (and any nested calls) are visited too.
      const callChild = node.namedChildren.find((child) => child.type === 'expr_call');
      if (callChild) {
        const name = callTargetName(callChild, source);
        // Builtins (`count`, `trim_space`, …) and rule-body keywords are not
        // graph symbols; an unresolvable `calls` ref only adds noise to blast
        // radius, so drop them here.
        if (name && !isPolicyKeyword(name.split('.').pop() as string)) {
          addRef(ctx, callChild, name, 'calls');
        }
        return false;
      }

      // A plain path reference. Only `data.` / `input.` paths describe a real
      // dependency; a bare local `user` is just a variable.
      const path = getNodeText(node, source).trim();
      const first = path.split(/[.[]/)[0];
      if ((first === 'data' || first === 'input') && path.length > first.length) {
        addRef(ctx, node, path, 'references');
      }
      return false;
    }

    return false;
  },
};
