import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { CodeGraph, getDatabasePath } from '../src';
import { terminateOnceStarted, workerStarted } from '../src/worker-teardown';
import type { ChunkResult } from '../src/resolution/resolver-pool';
import type { UnresolvedReference } from '../src/types';

interface WorkerMessage extends Partial<ChunkResult> { type: string; id?: number; message?: string }

function receive(worker: Worker, type: string, id?: number): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onExit = (code: number) => { cleanup(); reject(new Error(`Resolver worker exited before ${type}: ${code}`)); };
    const onMessage = (message: WorkerMessage) => {
      if (message.type === 'error') { onError(new Error(message.message ?? 'Resolver worker failed')); return; }
      if (message.type !== type || message.id !== id) return;
      cleanup();
      resolve(message);
    };
    const timer = setTimeout(() => onError(new Error(`Timed out awaiting resolver worker ${type}`)), 15_000);
    worker.on('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
  });
}

describe('compiled resolver worker Lua lexical analysis', () => {
  let dir: string;
  let cg: CodeGraph | undefined;
  let worker: Worker | undefined;
  let started: Promise<void>;

  beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lua-resolve-worker-'))); });
  afterEach(async () => {
    if (worker && worker.threadId !== -1) {
      const exiting = new Promise<void>(resolve => worker!.once('exit', () => resolve()));
      worker.postMessage({ type: 'close' });
      const timer = setTimeout(() => { void terminateOnceStarted(worker!, started); }, 5_000);
      await exiting;
      clearTimeout(timer);
    }
    worker = undefined;
    cg?.close();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('loads its own Lua parser before rejecting captured parameters and accepting proven rebindings', async () => {
    fs.writeFileSync(path.join(dir, 'bridge.lua'), `local Bridge = {}
function Bridge.call(op) return op end
return Bridge`);
    const source = `local Bridge = require("bridge")
function outer(Bridge)
  local function nested()
    return Bridge.call("task.run")
  end
  return nested()
end
function rebound(Bridge)
  Bridge = require("bridge")
  return Bridge.call("task.run")
end`;
    fs.writeFileSync(path.join(dir, 'caller.lua'), source);
    // The parameter rule serves the Lua/Rust bridge, so only such projects use it.
    fs.writeFileSync(path.join(dir, 'lib.rs'), 'pub fn native() {}\n');
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const node = (name: string) => cg!.getNodesByName(name).find(node => node.kind === 'function' || node.kind === 'method')!;
    const captured = node('nested');
    const rebound = node('rebound');
    const target = node('call');
    const ref = (fromNodeId: string, line: number): UnresolvedReference => ({
      fromNodeId,
      referenceName: 'Bridge.call',
      referenceKind: 'calls',
      filePath: 'caller.lua',
      language: 'lua',
      line,
      column: source.split('\n')[line - 1]!.indexOf('Bridge.call'),
    });
    worker = new Worker(path.resolve(__dirname, '../dist/resolution/resolver-worker.js'));
    started = workerStarted(worker);
    const ready = receive(worker, 'ready');
    worker.postMessage({ type: 'open', dbPath: getDatabasePath(dir), projectRoot: dir });
    await ready;
    const result = receive(worker, 'result', 1);
    worker.postMessage({ type: 'resolve', id: 1, refs: [ref(captured.id, 4), ref(rebound.id, 10)] });
    const response = await result;
    expect(response.resolved).toHaveLength(1);
    expect(response.resolved![0]).toMatchObject({ original: { fromNodeId: rebound.id }, targetNodeId: target.id });
    expect(response.unresolved).toHaveLength(1);
    expect(response.unresolved![0]!.fromNodeId).toBe(captured.id);
  }, 30_000);
});
