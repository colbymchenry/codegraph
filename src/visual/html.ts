/**
 * Single-file dark-theme HTML template for `codegraph visual`.
 * Loads D3 v7 from jsDelivr and embeds graph JSON inline.
 */

import type { VisualPayload } from './types';

function embedJson(payload: VisualPayload): string {
  // Prevent `</script>` in path/name strings from breaking out of the data tag.
  return JSON.stringify(payload).replace(/</g, '\\u003c');
}

/**
 * Render a self-contained HTML document for the file-level force graph.
 */
export function renderVisualHtml(payload: VisualPayload): string {
  const data = embedJson(payload);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>CodeGraph Visual</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<style>
  :root {
    --bg: #0d1117;
    --text: #e6edf3;
    --muted: #8b949e;
    --node: #58a6ff;
    --link: #484f58;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    background: var(--bg);
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  }
  #chart {
    width: 100%;
    height: 100%;
    position: relative;
  }
  #chart svg {
    width: 100%;
    height: 100%;
    display: block;
  }
  .link {
    stroke: var(--link);
    stroke-opacity: 0.7;
    stroke-width: 1;
    fill: none;
  }
  .node circle {
    fill: var(--node);
    stroke: #0d1117;
    stroke-width: 1.25;
    cursor: grab;
  }
  .node circle:active { cursor: grabbing; }
  .node text {
    fill: var(--muted);
    font-size: 11px;
    pointer-events: none;
    user-select: none;
  }
  .node.dim { opacity: 0.15; }
  .link.dim { stroke-opacity: 0.08; }
  .node.hot text { fill: var(--text); }
</style>
</head>
<body>
<div id="chart"></div>
<script type="application/json" id="graph-data">${data}</script>
<script>
(function () {
  const graph = JSON.parse(document.getElementById("graph-data").textContent);
  const chart = document.getElementById("chart");

  let simulation = null;
  let svg = null;
  let zoomBehavior = null;

  function clearChart() {
    if (simulation) {
      simulation.stop();
      simulation = null;
    }
    chart.innerHTML = "";
    svg = null;
    zoomBehavior = null;
  }

  function render() {
    clearChart();
    const width = chart.clientWidth || window.innerWidth;
    const height = chart.clientHeight || window.innerHeight;
    const nodes = graph.nodes.map(function (n) { return Object.assign({}, n); });
    const links = graph.links.map(function (l) {
      return { source: l.source, target: l.target, kind: l.kind };
    });

    svg = d3.select(chart).append("svg")
      .attr("viewBox", [0, 0, width, height])
      .attr("width", width)
      .attr("height", height);

    const root = svg.append("g");

    zoomBehavior = d3.zoom()
      .scaleExtent([0.1, 8])
      .on("zoom", function (event) {
        root.attr("transform", event.transform);
      });
    svg.call(zoomBehavior);

    const link = root.append("g")
      .attr("class", "links")
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("class", "link");

    const node = root.append("g")
      .attr("class", "nodes")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr("class", "node")
      .call(d3.drag()
        .on("start", dragstarted)
        .on("drag", dragged)
        .on("end", dragended));

    node.append("circle")
      .attr("r", 5)
      .append("title")
      .text(function (d) {
        return d.path ? (d.name + "\\n" + d.path) : d.name;
      });

    node.append("text")
      .attr("dx", 8)
      .attr("dy", 3)
      .text(function (d) { return d.name; });

    const neighbors = new Map();
    nodes.forEach(function (n) { neighbors.set(n.id, new Set([n.id])); });
    links.forEach(function (l) {
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      if (!neighbors.has(s)) neighbors.set(s, new Set([s]));
      if (!neighbors.has(t)) neighbors.set(t, new Set([t]));
      neighbors.get(s).add(t);
      neighbors.get(t).add(s);
    });

    node.on("mouseenter", function (_event, d) {
      const keep = neighbors.get(d.id) || new Set([d.id]);
      node.classed("dim", function (n) { return !keep.has(n.id); });
      node.classed("hot", function (n) { return n.id === d.id; });
      link.classed("dim", function (l) {
        const s = typeof l.source === "object" ? l.source.id : l.source;
        const t = typeof l.target === "object" ? l.target.id : l.target;
        return !(keep.has(s) && keep.has(t));
      });
    }).on("mouseleave", function () {
      node.classed("dim", false).classed("hot", false);
      link.classed("dim", false);
    });

    simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id(function (d) { return d.id; }).distance(60).strength(0.4))
      .force("charge", d3.forceManyBody().strength(nodes.length > 400 ? -40 : -120))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide().radius(10))
      .on("tick", ticked);

    function ticked() {
      link
        .attr("x1", function (d) { return d.source.x; })
        .attr("y1", function (d) { return d.source.y; })
        .attr("x2", function (d) { return d.target.x; })
        .attr("y2", function (d) { return d.target.y; });
      node.attr("transform", function (d) {
        return "translate(" + d.x + "," + d.y + ")";
      });
    }

    function dragstarted(event, d) {
      // Keep zoom from treating the pointer as a pan while dragging a node.
      if (event.sourceEvent) event.sourceEvent.stopPropagation();
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }
    function dragged(event, d) {
      // event.x/y are SVG viewport coords; invert through the active zoom
      // so fixed positions stay in the same space as the simulation.
      const t = d3.zoomTransform(svg.node());
      d.fx = t.invertX(event.x);
      d.fy = t.invertY(event.y);
    }
    function dragended(event, d) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    }
  }

  window.addEventListener("resize", render);
  render();
})();
</script>
</body>
</html>
`;
}
