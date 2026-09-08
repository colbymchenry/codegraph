/**
 * The panel registry — what the dashboard shows, in the order it shows it.
 *
 * Every panel is data in, chart config out, with no DOM anywhere in this file:
 * app.js owns the page, this owns the mapping from an API response to a chart.
 * Keeping them apart is what lets scripts/render-check.mjs drive the real panel
 * definitions in a real browser and compare what each one plotted against what
 * the API returned.
 *
 * A panel is:
 *   id       stable key, also the DOM id and the anchor in a bug report
 *   title    sentence case, at a readable size — never a tracked-out caps label
 *   note     the honest footnote: what the number actually counts
 *   span     grid columns out of 12
 *   source   (query) => API path; panels sharing a path share one fetch
 *   kind     'stat' | 'funnel' | 'chart'
 *   figure   optional headline shown under the title (pie totals)
 *   empty    (data) => is there nothing to draw
 *   table    (data) => the WCAG-clean twin every chart owes the reader
 */

import {
  CATEGORICAL,
  INDEX_HOVER,
  NEUTRAL,
  SURFACE,
  categoryScale,
  compact,
  number,
  paletteFor,
  percent,
  shortDay,
  valueScale,
} from './theme.js';

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const summary = (q) => `/api/summary?${q}`;
const activation = (q) => `/api/activation?${q}`;
const retention = (q) => `/api/retention?${q}`;
const series = (metric) => (q) => `/api/timeseries?metric=${metric}&${q}`;
const breakdown =
  (dim, extra = '') =>
  (q) =>
    `/api/breakdown?dim=${dim}${extra}&${q}`;

// ---------------------------------------------------------------------------
// Chart builders
// ---------------------------------------------------------------------------

const allZero = (data) => data.datasets.every((ds) => ds.data.every((v) => !v));
const noRows = (data) => data.labels.length === 0 || data.datasets[0].data.every((v) => !v);

/** Alpha-suffixed hex for the ~10% area wash under a single-series line. */
const wash = (hex) => `${hex}1a`;

/**
 * A line per series over days. One axis, always — two measures of different
 * scale get two panels rather than a second y-axis, which would invent a
 * correlation the data does not have.
 */
function lineChart(data, { unit = 'count' } = {}) {
  const dense = data.labels.length > 21;
  const isPercent = unit === 'percent';
  // A wash under a single line reads well — but not across gaps, where the fill
  // would colour in days the series has no value for. Days with no cohort at
  // all are exactly that case, so a gapped series goes unfilled.
  const gapped = data.datasets.some((ds) => ds.data.some((v) => v === null));
  const single = data.datasets.length === 1 && !gapped;

  return {
    type: 'line',
    data: {
      labels: data.labels.map(shortDay),
      datasets: data.datasets.map((ds, i) => {
        const colour = CATEGORICAL[i] ?? NEUTRAL;
        return {
          label: ds.label,
          data: ds.data,
          borderColor: colour,
          backgroundColor: single ? wash(colour) : colour,
          fill: single,
          // Dots on a 90-day line are noise; the index-mode tooltip is how you
          // read a value, and the table view is how you read all of them.
          pointRadius: dense ? 0 : 3,
          pointHoverRadius: 5,
          pointBackgroundColor: colour,
          // 2px surface ring, so a marker stays legible where lines cross.
          pointBorderColor: SURFACE,
          pointBorderWidth: 2,
          spanGaps: false,
        };
      }),
    },
    options: {
      interaction: INDEX_HOVER,
      plugins: {
        // A single series needs no legend box — the panel title names it.
        legend: { display: data.datasets.length > 1 },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              `${ctx.dataset.label}: ${
                ctx.parsed.y === null ? 'no data' : isPercent ? `${ctx.parsed.y}%` : number(ctx.parsed.y)
              }`,
          },
        },
      },
      scales: {
        x: categoryScale(),
        y: valueScale(
          isPercent
            ? { max: 100, ticks: { color: undefined, padding: 8, callback: (v) => `${v}%` } }
            : {},
        ),
      },
    },
  };
}

