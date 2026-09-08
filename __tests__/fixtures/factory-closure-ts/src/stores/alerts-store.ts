import type { FilterSpec, StoreDeps } from './types';
import { joinPath, toQueryString } from '../lib/http';

const ALERT_ENDPOINT = '/api/dashboard/alerts';

export interface Alert {
  id: string;
  widgetId: string;
  severity: 'info' | 'warn' | 'critical';
  message: string;
  raisedAt: number;
  acknowledgedAt: number | null;
}

/**
 * The alerts store — the dashboard's second factory closure. Same shape as the
 * metric store: every operation is a closure over private state.
 */
export function createAlertsStore(deps: StoreDeps, baseUrl: string) {
  let alerts: Alert[] = [];
  let filters: FilterSpec[] = [];
  let mutedWidgets = new Set<string>();
  let lastRefreshedAt = 0;

  /** Pull the current alert set and merge acknowledgements the user made locally. */
  async function refreshAlerts(dashboardId: string): Promise<Alert[]> {
    const url = joinPath(baseUrl, ALERT_ENDPOINT) + toQueryString({ dashboard: dashboardId });
    let payload: unknown;
    try {
      payload = await deps.fetchJson(url);
    } catch (error) {
      deps.log(`refreshAlerts failed: ${error instanceof Error ? error.message : String(error)}`);
      return alerts;
    }
    if (!Array.isArray(payload)) {
      deps.log('refreshAlerts got a non-array payload');
      return alerts;
    }

    const acknowledged = new Map(
      alerts.filter((a) => a.acknowledgedAt !== null).map((a) => [a.id, a.acknowledgedAt]),
    );
    const merged: Alert[] = [];
    for (const raw of payload as Alert[]) {
      if (typeof raw.id !== 'string' || raw.id.length === 0) continue;
      merged.push({
        ...raw,
        acknowledgedAt: acknowledged.get(raw.id) ?? raw.acknowledgedAt ?? null,
      });
    }
    merged.sort((a, b) => b.raisedAt - a.raisedAt);
    alerts = merged;
    lastRefreshedAt = deps.now();
    return alerts;
  }

  /** Filter the alert list the same way the metric store filters widgets. */
  function applyAlertFilter(specs: readonly FilterSpec[]): Alert[] {
    filters = specs.slice();
    if (filters.length === 0) return alerts;

    const fieldOf = (alert: Alert, field: string): string => {
      switch (field) {
        case 'severity': return alert.severity;
        case 'widget': return alert.widgetId;
        case 'message': return alert.message;
        default: return '';
      }
    };

    return alerts.filter((alert) => filters.every((spec) => {
      const value = fieldOf(alert, spec.field);
      switch (spec.op) {
        case 'eq': return value.toLowerCase() === spec.value.toLowerCase();
        case 'contains': return value.toLowerCase().includes(spec.value.toLowerCase());
        case 'gt': return value > spec.value;
        case 'lt': return value < spec.value;
        default: return false;
      }
    }));
  }

  /** Mark an alert acknowledged locally; the next refresh preserves it. */
  function acknowledge(alertId: string): boolean {
    const target = alerts.find((a) => a.id === alertId);
    if (!target || target.acknowledgedAt !== null) return false;
    target.acknowledgedAt = deps.now();
    deps.log(`acknowledged ${alertId}`);
    return true;
  }

  /** Silence a widget's alerts without dropping them from the buffer. */
  function muteWidget(widgetId: string): void {
    mutedWidgets.add(widgetId);
    deps.log(`muted ${widgetId} (${mutedWidgets.size} muted)`);
  }

  function unmuteWidget(widgetId: string): boolean {
    return mutedWidgets.delete(widgetId);
  }

  /** The alerts the dashboard should actually show right now. */
  function visibleAlerts(): Alert[] {
    return applyAlertFilter(filters)
      .filter((a) => !mutedWidgets.has(a.widgetId))
      .filter((a) => a.acknowledgedAt === null);
  }

  /** Counts per severity, for the badge on the alerts tab. */
  function countBySeverity(): Record<Alert['severity'], number> {
    const counts: Record<Alert['severity'], number> = { info: 0, warn: 0, critical: 0 };
    for (const alert of visibleAlerts()) counts[alert.severity] += 1;
    return counts;
  }

  function reset(): void {
    alerts = [];
    filters = [];
    mutedWidgets = new Set();
    lastRefreshedAt = 0;
  }

  function snapshot() {
    return { alerts: visibleAlerts(), counts: countBySeverity(), lastRefreshedAt };
  }

  return {
    refreshAlerts,
    applyAlertFilter,
    acknowledge,
    muteWidget,
    unmuteWidget,
    visibleAlerts,
    countBySeverity,
    reset,
    snapshot,
  };
}

export type AlertsStore = ReturnType<typeof createAlertsStore>;
