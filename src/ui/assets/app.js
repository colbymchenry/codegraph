(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const VIEWBOX = { width: 1400, height: 900 };
  const ATLAS_RECT = { x: 34, y: 64, width: 1332, height: 792 };
  const PALETTE = [
    '#6ee7b7', '#60a5fa', '#fbbf24', '#f472b6',
    '#a78bfa', '#22d3ee', '#fb923c', '#a3e635',
    '#fb7185', '#2dd4bf', '#c084fc', '#cbd5e1',
  ];
  const SEMANTIC_ORDER = [
    'Documents', 'Structure', 'Types', 'Behavior', 'Data', 'Dependencies', 'Other',
  ];
  const SEMANTIC_PALETTE = new Map(SEMANTIC_ORDER.map((name, index) => [name, index]));

  const state = {
    snapshot: null,
    contract: null,
    nodesById: new Map(),
    degrees: new Map(),
    hiddenKinds: new Set(),
    hiddenEdgeKinds: new Set(),
    grouping: 'semantic',
    coloring: 'kind',
    relations: 'aggregate',
    labels: 'auto',
    layout: { groups: [], nodePositions: new Map(), nodeToGroup: new Map() },
    selectedId: null,
    transform: { x: 0, y: 0, scale: 1 },
    panning: null,
    searchTimer: null,
  };

  const graphSvg = document.getElementById('graph');
  const viewport = document.getElementById('viewport');
  const groupLayer = document.getElementById('group-layer');
  const aggregateEdgeLayer = document.getElementById('aggregate-edge-layer');
  const exactEdgeLayer = document.getElementById('exact-edge-layer');
  const nodeLayer = document.getElementById('node-layer');
  const message = document.getElementById('graph-message');
  const legend = document.getElementById('legend');
  const edgeLegend = document.getElementById('edge-legend');
  const distribution = document.getElementById('distribution');
  const inspector = document.getElementById('inspector');
  const selectionKind = document.getElementById('selection-kind');
  const search = document.getElementById('search');
  const searchResults = document.getElementById('search-results');
  const projectCounts = document.getElementById('project-counts');
  const viewCounts = document.getElementById('view-counts');
  const truncationNote = document.getElementById('truncation-note');
  const canvasEyebrow = document.getElementById('canvas-eyebrow');
  const canvasMetrics = document.getElementById('canvas-metrics');
  const groupCount = document.getElementById('group-count');
  const groupBySelect = document.getElementById('group-by');
  const colorBySelect = document.getElementById('color-by');
  const relationModeSelect = document.getElementById('relation-mode');
  const labelModeSelect = document.getElementById('label-mode');

  function safeClass(value) {
    return String(value).replace(/[^a-z0-9_-]/gi, '');
  }

  function kindClass(kind) {
    return `kind-${safeClass(kind)}`;
  }

  function paletteClass(index) {
    return `palette-${Math.abs(index) % PALETTE.length}`;
  }

  function createSvg(tag, attributes = {}) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, String(value));
    }
    return element;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(value || 0);
  }

  function compactLabel(value, maxLength = 20) {
    const text = String(value || '').trim() || '(unnamed)';
    return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  async function fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }

  function semanticRole(node) {
    switch (node.kind) {
      case 'section':
        return 'Documents';
      case 'file':
      case 'module':
      case 'namespace':
        return node.language === 'markdown' ? 'Documents' : 'Structure';
      case 'class':
      case 'struct':
      case 'interface':
      case 'trait':
      case 'protocol':
      case 'enum':
      case 'type_alias':
        return 'Types';
      case 'function':
      case 'method':
      case 'component':
      case 'route':
        return 'Behavior';
      case 'property':
      case 'field':
      case 'variable':
      case 'constant':
      case 'enum_member':
      case 'parameter':
        return 'Data';
      case 'import':
      case 'export':
        return 'Dependencies';
      default:
        return 'Other';
    }
  }

  function topLevelDirectory(filePath) {
    const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const parts = normalized.split('/').filter(Boolean);
    return parts.length > 1 ? parts[0] : '[root]';
  }

  function groupName(node) {
    if (state.grouping === 'directory') return topLevelDirectory(node.filePath);
    if (state.grouping === 'language') return node.language || 'unknown';
    return semanticRole(node);
  }

  function groupSort(a, b) {
    if (state.grouping === 'semantic') {
      const aIndex = SEMANTIC_ORDER.indexOf(a.name);
      const bIndex = SEMANTIC_ORDER.indexOf(b.name);
      return aIndex - bIndex;
    }
    return b.nodes.length - a.nodes.length || a.name.localeCompare(b.name);
  }

  function degreeMap(snapshot) {
    const degrees = new Map(snapshot.nodes.map((node) => [node.id, 0]));
    for (const edge of snapshot.edges) {
      degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
      degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
    }
    return degrees;
  }

  function visibleNode(node) {
    return !state.hiddenKinds.has(node.kind);
  }

  function visibleNodes() {
    return state.snapshot ? state.snapshot.nodes.filter(visibleNode) : [];
  }

  function visibleEdges(nodes = visibleNodes()) {
    if (!state.snapshot) return [];
    const visibleIds = new Set(nodes.map((node) => node.id));
    return state.snapshot.edges.filter(
      (edge) =>
        visibleIds.has(edge.source) &&
        visibleIds.has(edge.target) &&
        !state.hiddenEdgeKinds.has(edge.kind)
    );
  }

  function splitTreemap(items, rect, output) {
    if (items.length === 0) return;
    if (items.length === 1) {
      output.set(items[0].name, rect);
      return;
    }

    const total = items.reduce((sum, item) => sum + item.nodes.length, 0);
    const target = total / 2;
    let running = 0;
    let splitIndex = 1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 1; index < items.length; index += 1) {
      running += items[index - 1].nodes.length;
      const distance = Math.abs(target - running);
      if (distance < bestDistance) {
        bestDistance = distance;
        splitIndex = index;
      }
    }

    const left = items.slice(0, splitIndex);
    const right = items.slice(splitIndex);
    const leftWeight = left.reduce((sum, item) => sum + item.nodes.length, 0);
    const ratio = Math.max(0.08, Math.min(0.92, leftWeight / total));

    if (rect.width >= rect.height) {
      const leftWidth = rect.width * ratio;
      splitTreemap(left, { ...rect, width: leftWidth }, output);
      splitTreemap(
        right,
        { x: rect.x + leftWidth, y: rect.y, width: rect.width - leftWidth, height: rect.height },
        output
      );
    } else {
      const topHeight = rect.height * ratio;
      splitTreemap(left, { ...rect, height: topHeight }, output);
      splitTreemap(
        right,
        { x: rect.x, y: rect.y + topHeight, width: rect.width, height: rect.height - topHeight },
        output
      );
    }
  }

  function groupPaletteIndex(group) {
    if (state.grouping === 'semantic') return SEMANTIC_PALETTE.get(group.name) || 0;
    return hashString(group.name) % PALETTE.length;
  }

  function buildLayout(nodes) {
    const grouped = new Map();
    for (const node of nodes) {
      const name = groupName(node);
      if (!grouped.has(name)) grouped.set(name, []);
      grouped.get(name).push(node);
    }

    const groups = [...grouped.entries()]
      .map(([name, groupNodes]) => ({ name, nodes: groupNodes }))
      .sort(groupSort);
    const rectangles = new Map();
    splitTreemap(groups, ATLAS_RECT, rectangles);
    const nodePositions = new Map();
    const nodeToGroup = new Map();

    for (const group of groups) {
      const rawRect = rectangles.get(group.name);
      const gap = 4;
      const rect = {
        x: rawRect.x + gap,
        y: rawRect.y + gap,
        width: Math.max(2, rawRect.width - gap * 2),
        height: Math.max(2, rawRect.height - gap * 2),
      };
      const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const headerHeight = rect.height >= 62 ? 29 : rect.height >= 34 ? 18 : 4;
      const inner = {
        x: rect.x + 8,
        y: rect.y + headerHeight,
        width: Math.max(2, rect.width - 16),
        height: Math.max(2, rect.height - headerHeight - 7),
      };
      const ordered = [...group.nodes].sort(
        (a, b) =>
          (state.degrees.get(b.id) || 0) - (state.degrees.get(a.id) || 0) ||
          a.kind.localeCompare(b.kind) ||
          a.name.localeCompare(b.name)
      );
      const aspect = Math.max(0.2, inner.width / Math.max(inner.height, 1));
      const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length * aspect)));
      const rows = Math.max(1, Math.ceil(ordered.length / columns));
      const cellWidth = inner.width / columns;
      const cellHeight = inner.height / rows;
      const keyCount = Math.max(1, Math.ceil(ordered.length * 0.025));

      ordered.forEach((node, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const jitter = hashString(node.id);
        const jitterX = (((jitter & 255) / 255) - 0.5) * Math.min(5, cellWidth * 0.32);
        const jitterY = ((((jitter >>> 8) & 255) / 255) - 0.5) * Math.min(5, cellHeight * 0.32);
        const degree = state.degrees.get(node.id) || 0;
        const radius = Math.max(
          1.7,
          Math.min(7.2, Math.min(cellWidth, cellHeight) * 0.24 + Math.log2(degree + 1) * 0.45)
        );
        nodePositions.set(node.id, {
          x: inner.x + cellWidth * (column + 0.5) + jitterX,
          y: inner.y + cellHeight * (row + 0.5) + jitterY,
          radius,
          key: index < keyCount,
        });
        nodeToGroup.set(node.id, group.name);
      });

      group.rect = rect;
      group.center = center;
      group.paletteIndex = groupPaletteIndex(group);
    }

    state.layout = { groups, nodePositions, nodeToGroup };
  }

  function nodeColorClass(node) {
    if (state.coloring === 'kind') return kindClass(node.kind);
    if (state.coloring === 'semantic') {
      return paletteClass(SEMANTIC_PALETTE.get(semanticRole(node)) || 0);
    }
    return paletteClass(hashString(node.language || 'unknown') % PALETTE.length);
  }

  function renderGroups(edges) {
    groupLayer.replaceChildren();
    const internalCounts = new Map();
    for (const edge of edges) {
      const sourceGroup = state.layout.nodeToGroup.get(edge.source);
      const targetGroup = state.layout.nodeToGroup.get(edge.target);
      if (sourceGroup && sourceGroup === targetGroup) {
        internalCounts.set(sourceGroup, (internalCounts.get(sourceGroup) || 0) + 1);
      }
    }
    const totalNodes = state.layout.groups.reduce((sum, group) => sum + group.nodes.length, 0);

    for (const group of state.layout.groups) {
      const color = PALETTE[group.paletteIndex];
      const element = createSvg('g', {
        class: `group ${paletteClass(group.paletteIndex)}`,
        'data-group': group.name,
      });
      const box = createSvg('rect', {
        class: 'group-box',
        x: group.rect.x,
        y: group.rect.y,
        width: group.rect.width,
        height: group.rect.height,
        rx: Math.min(10, group.rect.width / 6, group.rect.height / 6),
        fill: `${color}12`,
        stroke: `${color}78`,
      });
      const title = createSvg('title');
      const percentage = totalNodes ? (group.nodes.length / totalNodes) * 100 : 0;
      title.textContent =
        `${group.name}: ${formatNumber(group.nodes.length)} nodes (${percentage.toFixed(1)}%), ` +
        `${formatNumber(internalCounts.get(group.name) || 0)} internal visible relationships`;
      box.appendChild(title);
      box.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        focusGroup(group);
      });
      element.appendChild(box);

      if (group.rect.width >= 64 && group.rect.height >= 30) {
        const groupTitle = createSvg('text', {
          class: 'group-title',
          x: group.rect.x + 9,
          y: group.rect.y + 16,
        });
        groupTitle.textContent = compactLabel(group.name, Math.max(8, Math.floor(group.rect.width / 7)));
        element.appendChild(groupTitle);
      }
      if (group.rect.width >= 92 && group.rect.height >= 48) {
        const meta = createSvg('text', {
          class: 'group-meta',
          x: group.rect.x + 9,
          y: group.rect.y + 28,
        });
        meta.textContent = `${formatNumber(group.nodes.length)} · ${percentage.toFixed(1)}%`;
        element.appendChild(meta);
      }
      groupLayer.appendChild(element);
    }
  }

  function curvedGroupPath(source, target) {
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const length = Math.max(Math.hypot(dx, dy), 1);
    const bend = Math.min(80, length * 0.14);
    const middleX = (source.x + target.x) / 2 - (dy / length) * bend;
    const middleY = (source.y + target.y) / 2 + (dx / length) * bend;
    return `M ${source.x} ${source.y} Q ${middleX} ${middleY} ${target.x} ${target.y}`;
  }

  function renderAggregateEdges(edges) {
    const groupsByName = new Map(state.layout.groups.map((group) => [group.name, group]));
    const aggregates = new Map();
    for (const edge of edges) {
      const sourceGroup = state.layout.nodeToGroup.get(edge.source);
      const targetGroup = state.layout.nodeToGroup.get(edge.target);
      if (!sourceGroup || !targetGroup || sourceGroup === targetGroup) continue;
      const key = `${sourceGroup}\u0000${targetGroup}`;
      const aggregate = aggregates.get(key) || {
        sourceGroup,
        targetGroup,
        count: 0,
        kinds: new Map(),
      };
      aggregate.count += 1;
      aggregate.kinds.set(edge.kind, (aggregate.kinds.get(edge.kind) || 0) + 1);
      aggregates.set(key, aggregate);
    }

    for (const aggregate of aggregates.values()) {
      const source = groupsByName.get(aggregate.sourceGroup);
      const target = groupsByName.get(aggregate.targetGroup);
      if (!source || !target) continue;
      const path = createSvg('path', {
        class: 'aggregate-edge',
        d: curvedGroupPath(source.center, target.center),
        'stroke-width': Math.min(5, 0.65 + Math.log2(aggregate.count + 1) * 0.62),
        'data-source-group': aggregate.sourceGroup,
        'data-target-group': aggregate.targetGroup,
      });
      const kinds = [...aggregate.kinds.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([kind, count]) => `${kind} ${formatNumber(count)}`)
        .join(', ');
      const title = createSvg('title');
      title.textContent =
        `${aggregate.sourceGroup} -> ${aggregate.targetGroup}: ` +
        `${formatNumber(aggregate.count)} exact visible relationships (${kinds})`;
      path.appendChild(title);
      aggregateEdgeLayer.appendChild(path);
    }
    return aggregates.size;
  }

  function renderExactEdges(edges) {
    let rendered = 0;
    for (const edge of edges) {
      const source = state.layout.nodePositions.get(edge.source);
      const target = state.layout.nodePositions.get(edge.target);
      if (!source || !target) continue;
      const selected =
        Boolean(state.selectedId) &&
        (edge.source === state.selectedId || edge.target === state.selectedId);
      const line = createSvg('line', {
        class: `exact-edge${selected ? ' is-selected-edge' : ''}`,
        x1: source.x,
        y1: source.y,
        x2: target.x,
        y2: target.y,
        'data-kind': edge.kind,
        'data-source': edge.source,
        'data-target': edge.target,
      });
      const title = createSvg('title');
      title.textContent = edge.kind;
      line.appendChild(title);
      exactEdgeLayer.appendChild(line);
      rendered += 1;
    }
    return rendered;
  }

  function renderRelationships(edges) {
    aggregateEdgeLayer.replaceChildren();
    exactEdgeLayer.replaceChildren();
    if (state.relations === 'none') return 0;
    if (state.relations === 'aggregate') return renderAggregateEdges(edges);
    if (state.relations === 'selected') {
      if (!state.selectedId) return 0;
      return renderExactEdges(
        edges.filter(
          (edge) => edge.source === state.selectedId || edge.target === state.selectedId
        )
      );
    }
    return renderExactEdges(edges);
  }

  function renderNodes(nodes) {
    nodeLayer.replaceChildren();
    for (const node of nodes) {
      const position = state.layout.nodePositions.get(node.id);
      if (!position) continue;
      const element = createSvg('g', {
        class:
          `node ${nodeColorClass(node)}` +
          `${node.id === state.selectedId ? ' is-selected' : ''}`,
        transform: `translate(${position.x} ${position.y})`,
        tabindex: '0',
        role: 'button',
        'aria-label': `${node.kind} ${node.name}`,
        'data-id': node.id,
        'data-key': position.key ? 'true' : 'false',
      });
      element.appendChild(createSvg('circle', { r: position.radius }));
      const label = createSvg('text', {
        class: 'node-label',
        x: position.radius + 3,
        y: 3,
      });
      label.textContent = compactLabel(node.name);
      element.appendChild(label);
      const title = createSvg('title');
      title.textContent = `${node.kind}: ${node.qualifiedName}`;
      element.appendChild(title);
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        void inspectNode(node.id, false);
      });
      element.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void inspectNode(node.id, false);
        }
      });
      nodeLayer.appendChild(element);
    }
    updateLabels();
  }

  function renderDistribution() {
    distribution.replaceChildren();
    const total = state.layout.groups.reduce((sum, group) => sum + group.nodes.length, 0);
    const groups = [...state.layout.groups].sort(
      (a, b) => b.nodes.length - a.nodes.length || a.name.localeCompare(b.name)
    );
    groupCount.textContent = `${formatNumber(groups.length)} groups`;
    for (const group of groups) {
      const row = document.createElement('div');
      row.className = 'distribution-row';
      row.dataset.group = group.name;
      const copy = document.createElement('div');
      copy.className = 'distribution-copy';
      const name = document.createElement('strong');
      name.textContent = group.name;
      name.title = group.name;
      const count = document.createElement('span');
      count.textContent = formatNumber(group.nodes.length);
      copy.append(name, count);
      const percentage = document.createElement('span');
      percentage.textContent = total ? `${((group.nodes.length / total) * 100).toFixed(1)}%` : '0%';
      const progress = document.createElement('progress');
      progress.max = Math.max(1, total);
      progress.value = group.nodes.length;
      row.append(copy, percentage, progress);
      row.addEventListener('dblclick', () => focusGroup(group));
      distribution.appendChild(row);
    }
  }

  function legendItem(kind, count, edgeKind = false) {
    const label = document.createElement('label');
    const colorClass = edgeKind
      ? paletteClass(hashString(kind) % PALETTE.length)
      : kindClass(kind);
    label.className = `legend-item ${colorClass}`;
    const hiddenSet = edgeKind ? state.hiddenEdgeKinds : state.hiddenKinds;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !hiddenSet.has(kind);
    checkbox.setAttribute('aria-label', `Show ${kind} ${edgeKind ? 'relationships' : 'nodes'}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) hiddenSet.delete(kind);
      else hiddenSet.add(kind);
      label.classList.toggle('is-hidden', !checkbox.checked);
      renderVisualization();
    });

    const dot = document.createElement('span');
    dot.className = 'legend-dot';
    const name = document.createElement('span');
    name.className = 'legend-label';
    name.textContent = kind;
    const amount = document.createElement('span');
    amount.className = 'legend-count';
    amount.textContent = formatNumber(count);
    label.append(checkbox, dot, name, amount);
    return label;
  }

  function renderLegends(snapshot) {
    legend.replaceChildren();
    edgeLegend.replaceChildren();
    const nodeKinds = Object.entries(snapshot.stats.nodesByKind)
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    const edgeKinds = Object.entries(snapshot.stats.edgesByKind)
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [kind, count] of nodeKinds) legend.appendChild(legendItem(kind, count));
    for (const [kind, count] of edgeKinds) {
      edgeLegend.appendChild(legendItem(kind, count, true));
    }
  }

  function updateLabels() {
    const scale = state.transform.scale;
    for (const element of nodeLayer.querySelectorAll('.node')) {
      let show = false;
      if (state.labels === 'all') show = true;
      else if (state.labels === 'key') show = element.dataset.key === 'true';
      else if (state.labels === 'auto') {
        show = scale >= 2.5 || (scale >= 1.45 && element.dataset.key === 'true');
      }
      element.classList.toggle('show-label', show);
    }
  }

  function updateSummary(nodes, edges, renderedRelations) {
    if (!state.snapshot) return;
    projectCounts.textContent =
      `${formatNumber(state.snapshot.stats.nodeCount)} nodes · ` +
      `${formatNumber(state.snapshot.stats.edgeCount)} edges`;
    viewCounts.textContent =
      `${formatNumber(nodes.length)} nodes · ${formatNumber(edges.length)} edges`;
    truncationNote.textContent = state.snapshot.truncated
      ? `Atlas shows ${formatNumber(state.snapshot.nodes.length)} of ` +
        `${formatNumber(state.snapshot.totalMatchedNodes)} degree-ranked nodes. ` +
        'Search and the inspector still query the full graph.'
      : '';

    canvasMetrics.replaceChildren();
    const metrics = [
      `${formatNumber(state.layout.groups.length)} groups`,
      state.relations === 'aggregate'
        ? `${formatNumber(renderedRelations)} group flows`
        : `${formatNumber(renderedRelations)} visible links`,
    ];
    for (const value of metrics) {
      const item = document.createElement('span');
      item.textContent = value;
      canvasMetrics.appendChild(item);
    }
    const groupingLabels = {
      semantic: 'semantic role',
      directory: 'top-level directory',
      language: 'language',
    };
    canvasEyebrow.textContent = `Grouped by ${groupingLabels[state.grouping]}`;
  }

  function renderVisualization() {
    if (!state.snapshot) return;
    const nodes = visibleNodes();
    const edges = visibleEdges(nodes);
    buildLayout(nodes);
    renderGroups(edges);
    const renderedRelations = renderRelationships(edges);
    renderNodes(nodes);
    renderDistribution();
    updateSummary(nodes, edges, renderedRelations);
  }

  function selectedElement() {
    return nodeLayer.querySelector('.node.is-selected');
  }

  function selectNodeElement(id) {
    selectedElement()?.classList.remove('is-selected');
    const next = [...nodeLayer.querySelectorAll('.node')].find(
      (element) => element.dataset.id === id
    );
    next?.classList.add('is-selected');
    state.selectedId = id;
    if (state.relations === 'selected') {
      const nodes = visibleNodes();
      const edges = visibleEdges(nodes);
      const relationCount = renderRelationships(edges);
      updateSummary(nodes, edges, relationCount);
    }
    return next;
  }

  function focusNode(id) {
    const position = state.layout.nodePositions.get(id);
    if (!position) return false;
    state.transform.scale = Math.max(state.transform.scale, 2.25);
    state.transform.x = VIEWBOX.width / 2 - position.x * state.transform.scale;
    state.transform.y = VIEWBOX.height / 2 - position.y * state.transform.scale;
    updateTransform();
    selectNodeElement(id);
    return true;
  }

  function focusGroup(group) {
    const horizontalScale = (VIEWBOX.width * 0.86) / Math.max(group.rect.width, 1);
    const verticalScale = (VIEWBOX.height * 0.82) / Math.max(group.rect.height, 1);
    state.transform.scale = Math.max(1, Math.min(4, horizontalScale, verticalScale));
    state.transform.x =
      VIEWBOX.width / 2 - (group.rect.x + group.rect.width / 2) * state.transform.scale;
    state.transform.y =
      VIEWBOX.height / 2 - (group.rect.y + group.rect.height / 2) * state.transform.scale;
    updateTransform();
  }

  function detailRow(term, value) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    return [dt, dd];
  }

  function renderRelationList(title, edges, total, neighbors, direction) {
    const fragment = document.createDocumentFragment();
    const heading = document.createElement('h3');
    heading.className = 'relation-heading';
    heading.textContent = `${title} (${formatNumber(total)})`;
    fragment.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'neighbor-list';
    const neighborMap = new Map(neighbors.map((node) => [node.id, node]));
    for (const edge of edges.slice(0, 100)) {
      const neighborId = direction === 'incoming' ? edge.source : edge.target;
      const neighbor = neighborMap.get(neighborId);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'neighbor-button';
      const name = document.createElement('span');
      name.textContent = neighbor ? neighbor.name : neighborId;
      const kind = document.createElement('span');
      kind.textContent = edge.kind;
      button.append(name, kind);
      button.addEventListener('click', () => {
        focusNode(neighborId);
        void inspectNode(neighborId, false);
      });
      list.appendChild(button);
    }
    if (edges.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No relationships in this direction.';
      list.appendChild(empty);
    }
    fragment.appendChild(list);
    return fragment;
  }

  async function inspectNode(id, focus) {
    try {
      const payload = await fetchJson(`/api/node?id=${encodeURIComponent(id)}`);
      const inAtlas = focus ? focusNode(id) : Boolean(selectNodeElement(id));
      selectionKind.hidden = false;
      selectionKind.textContent = payload.node.kind;
      selectionKind.className = `kind-pill ${kindClass(payload.node.kind)}`;

      inspector.replaceChildren();
      const title = document.createElement('h3');
      title.className = 'node-title';
      title.textContent = payload.node.name;
      const path = document.createElement('p');
      path.className = 'node-path';
      path.textContent = payload.node.qualifiedName;
      const details = document.createElement('dl');
      details.className = 'detail-grid';
      details.append(
        ...detailRow('File', payload.node.filePath),
        ...detailRow('Language', payload.node.language),
        ...detailRow('Lines', `${payload.node.startLine}-${payload.node.endLine}`),
        ...detailRow('Node ID', payload.node.id)
      );
      inspector.append(title, path, details);
      inspector.append(
        renderRelationList(
          'Incoming',
          payload.incoming,
          payload.totalIncoming,
          payload.neighbors,
          'incoming'
        ),
        renderRelationList(
          'Outgoing',
          payload.outgoing,
          payload.totalOutgoing,
          payload.neighbors,
          'outgoing'
        )
      );
      if (!inAtlas) {
        const note = document.createElement('p');
        note.className = 'truncated-note';
        note.textContent =
          'This node is outside the bounded atlas snapshot; its exact identity and relationships are still shown.';
        inspector.prepend(note);
      }
      if (payload.truncated) {
        const note = document.createElement('p');
        note.className = 'truncated-note';
        note.textContent =
          `Inspector preview: ${formatNumber(payload.totalIncoming)} incoming and ` +
          `${formatNumber(payload.totalOutgoing)} outgoing relationships in the full graph.`;
        inspector.appendChild(note);
      }
    } catch (error) {
      inspector.replaceChildren();
      const paragraph = document.createElement('p');
      paragraph.className = 'empty-state';
      paragraph.textContent = error instanceof Error ? error.message : String(error);
      inspector.appendChild(paragraph);
    }
  }

  function renderSearchResults(results) {
    searchResults.replaceChildren();
    if (results.length === 0) {
      searchResults.hidden = true;
      return;
    }
    for (const result of results) {
      const node = result.node;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `search-result ${kindClass(node.kind)}`;
      const dot = document.createElement('span');
      dot.className = 'search-result-dot';
      const copy = document.createElement('span');
      copy.className = 'search-result-copy';
      const title = document.createElement('strong');
      title.textContent = node.name;
      const subtitle = document.createElement('small');
      subtitle.textContent = `${node.kind} · ${node.filePath}`;
      copy.append(title, subtitle);
      const language = document.createElement('small');
      language.textContent = node.language;
      button.append(dot, copy, language);
      button.addEventListener('click', () => {
        searchResults.hidden = true;
        search.value = '';
        const focused = focusNode(node.id);
        void inspectNode(node.id, !focused);
      });
      searchResults.appendChild(button);
    }
    searchResults.hidden = false;
  }

  function updateTransform() {
    viewport.setAttribute(
      'transform',
      `translate(${state.transform.x} ${state.transform.y}) scale(${state.transform.scale})`
    );
    updateLabels();
  }

  function fitGraph() {
    state.transform = { x: 0, y: 0, scale: 1 };
    updateTransform();
  }

  function showAll(hiddenSet, container) {
    hiddenSet.clear();
    for (const item of container.querySelectorAll('.legend-item')) {
      item.classList.remove('is-hidden');
      const checkbox = item.querySelector('input');
      if (checkbox) checkbox.checked = true;
    }
    renderVisualization();
  }

  function resetView() {
    state.hiddenKinds.clear();
    state.hiddenEdgeKinds.clear();
    state.grouping = 'semantic';
    state.coloring = 'kind';
    state.relations = 'aggregate';
    state.labels = 'auto';
    groupBySelect.value = state.grouping;
    colorBySelect.value = state.coloring;
    relationModeSelect.value = state.relations;
    labelModeSelect.value = state.labels;
    renderLegends(state.snapshot);
    fitGraph();
    renderVisualization();
  }

  function installInteractions() {
    graphSvg.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = graphSvg.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * VIEWBOX.width;
      const y = ((event.clientY - rect.top) / rect.height) * VIEWBOX.height;
      const oldScale = state.transform.scale;
      const nextScale = Math.max(0.35, Math.min(4, oldScale * Math.exp(-event.deltaY * 0.001)));
      const worldX = (x - state.transform.x) / oldScale;
      const worldY = (y - state.transform.y) / oldScale;
      state.transform.scale = nextScale;
      state.transform.x = x - worldX * nextScale;
      state.transform.y = y - worldY * nextScale;
      updateTransform();
    }, { passive: false });

    graphSvg.addEventListener('pointerdown', (event) => {
      if (event.target.closest?.('.node')) return;
      graphSvg.setPointerCapture(event.pointerId);
      state.panning = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        originX: state.transform.x,
        originY: state.transform.y,
      };
      graphSvg.classList.add('panning');
    });

    graphSvg.addEventListener('pointermove', (event) => {
      if (!state.panning || state.panning.pointerId !== event.pointerId) return;
      const rect = graphSvg.getBoundingClientRect();
      state.transform.x =
        state.panning.originX +
        ((event.clientX - state.panning.x) / rect.width) * VIEWBOX.width;
      state.transform.y =
        state.panning.originY +
        ((event.clientY - state.panning.y) / rect.height) * VIEWBOX.height;
      updateTransform();
    });

    const finishPan = (event) => {
      if (state.panning?.pointerId === event.pointerId) {
        state.panning = null;
        graphSvg.classList.remove('panning');
      }
    };
    graphSvg.addEventListener('pointerup', finishPan);
    graphSvg.addEventListener('pointercancel', finishPan);

    document.getElementById('fit-button').addEventListener('click', fitGraph);
    document.getElementById('reset-view-button').addEventListener('click', resetView);
    document.getElementById('show-all-button').addEventListener(
      'click',
      () => showAll(state.hiddenKinds, legend)
    );
    document.getElementById('show-all-edges-button').addEventListener(
      'click',
      () => showAll(state.hiddenEdgeKinds, edgeLegend)
    );

    groupBySelect.addEventListener('change', () => {
      state.grouping = groupBySelect.value;
      fitGraph();
      renderVisualization();
    });
    colorBySelect.addEventListener('change', () => {
      state.coloring = colorBySelect.value;
      renderVisualization();
    });
    relationModeSelect.addEventListener('change', () => {
      state.relations = relationModeSelect.value;
      renderVisualization();
    });
    labelModeSelect.addEventListener('change', () => {
      state.labels = labelModeSelect.value;
      updateLabels();
    });

    search.addEventListener('input', () => {
      window.clearTimeout(state.searchTimer);
      const query = search.value.trim();
      if (!query) {
        searchResults.hidden = true;
        return;
      }
      state.searchTimer = window.setTimeout(async () => {
        try {
          const payload = await fetchJson(`/api/search?q=${encodeURIComponent(query)}&limit=20`);
          if (search.value.trim() === query) renderSearchResults(payload.results);
        } catch {
          searchResults.hidden = true;
        }
      }, 180);
    });

    document.addEventListener('pointerdown', (event) => {
      if (!searchResults.contains(event.target) && event.target !== search) {
        searchResults.hidden = true;
      }
    });
  }

  async function initialize() {
    installInteractions();
    try {
      const [contract, snapshot] = await Promise.all([
        fetchJson('/api/contract'),
        fetchJson('/api/graph'),
      ]);
      if (!contract.readOnly) throw new Error('Topology endpoint is not read-only');
      state.contract = contract;
      state.snapshot = snapshot;
      state.nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
      state.degrees = degreeMap(snapshot);
      renderLegends(snapshot);
      renderVisualization();
      message.hidden = true;
      document.body.dataset.ready = 'true';
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : String(error);
      message.classList.add('error');
      document.body.dataset.ready = 'error';
    }
  }

  void initialize();
})();
