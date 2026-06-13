import { describe, expect, it } from 'vitest';
import {
  buildVisualizationGraphFromSubgraph,
  renderVisualizationHtml,
} from '../src/visualization';
import { Edge, Node, Subgraph } from '../src/types';

function makeNode(id: string, name: string, kind: Node['kind'] = 'function'): Node {
  return {
    id,
    kind,
    name,
    qualifiedName: `src/example.ts::${name}`,
    filePath: 'src/example.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 3,
    startColumn: 0,
    endColumn: 1,
    isExported: true,
    updatedAt: 1,
  };
}

describe('visualization', () => {
  it('keeps root nodes and removes dangling edges when limiting a subgraph', () => {
    const root = makeNode('root', 'root');
    const child = makeNode('child', 'child');
    const omitted = makeNode('omitted', 'omitted');
    const edges: Edge[] = [
      { source: root.id, target: child.id, kind: 'calls' },
      { source: child.id, target: omitted.id, kind: 'calls' },
    ];
    const subgraph: Subgraph = {
      nodes: new Map([
        [root.id, root],
        [child.id, child],
        [omitted.id, omitted],
      ]),
      edges,
      roots: [root.id],
    };

    const graph = buildVisualizationGraphFromSubgraph({
      subgraph,
      projectRoot: '/repo',
      title: 'Test graph',
      mode: 'symbol',
      limit: 2,
    });

    expect(graph.nodes.map((node) => node.id)).toContain(root.id);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([{ source: root.id, target: child.id, kind: 'calls' }]);
    expect(graph.stats.truncated).toBe(true);
  });

  it('escapes graph data before embedding it in the generated HTML', () => {
    const dangerous = makeNode('danger', '</script><img src=x onerror=alert(1)>');
    const graph = buildVisualizationGraphFromSubgraph({
      subgraph: {
        nodes: new Map([[dangerous.id, dangerous]]),
        edges: [],
        roots: [dangerous.id],
      },
      projectRoot: '/repo',
      title: 'Graph <danger>',
      mode: 'symbol',
      query: dangerous.name,
    });

    const html = renderVisualizationHtml(graph);

    expect(html).toContain('Graph &lt;danger&gt;');
    expect(html).toContain('<canvas id="graph"');
    expect(html).toContain('id="gravitySlider" type="range" min="0" max="140" value="18"');
    expect(html).toContain('id="linkSlider" type="range" min="70" max="900" value="165"');
    expect(html).toContain('id="spread"');
    expect(html).toContain('function stepPhysics');
    expect(html).toContain('\\u003c/script\\u003e');
    expect(html).not.toContain('</script><img');
  });
});
