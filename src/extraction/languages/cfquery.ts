import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * `<cfquery>` SQL bodies: `#hash#` expressions inside the SQL text are real
 * CFML expressions (tree-sitter-cfml's `cfquery` grammar parses them
 * structurally — `call_expression`/`member_expression`, same shape as
 * cfscript's), so a call like `#getCurrentUser().getId()#` embedded in a
 * WHERE clause is a genuine call edge. The surrounding SQL keywords/
 * identifiers aren't symbols CodeGraph models — only `call_expression` is
 * mapped, so extraction yields call references and nothing else.
 */
export const cfqueryExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['call_expression'],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
};
