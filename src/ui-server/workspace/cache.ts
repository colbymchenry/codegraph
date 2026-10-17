import { workbenchRevision } from '../api/revision';
import { WorkspacePool, type WorkspaceReply } from './pool';


export class WorkspaceQueries {
  private cache = new Map<string, { reply: WorkspaceReply; bytes: number }>();
  private bytes = 0;
  private pending = new Map<string, { promise: Promise<WorkspaceReply>; controller: AbortController; users: number }>();
  constructor(readonly pool: WorkspacePool, private maxBytes = 64 * 1024 * 1024) {}

  run(root: string, route: string, query: URLSearchParams, signal: AbortSignal): Promise<WorkspaceReply> {
    if (signal.aborted) return Promise.reject(new Error('查询已取消。'));
    if (route !== '/api/map') return this.pool.run(root, route, query.toString(), signal);
    const sorted = new URLSearchParams(query); sorted.sort();
    const key = JSON.stringify([root, workbenchRevision(root), route, sorted.toString()]);
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return Promise.resolve(cached.reply); }
    let pending = this.pending.get(key);
    if (!pending) {
      const controller = new AbortController();
      const promise = this.pool.run(root, route, sorted.toString(), controller.signal).then(reply => {
        if (reply.status === 200) {
          const bytes = Buffer.byteLength(JSON.stringify(reply));
          if (bytes <= this.maxBytes) {
            while (this.bytes + bytes > this.maxBytes && this.cache.size) {
              const oldest = this.cache.keys().next().value!;
              this.bytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
            }
            this.cache.set(key, { reply, bytes }); this.bytes += bytes;
          }
        }
        return reply;
      }).finally(() => { if (this.pending.get(key)?.controller === controller) this.pending.delete(key); });
      pending = { promise, controller, users: 0 }; this.pending.set(key, pending);
    }
    const shared = pending; shared.users++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = () => { done = true; signal.removeEventListener('abort', abort); shared.users--; };
      const abort = () => {
        if (done) return;
        finish();
        if (!shared.users) {
          if (this.pending.get(key) === shared) this.pending.delete(key);
          shared.controller.abort();
        }
        reject(new Error('查询已取消。'));
      };
      signal.addEventListener('abort', abort, { once: true });
      shared.promise.then(reply => { if (!done) { finish(); resolve(reply); } }, error => { if (!done) { finish(); reject(error); } });
    });
  }
  close(): void { this.pool.close(); this.cache.clear(); this.bytes = 0; }
}
