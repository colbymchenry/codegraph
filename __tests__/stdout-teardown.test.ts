import { describe, expect, it } from 'vitest';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import * as path from 'path';
import { treatStdoutFailureAsShutdown } from '../src/mcp/stdout-teardown';

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out waiting for the test-owned transport')), 5000);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer!); }
}

describe('stdout teardown', () => {
  it.each(['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'])('shuts down on %s', (code) => {
    const output = new PassThrough();
    let calls = 0;
    treatStdoutFailureAsShutdown(() => { calls++; }, output);
    expect(() => output.emit('error', Object.assign(new Error(code), { code }))).not.toThrow();
    expect(calls).toBe(1);
    expect(output.destroyed).toBe(true);
  });

  it('shuts down once across error, destroy and close', async () => {
    const output = new PassThrough();
    let calls = 0;
    treatStdoutFailureAsShutdown(() => { calls++; }, output);
    output.emit('error', new Error('broken output'));
    output.emit('close');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
  });

  it('also treats a clean output close as terminal', () => {
    const output = new PassThrough();
    let calls = 0;
    treatStdoutFailureAsShutdown(() => { calls++; }, output);
    output.emit('close');
    expect(calls).toBe(1);
  });

  it('keeps a healthy, backpressured output alive', async () => {
    const output = new PassThrough({ highWaterMark: 1 });
    let calls = 0;
    treatStdoutFailureAsShutdown(() => { calls++; }, output);
    expect(output.write('response')).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(0);
    expect(output.destroyed).toBe(false);
    output.destroy();
  });

  it('runs direct transport cleanup when the host closes only its response pipe', async () => {
    const transport = path.resolve(__dirname, '../dist/mcp/transport.js');
    const child = spawn(process.execPath, ['-e', `
      const { StdioTransport } = require(${JSON.stringify(transport)});
      const transport = new StdioTransport({ exitOnClose: false, onClose: () => {
        require('fs').writeSync(2, 'CLEANUP\\n');
        process.exit(0);
      } });
      transport.start(async (msg) => transport.sendResult(msg.id, {}));
    `], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => { /* only this test-owned child can exit */ });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    try {
      const firstResponse = new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
      child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
      await within(firstResponse);
      child.stdout.destroy();
      // stdin and the host stay alive. A subsequent response discovers EPIPE;
      // mere silence cannot reveal a closed anonymous pipe without a write.
      child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
      expect(await within(exited)).toBe(0);
      expect(stderr).toContain('CLEANUP');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }, 10_000);
});
