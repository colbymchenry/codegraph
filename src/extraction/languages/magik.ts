import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Magik exemplar-definition functions that create class-like objects.
 * These parse as `invoke` nodes with the function name in the `receiver` field
 * and the exemplar name as a `:symbol` argument.
 */
const EXEMPLAR_DEFINERS: ReadonlySet<string> = new Set([
  'define_slotted_exemplar',
  'def_slotted_exemplar',
  'define_mixin',
  'def_mixin',
  'define_pseudo_slot_exemplar',
  'define_indexed_exemplar',
]);

/**
 * Magik receivers that refer to "self" — skip for call resolution since they
 * don't aid name-based matching.
 */
const SELF_RECEIVERS: ReadonlySet<string> = new Set([
  '_self', '_super', '_clone', '_thisthread',
]);

export const magikExtractor: LanguageExtractor = {
  // Magik methods are `_method exemplar.name ... _endmethod` — top-level, not
  // inside a class body. The exemplarname field provides the receiver type so
  // getReceiverType can build the qualified name `exemplar::method_name`.
  functionTypes: [],         // procedures handled via visitNode
  classTypes: [],            // exemplars handled via visitNode
  methodTypes: [],           // methods handled via visitNode (for inline ## docstrings)
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],           // _import is block-scope variable sharing, not module imports
  callTypes: ['invoke'],     // standalone function invocations; `call` handled via visitNode/extractBareCall
  variableTypes: [],         // _local/_dynamic are function-body locals, not top-level symbols
  nameField: 'name',        // method: name field = the method name identifier
  bodyField: '',             // Magik has no explicit body field; resolveBody returns the node itself
  paramsField: '',           // arguments are unnamed children; getSignature collects them

  // Magik `_package sw` — creates a namespace wrapping all subsequent declarations
  packageTypes: ['package'],
  extractPackage: (node, source) => {
    const text = getNodeText(node, source);
    const m = text.match(/_package\s+(\S+)/i);
    return m ? m[1]! : null;
  },

  // The `method` node's `exemplarname` field is the class/exemplar name
  getReceiverType: (node, source) => {
    if (node.type !== 'method') return undefined;
    const exemplar = node.childForFieldName('exemplarname');
    return exemplar ? getNodeText(exemplar, source).trim() : undefined;
  },

  // Collect `argument` children for the signature string
  getSignature: (node, source) => {
    const args: string[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'argument') args.push(getNodeText(child, source));
    }
    return '(' + args.join(', ') + ')';
  },

  // Check for `_private` keyword among anonymous children
  getVisibility: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && !child.isNamed && child.text.toLowerCase() === '_private') {
        return 'private';
      }
    }
    return 'public';
  },

  // Magik's body IS the method/procedure node — no separate body field.
  // Returning the node itself causes visitFunctionBody to walk all children.
  resolveBody: (node, _bodyField) => {
    if (node.type === 'method' || node.type === 'procedure') return node;
    return null;
  },

  // Handle `call` nodes inside function bodies: extract the `message` field
  // as the callee name. The framework calls this for any node that is NOT in
  // callTypes (so `invoke` nodes go through extractCall, `call` nodes come here).
  extractBareCall: (node, source) => {
    if (node.type !== 'call') return undefined;
    const messageNode = node.childForFieldName('message');
    if (!messageNode) return undefined;
    const methodName = getNodeText(messageNode, source).trim();
    if (!methodName) return undefined;

    const receiverNode = node.childForFieldName('receiver');
    if (receiverNode) {
      const receiverText = getNodeText(receiverNode, source).trim();
      if (!SELF_RECEIVERS.has(receiverText) &&
          (receiverNode.type === 'variable' || receiverNode.type === 'identifier')) {
        return `${receiverText}.${methodName}`;
      }
    }
    return methodName;
  },

  visitNode: (node, ctx) => {
    // ── Methods (_method exemplar.name(args) ... _endmethod) ────────────────
    // Handled here (not via methodTypes) so we can extract inline ## docstrings.
    if (node.type === 'method') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return true;
      const name = getNodeText(nameNode, ctx.source).trim();
      if (!name) return true;

      const exemplarNode = node.childForFieldName('exemplarname');
      const exemplarName = exemplarNode ? getNodeText(exemplarNode, ctx.source).trim() : undefined;

      const docNode = node.namedChildren.find((c: SyntaxNode) => c.type === 'documentation');
      const docstring = docNode
        ? getNodeText(docNode, ctx.source)
            .split('\n')
            .map((l: string) => l.replace(/^\s*##\s?/, ''))
            .join('\n')
            .trim()
        : undefined;

      const args: string[] = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'argument') args.push(getNodeText(child, ctx.source));
      }

      let visibility: 'public' | 'private' | undefined;
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && !child.isNamed && child.text.toLowerCase() === '_private') {
          visibility = 'private';
          break;
        }
      }

      const extra: Record<string, unknown> = {
        signature: '(' + args.join(', ') + ')',
        docstring,
        visibility: visibility ?? 'public',
      };
      if (exemplarName) {
        extra.qualifiedName = `${exemplarName}::${name}`;
      }

      const methodNode = ctx.createNode('method', name, node, extra);
      if (methodNode) {
        // Create contains edge from the exemplar class node if it exists
        if (exemplarName) {
          const ownerNode = ctx.nodes.find(
            (n) => n.name === exemplarName && n.kind === 'class' && n.filePath === ctx.filePath
          );
          if (ownerNode) {
            ctx.addUnresolvedReference({
              fromNodeId: ownerNode.id,
              referenceName: name,
              referenceKind: 'references',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
        ctx.pushScope(methodNode.id);
        ctx.visitFunctionBody(node, methodNode.id);
        ctx.popScope();
      }
      return true;
    }

    // ── Procedures (_proc @name(args) ... _endproc) ─────────────────────────
    if (node.type === 'procedure') {
      const labelNode = node.namedChildren.find((c: SyntaxNode) => c.type === 'label');
      const name = labelNode
        ? getNodeText(labelNode, ctx.source).replace(/^@\s*/, '').trim()
        : '<anonymous>';

      const docNode = node.namedChildren.find((c: SyntaxNode) => c.type === 'documentation');
      const docstring = docNode
        ? getNodeText(docNode, ctx.source)
            .split('\n')
            .map((l: string) => l.replace(/^\s*##\s?/, ''))
            .join('\n')
            .trim()
        : undefined;

      const args: string[] = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'argument') args.push(getNodeText(child, ctx.source));
      }

      const fn = ctx.createNode('function', name, node, {
        signature: '(' + args.join(', ') + ')',
        docstring,
      });
      if (fn) {
        ctx.pushScope(fn.id);
        ctx.visitFunctionBody(node, fn.id);
        ctx.popScope();
      }
      return true;
    }

    // ── Exemplar definitions (define_slotted_exemplar, define_mixin, …) ─────
    if (node.type === 'invoke') {
      const receiverNode = node.childForFieldName('receiver');
      if (!receiverNode) return false;
      const fnName = getNodeText(receiverNode, ctx.source).trim();

      if (EXEMPLAR_DEFINERS.has(fnName)) {
        // First :symbol argument is the exemplar (class) name
        const symbolNode = node.namedChildren.find((c: SyntaxNode) => c.type === 'symbol');
        if (symbolNode) {
          const rawName = getNodeText(symbolNode, ctx.source)
            .replace(/^:/, '')
            .replace(/^\||\|$/g, '')
            .trim();
          if (rawName) {
            ctx.createNode('class', rawName, node);
          }
        }
        return true; // handled — don't also emit as a generic call
      }
      return false; // other invoke nodes → default extractCall path
    }

    // ── Top-level call nodes (outside method/procedure bodies) ───────────────
    // In method/procedure bodies, `call` is handled via extractBareCall.
    // At the fragment level (e.g. class initialisation code), handle here too.
    if (node.type === 'call') {
      const callerId = ctx.nodeStack[ctx.nodeStack.length - 1];
      if (callerId) {
        const messageNode = node.childForFieldName('message');
        if (messageNode) {
          const methodName = getNodeText(messageNode, ctx.source).trim();
          if (methodName) {
            const receiverNode = node.childForFieldName('receiver');
            let calleeName = methodName;
            if (receiverNode) {
              const receiverText = getNodeText(receiverNode, ctx.source).trim();
              if (!SELF_RECEIVERS.has(receiverText) &&
                  (receiverNode.type === 'variable' || receiverNode.type === 'identifier')) {
                calleeName = `${receiverText}.${methodName}`;
              }
            }
            ctx.addUnresolvedReference({
              fromNodeId: callerId,
              referenceName: calleeName,
              referenceKind: 'calls',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
      }
      // Visit children so nested calls inside arguments are captured
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) ctx.visitNode(child);
      }
      return true;
    }

    return false;
  },
};
