import { Worker } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import type { PoolWorker } from '../../mcp/query-pool';

export class WorkspaceTimeoutError extends Error {}

export interface WorkspaceReply { status: number; body: unknown }
interface Job {
  id: number; projectRoot: string; route: string; query: string;
  resolve: (reply: WorkspaceReply) => void; reject: (error: Error) => void;
  timer?: NodeJS.Timeout; cleanup?: () => void;
}
export interface WorkspacePoolOptions {
  size?: number;
  /** 普通交互查询的排队加执行预算；默认 3 秒。 */
  timeoutMs?: number;
  /** 架构图需要扫描并聚合项目关系，使用独立预算；默认 120 秒。 */
  mapTimeoutMs?: number;
  /**
   * 首次摘要统计还承担打开、迁移和修复大型索引的预热工作，不能使用
   * 交互查询的短预算。显式 timeoutMs 仍作为兼容回退，便于调用方统一覆盖。
   */
  statusTimeoutMs?: number;
  readOnly?: boolean;
  createWorker?: () => PoolWorker;
}

const DEFAULT_QUERY_TIMEOUT_MS = 3_000;
const DEFAULT_STATUS_TIMEOUT_MS = 120_000;
const DEFAULT_MAP_TIMEOUT_MS = 120_000;

/** 摘要统计和架构图都是全项目查询，不能套用普通交互请求的短预算。 */
export function workspaceTimeoutMs(route: string, query: string, options: WorkspacePoolOptions): number {
  const summaryStats = route === '/api/stats' && new URLSearchParams(query).get('summary') === '1';
  if (summaryStats) return options.statusTimeoutMs ?? options.timeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
  if (route === '/api/map') return options.mapTimeoutMs ?? options.timeoutMs ?? DEFAULT_MAP_TIMEOUT_MS;
  return options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
}

/** 每项预算从入队开始，取消必须终止线程，避免 SQLite 查询继续消耗 CPU。 */
export class WorkspacePool {
  private workers = new Map<PoolWorker, Job | null>();
  private queue: Job[] = [];
  private nextId = 1;
  private closed = false;
  private retiring = 0;
  constructor(private options: WorkspacePoolOptions = {}) {}

  run(projectRoot: string, route: string, query: string, signal?: AbortSignal): Promise<WorkspaceReply> {
    if (this.closed || signal?.aborted) return Promise.reject(new Error('查询已取消。'));
    return new Promise((resolve, reject) => {
      const job: Job = { id: this.nextId++, projectRoot, route, query, resolve, reject };
      const abort = () => this.cancel(job, '查询已取消。');
      signal?.addEventListener('abort', abort, { once: true });
      job.cleanup = () => { clearTimeout(job.timer); signal?.removeEventListener('abort', abort); };
      job.timer = setTimeout(
        () => this.cancel(job, new WorkspaceTimeoutError('查询超时，请缩小查询范围。')),
        workspaceTimeoutMs(route, query, this.options)
      );
      this.queue.push(job);
      this.pump();
    });
  }

  private pump(): void {
    if (this.closed) return;
    while (this.queue.length) {
      let worker = [...this.workers].find(([, job]) => job === null)?.[0];
      if (!worker && this.workers.size + this.retiring < (this.options.size ?? 2)) {
        try {
          const local = path.join(__dirname, 'worker.js');
          const filename = fs.existsSync(local) ? local : path.resolve(__dirname, '../../../dist/ui-server/workspace/worker.js');
          worker = this.options.createWorker?.() ?? new Worker(filename, { workerData: { readOnly: this.options.readOnly } });
        } catch (error) {
          const job = this.queue.shift()!;
          job.cleanup?.(); job.reject(error instanceof Error ? error : new Error(String(error)));
          continue;
        }
        const current = worker;
        this.workers.set(current, null);
        current.on('message', raw => {
          const reply = raw as WorkspaceReply & { id: number };
          const job = this.workers.get(current);
          if (!job || reply.id !== job.id) return;
          this.workers.set(current, null);
          job.cleanup?.(); job.resolve({ status: reply.status, body: reply.body });
          this.pump();
        });
        const failed = () => {
          if (!this.workers.has(current)) return;
          const job = this.workers.get(current);
          this.workers.delete(current);
          if (job) { job.cleanup?.(); job.reject(new Error('查询线程退出。')); }
          this.pump();
        };
        current.on('error', failed);
        current.on('exit', failed);
      }
      if (!worker) return;
      const job = this.queue.shift()!;
      this.workers.set(worker, job);
      worker.postMessage({ id: job.id, projectRoot: job.projectRoot, route: job.route, query: job.query });
    }
  }

  private cancel(job: Job, reason: string | Error): void {
    this.queue = this.queue.filter(queued => queued !== job);
    for (const [worker, active] of this.workers) {
      if (active === job) {
        this.workers.delete(worker); this.retiring++;
        void Promise.resolve(worker.terminate()).catch(() => undefined).finally(() => { this.retiring--; this.pump(); });
      }
    }
    job.cleanup?.(); job.reject(reason instanceof Error ? reason : new Error(reason));
    this.pump();
  }

  close(): void {
    this.closed = true;
    for (const job of [...this.queue, ...[...this.workers.values()].filter((value): value is Job => value !== null)]) this.cancel(job, '查询已取消。');
    for (const worker of this.workers.keys()) void worker.terminate();
    this.workers.clear();
  }
}
