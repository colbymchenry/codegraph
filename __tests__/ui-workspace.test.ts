import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { loadWorkspaceConfig } from '../src/ui-server/workspace/config';
import { WorkspacePool, workspaceTimeoutMs } from '../src/ui-server/workspace/pool';

class FakeWorker extends EventEmitter {
  messages: any[] = [];
  terminated = false;
  postMessage(message: unknown) { this.messages.push(message); }
  terminate() { this.terminated = true; return Promise.resolve(0); }
}

describe('工作区配置与查询预算', () => {
  it('摘要统计和架构图使用独立预算，普通查询仍保持短截止时间', () => {
    expect(workspaceTimeoutMs('/api/stats', 'summary=1', {})).toBe(120_000);
    expect(workspaceTimeoutMs('/api/map', 'bounded=1', {})).toBe(120_000);
    expect(workspaceTimeoutMs('/api/stats', '', {})).toBe(3_000);
    expect(workspaceTimeoutMs('/api/search', 'q=a', {})).toBe(3_000);
    expect(workspaceTimeoutMs('/api/stats', 'summary=1', { timeoutMs: 25 })).toBe(25);
    expect(workspaceTimeoutMs('/api/stats', 'summary=1', { timeoutMs: 25, statusTimeoutMs: 80 })).toBe(80);
    expect(workspaceTimeoutMs('/api/map', '', { timeoutMs: 25 })).toBe(25);
    expect(workspaceTimeoutMs('/api/map', '', { timeoutMs: 25, mapTimeoutMs: 80 })).toBe(80);
  });

  it('相对配置目录解析真实目录，允许未索引项目并拒绝重复编号', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-workspace-'));
    try {
      fs.mkdirSync(path.join(dir, 'repo'));
      const file = path.join(dir, 'workspace.json');
      fs.writeFileSync(file, JSON.stringify({ name: '本地', projects: [{ id: 'one', name: '项目', path: './repo' }] }));
      expect(loadWorkspaceConfig(file).projects[0]?.path).toBe(fs.realpathSync(path.join(dir, 'repo')));
      fs.writeFileSync(file, JSON.stringify({ name: '本地', projects: [{ id: 'one', name: '项目', path: './repo' }, { id: 'one', name: '重复', path: './repo' }] }));
      expect(() => loadWorkspaceConfig(file)).toThrow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('截止时间包含排队，超时终止运行 worker 并允许后续请求', async () => {
    const workers: FakeWorker[] = [];
    const pool = new WorkspacePool({ size: 1, timeoutMs: 25, createWorker: () => { const w = new FakeWorker(); workers.push(w); return w; } });
    const one = pool.run('/repo', '/api/stats', '').catch(e => e.message);
    const two = pool.run('/repo', '/api/search', 'q=a').catch(e => e.message);
    expect(await one).toMatch(/超时/);
    expect(await two).toMatch(/超时/);
    expect(workers[0]?.terminated).toBe(true);
    const three = pool.run('/repo', '/api/stats', '');
    const worker = workers.at(-1)!;
    const message = worker.messages.at(-1);
    worker.emit('message', { id: message.id, status: 200, body: { ok: true } });
    expect(await three).toEqual({ status: 200, body: { ok: true } });
    pool.close();
  });

  it('断连取消运行任务', async () => {
    const w = new FakeWorker();
    const pool = new WorkspacePool({ size: 1, createWorker: () => w });
    const abort = new AbortController();
    const task = pool.run('/repo', '/api/map', '', abort.signal).catch(e => e.message);
    abort.abort();
    expect(await task).toMatch(/取消/);
    expect(w.terminated).toBe(true);
    pool.close();
  });
});

import CodeGraph from '../src/index';
import { createWorkspaceApi } from '../src/ui-server/workspace';
import { startUiServer, GraphSession } from '../src/ui-server';

describe('工作区真实 HTTP 与线程', () => {
  it('统一概览含离线项目，项目路由隔离，搜索返回部分结果并保护写入', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-workspace-http-'));
    const projects = ['one', 'two', 'offline'].map(id => ({ id, name: id, path: path.join(dir, id) }));
    for (const project of projects) fs.mkdirSync(project.path);
    for (const project of projects.slice(0, 2)) {
      fs.writeFileSync(path.join(project.path, 'hello.ts'), 'export function hello() { return 1; }');
      const cg = CodeGraph.initSync(project.path);
      await cg.indexAll();
      cg.close();
    }
    const viewer = path.join(dir, 'viewer'); fs.mkdirSync(viewer); fs.writeFileSync(path.join(viewer, 'index.html'), '<html></html>');
    const api = createWorkspaceApi({ workspace: { name: '本地', projects } });
    const server = await startUiServer({ projectRoot: projects[0]!.path, viewerDir: viewer, port: 0, api: api.handler });
    try {
      expect((await fetch(`${server.url}/api/projects/one/stats?summary=1`)).status).toBe(200);
      const overview = await fetch(`${server.url}/api/workspace`).then(r => r.json());
      expect(overview.projects.map((p: any) => p.available)).toEqual([true, true, false]);
      const scoped = await fetch(`${server.url}/api/projects/one/stats`).then(r => r.json());
      expect(scoped.projectId).toBe('one');
      expect(scoped.blastScale.sampled).toBe(0);
      expect(scoped.revision).toMatch(/^[a-f0-9]{24}$/);
      expect(scoped.scope.route).toBe('/api/stats');
      expect((await fetch(`${server.url}/api/projects/offline/stats`)).status).toBe(503);
      expect((await fetch(`${server.url}/api/projects/missing/stats`)).status).toBe(404);
      const search = await fetch(`${server.url}/api/workspace/search?q=hello`).then(r => r.json());
      expect(search.results.filter((result: any) => result.node.matchKind === 'exact').map((result: any) => result.projectId)).toEqual(['one', 'two']);
      const nodeId = search.results[0].node.id;
      const saved = await fetch(`${server.url}/api/projects/one/trails`, { method: 'POST', headers: { 'x-codegraph-ui': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '轨迹', hops: [{ id: nodeId }] }) });
      expect(saved.status).toBe(200);
      expect((await fetch(`${server.url}/api/projects/two/trails`).then(r => r.json())).trails).toEqual([]);
      expect((await fetch(`${server.url}/api/projects/one/trails`).then(r => r.json())).trails).toHaveLength(1);
      expect(search.incomplete.map((p: any) => p.projectId)).toEqual(['offline']);
      expect((await fetch(`${server.url}/api/projects/one/trails`, { method: 'POST', body: '{}' })).status).toBe(403);
      expect((await fetch(`${server.url}/api/projects/one/source?file=../two/private.txt`)).status).toBe(403);
    } finally { api.close(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 15000);
});

import { WorkspaceQueries } from '../src/ui-server/workspace/cache';

describe('工作区地图缓存', () => {
  it('合并等价参数，单个订阅者取消不影响其他订阅者，并按字节逐出', async () => {
    const worker = new FakeWorker();
    const pool = new WorkspacePool({ size: 1, createWorker: () => worker });
    const cache = new WorkspaceQueries(pool, 100);
    const abort = new AbortController();
    const one = cache.run('/repo', '/api/map', new URLSearchParams('depth=2&root=a'), abort.signal).catch(error => error.message);
    const two = cache.run('/repo', '/api/map', new URLSearchParams('root=a&depth=2'), new AbortController().signal);
    expect(worker.messages).toHaveLength(1);
    abort.abort(); expect(await one).toMatch(/取消/);
    expect(worker.terminated).toBe(false);
    worker.emit('message', { id: worker.messages[0].id, status: 200, body: { data: 'a'.repeat(40) } });
    await two;
    await cache.run('/repo', '/api/map', new URLSearchParams('root=a&depth=2'), new AbortController().signal);
    expect(worker.messages).toHaveLength(1);
    const third = cache.run('/repo', '/api/map', new URLSearchParams('root=b'), new AbortController().signal);
    worker.emit('message', { id: worker.messages[1].id, status: 200, body: { data: 'b'.repeat(40) } });
    await third;
    const fourth = cache.run('/repo', '/api/map', new URLSearchParams('root=a&depth=2'), new AbortController().signal);
    expect(worker.messages).toHaveLength(3);
    worker.emit('message', { id: worker.messages[2].id, status: 200, body: {} });
    await fourth;
    cache.close();
  });
});

it('拒绝不同编号通过符号链接重复挂载同一真实项目', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-workspace-alias-'));
  try {
    fs.mkdirSync(path.join(dir, 'repo'));
    fs.symlinkSync(path.join(dir, 'repo'), path.join(dir, 'alias'));
    const file = path.join(dir, 'workspace.json');
    fs.writeFileSync(file, JSON.stringify({ name: '重复目录', projects: [{ id: 'one', name: '项目', path: './repo' }, { id: 'two', name: '别名', path: './alias' }] }));
    expect(() => loadWorkspaceConfig(file)).toThrow(/真实目录/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it('项目查询超时返回504和稳定timeout代码', async () => {
  const worker = new FakeWorker();
  const api = createWorkspaceApi({ workspace: { name: '超时', projects: [{ id: 'one', name: '项目', path: '/repo' }] }, pool: { timeoutMs: 10, createWorker: () => worker } });
  let status = 0;
  let body: any;
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(value: number) { status = value; },
    end(value: Buffer) { body = JSON.parse(value.toString()); this.writableEnded = true; },
  });
  try {
    await api.handler(new EventEmitter() as any, response as any, { pathname: '/api/projects/one/map', query: new URLSearchParams(), projectRoot: '/repo', method: 'GET' });
    expect(status).toBe(504);
    expect(body.code).toBe('timeout');
    expect(worker.terminated).toBe(true);
  } finally { api.close(); }
});

it('项目SSE断连释放主线程GraphSession', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-workspace-sse-'));
  CodeGraph.initSync(dir).close();
  const viewer = path.join(dir, 'viewer'); fs.mkdirSync(viewer); fs.writeFileSync(path.join(viewer, 'index.html'), '<html></html>');
  const close = vi.spyOn(GraphSession.prototype, 'close');
  const acquire = vi.spyOn(GraphSession.prototype, 'acquire');
  const api = createWorkspaceApi({ workspace: { name: 'SSE', projects: [{ id: 'one', name: '项目', path: dir }] } });
  const server = await startUiServer({ projectRoot: dir, viewerDir: viewer, port: 0, api: api.handler });
  try {
    const response = await fetch(`${server.url}/api/projects/one/events`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    let frames = new TextDecoder().decode(first.value);
    expect(frames).toContain('"projectId":"one"');
    while (!frames.includes('event: index')) frames += new TextDecoder().decode((await reader.read()).value);
    expect(acquire).not.toHaveBeenCalled();
    await reader.cancel();
    await vi.waitFor(() => expect(close).toHaveBeenCalled(), { timeout: 1000 });
  } finally { api.close(); await server.close(); close.mockRestore(); acquire.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

import { getDatabasePath } from '../src/db';
it('查询期间索引版本变化返回409而不把旧数据标成新版本', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-workspace-revision-'));
  const dbFile = getDatabasePath(dir); fs.mkdirSync(path.dirname(dbFile), { recursive: true }); fs.writeFileSync(dbFile, 'old');
  const worker = new FakeWorker();
  worker.postMessage = message => {
    fs.appendFileSync(dbFile, '-new');
    queueMicrotask(() => worker.emit('message', { id: (message as any).id, status: 200, body: { modules: [] } }));
  };
  const api = createWorkspaceApi({ workspace: { name: '版本', projects: [{ id: 'one', name: '项目', path: dir }] }, pool: { createWorker: () => worker } });
  let status = 0; let body: any;
  const response = Object.assign(new EventEmitter(), { writableEnded: false, writeHead(value: number) { status = value; }, end(value: Buffer) { body = JSON.parse(value.toString()); this.writableEnded = true; } });
  try {
    await api.handler(new EventEmitter() as any, response as any, { pathname: '/api/projects/one/map', query: new URLSearchParams(), projectRoot: dir, method: 'GET' });
    expect(status).toBe(409); expect(body.code).toBe('reload-required'); expect(body.revision).toBeUndefined();
  } finally { api.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it('工作区SSE探测复用查询池，断连终止未完成的Worker任务', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sse-queued-'));
  const worker = new FakeWorker();
  const api = createWorkspaceApi({ workspace: { name: '探测', projects: [{ id: 'one', name: '项目', path: dir }] }, pool: { createWorker: () => worker } });
  const frames: string[] = [];
  const res = Object.assign(new EventEmitter(), { writableEnded: false, writeHead() {}, write(value: string) { frames.push(value); }, end() { this.writableEnded = true; } });
  try {
    await api.handler(new EventEmitter() as any, res as any, { pathname: '/api/projects/one/events', query: new URLSearchParams(), projectRoot: dir, method: 'GET' });
    expect(frames[0]).toContain('event: hello');
    expect(worker.messages).toHaveLength(1);
    expect(worker.messages[0].route).toBe('/api/index-revision');
    res.emit('close');
    expect(worker.terminated).toBe(true);
  } finally { api.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