/**
 * Bands stacked to the day's total, for an ordered split of one measure.
 *
 * Four separate lines is the wrong form here: same-hue ordinal steps crossing
 * each other read as scribble, and the question ("how is run length shifting?")
 * is part-to-whole, not four independent trends. Stacked, the band heights are
 * the mix and the outline is the total. The 2px surface-coloured border is the
 * gap between touching fills — white doing the separating, not a stroke.
 */
function stackedAreaChart(data) {
  const colours = paletteFor(
    data.datasets.map((ds) => ds.label),
    'ordinal',
  );
  const config = lineChart(data);
  config.data.datasets.forEach((ds, i) => {
    ds.backgroundColor = colours[i];
    ds.borderColor = SURFACE;
    ds.borderWidth = 2;
    ds.pointRadius = 0;
    ds.pointHoverRadius = 4;
    ds.pointBackgroundColor = colours[i];
    ds.pointBorderColor = SURFACE;
    ds.fill = true;
  });
  config.options.scales.y.stacked = true;
  // The swatch has to be the band's colour; the line is surface-coloured here.
  config.options.plugins.legend = {
    display: true,
    labels: { generateLabels: () => data.datasets.map((ds, i) => ({
      text: ds.label,
      fillStyle: colours[i],
      strokeStyle: colours[i],
      pointStyle: 'circle',
      datasetIndex: i,
    })) },
  };
  return config;
}

/**
 * Horizontal bars. `scale: 'ordinal'` is for categories whose order is their
 * meaning (run length, codebase size) and takes the one-hue ramp; nominal
 * categories all take slot 1, because colouring them by value would spend the
 * identity channel re-encoding what bar length already says.
 */
