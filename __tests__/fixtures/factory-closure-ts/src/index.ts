import { createDashboardStore } from './stores/dashboard-store';
import { createAlertsStore } from './stores/alerts-store';
import { mountPanel } from './ui/panel';
import { parseFilterText } from './services/filter-parser';
import { refreshMetricCache } from './services/metric-service';
import type { StoreDeps } from './stores/types';

/** Wire a dashboard: build both stores, mount the panel, boot it. */
export async function startDashboard(deps: StoreDeps, baseUrl: string, dashboardId: string) {
  const store = createDashboardStore(deps, baseUrl);
  const alerts = createAlertsStore(deps, baseUrl);
  const panel = mountPanel(store, dashboardId);
  await panel.boot();
  await alerts.refreshAlerts(dashboardId);
  return { store, alerts, panel };
}

/** Apply the filter bar's text to the dashboard store. */
export function searchDashboard(store: ReturnType<typeof createDashboardStore>, text: string) {
  return store.applyFilter(parseFilterText(text));
}

export { refreshMetricCache };
