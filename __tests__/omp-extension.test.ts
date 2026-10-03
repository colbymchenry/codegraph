import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import codegraph from '../omp/index';

const context = '<codegraph_context note="indexed source">\nfunction download() {}\n</codegraph_context>';
type HookContext = Pick<ExtensionContext, 'cwd' | 'isProjectTrusted'>;
type Handler = (event: unknown, ctx: HookContext) => unknown;

describe('native OMP prompt hook', () => {
  let cwd: string;
  let trusted: boolean;
  let handlers: Map<string, Handler>;
  let which: Mock<() => string | null>;
  const ctx = () => ({ cwd, isProjectTrusted: () => trusted });
  const run = (prompt: string) => handlers.get('before_agent_start')!({
    type: 'before_agent_start', prompt, systemPrompt: ['base policy'],
  }, ctx());
  const load = () => {
    // Only registration is needed; these handlers use the narrow context above.
    const api = { on: (event: string, handler: Handler) => handlers.set(event, handler) } as unknown as ExtensionAPI;
    codegraph(api);
  };

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-omp-'));
    trusted = true;
    handlers = new Map();
    which = vi.fn(() => process.execPath);
    vi.stubGlobal('Bun', { which });
    vi.stubEnv('CODEGRAPH_NO_PROMPT_HOOK', '');
    vi.stubEnv('CODEGRAPH_PROMPT_HOOK', '');
    // Real subprocess, no CodeGraph index or host dependency. Node treats the
    // fixed `prompt-hook` argument as this fixture's entry point on every OS.
    fs.writeFileSync(path.join(cwd, 'prompt-hook'), `
      const fs = require('node:fs');
      fs.appendFileSync('invocations', 'started\\n');
      let raw = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => raw += chunk);
      process.stdin.on('end', () => {
        const input = JSON.parse(raw);
        if (process.env.CODEGRAPH_NO_DOWNLOAD !== '1') process.exit(2);
        const context = ${JSON.stringify(context)};
        switch (input.prompt) {
          // Real child deadline integration: parent fake timers cannot control
          // the subprocess or prove that its open handles are terminated.
          case 'hang': setInterval(() => {}, 100); break;
          case 'overflow': process.stdout.write('x'.repeat(128 * 1024)); break;
          case 'invalid': process.stdout.write('codegraph: missing bundle'); break;
          case 'partial': process.stdout.write('<codegraph_context>partial'); break;
          case 'error': process.stdout.write(context); process.exitCode = 3; break;
          case 'empty': break;
          default: process.stdout.write(context);
        }
      });
    `);
  });

  afterEach(() => {
    handlers.get('session_shutdown')?.({}, ctx());
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('delivers raw context as a hidden custom message', async () => {
    load();
    expect(await run('Explain download and its callers')).toEqual({
      message: { customType: 'codegraph-context', content: context, display: false },
    });
    expect(fs.readFileSync(path.join(cwd, 'invocations'), 'utf8')).toBe('started\n');
  });

  it('does not execute when the host reports an untrusted project', async () => {
    trusted = false;
    load();
    expect(await run('Explain download')).toBeUndefined();
    expect(fs.existsSync(path.join(cwd, 'invocations'))).toBe(false);
  });

  it('does not execute without an installed executable', async () => {
    which.mockReturnValue(null);
    load();
    expect(await run('Explain download')).toBeUndefined();
    expect(fs.existsSync(path.join(cwd, 'invocations'))).toBe(false);
  });

  it.each(['CODEGRAPH_NO_PROMPT_HOOK', 'CODEGRAPH_PROMPT_HOOK'])('honors %s before launching', async (name) => {
    vi.stubEnv(name, name === 'CODEGRAPH_NO_PROMPT_HOOK' ? '1' : '0');
    load();
    expect(await run('Explain download')).toBeUndefined();
    expect(fs.existsSync(path.join(cwd, 'invocations'))).toBe(false);
  });

  it('rejects oversized serialized input, including escaping and multibyte text', async () => {
    load();
    for (const prompt of ['x'.repeat(256 * 1024 + 1), '\u0000'.repeat(50 * 1024), '界'.repeat(90 * 1024)]) {
      expect(await run(prompt)).toBeUndefined();
    }
    expect(fs.existsSync(path.join(cwd, 'invocations'))).toBe(false);
  });

  it.each(['overflow', 'invalid', 'partial', 'error', 'empty'])('drops %s output without breaking the prompt', async (prompt) => {
    load();
    expect(await run(prompt)).toBeUndefined();
    expect(fs.readFileSync(path.join(cwd, 'invocations'), 'utf8')).toBe('started\n');
  });

  it('bounds execution time even when the hook does not finish', async () => {
    load();
    expect(await run('hang')).toBeUndefined();
    expect(fs.readFileSync(path.join(cwd, 'invocations'), 'utf8')).toBe('started\n');
  }, 4000);

  it.each(['session_start', 'session_switch', 'session_branch', 'session_tree', 'session_shutdown'])('drops pending context on %s', async (event) => {
    load();
    const pending = run('hang');
    handlers.get(event)!({}, ctx());
    expect(await pending).toBeUndefined();
    expect(await run('Explain download')).toEqual({
      message: { customType: 'codegraph-context', content: context, display: false },
    });
  });

  it('does not attach an older run result to a newer run', async () => {
    load();
    const old = run('hang');
    const current = run('Explain download');
    expect(await old).toBeUndefined();
    expect(await current).toEqual({
      message: { customType: 'codegraph-context', content: context, display: false },
    });
  });

  it('drops context if trust is revoked while the hook is running', async () => {
    load();
    const pending = run('Explain download');
    trusted = false;
    expect(await pending).toBeUndefined();
  });
});
