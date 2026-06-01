/**
 * Graph Export Formatters
 *
 * Exports the CodeGraph knowledge graph to DOT, Mermaid, Cytoscape JSON,
 * and self-contained HTML (vis-network) formats.
 */

import { Node, Edge, NodeKind } from '../types';

export type ExportFormat = 'dot' | 'mermaid' | 'cytoscape' | 'html';

// Colour palette for node kinds — used in all visual formats.
const NODE_COLORS: Record<NodeKind, string> = {
  file:        '#9E9E9E',
  module:      '#607D8B',
  class:       '#2196F3',
  struct:      '#03A9F4',
  interface:   '#00BCD4',
  trait:       '#009688',
  protocol:    '#4CAF50',
  function:    '#8BC34A',
  method:      '#66BB6A',
  property:    '#FFC107',
  field:       '#FF9800',
  variable:    '#FF5722',
  constant:    '#F44336',
  enum:        '#E91E63',
  enum_member: '#CE93D8',
  type_alias:  '#673AB7',
  namespace:   '#3F51B5',
  parameter:   '#A1887F',
  import:      '#BDBDBD',
  export:      '#90A4AE',
  route:       '#FF1744',
  component:   '#26C6DA',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeDotString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function escapeMermaidLabel(s: string): string {
  // Mermaid node labels must not contain quotes or structural characters.
  return s.replace(/['"[\](){}|<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build a node set for fast membership tests and filter edges whose
 * both endpoints are present.
 */
function boundEdges(nodes: Node[], edges: Edge[]): Edge[] {
  const ids = new Set(nodes.map(n => n.id));
  return edges.filter(e => ids.has(e.source) && ids.has(e.target));
}

// =============================================================================
// DOT
// =============================================================================

export function formatDot(nodes: Node[], edges: Edge[], title = 'CodeGraph'): string {
  const visibleEdges = boundEdges(nodes, edges);
  const lines: string[] = [
    `digraph "${escapeDotString(title)}" {`,
    '  rankdir=LR;',
    '  node [shape=box, style="filled,rounded", fontname="Helvetica", fontsize=10];',
    '  edge [fontname="Helvetica", fontsize=9, arrowsize=0.7];',
    '',
  ];

  for (const n of nodes) {
    const color = NODE_COLORS[n.kind] ?? '#9E9E9E';
    const label = `${escapeDotString(n.name)}\\n${n.kind}`;
    const tooltip = escapeDotString(`${n.filePath}:${n.startLine}`);
    lines.push(`  "${n.id}" [label="${label}", fillcolor="${color}22", color="${color}", tooltip="${tooltip}"];`);
  }

  lines.push('');

  for (const e of visibleEdges) {
    lines.push(`  "${e.source}" -> "${e.target}" [label="${e.kind}"];`);
  }

  lines.push('}');
  return lines.join('\n');
}

// =============================================================================
// Mermaid
// =============================================================================

export function formatMermaid(nodes: Node[], edges: Edge[], title = 'CodeGraph'): string {
  const visibleEdges = boundEdges(nodes, edges);
  // Mermaid requires alphanumeric IDs; map the hash IDs to N0…Nn.
  const idMap = new Map<string, string>(nodes.map((n, i) => [n.id, `N${i}`]));

  const lines: string[] = [
    `%% ${title}`,
    'flowchart LR',
  ];

  for (const n of nodes) {
    const mid = idMap.get(n.id)!;
    const label = escapeMermaidLabel(`${n.name} · ${n.kind}`);
    lines.push(`  ${mid}["${label}"]`);
  }

  lines.push('');

  for (const e of visibleEdges) {
    const src = idMap.get(e.source)!;
    const tgt = idMap.get(e.target)!;
    lines.push(`  ${src} -->|${e.kind}| ${tgt}`);
  }

  return lines.join('\n');
}

// =============================================================================
// Cytoscape JSON
// =============================================================================

export function formatCytoscape(nodes: Node[], edges: Edge[]): string {
  const visibleEdges = boundEdges(nodes, edges);
  const elements: Array<{ data: Record<string, unknown> }> = [];

  for (const n of nodes) {
    elements.push({
      data: {
        id: n.id,
        label: n.name,
        kind: n.kind,
        filePath: n.filePath,
        startLine: n.startLine,
        language: n.language,
        color: NODE_COLORS[n.kind] ?? '#9E9E9E',
      },
    });
  }

  for (const e of visibleEdges) {
    elements.push({
      data: {
        id: `${e.source}__${e.target}__${e.kind}`,
        source: e.source,
        target: e.target,
        kind: e.kind,
        ...(e.provenance ? { provenance: e.provenance } : {}),
      },
    });
  }

  return JSON.stringify({ elements }, null, 2);
}

// =============================================================================
// HTML (cytoscape.js — batch layout, sidebar filters, search)
// =============================================================================

export function formatHtml(nodes: Node[], edges: Edge[], title = 'CodeGraph'): string {
  const visibleEdges = boundEdges(nodes, edges);

  // Kind counts for sidebar checkboxes
  const kindCounts = new Map<NodeKind, number>();
  for (const n of nodes) kindCounts.set(n.kind, (kindCounts.get(n.kind) ?? 0) + 1);
  const kindsPresent = [...kindCounts.keys()].sort() as NodeKind[];

  const cyNodes = nodes.map(n => ({
    data: {
      id: n.id,
      label: n.name,
      kind: n.kind,
      color: NODE_COLORS[n.kind] ?? '#9E9E9E',
      tip: `${n.kind} · ${n.filePath}:${n.startLine}`,
    },
  }));

  const cyEdges = visibleEdges.map((e, i) => ({
    data: {
      id: `e${i}`,
      source: e.source,
      target: e.target,
      label: e.kind,
      dashed: e.provenance === 'heuristic',
    },
  }));

  const sidebarRows = kindsPresent.map(k => {
    const color = NODE_COLORS[k] ?? '#9E9E9E';
    const count = kindCounts.get(k) ?? 0;
    return `<label class="kind-row"><input type="checkbox" checked data-kind="${k}"><span class="dot" style="background:${color}"></span><span class="kname">${k}</span><span class="kcount">${count}</span></label>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.28.1/cytoscape.min.js" crossorigin="anonymous"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#1a1a2e;color:#e0e0e0;height:100vh;display:flex;flex-direction:column;overflow:hidden}
header{padding:8px 16px;background:#16213e;border-bottom:1px solid #0f3460;display:flex;align-items:center;gap:12px;flex-shrink:0;flex-wrap:wrap}
h1{font-size:14px;font-weight:600;white-space:nowrap}
.stats{font-size:11px;color:#888;white-space:nowrap}
.search-wrap{display:flex;align-items:center;gap:6px;flex:1;min-width:160px;max-width:320px;position:relative}
#search{width:100%;background:#0d1b35;border:1px solid #1a4a80;border-radius:4px;color:#e0e0e0;padding:4px 28px 4px 8px;font-size:11px;outline:none}
#search:focus{border-color:#4a90d9}
#search-clear{position:absolute;right:6px;cursor:pointer;color:#666;font-size:14px;line-height:1;display:none;background:none;border:none;color:#888}
#match-count{font-size:11px;color:#888;white-space:nowrap;min-width:60px}
.btn{background:#0f3460;border:1px solid #1a4a80;color:#ccc;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;white-space:nowrap}
.btn:hover{background:#1a4a80}
.main{flex:1;display:flex;overflow:hidden}
.sidebar{width:168px;flex-shrink:0;background:#13193a;border-right:1px solid #0f3460;display:flex;flex-direction:column;overflow:hidden}
.sidebar-hd{padding:8px 10px 6px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #0f3460;flex-shrink:0}
.sidebar-hd span{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:#666}
.toggle-all{font-size:10px;color:#4a90d9;cursor:pointer;background:none;border:none;padding:0}
.toggle-all:hover{color:#6ab0ff}
.kind-list{overflow-y:auto;flex:1;padding:6px 0}
.kind-row{display:flex;align-items:center;gap:6px;padding:4px 10px;cursor:pointer;user-select:none}
.kind-row:hover{background:#1a2550}
.kind-row input{cursor:pointer;accent-color:#4a90d9;flex-shrink:0}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.kname{flex:1;font-size:11px;color:#ccc}
.kcount{font-size:10px;color:#555}
#cy{flex:1}
#loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#1a1a2ecc;z-index:20;flex-direction:column;gap:10px}
.spinner{width:30px;height:30px;border:3px solid #333;border-top-color:#4a90d9;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-txt{font-size:13px;color:#888}
#tooltip{position:fixed;background:#16213e;border:1px solid #0f3460;border-radius:6px;padding:6px 10px;font-size:11px;color:#ccc;pointer-events:none;display:none;max-width:300px;z-index:30;line-height:1.6}
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <span class="stats">${nodes.length.toLocaleString()} nodes &middot; ${visibleEdges.length.toLocaleString()} edges</span>
  <div class="search-wrap">
    <input id="search" type="search" placeholder="Search nodes&hellip;" autocomplete="off" spellcheck="false">
    <button id="search-clear" title="Clear">&times;</button>
  </div>
  <span id="match-count"></span>
  <button class="btn" onclick="cy.fit()">Fit</button>
  <button class="btn" onclick="cy.reset()">Reset</button>
</header>
<div class="main">
  <aside class="sidebar">
    <div class="sidebar-hd">
      <span>Node kinds</span>
      <button class="toggle-all" id="toggle-all">none</button>
    </div>
    <div class="kind-list">${sidebarRows}</div>
  </aside>
  <div id="cy"></div>
</div>
<div id="loading"><div class="spinner"></div><span class="loading-txt">Computing layout&hellip;</span></div>
<div id="tooltip"></div>
<script>
(function(){
const elements=${JSON.stringify([...cyNodes, ...cyEdges])};
const cy=cytoscape({
  container:document.getElementById('cy'),
  elements,
  style:[
    {selector:'node',style:{
      'background-color':'data(color)',
      'label':'data(label)',
      'color':'#fff',
      'font-size':'10px',
      'text-valign':'center',
      'text-halign':'center',
      'width':28,'height':28,
      'border-width':2,
      'border-color':'data(color)',
      'border-opacity':0.6,
      'text-outline-width':2,
      'text-outline-color':'data(color)',
    }},
    {selector:'node:selected',style:{'border-width':3,'border-color':'#fff','border-opacity':1}},
    {selector:'edge',style:{
      'line-color':'#2a2a4c',
      'target-arrow-color':'#2a2a4c',
      'target-arrow-shape':'triangle',
      'arrow-scale':0.8,
      'curve-style':'bezier',
      'width':1.5,'opacity':0.6,
    }},
    {selector:'edge[?dashed]',style:{'line-style':'dashed'}},
    {selector:'edge:selected',style:{
      'line-color':'#4a90d9','target-arrow-color':'#4a90d9',
      'label':'data(label)','color':'#aaa','font-size':'9px',
      'text-rotation':'autorotate',
      'text-background-color':'#1a1a2e','text-background-opacity':1,'text-background-padding':'2px',
      'opacity':1,
    }},
    {selector:'.faded',style:{'opacity':0.08}},
    {selector:'.search-match',style:{'border-width':3,'border-color':'#FFD700','border-opacity':1,'z-index':9999}},
    {selector:'.search-dim',style:{'opacity':0.1}},
    {selector:'node:active',style:{'overlay-opacity':0}},
  ],
  layout:{name:'cose',animate:false,randomize:false,fit:true,padding:40,
    idealEdgeLength:80,nodeRepulsion:8000,edgeElasticity:200,gravity:0.4,numIter:500},
  wheelSensitivity:0.3,minZoom:0.05,maxZoom:5,
});

document.getElementById('loading').style.display='none';

// ── Kind filter ────────────────────────────────────────────────────────────
function refreshEdges(){
  cy.edges().forEach(function(e){
    (e.source().visible()&&e.target().visible())?e.show():e.hide();
  });
}

document.querySelectorAll('.kind-row input').forEach(function(cb){
  cb.addEventListener('change',function(){
    const kind=this.dataset.kind;
    this.checked?cy.nodes('[kind="'+kind+'"]').show():cy.nodes('[kind="'+kind+'"]').hide();
    refreshEdges();
  });
});

// All / None toggle
let allChecked=true;
document.getElementById('toggle-all').addEventListener('click',function(){
  allChecked=!allChecked;
  this.textContent=allChecked?'none':'all';
  document.querySelectorAll('.kind-row input').forEach(function(cb){
    cb.checked=allChecked;
    const kind=cb.dataset.kind;
    allChecked?cy.nodes('[kind="'+kind+'"]').show():cy.nodes('[kind="'+kind+'"]').hide();
  });
  refreshEdges();
});

// ── Search ─────────────────────────────────────────────────────────────────
const searchEl=document.getElementById('search');
const clearBtn=document.getElementById('search-clear');
const matchCount=document.getElementById('match-count');
let searchTimer=null;

function runSearch(q){
  cy.elements().removeClass('search-match search-dim faded');
  if(!q){matchCount.textContent='';return;}
  const lq=q.toLowerCase();
  const matches=cy.nodes(':visible').filter(function(n){
    return n.data('label').toLowerCase().includes(lq);
  });
  if(matches.length===0){
    matchCount.textContent='no matches';
    return;
  }
  cy.elements(':visible').addClass('search-dim');
  matches.removeClass('search-dim').addClass('search-match');
  matches.connectedEdges(':visible').removeClass('search-dim');
  matchCount.textContent=matches.length+' match'+(matches.length===1?'':'es');
  cy.fit(matches,60);
}

searchEl.addEventListener('input',function(){
  const q=this.value.trim();
  clearBtn.style.display=q?'block':'none';
  clearTimeout(searchTimer);
  searchTimer=setTimeout(function(){runSearch(q);},220);
});

clearBtn.addEventListener('click',function(){
  searchEl.value='';
  clearBtn.style.display='none';
  matchCount.textContent='';
  cy.elements().removeClass('search-match search-dim');
  searchEl.focus();
});

// ── Tooltip ────────────────────────────────────────────────────────────────
const tip=document.getElementById('tooltip');
cy.on('mouseover','node',function(e){
  const d=e.target.data();
  tip.innerHTML='<strong>'+d.label+'</strong><br><span style="color:#888">'+d.tip+'</span>';
  tip.style.display='block';
});
cy.on('mouseout','node',function(){tip.style.display='none';});
cy.on('mousemove',function(e){
  tip.style.left=(e.originalEvent.clientX+14)+'px';
  tip.style.top=(e.originalEvent.clientY+14)+'px';
});

// ── Neighbourhood highlight on click ──────────────────────────────────────
cy.on('tap','node',function(e){
  cy.elements().removeClass('faded search-match search-dim');
  searchEl.value='';clearBtn.style.display='none';matchCount.textContent='';
  const hood=e.target.closedNeighborhood();
  cy.elements().not(hood).addClass('faded');
});
cy.on('tap',function(e){
  if(e.target===cy){cy.elements().removeClass('faded');}
});

window.cy=cy;
})();
</script>
</body>
</html>`;
}
