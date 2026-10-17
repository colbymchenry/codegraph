import { createGraphApi, type GraphApi } from '../api';
import { workbenchRevision } from '../api/revision';
import type { EventProbeResult } from '../api/events';
import { badRequest, fail, intParam, notFound, optionalTextParam } from '../api/respond';
import type { WireSearchResult, MatchKind } from '../api/search';
import { sendJson } from '../static';
import type { UiApiHandler } from '../index';
import { WorkspacePool, WorkspaceTimeoutError, type WorkspacePoolOptions } from './pool';
import { WorkspaceQueries } from './cache';
import type { WorkspaceConfig, WorkspaceProject } from './config';
export { loadWorkspaceConfig } from './config';
export type { WorkspaceConfig, WorkspaceProject } from './config';

const ranks: Record<MatchKind, number> = { exact: 0, prefix: 1, substring: 2, qualified: 3, file: 4, related: 5 };
interface SearchPayload { results: { items: WireSearchResult[]; truncated: boolean }; limited?: boolean; candidateLimited?: boolean }

export function createWorkspaceApi(options: { workspace: WorkspaceConfig; readOnly?: boolean; defaultProjectRoot?: string; pool?: WorkspacePoolOptions }): GraphApi {
  const { workspace } = options;
  const queries = new WorkspaceQueries(new WorkspacePool({ ...options.pool, readOnly: options.readOnly }));
  const local = new Map<string, { api: GraphApi; users: number }>();
  const projectById = new Map(workspace.projects.map(project => [project.id, project]));
  const defaultRoot = options.defaultProjectRoot ?? workspace.projects[0]!.path;
  const direct = (root: string, projectId: string | null) => {
    const key = JSON.stringify([root, projectId]);
    let entry = local.get(key);
    if (!entry) { entry = { api: createGraphApi({ projectRoot: root, readOnly: options.readOnly, projectId: projectId ?? undefined,
      eventProbe: async (since, signal) => {
        const query = new URLSearchParams();
        if (since !== null) query.set('since', String(since));
        const reply = await queries.run(root, '/api/index-revision', query, signal);
        if (reply.status !== 200) throw new Error((reply.body as { error: string }).error);
        return reply.body as EventProbeResult;
      },
    }), users: 0 }; local.set(key, entry); }
    entry.users++;
    const current = entry;
    let released = false;
    return { api: current.api, release: () => {
      if (released) return;
      released = true;
      // 最后一个 SSE 或写请求离开即释放主线程连接，切换项目不会积累句柄。
      if (--current.users === 0) { current.api.close(); local.delete(key); }
    } };
  };
  const handler: UiApiHandler = async (req, res, ctx) => {
    const abort = new AbortController();
    const disconnect = () => { if (!res.writableEnded) abort.abort(); };
    res.once('close', disconnect);
    try {
      let route = ctx.pathname.replace(/\/$/, '');
      if (route.startsWith('/api/workspace') && ctx.method !== 'GET' && ctx.method !== 'HEAD') throw badRequest('工作区接口只接受读取。');
      if (route === '/api/workspace') {
        const projects = await Promise.all(workspace.projects.map(async project => {
          try {
            const reply = await queries.run(project.path, '/api/stats', new URLSearchParams('summary=1'), abort.signal);
            if (reply.status !== 200) throw new Error((reply.body as { error: string }).error);
            return { id: project.id, name: project.name, available: true, stats: reply.body };
          } catch (error) { return { id: project.id, name: project.name, available: false, error: String((error as Error).message) }; }
        }));
        sendJson(res, 200, { name: workspace.name, projects }, ctx.method); return true;
      }
      if (route === '/api/workspace/search') {
        optionalTextParam(ctx.query, 'q');
        const limit = intParam(ctx.query, 'limit', { min: 1, max: 200, default: 60 });
        const ids = ctx.query.getAll('project').filter(Boolean);
        const projects: WorkspaceProject[] = ids.length ? [...new Set(ids)].map(id => { const project = projectById.get(id); if (!project) throw notFound(`未知项目：${id}`); return project; }) : workspace.projects;
        const query = new URLSearchParams(ctx.query); query.delete('project'); query.set('bounded', '1'); query.set('limit', String(limit));
        const outcomes = await Promise.all(projects.map(async project => {
          try {
            const reply = await queries.run(project.path, '/api/search', query, abort.signal);
            if (reply.status !== 200) throw new Error((reply.body as { error: string }).error);
            return { project, payload: reply.body as SearchPayload };
          } catch (error) { return { project, error: (error as Error).message }; }
        }));
        const results = outcomes.flatMap(outcome => outcome.payload?.results.items.map(node => ({ projectId: outcome.project.id, projectName: outcome.project.name, node })) ?? []);
        results.sort((a, b) => ranks[a.node.matchKind] - ranks[b.node.matchKind]
          || a.projectId.localeCompare(b.projectId)
          || a.node.file.localeCompare(b.node.file)
          || a.node.line - b.node.line
          || a.node.id.localeCompare(b.node.id));
        sendJson(res, 200, {
          results: results.slice(0, limit),
          incomplete: outcomes.filter(outcome => outcome.error !== undefined).map(outcome => ({ projectId: outcome.project.id, reason: outcome.error })),
          limited: results.length > limit || outcomes.some(outcome => outcome.payload?.results.truncated || outcome.payload?.limited || outcome.payload?.candidateLimited),
        }, ctx.method); return true;
      }
      let root = defaultRoot;
      let projectId = workspace.projects.find(project => project.path === root)?.id ?? null;
      const match = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(route);
      if (match) {
        const project = projectById.get(match[1]!);
        if (!project) throw notFound(`未知项目：${match[1]}`);
        root = project.path; projectId = project.id; route = `/api${match[2] ?? ''}`;
      }
      const context = { ...ctx, pathname: route, projectRoot: root };
      if (route === '/api/events' || ctx.method === 'POST' || ctx.method === 'DELETE') {
        const lease = direct(root, projectId);
        const streaming = route === '/api/events' && ctx.method === 'GET';
        if (streaming) res.once('close', lease.release);
        try { return await lease.api.handler(req, res, context); }
        finally { if (!streaming || res.writableEnded) lease.release(); }
      }
      const query = new URLSearchParams(ctx.query);
      // 工作区顶栏只需要计数和索引状态。完整 stats 还会对 24 个候选
      // 做深度影响遍历，在百万级图上可能耗时数分钟；单项目模式仍保留
      // 完整标尺，工作区则使用同形状的轻量摘要。
      if (route === '/api/stats') query.set('summary', '1');
      if (['/api/map', '/api/screens', '/api/steps', '/api/flow'].includes(route)) query.set('bounded', '1');
      query.sort();
      const revision = workbenchRevision(root);
      const reply = await queries.run(root, route, query, abort.signal);
      if (reply.status === 200 && workbenchRevision(root) !== revision) {
        sendJson(res, 409, { error: '索引在查询期间更新，请重新加载。', code: 'reload-required', projectId }, ctx.method); return true;
      }
      const body = reply.status === 200 && reply.body !== null && typeof reply.body === 'object' && !Array.isArray(reply.body)
        ? { ...reply.body, projectId, revision, scope: { route, query: query.toString() } } : reply.body;
      sendJson(res, reply.status, body, ctx.method); return true;
    } catch (error) {
      if (abort.signal.aborted) return true;
      if (error instanceof WorkspaceTimeoutError) {
        sendJson(res, 504, { error: error.message, code: 'timeout' }, ctx.method); return true;
      }
      return fail(res, error, ctx.method);
    } finally {
      res.removeListener('close', disconnect);
    }
  };
  return { handler, close: () => { queries.close(); for (const entry of local.values()) entry.api.close(); } };
}
