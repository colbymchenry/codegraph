/**
 * Strongly connected components, shared by every consumer that needs to find cycles.
 *
 * Extracted from the viewer's map endpoint (`src/ui-server/api/map.ts`) so the CLI/MCP
 * architecture report and the UI map use one implementation instead of each computing cycles
 * their own way.
 */

/** Tarjan's strongly connected components, iterative so a deep graph cannot blow the stack. */
export function tarjan(nodes: readonly string[], edgesOf: (id: string) => readonly string[]): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;

  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: Array<{ id: string; edges: readonly string[]; at: number }> = [
      { id: start, edges: edgesOf(start), at: 0 },
    ];
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;
      if (frame.at < frame.edges.length) {
        const next = frame.edges[frame.at]!;
        frame.at += 1;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ id: next, edges: edgesOf(next), at: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.id, Math.min(low.get(frame.id) ?? 0, index.get(next) ?? 0));
        }
        continue;
      }
      work.pop();
      if (low.get(frame.id) === index.get(frame.id)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.id) break;
        }
        out.push(component);
      }
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id) ?? 0, low.get(frame.id) ?? 0));
    }
  }
  return out;
}
