import { AsyncLocalStorage } from 'node:async_hooks';
import type { FrameworkResolver } from '../resolution/types';
import type { SynthPassDef } from '../resolution/callback-synthesizer';
import type { PluginDiagnostic, ResolvedPlugin } from './api';

export interface PluginRegistry {
  projectRoot: string;
  resolved: ResolvedPlugin[];
  frameworks: FrameworkResolver[];
  synthPasses: SynthPassDef[];
  replaces: Set<string>;
  diagnostics: PluginDiagnostic[];
}

// A daemon can index several roots concurrently. Never mutate a module-global
// resolver list to install a project's extensions.
const scope = new AsyncLocalStorage<PluginRegistry>();
export const currentPlugins = (): PluginRegistry | undefined => scope.getStore();
export function withPlugins<T>(registry: PluginRegistry, fn: () => T): T {
  return scope.run(registry, fn);
}
export function emptyRegistry(projectRoot: string): PluginRegistry {
  return { projectRoot, resolved: [], frameworks: [], synthPasses: [], replaces: new Set(), diagnostics: [] };
}

export function mergePluginDiagnostics(registry: PluginRegistry | undefined, diagnostics?: PluginDiagnostic[]): void {
  if (!registry || !diagnostics) return;
  for (const diagnostic of diagnostics) {
    if (diagnostic.state === 'loaded') continue;
    const current = registry.diagnostics.find(d => d.id === diagnostic.id);
    if (current) Object.assign(current, diagnostic);
    else registry.diagnostics.push(diagnostic);
  }
}
