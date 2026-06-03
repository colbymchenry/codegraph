import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/sync/global-hooks', () => ({
  installGlobalAutoInitHook: vi.fn(),
  removeGlobalAutoInitHook: vi.fn(),
}));

import { autoInitReposAction } from '../src/bin/auto-init-repos-action';
import {
  installGlobalAutoInitHook,
  removeGlobalAutoInitHook,
} from '../src/sync/global-hooks';

const mockInstall = vi.mocked(installGlobalAutoInitHook);
const mockRemove  = vi.mocked(removeGlobalAutoInitHook);

function makeClack() {
  const calls: string[] = [];
  return {
    intro:  vi.fn(),
    outro:  vi.fn(),
    log: {
      success: vi.fn((msg: string) => calls.push(msg)),
      info:    vi.fn((msg: string) => calls.push(msg)),
      warn:    vi.fn((msg: string) => calls.push(msg)),
      error:   vi.fn((msg: string) => calls.push(msg)),
    },
    _calls: calls,
  };
}

type MockClack = ReturnType<typeof makeClack>;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  process.exitCode = undefined;
});

describe('autoInitReposAction — install path', () => {
  it('C1: calls installGlobalAutoInitHook when remove is not set', async () => {
    mockInstall.mockReturnValue({ status: 'installed', templateDir: '/tmp/t', configWasSet: true });
    const clack = makeClack();
    await autoInitReposAction({}, clack as unknown as MockClack);
    expect(mockInstall).toHaveBeenCalledOnce();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('C3: logs the resolved templateDir on successful install', async () => {
    mockInstall.mockReturnValue({ status: 'installed', templateDir: '/tmp/t', configWasSet: true });
    const clack = makeClack();
    await autoInitReposAction({}, clack as unknown as MockClack);
    expect(clack._calls.join(' ')).toContain('/tmp/t');
  });

  it('C4: logs that init.templateDir was set when configWasSet is true', async () => {
    mockInstall.mockReturnValue({ status: 'installed', templateDir: '/tmp/t', configWasSet: true });
    const clack = makeClack();
    await autoInitReposAction({}, clack as unknown as MockClack);
    expect(clack._calls.join(' ')).toMatch(/init\.templateDir set/i);
  });

  it('C5: logs that init.templateDir was already configured when configWasSet is false', async () => {
    mockInstall.mockReturnValue({ status: 'installed', templateDir: '/tmp/t', configWasSet: false });
    const clack = makeClack();
    await autoInitReposAction({}, clack as unknown as MockClack);
    expect(clack._calls.join(' ')).toMatch(/already (set|configured)/i);
  });

  it('C6: logs Already installed with templateDir when status is unchanged', async () => {
    mockInstall.mockReturnValue({ status: 'unchanged', templateDir: '/tmp/t', configWasSet: false });
    const clack = makeClack();
    await autoInitReposAction({}, clack as unknown as MockClack);
    const allOutput = clack._calls.join(' ');
    expect(allOutput).toMatch(/already installed/i);
    expect(allOutput).toContain('/tmp/t');
  });

  it('C7: does not set exit code to 1 when status is unchanged', async () => {
    mockInstall.mockReturnValue({ status: 'unchanged', templateDir: '/tmp/t', configWasSet: false });
    const clack = makeClack();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await autoInitReposAction({}, clack as unknown as MockClack);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe('autoInitReposAction — remove path', () => {
  it('C2: calls removeGlobalAutoInitHook when remove is true', async () => {
    mockRemove.mockReturnValue({ status: 'removed', templateDir: '/tmp/t', configWasSet: false });
    const clack = makeClack();
    await autoInitReposAction({ remove: true }, clack as unknown as MockClack);
    expect(mockRemove).toHaveBeenCalledOnce();
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('C8: logs templateDir and git config note on successful remove', async () => {
    mockRemove.mockReturnValue({ status: 'removed', templateDir: '/tmp/t', configWasSet: false });
    const clack = makeClack();
    await autoInitReposAction({ remove: true }, clack as unknown as MockClack);
    const allOutput = clack._calls.join(' ');
    expect(allOutput).toContain('/tmp/t');
    expect(allOutput).toMatch(/init\.templateDir was not modified/i);
  });

  it('C9: logs hook-not-found message with templateDir when status is skipped', async () => {
    mockRemove.mockReturnValue({ status: 'skipped', templateDir: '/tmp/t', configWasSet: false, reason: 'no block found' });
    const clack = makeClack();
    await autoInitReposAction({ remove: true }, clack as unknown as MockClack);
    const allOutput = clack._calls.join(' ');
    expect(allOutput).toMatch(/no codegraph auto-init hook found/i);
    expect(allOutput).toContain('/tmp/t');
  });

  it('C10: does not set exit code to 1 when status is skipped', async () => {
    mockRemove.mockReturnValue({ status: 'skipped', templateDir: '/tmp/t', configWasSet: false });
    const clack = makeClack();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await autoInitReposAction({ remove: true }, clack as unknown as MockClack);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe('autoInitReposAction — error handling', () => {
  it('C11: calls process.exit(1) when installGlobalAutoInitHook throws', async () => {
    mockInstall.mockImplementation(() => { throw new Error('write failed'); });
    const clack = makeClack();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await expect(autoInitReposAction({}, clack as unknown as MockClack)).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('C12: logs error message via clack.log.error when installGlobalAutoInitHook throws', async () => {
    mockInstall.mockImplementation(() => { throw new Error('write failed'); });
    const clack = makeClack();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    try {
      await expect(autoInitReposAction({}, clack as unknown as MockClack)).rejects.toThrow('exit');
      expect(clack.log.error).toHaveBeenCalledWith(expect.stringContaining('write failed'));
    } finally {
      exitSpy.mockRestore();
    }
  });
});
