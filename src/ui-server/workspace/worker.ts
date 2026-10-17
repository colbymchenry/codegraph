import { parentPort, workerData } from 'worker_threads';
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import { createGraphApi, type GraphApi } from '../api';

const sessions = new Map<string, GraphApi>();
/** 复用完整 API 分发和每项目会话，不复制查询或路径安全逻辑。 */
parentPort!.on('message', async (job: { id: number; projectRoot: string; route: string; query: string }) => {
  try {
    let api = sessions.get(job.projectRoot);
    if (!api) {
      if (sessions.size >= 4) {
        const oldest = sessions.keys().next().value!;
        sessions.get(oldest)!.close(); sessions.delete(oldest);
      }
      api = createGraphApi({ projectRoot: job.projectRoot, readOnly: workerData?.readOnly === true });
    }
    sessions.delete(job.projectRoot); sessions.set(job.projectRoot, api);
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      setHeader: () => undefined,
      writeHead(status: number) { this.statusCode = status; },
      end(body: string | Buffer) { parentPort!.postMessage({ id: job.id, status: this.statusCode, body: body ? JSON.parse(body.toString()) : null }); },
    });
    await api.handler(new EventEmitter() as IncomingMessage, res as unknown as ServerResponse, {
      pathname: job.route, projectRoot: job.projectRoot, query: new URLSearchParams(job.query), method: 'GET',
    });
  } catch (error) {
    parentPort!.postMessage({ id: job.id, status: 500, body: { error: error instanceof Error ? error.message : String(error) } });
  }
});
