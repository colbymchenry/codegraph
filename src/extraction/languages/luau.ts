import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';
import { luaExtractor } from './lua';

// Luau (https://luau.org) is a gradually-typed superset of Lua. The
// tree-sitter-luau grammar reuses the same node names as the vendored Lua
// grammar (function_declaration, variable_declaration, function_call,
// dot/method_index_expression, …), so the Luau extractor extends the Lua one
// and adds the type-system pieces Luau introduces:
//   - `type X = ...` / `export type X = ...`  → type_definition (type_alias)
//   - typed parameters and return types        → richer signatures
//
// require detection, receiver-splitting (t.f / t:m → methods), and local
// variable extraction are inherited unchanged from luaExtractor. The shared
// `extractVariable` core branch is gated on `lua` || `luau`.
export const luauExtractor: LanguageExtractor = {
  ...luaExtractor,

  // `type X = ...` and `export type X = ...`
  typeAliasTypes: ['type_definition'],

  // Only Luau `export type` is exported; the keyword leads the node.
  isExported: (node, source) => source.slice(node.startIndex, node.startIndex + 7) === 'export ',

  // Params + Luau return type (the named child after `parameters`, before the body).
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    const kids = node.namedChildren;
    const idx = kids.findIndex((c) => c.startIndex === params.startIndex);
    const ret = idx >= 0 ? kids[idx + 1] : null;
    if (ret && ret.type !== 'block') sig += `: ${getNodeText(ret, source)}`;
    return sig;
  },
};
