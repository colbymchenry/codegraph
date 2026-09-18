import type { WireMapLink, WireMapModule, WireMapPayload } from './wire';

/** Whether a module belongs in the map under the reader's test visibility setting. */
export function isEligibleMapModule(module: WireMapModule, includeTests: boolean): boolean {
  return includeTests || !module.test;
}

/** The visible graph's endpoints and links, before layout-specific decisions. */
export function selectEligibleMapGraph(
  payload: Pick<WireMapPayload, 'modules' | 'links'>,
  includeTests: boolean
): { modules: WireMapModule[]; ids: Set<string>; links: WireMapLink[] } {
  const modules = payload.modules.filter((module) => isEligibleMapModule(module, includeTests));
  const ids = new Set(modules.map((module) => module.id));
  return {
    modules,
    ids,
    links: payload.links.filter((link) => ids.has(link.source) && ids.has(link.target)),
  };
}
