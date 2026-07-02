import type { LanguageExtractor } from '../tree-sitter-types';
import { typescriptExtractor } from './typescript';

/**
 * ArkTS language extractor.
 *
 * ArkTS is a TypeScript superset used in HarmonyOS/ArkUI development.
 * It extends TypeScript with:
 *   - `struct` keyword for component definitions (@Component struct X { ... })
 *   - Decorator-first patterns (@State, @Prop, @Link, @Builder, @Styles, etc.)
 *   - `.ets` file extension
 *
 * The base TypeScript extractor handles all shared syntax. ArkTS-specific
 * constructs (decorators, structs) are recognized through the existing
 * decorator and struct extraction paths.
 */
export const arktsExtractor: LanguageExtractor = {
  ...typescriptExtractor,

  // ArkTS uses `struct` keyword for component definitions.
  // tree-sitter-arkts grammar parses these as `struct_declaration` nodes.
  structTypes: ['struct_declaration'],

  // Override methodTypes: exclude public_field_definition — ArkUI state
  // properties (@State count: number = 0) are field declarations, not
  // methods.  Pure arrow-function class fields are uncommon in ArkTS;
  // the ArkUI convention defines event handlers as proper methods.
  methodTypes: ['method_definition'],

  // Extract ArkUI state properties as 'property' nodes so the state-dep
  // edge synthesis (Phase B + Phase E) can find and link them to handler
  // methods that read this.<prop>.
  propertyTypes: ['public_field_definition'],
};
