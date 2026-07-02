import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// openBrowser() launches a URL that originates from the device-login server
// response (verification_uri_complete). On Windows the URL must never be handed
// to cmd.exe, which re-parses shell metacharacters (& | ^ ") and would allow a
// malicious/compromised login server to inject commands. See issue #1114.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', () => ({ spawn: spawnMock }));

import { openBrowser } from '../src/reasoning/login';

describe('openBrowser — Windows shell-injection hardening (#1114)', () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn() });
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  });

  it('does not launch the URL through cmd.exe on Windows', async () => {
    const url = 'https://app.getcodegraph.com/device?user_code=ABCD-1234&calc';

    await openBrowser(url);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];

    // cmd.exe (and its `start` builtin) re-parse metacharacters, so the launcher
    // must not be cmd and must not carry cmd's `/c` switch.
    expect(command.toLowerCase()).not.toContain('cmd');
    expect(args).not.toContain('/c');

    // The server-supplied URL is passed to the launcher as one intact argument,
    // never concatenated into a shell command string.
    expect(args).toContain(url);

    // And never through a shell at all.
    const options = spawnMock.mock.calls[0][2] as { shell?: boolean } | undefined;
    expect(options?.shell).toBeFalsy();
  });

  it.each([
    ['file:///C:/Windows/System32/calc.exe'],
    ['\\\\evil.example\\share\\payload.exe'],
    ['C:\\Windows\\System32\\calc.exe'],
    ['javascript:alert(1)'],
  ])('refuses to launch a non-http(s) target: %s', async (target) => {
    // rundll32 url.dll,FileProtocolHandler (like `open` / `xdg-open`) hands the
    // string to the OS handler, which happily executes file/UNC paths — so the
    // server-supplied string must be scheme-checked before launching anything.
    await openBrowser(target);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('still launches plain http:// URLs', async () => {
    await openBrowser('http://localhost:8080/device?user_code=ABCD-1234');

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
