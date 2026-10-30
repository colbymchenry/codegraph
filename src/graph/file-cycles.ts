/**
 * Circular imports between files, read by more than one surface: the
 * `codegraph cycles` command (through `CodeGraph.findCircularDependencies`) and
 * the viewer's map.
 */

/**
 * The strongly connected components of a file import graph, each with more than
 * one file: groups of files that all reach each other through imports. A group
 * is not a path. Two files that import each other are a group of two, and a
 * 400-file knot is one group of 400, whatever the number of distinct loops that
 * run through it, which depends on the order they are walked in.
 *
 * Files are sorted inside a group and groups by size, then first file, so two
 * runs over one index print the same report.
 */
export function findFileCycles(pairs: ReadonlyArray<{ source: string; target: string }>): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const pair of pairs) {
    let out = adjacency.get(pair.source);
    if (!out) adjacency.set(pair.source, (out = []));
    out.push(pair.target);
  }
  // Deterministic iteration: SQLite's DISTINCT ordering is not a contract.
  const nodes = [...new Set([...adjacency.keys(), ...[...adjacency.values()].flat()])].sort();
  for (const list of adjacency.values()) list.sort();

  return tarjan(nodes, (id) => adjacency.get(id) ?? [])
    .filter((component) => component.length > 1)
    .map((component) => component.slice().sort())
    .sort((a, b) => a.length - b.length || (a[0] ?? '').localeCompare(b[0] ?? ''));
}

/** Tarjan's strongly connected components, iterative so a deep graph cannot blow the stack. */
function tarjan(nodes: readonly string[], edgesOf: (id: string) => readonly string[]): string[][] {
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
