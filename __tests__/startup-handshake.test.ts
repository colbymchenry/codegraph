/**
 * Never-initialized backstop + early ppid capture (#1185).
 *
 * The orphan these guard against: an MCP host kills the launcher chain within
 * the server's first ~100ms and keeps the stdio pipes open. The server boots
 * already reparented (ppid baseline reads 1 → the divergence watchdog is
 * blind), stdin never EOFs, and pre-#1185 the process lived until the host
 * itself exited. The backstop reaps any server that never receives a single
 * byte of MCP traffic; early-ppid.ts shrinks the blind window itself.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import {
  DEFAULT_STARTUP_HANDSHAKE_TIMEOUT_MS,
  armStartupHandshakeTimeout,
  parseStartupHandshakeTimeoutMs,
} from '../src/mcp/startup-handshake';
import { EARLY_PPID } from '../src/mcp/early-ppid';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('parseStartupHandshakeTimeoutMs', () => {
  it('defaults when unset or empty', () => {
    expect(parseStartupHandshakeTimeoutMs(undefined)).toBe(DEFAULT_STARTUP_HANDSHAKE_TIMEOUT_MS);
    expect(parseStartupHandshakeTimeoutMs('')).toBe(DEFAULT_STARTUP_HANDSHAKE_TIMEOUT_MS);
  });

  it('defaults on non-numeric garbage', () => {
    expect(parseStartupHandshakeTimeoutMs('abc')).toBe(DEFAULT_STARTUP_HANDSHAKE_TIMEOUT_MS);
    expect(parseStartupHandshakeTimeoutMs('NaN')).toBe(DEFAULT_STARTUP_HANDSHAKE_TIMEOUT_MS);
  });

  it('treats 0 and negatives as disabled', () => {
    expect(parseStartupHandshakeTimeoutMs('0')).toBe(0);
    expect(parseStartupHandshakeTimeoutMs('-5')).toBe(0);
  });

  it('floors fractional values', () => {
    expect(parseStartupHandshakeTimeoutMs('2500.7')).toBe(2500);
  });
});

describe('armStartupHandshakeTimeout', () => {
  it('fires exactly once when no data ever arrives', async () => {
    const stream = new PassThrough();
    let fired = 0;
    armStartupHandshakeTimeout(() => { fired++; }, stream, 40);
    await sleep(140);
    expect(fired).toBe(1);
  });

  it('does not fire once any traffic arrives', async () => {
    const stream = new PassThrough();
    let fired = 0;
    armStartupHandshakeTimeout(() => { fired++; }, stream, 40);
    stream.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    await sleep(140);
    expect(fired).toBe(0);
  });

  it('a single early byte disarms it for good', async () => {
    const stream = new PassThrough();
    let fired = 0;
    armStartupHandshakeTimeout(() => { fired++; }, stream, 40);
    stream.write('x');
    await sleep(140); // well past the 40ms window, with no further traffic
    expect(fired).toBe(0);
  });

  it('the returned disarm function cancels it', async () => {
    const stream = new PassThrough();
    let fired = 0;
    const disarm = armStartupHandshakeTimeout(() => { fired++; }, stream, 40);
    disarm();
    disarm(); // idempotent
    await sleep(140);
    expect(fired).toBe(0);
  });

  it('timeout 0 disables (env convention shared with CODEGRAPH_PPID_POLL_MS)', async () => {
    const stream = new PassThrough();
    let fired = 0;
    const disarm = armStartupHandshakeTimeout(() => { fired++; }, stream, 0);
    await sleep(80);
    expect(fired).toBe(0);
    disarm(); // still callable
  });

  it('does not steal data from the real consumer', async () => {
    // The backstop attaches its own once('data') listener; the actual MCP
    // consumer on the same stream must still see every byte.
    const stream = new PassThrough();
    let seen = '';
    stream.on('data', (c: Buffer) => { seen += c.toString(); });
    armStartupHandshakeTimeout(() => { /* no-op */ }, stream, 1000);
    stream.write('hello');
    stream.write(' world');
    await sleep(20);
    expect(seen).toBe('hello world');
  });
});

describe('EARLY_PPID', () => {
  it('captured a plausible parent pid at module load', () => {
    expect(Number.isInteger(EARLY_PPID)).toBe(true);
    expect(EARLY_PPID).toBeGreaterThan(0);
  });
});
