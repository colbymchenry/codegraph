/**
 * `codegraph serve --mcp --no-telemetry` records nothing (#1908).
 *
 * Drives the real stdio server (direct mode, a temp HOME holding an opted-in
 * telemetry config, an unreachable endpoint so nothing leaves the machine) and
 * reads the telemetry queue the server leaves behind on exit. The same run
 * without the flag is the control: it must queue the tool call, or the
 * flagged run's empty queue would prove nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

async function runOneToolCall(
  home: string,
  project: string,
  extraArgs: string[],
): Promise<{ answered: boolean; queue: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEGRAPH_NO_DAEMON: '1',
    CODEGRAPH_NO_UPDATE_CHECK: '1',
    CODEGRAPH_TELEMETRY_ENDPOINT: 'http://127.0.0.1:9/',
  };
  delete env.CODEGRAPH_TELEMETRY;
  delete env.DO_NOT_TRACK;
  const child = spawn(process.execPath, [BIN, 'serve', '--mcp', '--no-watch', '--path', project, ...extraArgs], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  let out = '';
  const answered = new Promise<void>((resolve) => {
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
      if (out.includes('"id":2')) resolve();
    });
  });
  const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codegraph_explore', arguments: { query: 'greet' } } });
  // A server that rejects the flag exits without answering; don't wait on it.
  await Promise.race([answered, exited]);
  child.stdin.end();
  await exited;
  const queue = path.join(home, '.codegraph', 'telemetry-queue.jsonl');
  return {
    answered: out.includes('"id":2'),
    queue: fs.existsSync(queue) ? fs.readFileSync(queue, 'utf8') : '',
  };
}

describe('serve --no-telemetry (#1908)', () => {
  let root: string;
  let project: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-no-telemetry-'));
    project = path.join(root, 'project');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(path.join(project, 'src', 'a.ts'), 'export function greet() { return 1; }\n');
    const cg = await CodeGraph.init(project, { index: true });
    cg.close();
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function optedInHome(name: string): string {
    const home = path.join(root, name);
    fs.mkdirSync(path.join(home, '.codegraph'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.codegraph', 'telemetry.json'),
      JSON.stringify({
        enabled: true,
        machine_id: 'test-machine',
        consent_source: 'cli',
        first_run_notice_shown: true,
        updated_at: new Date().toISOString(),
      }),
    );
    return home;
  }

  it('queues the tool call without the flag (control)', async () => {
    const run = await runOneToolCall(optedInHome('home-on'), project, []);
    expect(run.answered).toBe(true);
    expect(run.queue).toContain('codegraph_explore');
  }, 60_000);

  it('queues nothing with --no-telemetry', async () => {
    const run = await runOneToolCall(optedInHome('home-off'), project, ['--no-telemetry']);
    expect(run.answered).toBe(true);
    expect(run.queue).toBe('');
  }, 60_000);
});
