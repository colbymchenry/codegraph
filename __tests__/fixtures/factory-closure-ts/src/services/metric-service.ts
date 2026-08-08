import type { FilterSpec, MetricSample, Widget } from '../stores/types';
import { bucketByHour, meanOf, rateOfChange } from '../lib/metrics';

/**
 * Stateless metric helpers — the server-shaped half of the same domain. These
 * are ordinary top-level functions, not closures, so they are the control the
 * factory-closure file is measured against.
 */

const STALE_AFTER_MS = 15 * 60 * 1000;

/** Refresh a cached metric map in place, returning the widgets that changed. */
export function refreshMetricCache(
  cache: Map<string, MetricSample[]>,
  incoming: readonly MetricSample[],
  now: number,
): string[] {
  const touched = new Set<string>();
  for (const sample of incoming) {
    if (typeof sample.value !== 'number' || Number.isNaN(sample.value)) continue;
    const bucket = cache.get(sample.widgetId);
    if (bucket) bucket.push(sample);
    else cache.set(sample.widgetId, [sample]);
    touched.add(sample.widgetId);
  }
  for (const [widgetId, bucket] of cache) {
    const fresh = bucket.filter((s) => now - s.at <= STALE_AFTER_MS);
    if (fresh.length !== bucket.length) {
      cache.set(widgetId, fresh);
      touched.add(widgetId);
    }
  }
  return [...touched].sort();
}

/** Apply a filter spec set to raw samples rather than to widgets. */
export function filterMetrics(
  samples: readonly MetricSample[],
  specs: readonly FilterSpec[],
): MetricSample[] {
  if (specs.length === 0) return samples.slice();
  return samples.filter((sample) => specs.every((spec) => {
    const field = spec.field === 'unit'
      ? sample.unit
      : spec.field === 'widget'
        ? sample.widgetId
        : String(sample.value);
    switch (spec.op) {
      case 'eq': return field === spec.value;
      case 'contains': return field.includes(spec.value);
      case 'gt': return Number(field) > Number(spec.value);
      case 'lt': return Number(field) < Number(spec.value);
      default: return false;
    }
  }));
}

/** Per-widget rollup used by the server-rendered summary card. */
export function rollupByWidget(
  samples: readonly MetricSample[],
  widgets: readonly Widget[],
): Array<{ widgetId: string; title: string; mean: number; slope: number; hours: number }> {
  const titles = new Map(widgets.map((w) => [w.id, w.title]));
  const grouped = new Map<string, MetricSample[]>();
  for (const sample of samples) {
    const bucket = grouped.get(sample.widgetId);
    if (bucket) bucket.push(sample);
    else grouped.set(sample.widgetId, [sample]);
  }

  const out: Array<{ widgetId: string; title: string; mean: number; slope: number; hours: number }> = [];
  for (const [widgetId, bucket] of grouped) {
    out.push({
      widgetId,
      title: titles.get(widgetId) ?? '(unknown)',
      mean: meanOf(bucket),
      slope: rateOfChange(bucket),
      hours: bucketByHour(bucket).size,
    });
  }
  out.sort((a, b) => b.mean - a.mean);
  return out;
}

/** Which widgets have not reported inside the staleness window. */
export function staleWidgets(
  samples: readonly MetricSample[],
  widgets: readonly Widget[],
  now: number,
): string[] {
  const newest = new Map<string, number>();
  for (const sample of samples) {
    const seen = newest.get(sample.widgetId) ?? 0;
    if (sample.at > seen) newest.set(sample.widgetId, sample.at);
  }
  return widgets
    .filter((w) => !w.hidden)
    .filter((w) => now - (newest.get(w.id) ?? 0) > STALE_AFTER_MS)
    .map((w) => w.id)
    .sort();
}
