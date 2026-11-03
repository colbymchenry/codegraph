/** Join a signal's emissions and subscriptions, as resolution left them, by the signal's declaration. */
import type { Edge } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { MaybeYield } from './cooperative-yield';
import type { ResolutionContext } from './types';
import { signalUseOf } from './gdscript';

export async function gdscriptSignalEdges(
  queries: QueryBuilder,
  ctx: ResolutionContext,
  onYield: MaybeYield,
  maxHandlers: number,
): Promise<Edge[]> {
  const result: Edge[] = [];
  const seen = new Set<string>();
  const outgoing = new Map<string, Edge[]>();
  const signals = ctx.iterateNodesByKind?.('field') ?? ctx.getNodesByKind('field');
  let scanned = 0;
  for (const signal of signals) {
    if ((++scanned & 63) === 0) await onYield();
    if (signal.language !== 'gdscript' || !signal.decorators?.includes('signal')) continue;
    const emits: Edge[] = [];
    const registrations: Array<{ handler: string; site: string }> = [];
    for (const edge of queries.getIncomingEdges(signal.id, ['references'])) {
      const use = signalUseOf(edge.metadata?.refName);
      const caller = use ? ctx.getNodeById?.(edge.source) : undefined;
      if (caller?.language !== 'gdscript') continue;
      if (use === 'emit') {
        emits.push(edge);
        continue;
      }
      // The extractor files a connect's handler at the connect's own position.
      let fromCaller = outgoing.get(edge.source);
      if (!fromCaller) outgoing.set(edge.source, fromCaller = queries.getOutgoingEdges(edge.source, ['references']));
      for (const handler of fromCaller) {
        if (handler.metadata?.fnRef && handler.line === edge.line && handler.column === edge.column) {
          registrations.push({ handler: handler.target, site: `${caller.filePath}:${edge.line}` });
        }
      }
    }
    if (new Set(registrations.map((r) => r.handler)).size > maxHandlers) continue;
    for (const emit of emits) for (const registration of registrations) {
      const key = `${emit.source}:${registration.handler}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        source: emit.source, target: registration.handler, kind: 'calls', provenance: 'heuristic',
        line: emit.line, column: emit.column,
        metadata: { synthesizedBy: 'gdscript-signal', event: signal.name, registeredAt: registration.site },
      });
    }
  }
  return result;
}
