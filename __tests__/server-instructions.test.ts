/**
 * Server Instructions Tests
 *
 * The MCP `initialize` instructions land in the agent's system prompt on
 * EVERY session, for every client — so they carry a size budget (the header
 * of server-instructions.ts already demands "keep it tight"; this pins it),
 * and the literal marker strings that agents pattern-match on (staleness
 * banners, the dedup pointer line) must survive any rewording.
 */

import { describe, it, expect } from 'vitest';
import {
  SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS_NO_ROOT_INDEX,
} from '../src/mcp/server-instructions';

describe('server instructions', () => {
  it('keeps the literal marker strings agents pattern-match on', () => {
    expect(SERVER_INSTRUCTIONS).toContain(
      '⚠️ Some files referenced below were edited since the last index sync',
    );
    expect(SERVER_INSTRUCTIONS).toContain('⚠️ CodeGraph auto-sync is DISABLED');
    expect(SERVER_INSTRUCTIONS).toContain('changed on disk after the last index sync');
    expect(SERVER_INSTRUCTIONS).toContain('Already sent earlier in this conversation');
  });

  it('keeps the core operative guidance', () => {
    expect(SERVER_INSTRUCTIONS).toContain('codegraph_explore');
    expect(SERVER_INSTRUCTIONS).toContain('codegraph init');
    // The default MCP surface is codegraph_explore alone — no other tool
    // may be named (they are hidden unless re-enabled via CODEGRAPH_MCP_TOOLS).
    expect(SERVER_INSTRUCTIONS).not.toMatch(/codegraph_(?!explore)\w+/);
    expect(SERVER_INSTRUCTIONS_NO_ROOT_INDEX).toContain('projectPath');
    expect(SERVER_INSTRUCTIONS_NO_ROOT_INDEX).toContain('codegraph init');
  });

  it('stays inside the per-session size budget (chars ≈ tokens×4)', () => {
    // ~1k tokens. Injected into every session of every MCP client; growth
    // here is paid by every agent conversation before any work happens.
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(4000);
    expect(SERVER_INSTRUCTIONS_NO_ROOT_INDEX.length).toBeLessThan(1500);
  });
});
