/**
 * #618 — the "attached to shared daemon" line is benign INFO, but MCP hosts
 * render server stderr at error level (and tack on an `undefined` data field),
 * so on every session start a healthy attach showed up as `[error] … undefined`.
 * It's now gated behind CODEGRAPH_MCP_LOG_ATTACH=1 — silent by default, opt-in
 * for debugging. Approach from #640 by @mturac.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logAttachedDaemon } from '../src/mcp/proxy';

const hello = { pid: 4242, codegraph: '9.9.9' } as any;

describe('daemon attach log gating (#618)', () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as any);
  });

  afterEach(() => {
    spy.mockRestore();
    delete process.env.CODEGRAPH_MCP_LOG_ATTACH;
  });

  it('is silent by default (no [error]/undefined noise in MCP hosts)', () => {
    delete process.env.CODEGRAPH_MCP_LOG_ATTACH;
    logAttachedDaemon('/tmp/cg.sock', hello);
    expect(spy).not.toHaveBeenCalled();
  });

  it('logs the attach line only when CODEGRAPH_MCP_LOG_ATTACH=1 (opt-in debug)', () => {
    process.env.CODEGRAPH_MCP_LOG_ATTACH = '1';
    logAttachedDaemon('/tmp/cg.sock', hello);
    const out = spy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('Attached to shared daemon on /tmp/cg.sock');
    expect(out).toContain('pid 4242');
  });
});
