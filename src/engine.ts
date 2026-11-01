/**
 * The half of CodeGraph that builds and updates an index: extraction,
 * resolution and the file watcher. `src/index.ts` reaches all of it through
 * `engine()` in `./lazy-engine`, never with an import of its own, so a command
 * that only reads an index doesn't load it. See that file for why.
 */

export { ExtractionOrchestrator, extractFromSource } from './extraction';
export { changedModuleConfigs, changedRoutes, createResolver, moduleConfigLanguages, parseModuleConfigSnapshot } from './resolution';
export { hasSynthesisPattern, isJsxChildCandidate } from './resolution/callback-synthesizer';
export { aliasMayName } from './resolution/const-alias-synthesizer';
export { ESM_IMPORT_LANGUAGES } from './resolution/import-resolver';
export {
  createImportReader,
  reopenNameMatchedImports,
  reopenReferencesThroughAddedFiles,
  reopenReferencesThroughBarrels,
  reopenReferencesThroughChangedDefaults,
  reopenReferencesThroughDeclaredPackages,
  reopenReferencesThroughRetargetedModules,
} from './resolution/module-importers';
export { FileWatcher } from './sync/watcher';
