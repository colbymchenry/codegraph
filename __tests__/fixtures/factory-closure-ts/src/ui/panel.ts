import type { DashboardStore } from '../stores/dashboard-store';
import type { FilterSpec } from '../stores/types';
import { medianOf } from '../lib/metrics';

/** The dashboard panel — the only consumer of the store's closures. */
export function mountPanel(store: DashboardStore, dashboardId: string) {
  let disposed = false;

  const unsubscribe = store.subscribe((state) => {
    if (disposed) return;
    render(state.widgets.length, state.sampleCount, state.loading);
  });

  async function boot(): Promise<void> {
    await store.loadWidgets(dashboardId);
    await store.refreshMetrics();
    store.reconcileLayout();
  }

  function search(text: string): void {
    const specs: FilterSpec[] = text.trim().length === 0
      ? []
      : [{ field: 'title', op: 'contains', value: text.trim() }];
    store.applyFilter(specs);
  }

  function download(): string {
    return store.exportCsv();
  }

  function render(widgetCount: number, sampleCount: number, loading: boolean): void {
    void widgetCount;
    void sampleCount;
    void loading;
  }

  function dispose(): void {
    disposed = true;
    unsubscribe();
  }

  return { boot, search, download, dispose, median: medianOf };
}
