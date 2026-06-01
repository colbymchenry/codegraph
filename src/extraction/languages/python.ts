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

    // @api.depends / @api.onchange / @api.constrains / @api.returns
    if (node.type === 'decorator') {
      const expr = node.namedChildren[0];
      if (!expr || expr.type !== 'call') return false;
      const funcNode = getChildByField(expr, 'function');
      if (!funcNode) return false;
      const funcText = getNodeText(funcNode, ctx.source);
      const argsNode = getChildByField(expr, 'arguments');
      if (!argsNode) return false;
      const line = node.startPosition.row + 1;

      if (/^api\.(depends|onchange|constrains)$/.test(funcText)) {
        // T2-K: split dotted paths — 'a.b.c' → refs for 'a', 'b', 'c'
        for (const arg of extractStringLiterals(argsNode, ctx.source)) {
          for (const segment of arg.split('.')) {
            if (segment) {
              ctx.addUnresolvedReference({
                fromNodeId,
                referenceName: segment,
                referenceKind: 'references',
                line,
                column: node.startPosition.column,
                filePath: ctx.filePath,
                language: 'python',
              });
            }
          }
        }
        return false;
      }

      // T2-J: @api.returns('res.partner') → model ref
      if (funcText === 'api.returns') {
        const firstArg = argsNode.namedChildren[0];
        if (firstArg?.type === 'string') {
          const modelName = stripQuotes(getNodeText(firstArg, ctx.source));
          if (modelName) {
            ctx.addUnresolvedReference({
              fromNodeId,
              referenceName: modelName,
              referenceKind: 'references',
              line,
              column: node.startPosition.column,
              filePath: ctx.filePath,
              language: 'python',
            });
          }
        }
        return false;
      }

      return false;
    }

    // Class-level assignments: field kwargs, model meta, _inherit/_inherits
    if (node.type === 'assignment') {
      const left = getChildByField(node, 'left');
      const right = getChildByField(node, 'right');
      if (!left || !right) return false;
      const leftText = getNodeText(left, ctx.source);
      const line = node.startPosition.row + 1;

      // _inherit = 'account.move' (string) or ['account.move', 'mail.thread'] (list)
      if (leftText === '_inherit') {
        if (right.type === 'list') {
          for (const str of extractStringLiterals(right, ctx.source)) {
            ctx.addUnresolvedReference({ fromNodeId, referenceName: str, referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });
          }
        } else if (right.type === 'string') {
          // T1-I: string form
          const val = stripQuotes(getNodeText(right, ctx.source));
          if (val) ctx.addUnresolvedReference({ fromNodeId, referenceName: val, referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });
        }
        return false;
      }

      // T2-D: _inherits = {'res.partner': 'partner_id'} → model + field refs
      if (leftText === '_inherits' && right.type === 'dictionary') {
        for (const pair of right.namedChildren) {
          if (pair.type !== 'pair') continue;
          const key = getChildByField(pair, 'key');
          const val = getChildByField(pair, 'value');
          if (key?.type === 'string') {
            const modelName = stripQuotes(getNodeText(key, ctx.source));
            if (modelName) ctx.addUnresolvedReference({ fromNodeId, referenceName: modelName, referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });
          }
          if (val?.type === 'string') {
            const fieldName = stripQuotes(getNodeText(val, ctx.source));
            if (fieldName) ctx.addUnresolvedReference({ fromNodeId, referenceName: fieldName, referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });
          }
        }
        return false;
      }

      // T2-E: _rec_name / _parent_name → single field ref
      if (['_rec_name', '_parent_name'].includes(leftText) && right.type === 'string') {
        const val = stripQuotes(getNodeText(right, ctx.source));
        if (val) ctx.addUnresolvedReference({ fromNodeId, referenceName: val, referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });
        return false;
      }

      // T2-E: _order = 'date desc, name asc' → field refs per sort key
      if (leftText === '_order' && right.type === 'string') {
        const order = stripQuotes(getNodeText(right, ctx.source));
        for (const part of order.split(',')) {
          const field = part.trim().split(/\s+/)[0];
          if (field) ctx.addUnresolvedReference({ fromNodeId, referenceName: field, referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });
        }
        return false;
      }

      // T2-E: _rec_names_search = ['name', 'ref'] → field refs
      if (leftText === '_rec_names_search' && right.type === 'list') {
        for (const str of extractStringLiterals(right, ctx.source)) {
          ctx.addUnresolvedReference({ fromNodeId, referenceName: str, referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });
        }
        return false;
      }

      // T2-F: _sql_constraints → constraint refs
      if (leftText === '_sql_constraints' && right.type === 'list') {
        for (const child of right.namedChildren) {
          if (child.type !== 'tuple') continue;
          const first = child.namedChildren.find((c: SyntaxNode) => c.type === 'string');
          if (first) {
            const name = stripQuotes(getNodeText(first, ctx.source));
            if (name) ctx.addUnresolvedReference({ fromNodeId, referenceName: `constraint::${name}`, referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });
          }
        }
        return false;
      }

      // fields.Many2one(...) / fields.Char(...) etc.
      if (right.type === 'call') {
        const funcNode = getChildByField(right, 'function');
        if (!funcNode) return false;
        const funcText = getNodeText(funcNode, ctx.source);
        if (!/^fields\./.test(funcText)) return false;
        const argsNode = getChildByField(right, 'arguments');
        if (!argsNode) return false;

        const kwargs = extractKwargs(argsNode, ctx.source);
        // T1-7 + T2-C/H/I/S: extended singleRefKeys
        const singleRefKeys = [
          'compute', 'inverse', 'search', 'currency_field', 'comodel_name', 'inverse_name',
          'groups', 'config_parameter', 'digits', 'selection',
        ];
        for (const key of singleRefKeys) {
          const val = kwargs[key];
          if (val) ctx.addUnresolvedReference({ fromNodeId, referenceName: val, referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });
        }

        // related='partner_id.name' → ref for each dotted segment
        const related = kwargs['related'];
        if (related) {
          for (const segment of related.split('.')) {
            if (segment) ctx.addUnresolvedReference({ fromNodeId, referenceName: segment, referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });
          }
        }

        // T2-R: relation='table_name' → m2m_relation ref
        const relation = kwargs['relation'];
        if (relation) ctx.addUnresolvedReference({ fromNodeId, referenceName: `m2m_relation::${relation}`, referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });

        // T1-A: positional args → comodel/inverse_name refs for relational fields
        const positionalArgs: string[] = [];
        for (const child of argsNode.namedChildren) {
          if (child.type === 'keyword_argument') continue;
          if (child.type === 'string') positionalArgs.push(stripQuotes(getNodeText(child, ctx.source)));
        }
        const fieldType = funcText.split('.')[1] ?? '';
        if (['Many2one', 'Reference', 'Many2oneReference'].includes(fieldType) && positionalArgs[0]) {
          ctx.addUnresolvedReference({ fromNodeId, referenceName: positionalArgs[0], referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });
        }
        if (fieldType === 'One2many') {
          if (positionalArgs[0]) ctx.addUnresolvedReference({ fromNodeId, referenceName: positionalArgs[0], referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });
          if (positionalArgs[1]) ctx.addUnresolvedReference({ fromNodeId, referenceName: positionalArgs[1], referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });
        }
        if (fieldType === 'Many2many' && positionalArgs[0]) {
          ctx.addUnresolvedReference({ fromNodeId, referenceName: positionalArgs[0], referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });
        }

        // T1-B: selection=[('draft','Draft'), ...] → selection::fieldName::key refs
        const fieldName = getNodeText(left, ctx.source);
        for (const child of argsNode.namedChildren) {
          if (child.type !== 'keyword_argument') continue;
          const nameNode = getChildByField(child, 'name');
          if (!nameNode || getNodeText(nameNode, ctx.source) !== 'selection') continue;
          const valNode = getChildByField(child, 'value');
          if (valNode?.type !== 'list') continue;
          for (const item of valNode.namedChildren) {
            if (item.type !== 'tuple') continue;
            const firstStr = item.namedChildren.find((c: SyntaxNode) => c.type === 'string');
            if (firstStr) {
              const key = stripQuotes(getNodeText(firstStr, ctx.source));
              if (key) ctx.addUnresolvedReference({ fromNodeId, referenceName: `selection::${fieldName}::${key}`, referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });
            }
          }
        }
      }
      return false;
    }

    // T1-H + T2-G: ORM call refs — self.create/write dict keys, self.mapped path segments
    if (node.type === 'call') {
      const funcNode = getChildByField(node, 'function');
      const argsNode = getChildByField(node, 'arguments');
      if (!funcNode || !argsNode) return false;
      const funcText = getNodeText(funcNode, ctx.source);
      const line = node.startPosition.row + 1;

      // self.create({...}) / self.write({...}) → field refs from dict keys
      if (/\.(create|write)$/.test(funcText)) {
        const dictArg = argsNode.namedChildren.find((c: SyntaxNode) => c.type === 'dictionary');
        if (dictArg) {
          for (const pair of dictArg.namedChildren) {
            if (pair.type !== 'pair') continue;
            const key = getChildByField(pair, 'key');
            if (key?.type === 'string') {
              const name = stripQuotes(getNodeText(key, ctx.source));
              if (name) ctx.addUnresolvedReference({ fromNodeId, referenceName: name, referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });
            }
          }
        }
        return false;
      }

      // self.mapped('a.b.c') → field refs for each dotted segment
      if (/\.mapped$/.test(funcText)) {
        const firstArg = argsNode.namedChildren[0];
        if (firstArg?.type === 'string') {
          const path = stripQuotes(getNodeText(firstArg, ctx.source));
          for (const seg of path.split('.')) {
            if (seg) ctx.addUnresolvedReference({ fromNodeId, referenceName: seg, referenceKind: 'references', line, column: 0, filePath: ctx.filePath, language: 'python' });
          }
        }
        return false;
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
