/**
 * Server Instructions Tests
 *
 * Claude Code truncates each MCP server's `instructions` and each tool's
 * description at 2,048 characters by default
 * (https://code.claude.com/docs/en/mcp). Text past the cut never reaches the
 * agent, so these pin a hard budget rather than a soft "keep it tight":
 *  - the instructions INCLUDING the update notice `initializeInstructions`
 *    appends after them,
 *  - the rules that are only safe when delivered (staleness banners,
 *    not-indexed) inside that budget, with their literal marker strings,
 *  - `codegraph_explore`'s description including its per-project suffix.
 */

import { describe, it, expect } from 'vitest';
import {
  SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS_NO_ROOT_INDEX,
} from '../src/mcp/server-instructions';
import { initializeInstructions } from '../src/mcp/session';
import { formatUpdateNotice } from '../src/upgrade/update-check';
import { tools, exploreGuidanceSuffix } from '../src/mcp/tools';

const CLAUDE_CODE_MAX_CHARS = 2048;
// Longest plausible notice: pre-release tags on both sides.
const LONG_NOTICE = formatUpdateNotice('99.99.99-beta.99', '99.99.99-beta.99');

describe('server instructions', () => {
  it('fit Claude Code\'s 2,048-char cap, update notice included', () => {
    for (const text of [SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_NO_ROOT_INDEX]) {
      expect(initializeInstructions(text, LONG_NOTICE).length).toBeLessThanOrEqual(CLAUDE_CODE_MAX_CHARS);
    }
  });

  it('keep the literal marker strings agents pattern-match on', () => {
    for (const marker of [
      '⚠️ Some files referenced below were edited since the last index sync',
      '⚠️ CodeGraph auto-sync is DISABLED',
      'RECOVERING',
      '⚠ changed on disk after the last index sync',
      '⚠️ CodeGraph cannot answer from this index',
      'Already sent earlier in this conversation',
    ]) {
      expect(SERVER_INSTRUCTIONS).toContain(marker);
    }
  });

  it('keep the core operative guidance', () => {
    expect(SERVER_INSTRUCTIONS).toContain('codegraph_explore');
    expect(SERVER_INSTRUCTIONS).toContain('## How to query');
    expect(SERVER_INSTRUCTIONS).toMatch(/no `\.codegraph\/`, stop calling codegraph/);
    expect(SERVER_INSTRUCTIONS).toContain('codegraph init');
    expect(SERVER_INSTRUCTIONS).toContain('advisory, never a quota');
    // The default MCP surface is codegraph_explore alone — no other tool
    // may be named (they are hidden unless re-enabled via CODEGRAPH_MCP_TOOLS).
    expect(SERVER_INSTRUCTIONS).not.toMatch(/codegraph_(?!explore)\w+/);
    expect(SERVER_INSTRUCTIONS_NO_ROOT_INDEX).toContain('projectPath');
    expect(SERVER_INSTRUCTIONS_NO_ROOT_INDEX).toContain('codegraph init');
  });
});

describe('codegraph_explore description', () => {
  const explore = tools.find((t) => t.name === 'codegraph_explore')!;

  it('fits Claude Code\'s 2,048-char cap, per-project suffix included', () => {
    const rebuilt = explore.description + exploreGuidanceSuffix(123_456_789);
    expect(rebuilt.length).toBeLessThanOrEqual(CLAUDE_CODE_MAX_CHARS);
  });

  it('carries the query rules moved out of the server instructions', () => {
    expect(explore.description).toContain('did-you-mean');
    expect(explore.description).toContain('lexical, not semantic');
    expect(explore.description).toContain('overloaded name');
  });
});
