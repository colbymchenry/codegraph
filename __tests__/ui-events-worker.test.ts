import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { EventHub, type EventProbeResult } from '../src/ui-server/api/events';

function client() {
  const frames: string[] = [];
  const res = Object.assign(new EventEmitter(), { writableEnded: false, writeHead() {}, write(value: string) { frames.push(value); }, end() { this.writableEnded = true; } });
  return { res, frames, req: new EventEmitter() };
}
beforeEach(() => vi.stubEnv('CODEGRAPH_NO_WATCH', '1'));
afterEach(() => vi.unstubAllEnvs());
const result: EventProbeResult = { index: { lastIndexedAt: 10, files: 2 }, files: ['src/a.ts'], total: 1 };

describe('SSE异步索引探测', () => {
  it('立即hello、不打开主线程数据库，异步结果更新且同版本不重复广播', async () => {
    const acquire = vi.fn(() => { throw new Error('主线程不应打开数据库'); });
    let complete!: (result: EventProbeResult) => void;
    const loader = vi.fn(() => new Promise<EventProbeResult>(resolve => { complete = resolve; }));
    const hub = new EventHub('/missing-project', { acquire } as any, 'one', loader);
    const first = client();
    try {
      hub.subscribe(first.req as any, first.res as any, 'GET');
      expect(first.frames[0]).toContain('event: hello');
      expect(first.frames[0]).toContain('"index":null');
      expect(acquire).not.toHaveBeenCalled();
      complete(result);
      await vi.waitFor(() => expect(first.frames.filter(frame => frame.includes('event: index'))).toHaveLength(1));
      const second = client(); hub.subscribe(second.req as any, second.res as any, 'GET');
      complete(result);
      await Promise.resolve(); await Promise.resolve();
      expect(first.frames.filter(frame => frame.includes('event: index'))).toHaveLength(1);
    } finally { hub.close(); }
  });

  it('最后客户端关闭会取消排队探测并忽略迟到结果', async () => {
    let complete!: (result: EventProbeResult) => void;
    let signal!: AbortSignal;
    const hub = new EventHub('/missing-project', { acquire: vi.fn() } as any, 'one', (_since, abort) => {
      signal = abort;
      return new Promise(resolve => { complete = resolve; });
    });
    const first = client(); const second = client();
    hub.subscribe(first.req as any, first.res as any, 'GET'); hub.subscribe(second.req as any, second.res as any, 'GET');
    first.res.emit('close'); expect(signal.aborted).toBe(false);
    second.res.emit('close'); expect(signal.aborted).toBe(true);
    complete(result); await Promise.resolve(); await Promise.resolve();
    expect(second.frames.filter(frame => frame.includes('event: index'))).toHaveLength(0);
    hub.close();
  });
});

it('共享池饱和失败不关闭SSE，也不自动循环提交任务', async () => {
  const loader = vi.fn(async () => { throw new Error('查询超时'); });
  const hub = new EventHub('/missing-project', { acquire: vi.fn() } as any, 'one', loader);
  const first = client();
  try {
    hub.subscribe(first.req as any, first.res as any, 'GET');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(first.frames[0]).toContain('event: hello');
    expect(first.res.writableEnded).toBe(false);
    expect(loader).toHaveBeenCalledTimes(1);
    const second = client(); hub.subscribe(second.req as any, second.res as any, 'GET');
    expect(loader).toHaveBeenCalledTimes(2);
  } finally { hub.close(); }
});
