import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

export const pythonExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_definition'],
  methodTypes: ['function_definition'], // Methods are functions inside classes
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_statement', 'import_from_statement'],
  callTypes: ['call'],
  variableTypes: ['assignment'], // Python uses assignment for variable declarations
  // Class-level assignments: Odoo fields (fields.XXX) and model meta (_name, _inherit, ...)
  fieldTypes: ['assignment'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ' -> ' + getNodeText(returnType, source);
    }
    return sig;
  },
  isAsync: (node) => {
    const prev = node.previousSibling;
    return prev?.type === 'async';
  },
  isStatic: (node) => {
    // Check for @staticmethod decorator
    const prev = node.previousNamedSibling;
    if (prev?.type === 'decorator') {
      const text = prev.text;
      return text.includes('staticmethod');
    }
    return false;
  },
  visitNode: (node: SyntaxNode, ctx: ExtractorContext): boolean => {
    const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
    if (!fromNodeId) return false;

    // @api.depends / @api.onchange / @api.constrains → refs to each field/method name
    if (node.type === 'decorator') {
      const expr = node.namedChildren[0];
      if (!expr || expr.type !== 'call') return false;
      const funcNode = getChildByField(expr, 'function');
      if (!funcNode) return false;
      const funcText = getNodeText(funcNode, ctx.source);
      if (!/^api\.(depends|onchange|constrains)$/.test(funcText)) return false;
      const argsNode = getChildByField(expr, 'arguments');
      if (!argsNode) return false;
      const line = node.startPosition.row + 1;
      for (const arg of extractStringLiterals(argsNode, ctx.source)) {
        ctx.addUnresolvedReference({
          fromNodeId,
          referenceName: arg,
          referenceKind: 'references',
          line,
          column: node.startPosition.column,
          filePath: ctx.filePath,
          language: 'python',
        });
      }
      return false;
    }

    // Class-level assignments: field kwargs + _inherit as list
    if (node.type === 'assignment') {
      const left = getChildByField(node, 'left');
      const right = getChildByField(node, 'right');
      if (!left || !right) return false;
      const leftText = getNodeText(left, ctx.source);
      const line = node.startPosition.row + 1;

      // _inherit = ['account.move', 'mail.thread']
      if (leftText === '_inherit' && right.type === 'list') {
        for (const str of extractStringLiterals(right, ctx.source)) {
          ctx.addUnresolvedReference({
            fromNodeId,
            referenceName: str,
            referenceKind: 'references',
            line,
            column: 0,
            filePath: ctx.filePath,
            language: 'python',
          });
        }
        return false;
      }

      // fields.Many2one(..., compute='_x', related='a.b', comodel_name='res.partner', ...)
      if (right.type === 'call') {
        const funcNode = getChildByField(right, 'function');
        if (!funcNode) return false;
        const funcText = getNodeText(funcNode, ctx.source);
        if (!/^fields\./.test(funcText)) return false;
        const argsNode = getChildByField(right, 'arguments');
        if (!argsNode) return false;
        const kwargs = extractKwargs(argsNode, ctx.source);
        const singleRefKeys = ['compute', 'inverse', 'search', 'currency_field', 'comodel_name', 'inverse_name'];
        for (const key of singleRefKeys) {
          const val = kwargs[key];
          if (val) {
            ctx.addUnresolvedReference({
              fromNodeId,
              referenceName: val,
              referenceKind: 'references',
              line,
              column: 0,
              filePath: ctx.filePath,
              language: 'python',
            });
          }
        }
        // related='partner_id.name' → ref for each dotted segment
        const related = kwargs['related'];
        if (related) {
          for (const segment of related.split('.')) {
            if (segment) {
              ctx.addUnresolvedReference({
                fromNodeId,
                referenceName: segment,
                referenceKind: 'references',
                line,
                column: 0,
                filePath: ctx.filePath,
                language: 'python',
              });
            }
          }
        }
      }
      return false;
    }

    return false;
  },

  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    if (node.type === 'import_from_statement') {
      const moduleNode = node.childForFieldName('module_name');
      if (moduleNode) {
        return { moduleName: source.substring(moduleNode.startIndex, moduleNode.endIndex), signature: importText };
      }
    }
    // import_statement creates multiple imports - return null for core fallback
    return null;
  },
};

// ---------------------------------------------------------------------------
// Helpers for Odoo-aware visitNode
// ---------------------------------------------------------------------------

/** Extract all string literal values from a node's named children (recursive one level). */
function extractStringLiterals(node: SyntaxNode, source: string): string[] {
  const results: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'string') {
      const val = stripQuotes(getNodeText(child, source));
      if (val) results.push(val);
    } else if (child.type === 'concatenated_string') {
      // Handle 'partner_' + '_id' style (rare but valid)
      const combined = child.namedChildren
        .filter((c: SyntaxNode) => c.type === 'string')
        .map((c: SyntaxNode) => stripQuotes(getNodeText(c, source)))
        .join('');
      if (combined) results.push(combined);
    }
  }
  return results;
}

/** Extract keyword argument values from an argument_list node. Returns { key: value }. */
function extractKwargs(argsNode: SyntaxNode, source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const child of argsNode.namedChildren) {
    if (child.type !== 'keyword_argument') continue;
    const nameNode = getChildByField(child, 'name');
    const valNode = getChildByField(child, 'value');
    if (!nameNode || !valNode) continue;
    const key = getNodeText(nameNode, source);
    if (valNode.type === 'string') {
      result[key] = stripQuotes(getNodeText(valNode, source));
    }
  }
  return result;
}

/** Strip surrounding quotes from a Python string token. Handles ', ", ''', \"\"\". */
function stripQuotes(raw: string): string {
  return raw.replace(/^(?:'''|"""|'|")(.*)(?:'''|"""|'|")$/s, '$1').trim();
}
