import { SvelteMap } from 'svelte/reactivity';
import { graphStatus } from './graph-status.svelte';
import { i18n } from './i18n.svelte';
import { createHttpAdapter, setGraphAdapter } from './adapter';
import { createProjectNavigation, setNavigationDriver } from './navigation';
import { project } from './project.svelte';
import { live } from './live.svelte';
import { palette } from './palette.svelte';
import { trail } from './trail.svelte';
import { trails } from './trails.svelte';
import { hot, railFocus } from './focus.svelte';
import { toast } from './toast.svelte';
import type { WireStats, WireSearchResult } from './wire';
export interface WorkspaceProject { id: string; name: string; available: boolean; stats?: WireStats; error?: string }
export interface WorkspaceResult { projectId: string; projectName: string; node: WireSearchResult }
let ready = $state(false);
let loading = $state(false);
let name = $state('CodeGraph');
let projects = $state<WorkspaceProject[]>([]);
let activeId = $state<string | null>(null);
let error = $state<string | null>(null);
let standalone = false;
let pending: Promise<void> | null = null;
let controller: AbortController | null = null;
export type WorkspaceView = 'map' | 'steps' | 'flow' | 'screens' | 'execution';
interface ProjectContext { last: string; views: Partial<Record<WorkspaceView, string>> }
const contexts = new SvelteMap<string, ProjectContext>();
export const workspace = {
  get loading() { return loading; },
  get ready() { return ready; }, get name() { return name; }, get projects() { return projects; },
  get activeId() { return activeId; }, get error() { return error; },
  async ensure() {
    if (pending) return pending;
    loading = true; error = null;
    pending = (async () => {
      try {
        const response = await fetch('api/workspace');
        if (response.status === 404) {
          standalone = true;
          const stats = await createHttpAdapter().stats();
          projects = [{ id: 'default', name: stats.project.name, available: true, stats }];
        } else {
          if (!response.ok) throw new Error(i18n.t('wb.loadError', { status: response.status }));
          const data = await response.json(); standalone = false; name = data.name; projects = data.projects;
        }
      } catch (cause) { error = String(cause); }
      ready = true; loading = false;
    })();
    return pending;
  },
  reload() {
    if (loading && pending) return pending;
    pending = null;
    return workspace.ensure();
  },
  activate(id: string | null) {
    if (id === activeId) return;
    controller?.abort(); live.stop();
    const selected = id ? projects.find(item => item.id === id) : undefined;
    graphStatus.resetProject(); project.resetProject(selected?.stats); palette.resetProject(); trail.resetProject(); trails.resetProject();
    hot.clear(null); railFocus.reset(); toast.clear();
    activeId = id;
    if (!id) return;
    controller = new AbortController();
    setGraphAdapter(createHttpAdapter({
      apiBase: standalone ? undefined : `/api/projects/${encodeURIComponent(id)}`,
      signal: controller.signal,
    }));
    setNavigationDriver(createProjectNavigation(id));
    void project.ensure(); live.start();
  },
  remember(id: string, href: string) {
    const context = contexts.get(id);
    const views = { ...context?.views };
    const view = href.replace(/^#\/p\/[^/]+/, '#').split('?')[0]?.split('/')[1];
    if (view === 'map' || view === 'steps' || view === 'flow' || view === 'screens') views[view] = href;
    if (view === 'steps' || view === 'flow' || view === 'screens' || view === 'entry') views.execution = href;
    contexts.set(id, { last: href, views });
  },
  href(id: string, view?: WorkspaceView) {
    const context = contexts.get(id);
    if (!view) return context?.last ?? `#/p/${encodeURIComponent(id)}/`;
    if (context?.views[view]) return context.views[view]!;
    const navigation = createProjectNavigation(id);
    if (view === 'map') return navigation.mapHref();
    if (view === 'flow') return navigation.flowHref();
    if (view === 'screens') return navigation.screensHref();
    return navigation.stepsHref();
  },
  async search(query: string, projectId: string, signal: AbortSignal): Promise<{ results: WorkspaceResult[]; incomplete: {projectId:string;reason:string}[]; limited: boolean }> {
    if (standalone) {
      const data = await createHttpAdapter().search(query, { limit: 60 }, signal);
      const item = projects[0]!;
      return { results: data.results.items.map(node => ({ projectId: item.id, projectName: item.name, node })), incomplete: [], limited: data.results.total > data.results.items.length };
    }
    const params = new URLSearchParams({ q: query, limit: '60' });
    if (projectId) params.set('project', projectId);
    const response = await fetch(`api/workspace/search?${params}`, { signal });
    if (!response.ok) throw new Error(i18n.t('wb.searchError', { status: response.status }));
    return response.json();
  },
};
