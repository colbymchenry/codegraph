/**
 * Chart theme — the colours and the Chart.js defaults every panel inherits.
 *
 * The palette is not eyeballed. Both scales below were run through the data-viz
 * validator against this dashboard's actual chart surface (#ffffff, the panel
 * fill — not the page's paper), and both clear every hard gate:
 *
 *   categorical  #a8342a,#2a6f9e,#17916a,#c98500   (light, surface #ffffff, --pairs all)
 *     lightness band PASS · chroma floor PASS · CVD separation PASS (worst pair
 *     ΔE 8.7 protan, all 6 pairs) · normal-vision floor PASS (worst 15.1) ·
 *     contrast PASS (all ≥ 3:1, so no panel depends on the relief rule)
 *
 *   ordinal      #d99a90,#c26a5c,#a3423a,#7a201a   (light, surface #ffffff, --ordinal)
 *     monotone lightness PASS · adjacent ΔL PASS · light-end contrast 2.34:1
 *     PASS · single hue PASS (spread 3°)
 *
 * If you change a hex, re-run the validator rather than trusting your eye —
 * the red/green pair that "looks fine" is the one that collapses under
 * deuteranopia. Slot order is the CVD-safety mechanism: assign in sequence,
 * never cycle, and fold a ninth series into "Other".
 */

/** Panel fill — the surface every contrast number above was measured against. */
export const SURFACE = '#ffffff';
export const INK = '#16150f';
export const SECONDARY = '#56534a';
export const MUTED = '#807d74';
export const GRID = '#e7e5de';
export const AXIS = '#c9c6bc';

/**
 * Categorical — identity. Slot 1 is the brand oxblood stepped up into the
 * lightness band (#7a201a itself is too dark to sit in a categorical scale).
 */
export const CATEGORICAL = ['#a8342a', '#2a6f9e', '#17916a', '#c98500'];

/**
 * Neutral, deliberately outside the categorical scale: "Other" is a leftover,
 * not a series, and should not read as one.
 */
export const NEUTRAL = '#8d8a80';

/**
 * Ordinal — order IS the meaning (run length, codebase size). One hue, light to
 * dark, so the reader sees the ordering in the colour instead of decoding a legend.
 */
export const ORDINAL = ['#d99a90', '#c26a5c', '#a3423a', '#7a201a'];

/** Identity by position, never by rank — a filter must not repaint the survivors. */
export function categorical(index) {
  return CATEGORICAL[index] ?? NEUTRAL;
}

/**
 * Colours for an ordered set of n marks. Four buckets map onto the ramp exactly;
 * a shorter set is spread across it so the light→dark reading survives. Anything
 * past the ramp (an unexpected bucket from an old client) goes neutral rather
 * than inventing a step that would misstate the order.
 */
export function ordinal(n) {
  if (n <= 0) return [];
  if (n === 1) return [ORDINAL[2]];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(i < ORDINAL.length ? ORDINAL[Math.round((i * (ORDINAL.length - 1)) / (n - 1))] : NEUTRAL);
  }
  return out;
}

/** "Other" keeps the neutral wherever the API folded a tail into it. */
export function paletteFor(labels, scale) {
  const hues = scale === 'ordinal' ? ordinal(labels.length) : labels.map((_, i) => categorical(i));
  return labels.map((label, i) => (label === 'Other' ? NEUTRAL : hues[i]));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const PLAIN = new Intl.NumberFormat('en-US');

/** Stat-tile values: 1,284 stays exact; 12,900 becomes 12.9K. */
export function compact(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Math.abs(n) >= 10_000 ? COMPACT.format(n) : PLAIN.format(n);
}

export function number(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return PLAIN.format(n);
}

export function percent(fraction, digits = 1) {
  if (fraction === null || fraction === undefined || Number.isNaN(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** "2026-07-04" → "Jul 4". Axis ticks only; tables keep the full date. */
export function shortDay(day) {
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return day;
  return new Date(parsed).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// ---------------------------------------------------------------------------
// Chart.js defaults
// ---------------------------------------------------------------------------

/**
 * Applied once, before any chart is built. Everything here is the recessive
 * half of the design: hairline grid, muted axis text, no animation loud enough
 * to notice. Text never wears a series colour — identity comes from the mark
 * beside it, which is why the legend uses point-style swatches.
 */
export function applyChartDefaults(Chart) {
  const { defaults } = Chart;
  defaults.font.family =
    "'Archivo', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  defaults.font.size = 12;
  defaults.color = MUTED;
  defaults.borderColor = GRID;
  defaults.maintainAspectRatio = false;
  defaults.animation.duration = 180;

  defaults.plugins.legend.position = 'bottom';
  defaults.plugins.legend.align = 'start';
  defaults.plugins.legend.labels.usePointStyle = true;
  defaults.plugins.legend.labels.pointStyle = 'circle';
  defaults.plugins.legend.labels.boxWidth = 8;
  defaults.plugins.legend.labels.boxHeight = 8;
  defaults.plugins.legend.labels.padding = 14;
  defaults.plugins.legend.labels.color = SECONDARY;

  defaults.plugins.tooltip.backgroundColor = INK;
  defaults.plugins.tooltip.padding = 10;
  defaults.plugins.tooltip.cornerRadius = 0;
  defaults.plugins.tooltip.displayColors = true;
  defaults.plugins.tooltip.usePointStyle = true;
  defaults.plugins.tooltip.boxWidth = 8;
  defaults.plugins.tooltip.boxHeight = 8;

  defaults.elements.line.borderWidth = 2;
  defaults.elements.line.borderJoinStyle = 'round';
  defaults.elements.line.borderCapStyle = 'round';
  defaults.elements.line.tension = 0;
  defaults.elements.point.hoverBorderWidth = 2;
  defaults.elements.bar.borderRadius = 4;
  defaults.elements.arc.borderColor = SURFACE;
  // The 2px surface gap between touching fills — white doing the separating,
  // rather than a stroke drawn around each mark.
  defaults.elements.arc.borderWidth = 2;
}

/**
 * `ticks` is merged rather than replaced: spreading an override on top would
 * silently drop the tick limit and hand back a y-axis labelled every 10%.
 */
const scale = (base, extra) => ({ ...base, ...extra, ticks: { ...base.ticks, ...extra.ticks } });

/** A value axis: hairline grid, clean ticks, always anchored at zero. */
export function valueScale(extra = {}) {
  return scale(
    {
      beginAtZero: true,
      border: { color: AXIS },
      grid: { color: GRID, drawTicks: false },
      ticks: { color: MUTED, padding: 8, maxTicksLimit: 6, precision: 0 },
    },
    extra,
  );
}

/** A category or time axis: no grid at all, so the marks carry the chart. */
export function categoryScale(extra = {}) {
  return scale(
    {
      border: { color: AXIS },
      grid: { display: false },
      ticks: { color: MUTED, padding: 6, autoSkipPadding: 12, maxRotation: 0 },
    },
    extra,
  );
}

/**
 * Crosshair-style reading on anything plotted against days: hovering anywhere in
 * a column reports every series at that day, so a 2px line never has to be hit
 * dead-centre.
 */
export const INDEX_HOVER = { mode: 'index', intersect: false, axis: 'x' };
