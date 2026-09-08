import type { FilterSpec, MetricSample, StoreDeps, Widget } from './types';
import { defaultRequestOptions, joinPath, toQueryString } from '../lib/http';

const WIDGET_ENDPOINT = '/api/dashboard/widgets';
const METRIC_ENDPOINT = '/api/dashboard/metrics';
const SAMPLE_RETENTION_MS = 6 * 60 * 60 * 1000;
const MAX_SAMPLES_PER_WIDGET = 720;
const COLUMN_COUNT = 12;

/**
 * The dashboard store: one factory closure holding every operation the
 * dashboard performs. Callers get an object of closures; nothing inside is
 * exported on its own.
 */
export function createDashboardStore(deps: StoreDeps, baseUrl: string) {
  let widgets: Widget[] = [];
  let samples: MetricSample[] = [];
  let activeFilters: FilterSpec[] = [];
  let lastSyncedAt = 0;
  let loading = false;
  let lastError: string | null = null;
  const listeners = new Set<(snapshot: ReturnType<typeof snapshot>) => void>();

  function snapshot() {
    return {
      widgets: widgets.filter((w) => !w.hidden),
      sampleCount: samples.length,
      filters: activeFilters.slice(),
      lastSyncedAt,
      loading,
      lastError,
    };
  }

  /**
   * Fetch the widget set for the current user and merge it into local state,
   * preserving any layout the user has moved since the last sync.
   */
  async function loadWidgets(dashboardId: string, includeHidden = false): Promise<Widget[]> {
    loading = true;
    lastError = null;
    const url = joinPath(baseUrl, WIDGET_ENDPOINT) + toQueryString({
      dashboard: dashboardId,
      hidden: includeHidden ? '1' : undefined,
    });

    let attempt = 0;
    let payload: unknown = null;
    while (attempt <= defaultRequestOptions.retries) {
      try {
        payload = await deps.fetchJson(url);
        break;
      } catch (error) {
        attempt += 1;
        if (attempt > defaultRequestOptions.retries) {
          lastError = error instanceof Error ? error.message : String(error);
          loading = false;
          deps.log(`loadWidgets failed after ${attempt} attempts: ${lastError}`);
          notify();
          return widgets;
        }
        deps.log(`loadWidgets retry ${attempt} for ${dashboardId}`);
      }
    }

    const incoming = Array.isArray(payload) ? (payload as Widget[]) : [];
    const byId = new Map(widgets.map((w) => [w.id, w]));
    const merged: Widget[] = [];
    for (const next of incoming) {
      const existing = byId.get(next.id);
      if (!existing) {
        merged.push({ ...next });
        continue;
      }
      // Server owns identity and content; the client owns placement.
      merged.push({
        ...next,
        column: existing.column,
        row: existing.row,
        span: existing.span,
        hidden: existing.hidden,
      });
      byId.delete(next.id);
    }
    for (const orphan of byId.values()) {
      deps.log(`widget ${orphan.id} no longer exists on the server`);
    }

    widgets = merged;
    lastSyncedAt = deps.now();
    loading = false;
    notify();
    return widgets;
  }

  /**
   * Pull fresh metric samples for every visible widget, append them to the
   * rolling buffer, and drop anything past the retention window.
   */
  async function refreshMetrics(windowMs = SAMPLE_RETENTION_MS): Promise<MetricSample[]> {
    if (widgets.length === 0) {
      deps.log('refreshMetrics called with no widgets loaded');
      return samples;
    }
    loading = true;
    const visible = widgets.filter((w) => !w.hidden);
    const collected: MetricSample[] = [];

    for (const widget of visible) {
      const url = joinPath(baseUrl, METRIC_ENDPOINT) + toQueryString({
        widget: widget.id,
        since: deps.now() - windowMs,
      });
      let payload: unknown;
      try {
        payload = await deps.fetchJson(url);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        deps.log(`refreshMetrics failed for ${widget.id}: ${lastError}`);
        continue;
      }
      if (!Array.isArray(payload)) {
        deps.log(`refreshMetrics got a non-array payload for ${widget.id}`);
        continue;
      }
      for (const raw of payload as MetricSample[]) {
        if (typeof raw.value !== 'number' || Number.isNaN(raw.value)) continue;
        if (typeof raw.at !== 'number' || raw.at <= 0) continue;
        collected.push({
          widgetId: widget.id,
          at: raw.at,
          value: raw.value,
          unit: raw.unit ?? 'count',
        });
      }
    }

    const cutoff = deps.now() - windowMs;
    const kept = samples.filter((s) => s.at >= cutoff);
    samples = kept.concat(collected);
    pruneSamples(MAX_SAMPLES_PER_WIDGET);
    lastSyncedAt = deps.now();
    loading = false;
    notify();
    return samples;
  }

  /**
   * Replace the active filter set and recompute which widgets stay visible.
   * A widget survives when every filter matches one of its fields.
   */
  function applyFilter(specs: readonly FilterSpec[]): Widget[] {
    activeFilters = specs.slice();
    if (activeFilters.length === 0) {
      widgets = widgets.map((w) => ({ ...w, hidden: false }));
      notify();
      return widgets;
    }

    const matches = (widget: Widget, spec: FilterSpec): boolean => {
      const field = spec.field === 'title'
        ? widget.title
        : spec.field === 'kind'
          ? widget.kind
          : spec.field === 'column'
            ? String(widget.column)
            : '';
      switch (spec.op) {
        case 'eq':
          return field.toLowerCase() === spec.value.toLowerCase();
        case 'contains':
          return field.toLowerCase().includes(spec.value.toLowerCase());
        case 'gt':
          return Number(field) > Number(spec.value);
        case 'lt':
          return Number(field) < Number(spec.value);
        default:
          return false;
      }
    };

    let hiddenCount = 0;
    widgets = widgets.map((widget) => {
      const visible = activeFilters.every((spec) => matches(widget, spec));
      if (!visible) hiddenCount += 1;
      return { ...widget, hidden: !visible };
    });
    deps.log(`applyFilter hid ${hiddenCount} of ${widgets.length} widgets`);
    notify();
    return widgets;
  }

  /**
   * Render the current sample buffer as CSV, one row per sample, ordered by
   * widget then timestamp so a diff between two exports stays readable.
   */
  function exportCsv(separator = ','): string {
    const header = ['widget', 'title', 'at', 'value', 'unit'].join(separator);
    if (samples.length === 0) return header;

    const titles = new Map(widgets.map((w) => [w.id, w.title]));
    const ordered = samples.slice().sort((a, b) => {
      if (a.widgetId !== b.widgetId) return a.widgetId < b.widgetId ? -1 : 1;
      return a.at - b.at;
    });

    const escape = (value: string): string => {
      if (!value.includes(separator) && !value.includes('"') && !value.includes('\n')) return value;
      return `"${value.replace(/"/g, '""')}"`;
    };

    const rows = ordered.map((sample) => [
      escape(sample.widgetId),
      escape(titles.get(sample.widgetId) ?? '(unknown)'),
      String(sample.at),
      String(sample.value),
      escape(sample.unit),
    ].join(separator));

    return [header, ...rows].join('\n');
  }

  /**
   * Pack widgets back into a dense grid after a move or a hide, so the layout
   * never leaves a hole a user has to scroll past.
   */
  function reconcileLayout(columnCount = COLUMN_COUNT): Widget[] {
    const visible = widgets.filter((w) => !w.hidden);
    const hidden = widgets.filter((w) => w.hidden);

    const ordered = visible.slice().sort((a, b) => {
      if (a.row !== b.row) return a.row - b.row;
      return a.column - b.column;
    });

    const rowWidth = new Map<number, number>();
    const placed: Widget[] = [];
    for (const widget of ordered) {
      const span = Math.max(1, Math.min(widget.span, columnCount));
      let row = 0;
      let column = 0;
      for (;;) {
        const used = rowWidth.get(row) ?? 0;
        if (used + span <= columnCount) {
          column = used;
          rowWidth.set(row, used + span);
          break;
        }
        row += 1;
      }
      placed.push({ ...widget, row, column, span });
    }

    let trailing = placed.length > 0 ? Math.max(...placed.map((w) => w.row)) + 1 : 0;
    for (const widget of hidden) {
      placed.push({ ...widget, row: trailing, column: 0 });
      trailing += 1;
    }

    widgets = placed;
    notify();
    return widgets;
  }

  /**
   * Cap the rolling buffer per widget, keeping the newest samples. Called after
   * every refresh so memory stays bounded on a long-lived dashboard.
   */
  function pruneSamples(perWidget = MAX_SAMPLES_PER_WIDGET): number {
    if (samples.length === 0) return 0;
    const grouped = new Map<string, MetricSample[]>();
    for (const sample of samples) {
      const bucket = grouped.get(sample.widgetId);
      if (bucket) bucket.push(sample);
      else grouped.set(sample.widgetId, [sample]);
    }

    let dropped = 0;
    const kept: MetricSample[] = [];
    for (const [, bucket] of grouped) {
      bucket.sort((a, b) => a.at - b.at);
      if (bucket.length > perWidget) {
        dropped += bucket.length - perWidget;
        kept.push(...bucket.slice(bucket.length - perWidget));
      } else {
        kept.push(...bucket);
      }
    }

    kept.sort((a, b) => a.at - b.at);
    samples = kept;
    if (dropped > 0) deps.log(`pruneSamples dropped ${dropped} samples`);
    return dropped;
  }

  /**
   * Reduce the buffer to one aggregate per widget — the numbers the summary
   * strip at the top of the dashboard renders.
   */
  function summarize(): Array<{ widgetId: string; title: string; min: number; max: number; mean: number; count: number }> {
    const titles = new Map(widgets.map((w) => [w.id, w.title]));
    const grouped = new Map<string, MetricSample[]>();
    for (const sample of samples) {
      const bucket = grouped.get(sample.widgetId);
      if (bucket) bucket.push(sample);
      else grouped.set(sample.widgetId, [sample]);
    }

    const out: Array<{ widgetId: string; title: string; min: number; max: number; mean: number; count: number }> = [];
    for (const [widgetId, bucket] of grouped) {
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      let total = 0;
      for (const sample of bucket) {
        if (sample.value < min) min = sample.value;
        if (sample.value > max) max = sample.value;
        total += sample.value;
      }
      out.push({
        widgetId,
        title: titles.get(widgetId) ?? '(unknown)',
        min: bucket.length > 0 ? min : 0,
        max: bucket.length > 0 ? max : 0,
        mean: bucket.length > 0 ? total / bucket.length : 0,
        count: bucket.length,
      });
    }

    out.sort((a, b) => b.count - a.count || (a.title < b.title ? -1 : 1));
    return out;
  }

  /** Register a listener and get an unsubscribe back. */
  function subscribe(listener: (snapshot: ReturnType<typeof snapshot>) => void): () => void {
    listeners.add(listener);
    listener(snapshot());
    return () => {
      listeners.delete(listener);
    };
  }

  function notify(): void {
    const current = snapshot();
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (error) {
        deps.log(`dashboard listener threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Drop every sample and widget — used when the user switches dashboards. */
  function reset(): void {
    widgets = [];
    samples = [];
    activeFilters = [];
    lastSyncedAt = 0;
    lastError = null;
    loading = false;
    notify();
  }

  return {
    loadWidgets,
    refreshMetrics,
    applyFilter,
    exportCsv,
    reconcileLayout,
    pruneSamples,
    summarize,
    subscribe,
    reset,
    snapshot,
  };
}

export type DashboardStore = ReturnType<typeof createDashboardStore>;

/** One-line description of a store's state, for the debug panel. */
export function describeStore(store: DashboardStore): string {
  const state = store.snapshot();
  return `${state.widgets.length} widgets · ${state.sampleCount} samples · synced ${state.lastSyncedAt}`;
}
