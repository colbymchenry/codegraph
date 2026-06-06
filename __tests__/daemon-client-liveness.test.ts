/**
 * Unit coverage for the daemon-side client-liveness primitives (#692, Layer 2).
 *
 * These back the daemon's defense against a phantom client — one whose process
 * died without the socket ever signalling close (a Windows named-pipe hazard).
 * The wire parsing and the liveness decision are pure, so they're tested here;
 * the full handshake + sweep is exercised end-to-end in `mcp-daemon.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { parseClientHelloLine, peerIsDead } from '../src/mcp/daemon';

describe('parseClientHelloLine', () => {
  it('parses a well-formed client-hello', () => {
    expect(parseClientHelloLine('{"codegraph_client":1,"pid":1234,"hostPid":56}'))
      .toEqual({ pid: 1234, hostPid: 56 });
  });

  it('accepts a null host pid and a missing host pid', () => {
    expect(parseClientHelloLine('{"codegraph_client":1,"pid":1234,"hostPid":null}'))
      .toEqual({ pid: 1234, hostPid: null });
    expect(parseClientHelloLine('{"codegraph_client":1,"pid":1234}'))
      .toEqual({ pid: 1234, hostPid: null });
  });

  it('returns null for a JSON-RPC message (no marker) so it is treated as data', () => {
    expect(parseClientHelloLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}')).toBeNull();
  });

  it('rejects a wrong-typed marker, a non-numeric pid, and a non-integer marker', () => {
    expect(parseClientHelloLine('{"codegraph_client":true,"pid":1}')).toBeNull();
    expect(parseClientHelloLine('{"codegraph_client":2,"pid":1}')).toBeNull();
    expect(parseClientHelloLine('{"codegraph_client":1,"pid":"1"}')).toBeNull();
  });

  it('returns null for invalid / empty / non-object JSON', () => {
    expect(parseClientHelloLine('not json')).toBeNull();
    expect(parseClientHelloLine('')).toBeNull();
    expect(parseClientHelloLine('42')).toBeNull();
    expect(parseClientHelloLine('null')).toBeNull();
  });
});

describe('peerIsDead', () => {
  const aliveAll = () => true;
  const deadAll = () => false;
  const deadOnly = (...pids: number[]) => (pid: number) => !pids.includes(pid);

  it('never reaps a client with an unknown pid (no client-hello)', () => {
    expect(peerIsDead({ pid: null, hostPid: null }, deadAll)).toBe(false);
    expect(peerIsDead({ pid: null, hostPid: 99 }, deadAll)).toBe(false);
  });

  it('keeps a client whose proxy is alive', () => {
    expect(peerIsDead({ pid: 100, hostPid: null }, aliveAll)).toBe(false);
  });

  it('reaps a client whose proxy process is gone', () => {
    expect(peerIsDead({ pid: 100, hostPid: null }, deadOnly(100))).toBe(true);
  });

  it('reaps when the proxy is alive but its host is gone', () => {
    // proxy 100 alive, host 42 dead
    expect(peerIsDead({ pid: 100, hostPid: 42 }, deadOnly(42))).toBe(true);
  });

  it('keeps a client when both proxy and host are alive', () => {
    expect(peerIsDead({ pid: 100, hostPid: 42 }, aliveAll)).toBe(false);
  });
});
