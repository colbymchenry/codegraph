import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function request(
  child: ChildProcessWithoutNullStreams,
  msg: { id: number; method: string; params?: unknown },
  timeoutMs = 15000,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for response id=${msg.id}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      let newline: number;
      while ((newline = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, newline).trim();
        buf = buf.slice(newline + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === msg.id) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            resolve(parsed);
            return;
          }
        } catch { /* ignore non-protocol output */ }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  });
}

describe('MCP default project resolution from a workspace root (#1606, #1607)', () => {
  let tmp: string;
  let child: ChildProcessWithoutNullStreams | null;
  let stderr: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-subproject-')));
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"private":true,"workspaces":["packages/*"]}');
    child = null;
    stderr = '';
  });

  afterEach(async () => {
    if (child) {
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      child = null;
    }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function makeIndexed(relativePath: string): string {
    const root = path.join(tmp, relativePath);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.ts'), 'export function marker(): string { return "ok"; }\n');
    const cg = CodeGraph.initSync(root);
    cg.close();
    return root;
  }

  function spawnServer(): ChildProcessWithoutNullStreams {
    const proc = spawn(process.execPath, [BIN, 'serve', '--mcp', '--no-watch'], {
      cwd: tmp,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
    }) as ChildProcessWithoutNullStreams;
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    return proc;
  }

  async function initialize(): Promise<void> {
    await request(child!, {
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
        rootUri: `file://${tmp}`,
      },
    });
  }

  it('opens the only indexed child as the shared default project', async () => {
    makeIndexed(path.join('packages', 'api'));
    child = spawnServer();
    await initialize();

    const response = await request(child, {
      id: 1,
      method: 'tools/call',
      params: { name: 'codegraph_status', arguments: {} },
    });
    const text = response.result.content[0].text as string;
    expect(text).toContain('CodeGraph Status');
    expect(text).not.toContain('No CodeGraph project is loaded');
  });

  it('lists multiple indexed children instead of guessing a default', async () => {
    makeIndexed(path.join('packages', 'api'));
    makeIndexed(path.join('packages', 'web'));
    child = spawnServer();
    await initialize();
    await request(child, { id: 1, method: 'tools/list' });

    expect(stderr).toContain('multiple indexed sub-projects');
    expect(stderr).toContain(path.join('packages', 'api'));
    expect(stderr).toContain(path.join('packages', 'web'));
    expect(stderr).toContain('projectPath');
  });

  it('explains the no-index case and how to select or create a project', async () => {
    child = spawnServer();
    await initialize();
    await request(child, { id: 1, method: 'tools/list' });

    expect(stderr).toContain('no .codegraph/ was found');
    expect(stderr).toContain('Live sync is disabled');
    expect(stderr).toContain('codegraph init');
  });
});
