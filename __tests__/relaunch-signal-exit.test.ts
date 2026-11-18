/**
 * What the CLI's relaunch does with how its child ended (#3277), on every
 * platform: the child's spawn result is stubbed, so the signal case runs on
 * Windows too, where no process ends by a signal. wasm-runtime-flags.test.ts
 * kills a real relaunched child on POSIX.
 *
 * A child killed by a signal (the kernel's out-of-memory killer, most often)
 * made the CLI exit 1 with nothing on stderr. It now names the signal and
 * exits as a shell would, 128 plus the signal's number.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnResult: { current: { status: number | null; signal: string | null } } = { current: { status: 0, signal: null } };
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawnSync: vi.fn(() => spawnResult.current),
}));

import { relaunchWithWasmRuntimeFlagsIfNeeded, WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

class Exited extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

describe('the relaunch reports a child killed by a signal (#3277)', () => {
  const savedExecArgv = [...process.execArgv];
  const savedEnv = { relaunched: process.env.CODEGRAPH_WASM_RELAUNCHED, noRelaunch: process.env.CODEGRAPH_NO_RELAUNCH };

  beforeEach(() => {
    // The relaunch runs only for a process started without the runtime flags.
    process.execArgv.splice(0, process.execArgv.length, ...savedExecArgv.filter((arg) => !WASM_RUNTIME_FLAGS.includes(arg)));
    delete process.env.CODEGRAPH_WASM_RELAUNCHED;
    delete process.env.CODEGRAPH_NO_RELAUNCH;
  });

  afterEach(() => {
    process.execArgv.splice(0, process.execArgv.length, ...savedExecArgv);
    if (savedEnv.relaunched === undefined) delete process.env.CODEGRAPH_WASM_RELAUNCHED;
    else process.env.CODEGRAPH_WASM_RELAUNCHED = savedEnv.relaunched;
    if (savedEnv.noRelaunch === undefined) delete process.env.CODEGRAPH_NO_RELAUNCH;
    else process.env.CODEGRAPH_NO_RELAUNCH = savedEnv.noRelaunch;
    vi.restoreAllMocks();
  });

  /** Run the relaunch with the child ending as `result` says; what it exits with and prints. */
  function relaunchEndingAs(result: { status: number | null; signal: string | null }): { code: number | undefined; stderr: string } {
    spawnResult.current = result;
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Exited(code);
    }) as typeof process.exit);
    try {
      relaunchWithWasmRuntimeFlagsIfNeeded('codegraph.js');
    } catch (err) {
      if (err instanceof Exited) return { code: err.code, stderr };
      throw err;
    }
    throw new Error('the relaunch returned instead of exiting');
  }

  it('names SIGKILL as a likely out-of-memory kill and exits 137', () => {
    const { code, stderr } = relaunchEndingAs({ status: null, signal: 'SIGKILL' });
    expect(code).toBe(137);
    expect(stderr).toBe('codegraph: the process was killed by SIGKILL; the system may have run out of memory.\n');
  });

  it('names any other signal and exits 128 plus its number', () => {
    expect(relaunchEndingAs({ status: null, signal: 'SIGTERM' })).toEqual({ code: 143, stderr: 'codegraph: the process was stopped by SIGTERM.\n' });
    expect(relaunchEndingAs({ status: null, signal: 'SIGNOTREAL' })).toEqual({ code: 1, stderr: 'codegraph: the process was stopped by SIGNOTREAL.\n' });
  });

  it('passes an exit code through, with nothing on stderr', () => {
    expect(relaunchEndingAs({ status: 3, signal: null })).toEqual({ code: 3, stderr: '' });
    expect(relaunchEndingAs({ status: 0, signal: null })).toEqual({ code: 0, stderr: '' });
  });
});
