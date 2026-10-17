import { graphBudget, programBudget } from './graph-budget';
import { compactMapPositions, type CompactMapInput } from './map-compact';
import { buildMapLayout, type MapLayoutOptions } from './map-model';
import { buildScreensModel } from './screens-model';
import { buildStepsModel } from './steps-model';
import { buildOrderModel } from './program-model';
import { buildFlowLayout } from './flow-model';
import { routeScene } from './graph-routing';
import type { WireMapPayload, WireScreensPayload, WireStepsPayload, WireFlow } from './wire';
/** Rendering layout is async; the pure semantic builder remains reusable and testable. */
export async function calculateRenderLayout(kind: string, payload: unknown, options: Record<string, unknown>) {
  if (kind === 'relationships') {
    const data = payload as import('./relationship-layout').RelationshipLayoutInput;
    assertBudget(graphBudget(data.nodes.length, data.relations.length));
    if (!['force', 'concentric', 'circular'].includes(String(options.mode))) throw new Error('Unknown relationship layout');
    const { layoutRelationships } = await import('./relationship-layout');
    return layoutRelationships(data, options.mode as 'force' | 'concentric' | 'circular');
  }
  const result = calculateLayout(kind, payload, options);
  if (kind === 'map') {
    const { layoutArchitecture } = await import('./g6-layout');
    return layoutArchitecture(result as import('./map-model').MapLayout);
  }
  return result;
}
export function calculateLayout(kind: string, payload: unknown, options: Record<string, unknown>) {
  if (kind === 'scene-routes') {
    const data = payload as { nodes: Parameters<typeof routeScene>[0]; edges: Parameters<typeof routeScene>[1] };
    assertBudget(graphBudget(data.nodes.length, data.edges.length));
    return routeScene(data.nodes, data.edges);
  }
  if (kind === 'map-compact') {
    const data = payload as CompactMapInput;
    assertBudget(graphBudget(data.nodes.length, data.edges.length));
    return compactMapPositions(data);
  }
  let result;
  if (kind === 'map') {
    const data = payload as WireMapPayload;
    assertBudget(graphBudget(data.modules.length, data.links.length));
    result = buildMapLayout(data, options as unknown as MapLayoutOptions);
  } else if (kind === 'screens') {
    const data = payload as WireScreensPayload;
    assertBudget(graphBudget(data.screens.length + data.origins.length, data.links.length));
    result = buildScreensModel(data);
  } else if (kind === 'steps') {
    const data = payload as WireStepsPayload;
    assertBudget(programBudget(data.steps.length, data.links.length, options.readAs === 'order' ? data.program?.root : undefined));
    result = (options.readAs === 'order' ? buildOrderModel(data) : null) ?? buildStepsModel(data);
  } else {
    const data = payload as WireFlow[];
    assertBudget(graphBudget(new Set(data.flatMap(f => f.hops.map(h => h.node.id))).size + data.filter(f => f.boundary).length, data.reduce((n, f) => n + f.hops.length, 0)));
    const flow = buildFlowLayout(data, options.picked as string | null);
    assertBudget(graphBudget(flow.cards.length + flow.endCaps.length, flow.links.length));
    return flow;
  }
  const layout = 'layout' in result ? result.layout : result;
  assertBudget(graphBudget(layout.nodes.length, layout.edges.length));
  return result;
}
function assertBudget(budget: ReturnType<typeof graphBudget>): void {
  if (budget.exceeded) throw new Error('图谱超过 400 节点 / 2000 边预算，请缩小范围。 Graph exceeds canvas budget; narrow the scope.');
}