function barChart(data, { scale = 'nominal' } = {}) {
  const colours =
    scale === 'ordinal'
      ? paletteFor(data.labels, 'ordinal')
      : data.labels.map((label) => (label === 'Other' ? NEUTRAL : CATEGORICAL[0]));

  return {
    type: 'bar',
    data: {
      labels: data.labels,
      datasets: [
        {
          label: data.datasets[0].label,
          data: data.datasets[0].data,
          backgroundColor: colours,
          maxBarThickness: 24,
          // Rounded at the data end, square at the baseline (Chart.js skips the
          // 'start' edge by default, which is the baseline on a horizontal bar).
          borderRadius: 4,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: valueScale(),
        y: categoryScale({ ticks: { color: undefined, padding: 6, autoSkip: false } }),
      },
    },
  };
}

/** Part-to-whole at a glance. Capped at a handful of slices by the API's `limit`. */
function pieChart(data, { scale = 'categorical' } = {}) {
  const total = data.datasets[0].data.reduce((n, v) => n + v, 0);
  return {
    type: 'pie',
    data: {
      labels: data.labels,
      datasets: [
        {
          label: data.datasets[0].label,
          data: data.datasets[0].data,
          backgroundColor: paletteFor(data.labels, scale === 'ordinal' ? 'ordinal' : 'categorical'),
        },
      ],
    },
    options: {
      plugins: {
        legend: { display: true },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              `${ctx.label}: ${number(ctx.parsed)} (${total > 0 ? percent(ctx.parsed / total, 1) : '—'})`,
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Table twins
// ---------------------------------------------------------------------------

/** Days down the side, one column per series. */
const seriesTable = (data) => ({
  columns: ['Day', ...data.datasets.map((ds) => ds.label)],
  rows: data.labels.map((day, i) => [
    day,
    ...data.datasets.map((ds) => (ds.data[i] === null ? '—' : number(ds.data[i]))),
  ]),
});

/** Both numbers, always — the panel plots one of them, the table shows both. */
const breakdownTable = (data) => ({
  columns: [data.title, 'Events', 'Machine-days'],
  rows: data.rows.map((r) => [r.value, number(r.count), number(r.machines)]),
});

// ---------------------------------------------------------------------------
// The panels
// ---------------------------------------------------------------------------

export const PANELS = [
  {
    id: 'production-users',
    title: 'Production users',
    note: 'Distinct machines active in the range, excluding CI runners.',
    span: 3,
    kind: 'stat',
    source: summary,
    stat: (d) => ({ value: compact(d.production_users), caption: `${number(d.active_machines)} including CI` }),
    table: (d) => ({
      columns: ['Measure', 'Machines'],
      rows: [
        ['Production users', number(d.production_users)],
        ['All active machines', number(d.active_machines)],
        ['First seen in range', number(d.new_machines)],
      ],
    }),
  },
  {
    id: 'installs',
    title: 'Installs',
    note: 'Install events, including upgrades and reinstalls.',
    span: 3,
    kind: 'stat',
    source: summary,
    stat: (d) => ({ value: compact(d.installs), caption: `${number(d.new_machines)} from machines never seen before` }),
    table: (d) => ({
      columns: ['Measure', 'Events'],
      rows: [
        ['Installs', number(d.installs)],
        ['New machines', number(d.new_machines)],
      ],
    }),
  },
  {
    id: 'uninstalls',
    title: 'Uninstalls',
    note: 'Uninstall events in the range.',
    span: 3,
    kind: 'stat',
    source: summary,
    stat: (d) => ({
      value: compact(d.uninstalls),
      caption: d.installs > 0 ? `${percent(d.uninstalls / d.installs)} of installs` : 'No installs in range',
    }),
    table: (d) => ({
      columns: ['Measure', 'Events'],
      rows: [
        ['Uninstalls', number(d.uninstalls)],
        ['Installs', number(d.installs)],
      ],
    }),
  },
  {
    id: 'indexing-runs',
    title: 'Indexing runs',
    note: 'Index events in the range, across every machine.',
    span: 3,
    kind: 'stat',
    source: summary,
    stat: (d) => ({ value: compact(d.index_runs), caption: `${compact(d.tool_calls)} tool and command calls` }),
    table: (d) => ({
      columns: ['Measure', 'Events'],
      rows: [
        ['Indexing runs', number(d.index_runs)],
        ['Tool and command calls', number(d.tool_calls)],
      ],
    }),
  },

  {
    id: 'activation-funnel',
    title: 'Install to first use',
    note: 'Machines first seen in the range that ran an index within 7 days.',
    span: 4,
    kind: 'funnel',
    source: activation,
    empty: (d) => d.installs === 0,
    funnel: (d) => ({
      stages: [
        { label: 'Installed', value: d.installs, share: 1 },
        {
          label: `Indexed within ${d.window_days} days`,
          value: d.activated,
          share: d.installs > 0 ? d.activated / d.installs : 0,
        },
      ],
      rate: d.rate,
      dropped: d.dropped,
    }),
    table: (d) => ({
      columns: ['Stage', 'Machines', 'Share'],
      rows: [
        ['Installed', number(d.installs), '100%'],
        [`Indexed within ${d.window_days} days`, number(d.activated), percent(d.rate)],
        ['Dropped off', number(d.dropped), percent(d.installs > 0 ? d.dropped / d.installs : null)],
      ],
    }),
  },
  {
    id: 'activation-rate',
    title: 'Conversion rate over time',
    note: 'By the day a machine was first seen. Recent days are still converting, so their rate only rises.',
    span: 8,
    kind: 'chart',
    source: activation,
    empty: (d) => d.installs === 0,
    chart: (d) => lineChart(d, { unit: 'percent' }),
    table: (d) => ({
      columns: ['Day', 'Installs', 'Indexed', 'Rate', 'Window elapsed'],
      rows: d.rows.map((r) => [
        r.day,
        number(r.installs),
        number(r.activated),
        percent(r.rate),
        r.complete ? 'Yes' : 'Not yet',
      ]),
    }),
  },

  {
    id: 'os',
    title: 'Users by operating system',
    note: 'Share of machine-days: a machine active on several days counts once per day.',
    span: 4,
    kind: 'chart',
    // Three hues plus a neutral "Other" — the point past which categorical
    // colours stop being reliably distinguishable under colour-vision deficiency.
    source: breakdown('os', '&limit=3'),
    empty: noRows,
    figure: (d) => `${compact(d.total)} machine-days`,
    chart: (d) => pieChart(d),
    table: breakdownTable,
  },
  {
    id: 'run-length',
    title: 'Session run length',
    note: 'Indexing runs by how long they took.',
    span: 4,
    kind: 'chart',
    source: breakdown('duration_bucket'),
    empty: noRows,
    figure: (d) => `${compact(d.total)} runs`,
    chart: (d) => pieChart(d, { scale: 'ordinal' }),
    table: breakdownTable,
  },
  {
    id: 'codebase-size',
    title: 'Codebase size',
    note: 'Files per indexed project.',
    span: 4,
    kind: 'chart',
    source: breakdown('file_count_bucket'),
    empty: noRows,
    chart: (d) => barChart(d, { scale: 'ordinal' }),
    table: breakdownTable,
  },

  {
    id: 'installs-uninstalls',
    title: 'Installs and uninstalls over time',
    note: 'Install and uninstall events per day.',
    span: 6,
    kind: 'chart',
    source: series('installs_uninstalls'),
    empty: allZero,
    chart: (d) => lineChart(d),
    table: seriesTable,
  },
  {
    id: 'new-installs',
    title: 'New installs over time',
    note: 'Machines seen for the first time, by day.',
    span: 6,
    kind: 'chart',
    source: series('new_installs'),
    empty: allZero,
    chart: (d) => lineChart(d),
    table: seriesTable,
  },
  {
    id: 'indexing-activity',
    title: 'Daily indexing activity',
    note: 'Indexing runs and the machines that ran them.',
    span: 6,
    kind: 'chart',
    source: series('indexing_activity'),
    empty: allZero,
    chart: (d) => lineChart(d),
    table: seriesTable,
  },
  {
    id: 'daily-production-users',
    title: 'Daily production users',
    note: 'Distinct machines active each day, excluding CI runners.',
    span: 6,
    kind: 'chart',
    source: series('production_users'),
    empty: allZero,
    chart: (d) => lineChart(d),
    table: seriesTable,
  },
  {
    id: 'run-length-over-time',
    title: 'Run length over time',
    note: 'Indexing runs per day, split by how long they took.',
    span: 6,
    kind: 'chart',
    source: series('duration_buckets'),
    empty: allZero,
    // Ordered buckets, so the bands take the one-hue ramp rather than four
    // unrelated hues: the reader sees "longer" in the colour.
    chart: stackedAreaChart,
    table: seriesTable,
  },
  {
    id: 'retention',
    title: 'Daily retention cohorts',
    note: 'Machines first seen in the range, and the share still active k days later.',
    span: 6,
    kind: 'chart',
    source: retention,
    empty: (d) => d.cohort === 0,
    figure: (d) => `${compact(d.cohort)} machines in cohort`,
    chart: (d) => lineChart(d, { unit: 'percent' }),
    table: (d) => ({
      columns: ['Day', 'Machines old enough', 'Still active', 'Rate'],
      rows: d.rows.map((r) => [
        `Day ${r.day}`,
        number(r.eligible),
        number(r.retained),
        percent(r.rate),
      ]),
    }),
  },

  {
    id: 'languages',
    title: 'Most-indexed programming languages',
    note: 'One count per indexing run that found the language; a mixed repo counts under each.',
    span: 6,
    kind: 'chart',
    source: breakdown('language'),
    empty: noRows,
    chart: (d) => barChart(d),
    table: breakdownTable,
  },
  {
    id: 'indexing-speed',
    title: 'Indexing speed',
    note: 'Indexing runs by duration bucket.',
    span: 6,
    kind: 'chart',
    source: breakdown('duration_bucket'),
    empty: noRows,
    chart: (d) => barChart(d, { scale: 'ordinal' }),
    table: breakdownTable,
  },
  {
    id: 'versions',
    title: 'Users by app version',
    note: 'Machine-days per version, newest first.',
    span: 6,
    kind: 'chart',
    source: breakdown('codegraph_version'),
    empty: noRows,
    chart: (d) => barChart(d),
    table: breakdownTable,
  },
  {
    id: 'targets',
    title: 'AI agent targets',
    note: 'Agents wired up at install time. One install can configure several.',
    span: 6,
    kind: 'chart',
    source: breakdown('target'),
    empty: noRows,
    chart: (d) => barChart(d),
    table: breakdownTable,
  },
];
