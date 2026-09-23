/** Public v1 framework/semantic extension contract. No query-time hooks. */
import type { Edge } from '../types';
import type { FrameworkResolver, ResolutionContext } from '../resolution/types';

export type { Node, Edge, NodeKind, EdgeKind, Language } from '../types';
export type { FrameworkResolver, ResolutionContext, UnresolvedRef, ResolvedRef } from '../resolution/types';

export interface PluginManifest {
  id: string;
  apiVersion: 1;
  engines?: string;
  capabilities: ('frameworks' | 'synthPasses')[];
}
export interface PluginEntry {
  name: string;
  options?: Record<string, unknown>;
  replaces?: string[];
  enabled?: boolean;
  /** Managed packages are pinned to immutable release bytes. */
  version?: string;
  integrity?: string;
  source?: string;
}
export interface PluginContext {
  projectRoot: string;
  options: Record<string, unknown>;
  engineVersion: string;
  log: { warn(message: string): void; debug(message: string): void };
}
export interface SynthPass {
  name: string;
  languages?: string[];
  /** Return edges only. Persistence and deterministic merge belong to core. */
  run(context: ResolutionContext, yieldToLoop: () => Promise<void> | undefined): Promise<Edge[]>;
}
export interface PluginContributions {
  frameworks?: FrameworkResolver[];
  synthPasses?: SynthPass[];
}
export type CodeGraphPlugin = (context: PluginContext) => PluginContributions | Promise<PluginContributions>;

export interface ResolvedPlugin {
  manifest: PluginManifest;
  name: string;
  version: string;
  entryPath: string;
  packageRoot: string;
  digest: string;
  options: Record<string, unknown>;
  replaces: string[];
}
export interface PluginDiagnostic {
  id: string;
  version?: string;
  state: 'loaded' | 'skipped' | 'disabled';
  message?: string;
  loadMs?: number;
}
