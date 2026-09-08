/**
 * The dashboard page: one filter row, a grid of panels, and a fetch per panel.
 *
 * Deliberate properties:
 * - **One filter row, above everything it scopes.** Changing the range or
 *   hitting refresh re-queries every panel against the same slice; no panel
 *   carries its own time control.
 * - **Panels fail alone.** Each one fetches, draws, and reports independently,
 *   so a 503 on one query leaves the other eighteen on screen instead of
 *   blanking the page.
 * - **No client-side cache.** The only reuse is deduplicating identical URLs
 *   within a single render (four stat tiles read one /api/summary); that map is
 *   thrown away afterwards, so refresh really does re-ask. Anything longer-lived
 *   is the API's `Cache-Control` doing its job in the browser's own cache.
 * - **No skeleton flash.** A refetch dims the previous render instead of tearing
 *   it down, so nothing jumps while new numbers land.
 * - **Every chart has a table twin.** "Show numbers" reveals the same data as
 *   text, which is what keeps a value from being reachable only by hovering.
 */

import { PANELS } from './panels.js';
import { applyChartDefaults, shortDay } from './theme.js';

const RANGE_PRESETS = [
  { days: 7, label: 'Last 7 days' },
  { days: 14, label: 'Last 14 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];
const DEFAULT_PRESET = 30;
const DAY_MS = 86_400_000;

const Chart = window.Chart;

/** Every fetch goes through here so an expired session lands on /login instead
 *  of failing silently mid-render. */
export async function api(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (response.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new Error('session expired');
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? `responded ${response.status}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

const utcDay = (atMs) => new Date(atMs).toISOString().slice(0, 10);
const dayMs = (day) => Date.parse(`${day}T00:00:00Z`);
const addDays = (day, delta) => utcDay(dayMs(day) + delta * DAY_MS);
const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(dayMs(value));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  /** Latest day the nightly rollup has written; every preset ends here. */
  anchor: utcDay(Date.now()),
  earliest: null,
  preset: DEFAULT_PRESET,
  custom: { from: null, to: null },
  /** Panels whose table twin the reader has opened, kept across re-renders. */
  openTables: new Set(),
  renderToken: 0,
};

const charts = new Map();

function currentRange() {
  if (state.preset === 'custom' && state.custom.from && state.custom.to) {
    return { from: state.custom.from, to: state.custom.to };
  }
  const to = state.anchor;
  return { from: addDays(to, -(state.preset - 1)), to };
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);

// ---------------------------------------------------------------------------
// Building the page
// ---------------------------------------------------------------------------

function buildFilters() {
  const bar = document.getElementById('filters');
  const presets = $(bar, 'presets');

  for (const preset of RANGE_PRESETS) {
    const button = el('button', 'range', preset.label);
    button.type = 'button';
    button.dataset.days = String(preset.days);
    button.addEventListener('click', () => {
      state.preset = preset.days;
      syncFilters();
      render();
    });
    presets.append(button);
  }

  const from = $(bar, 'custom-from');
  const to = $(bar, 'custom-to');
  const apply = $(bar, 'custom-apply');
  apply.addEventListener('click', () => {
    if (!isDay(from.value) || !isDay(to.value)) {
      setRangeSummary('Enter both dates as YYYY-MM-DD.');
      return;
    }
    if (from.value > to.value) {
      setRangeSummary('The start date must come before the end date.');
      return;
    }
    state.preset = 'custom';
    state.custom = { from: from.value, to: to.value };
    syncFilters();
    render();
  });

  $(bar, 'refresh').addEventListener('click', () => {
    refreshMeta().finally(render);
  });
}

function syncFilters() {
  const bar = document.getElementById('filters');
  for (const button of bar.querySelectorAll('button.range')) {
    const selected = String(state.preset) === button.dataset.days;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  const { from, to } = currentRange();
  $(bar, 'custom-from').value = from;
  $(bar, 'custom-to').value = to;
}

function setRangeSummary(text) {
  document.getElementById('range-summary').textContent = text;
}

function buildPanels() {
  const grid = document.getElementById('grid');
  for (const panel of PANELS) {
    const section = el('section', `panel span-${panel.span}`);
    section.id = `panel-${panel.id}`;
    section.dataset.panel = panel.id;
    section.dataset.state = 'loading';

    const head = el('div', 'panel-head');
    head.append(el('h2', null, panel.title));
    const figure = el('p', 'panel-figure');
    figure.dataset.role = 'figure';
    head.append(figure);
    section.append(head);

    if (panel.note) section.append(el('p', 'panel-note', panel.note));

    const body = el('div', 'panel-body');
    body.dataset.role = 'body';
    if (panel.kind === 'chart') {
      const wrap = el('div', 'chart-wrap');
      const canvas = document.createElement('canvas');
      canvas.dataset.role = 'canvas';
      // Chart.js renders to canvas, so the accessible copy is the table twin
      // below — say so rather than leaving a bare graphic.
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `${panel.title}. The same data is in the table below.`);
      wrap.append(canvas);
      body.append(wrap);
    } else if (panel.kind === 'stat') {
      const stat = el('div', 'stat');
      stat.dataset.role = 'stat';
      stat.append(el('p', 'stat-value'), el('p', 'stat-caption'));
      body.append(stat);
    } else if (panel.kind === 'funnel') {
      const funnel = el('div', 'funnel');
      funnel.dataset.role = 'funnel';
      body.append(funnel);
    }

    const status = el('p', 'panel-state');
    status.dataset.role = 'state';
    body.append(status);
    section.append(body);

    const toggle = el('button', 'link', 'Show numbers');
    toggle.type = 'button';
    toggle.dataset.role = 'toggle';
    toggle.setAttribute('aria-expanded', 'false');
    const table = el('div', 'table-wrap');
    table.dataset.role = 'table';
    table.hidden = true;
    toggle.addEventListener('click', () => {
      const open = table.hidden;
      table.hidden = !open;
      toggle.textContent = open ? 'Hide numbers' : 'Show numbers';
      toggle.setAttribute('aria-expanded', String(open));
      if (open) state.openTables.add(panel.id);
      else state.openTables.delete(panel.id);
    });
    section.append(toggle, table);

    grid.append(section);
  }
}

// ---------------------------------------------------------------------------
// Drawing one panel
// ---------------------------------------------------------------------------

function setState(section, name, message) {
  section.dataset.state = name;
  $(section, 'state').textContent = message ?? '';
}

function drawTable(section, spec) {
  const host = $(section, 'table');
  host.replaceChildren();
  if (!spec) return;

  const table = el('table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const column of spec.columns) {
    const th = el('th', null, column);
    th.scope = 'col';
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = el('tbody');
  for (const row of spec.rows) {
    const tr = el('tr');
    row.forEach((cell, i) => {
      const node = el(i === 0 ? 'th' : 'td', null, String(cell));
      if (i === 0) node.scope = 'row';
      tr.append(node);
    });
    tbody.append(tr);
  }
  table.append(thead, tbody);
  host.append(table);
}

function drawStat(section, stat) {
  const host = $(section, 'stat');
  host.querySelector('.stat-value').textContent = stat.value;
  host.querySelector('.stat-caption').textContent = stat.caption ?? '';
}

/**
 * The two-stage conversion funnel, drawn as proportional bars rather than a
 * chart: two bars and a percentage is the whole story, and a two-slice pie or a
 * two-bar chart would be more chrome than data.
 */
function drawFunnel(section, funnel) {
  const host = $(section, 'funnel');
  host.replaceChildren();

  for (const stage of funnel.stages) {
    const row = el('div', 'funnel-stage');
    const head = el('div', 'funnel-label');
    head.append(el('span', null, stage.label), el('span', 'funnel-value', stage.value.toLocaleString('en-US')));
    const track = el('div', 'funnel-track');
    const fill = el('div', 'funnel-fill');
    // Width is the datum, so it is set from JS rather than a style attribute —
    // the CSP here allows no inline styles at all.
    fill.style.width = `${Math.max(0, Math.min(1, stage.share)) * 100}%`;
    track.append(fill);
    row.append(head, track);
    host.append(row);
  }

  const rate = funnel.rate === null ? '—' : `${(funnel.rate * 100).toFixed(1)}%`;
  host.append(
    el('p', 'funnel-summary', `${rate} converted · ${funnel.dropped.toLocaleString('en-US')} dropped off`),
  );
}

function drawChart(section, panel, config) {
  const canvas = $(section, 'canvas');
  const existing = charts.get(panel.id);
  if (existing) existing.destroy();
  charts.set(panel.id, new Chart(canvas, config));
}

async function drawPanel(panel, request, token) {
  const section = document.getElementById(`panel-${panel.id}`);
  section.dataset.stale = 'true';

  try {
    const data = await request;
    // A slower panel from a superseded render must never overwrite the current one.
    if (token !== state.renderToken) return;

    if (panel.empty?.(data)) {
      setState(section, 'empty', 'Nothing in this range.');
      drawTable(section, panel.table?.(data));
      return;
    }

    if (panel.kind === 'stat') drawStat(section, panel.stat(data));
    else if (panel.kind === 'funnel') drawFunnel(section, panel.funnel(data));
    else drawChart(section, panel, panel.chart(data));

    $(section, 'figure').textContent = panel.figure ? panel.figure(data) : '';
    drawTable(section, panel.table?.(data));
    setState(section, 'ready');
  } catch (err) {
    if (token !== state.renderToken) return;
    // One panel's failure is one panel's problem: the message lands in the
    // panel, the rest of the page keeps its data.
    setState(section, 'error', `Could not load this panel — ${err.message ?? err}`);
    const chart = charts.get(panel.id);
    if (chart) {
      chart.destroy();
      charts.delete(panel.id);
    }
  } finally {
    if (token === state.renderToken) section.dataset.stale = 'false';
  }
}

// ---------------------------------------------------------------------------
// Rendering everything
// ---------------------------------------------------------------------------

async function refreshMeta() {
  try {
    const meta = await api('/api/meta');
    if (meta.latest_day) state.anchor = meta.latest_day;
    state.earliest = meta.earliest_day ?? null;
    syncFilters();
  } catch {
    // A meta failure is not fatal: the picker falls back to today's date and
    // every panel still answers. The banner is what says so.
    document.getElementById('data-through').textContent = 'Could not read the data range.';
  }
}

async function render() {
  const token = ++state.renderToken;
  const { from, to } = currentRange();
  const query = `from=${from}&to=${to}`;

  setRangeSummary(`${shortDay(from)} – ${shortDay(to)}, ${to.slice(0, 4)}`);
  document.getElementById('data-through').textContent = `Data through ${shortDay(state.anchor)}`;

  // Deduplicate identical URLs within THIS render only — the four stat tiles
  // share one /api/summary. Discarded when the render ends, so refresh refetches.
  const inFlight = new Map();
  const request = (path) => {
    if (!inFlight.has(path)) inFlight.set(path, api(path));
    return inFlight.get(path);
  };

  await Promise.allSettled(PANELS.map((panel) => drawPanel(panel, request(panel.source(query)), token)));

  if (token === state.renderToken) {
    document.getElementById('refreshed-at').textContent =
      `Last refreshed ${new Date().toLocaleTimeString('en-US')}`;
    document.body.dataset.ready = 'true';
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (!Chart) {
  document.getElementById('data-through').textContent =
    'The chart library did not load — run `npm run vendor` and reload.';
} else {
  applyChartDefaults(Chart);
  buildFilters();
  buildPanels();
  syncFilters();
  await refreshMeta();
  await render();
}
