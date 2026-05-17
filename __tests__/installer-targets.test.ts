/**
 * Multi-target installer tests.
 *
 * Each `AgentTarget` is exercised against the same contract:
 *   - `install` writes the expected files
 *   - re-running `install` is byte-identical (idempotent)
 *   - sibling MCP servers / unrelated config is preserved
 *   - `uninstall` reverses `install`
 *   - `printConfig` returns parseable, non-empty content
 *
 * For agent-config destinations we redirect HOME to a tmpdir via
 * `os.homedir` spying, and CWD via `process.chdir` — same pattern as
 * the legacy `installer.test.ts`. No real `~/.claude/` etc. ever
 * touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ALL_TARGETS, getTarget, resolveTargetFlag } from '../src/installer/targets/registry';
import { upsertTomlTable, removeTomlTable, buildTomlTable } from '../src/installer/targets/toml';

function mkTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cg-targets-${label}-`));
}

// `os.homedir` is non-configurable on Node, so we redirect it via the
// `$HOME` (POSIX) / `$USERPROFILE` (Windows) env vars that
// `os.homedir()` reads first. Same trick the rest of the suite uses
// when it needs a mock home.
function setHome(dir: string): { restore: () => void } {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return {
    restore() {
      if (prev.HOME === undefined) delete process.env.HOME; else process.env.HOME = prev.HOME;
      if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.USERPROFILE;
    },
  };
}

describe('Installer targets — contract', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('home');
    tmpCwd = mkTmpDir('cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
  });

  afterEach(() => {
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  for (const target of ALL_TARGETS) {
    describe(target.id, () => {
      const supportedLocations = (['global', 'local'] as const).filter((l) =>
        target.supportsLocation(l),
      );

      for (const location of supportedLocations) {
        describe(`location=${location}`, () => {
          it('install writes files; detect.alreadyConfigured becomes true', () => {
            expect(target.detect(location).alreadyConfigured).toBe(false);

            const result = target.install(location, { autoAllow: true });
            expect(result.files.length).toBeGreaterThan(0);
            for (const file of result.files) {
              if (file.action !== 'unchanged') {
                expect(fs.existsSync(file.path)).toBe(true);
              }
            }

            expect(target.detect(location).alreadyConfigured).toBe(true);
          });

          it('re-running install is idempotent (no actions other than unchanged)', () => {
            target.install(location, { autoAllow: true });
            const second = target.install(location, { autoAllow: true });
            for (const file of second.files) {
              expect(file.action).toBe('unchanged');
            }
          });

          it('install preserves a pre-existing sibling MCP server (where applicable)', () => {
            // Plant a sibling entry in the same JSON config, install,
            // and verify the sibling survives. Skip for Codex (TOML)
            // and any target with no JSON config — they get covered
            // by their own dedicated tests below.
            const paths = target.describePaths(location);
            const jsonPath = paths.find((p) => p.endsWith('.json'));
            if (!jsonPath) return;

            // Seed pre-existing config.
            fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
            const seed: Record<string, any> = { mcpServers: { other: { command: 'x' } } };
            // opencode uses `mcp` not `mcpServers`. Match its shape too.
            if (target.id === 'opencode') {
              delete seed.mcpServers;
              seed.mcp = { other: { type: 'local', command: ['x'], enabled: true } };
            }
            fs.writeFileSync(jsonPath, JSON.stringify(seed, null, 2) + '\n');

            target.install(location, { autoAllow: true });

            const after = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
            if (target.id === 'opencode') {
              expect(after.mcp.other).toBeDefined();
              expect(after.mcp.codegraph).toBeDefined();
            } else {
              expect(after.mcpServers.other).toBeDefined();
              expect(after.mcpServers.codegraph).toBeDefined();
            }
          });

          it('uninstall reverses install (alreadyConfigured returns to false)', () => {
            target.install(location, { autoAllow: true });
            expect(target.detect(location).alreadyConfigured).toBe(true);

            target.uninstall(location);
            expect(target.detect(location).alreadyConfigured).toBe(false);
          });

          it('printConfig returns non-empty output without writing anything', () => {
            const before = listAllFiles(tmpHome).concat(listAllFiles(tmpCwd));
            const out = target.printConfig(location);
            expect(out.length).toBeGreaterThan(0);
            const after = listAllFiles(tmpHome).concat(listAllFiles(tmpCwd));
            expect(after.sort()).toEqual(before.sort());
          });
        });
      }
    });
  }
});

describe('Installer targets — partial-state idempotency', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('home');
    tmpCwd = mkTmpDir('cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
  });

  afterEach(() => {
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('codex: install after only config.toml exists — second pass is fully unchanged', () => {
    const codex = getTarget('codex')!;
    // First install creates both files.
    codex.install('global', { autoAllow: false });
    // Delete the AGENTS.md to simulate partial state (user wiped one file).
    const agentsMd = path.join(tmpHome, '.codex', 'AGENTS.md');
    expect(fs.existsSync(agentsMd)).toBe(true);
    fs.unlinkSync(agentsMd);
    // Reinstall — TOML stays unchanged, AGENTS.md is recreated.
    const second = codex.install('global', { autoAllow: false });
    const tomlEntry = second.files.find((f) => f.path.endsWith('config.toml'))!;
    const mdEntry = second.files.find((f) => f.path.endsWith('AGENTS.md'))!;
    expect(tomlEntry.action).toBe('unchanged');
    expect(mdEntry.action).toBe('created');
    // Third install — both unchanged (full idempotency restored).
    const third = codex.install('global', { autoAllow: false });
    for (const f of third.files) expect(f.action).toBe('unchanged');
  });

  it('codex: user-added key inside [mcp_servers.codegraph] survives idempotent re-install', () => {
    const codex = getTarget('codex')!;
    codex.install('global', { autoAllow: false });
    const tomlPath = path.join(tmpHome, '.codex', 'config.toml');
    const original = fs.readFileSync(tomlPath, 'utf-8');
    // User edits the block to add a custom key.
    const edited = original.replace(
      'args = ["serve", "--mcp"]',
      'args = ["serve", "--mcp"]\nenabled = true',
    );
    fs.writeFileSync(tomlPath, edited);
    // Re-install: our serializer doesn't know `enabled = true`, so
    // the block no longer matches the canonical form — we'll
    // overwrite it. This is the documented contract: we own the
    // codegraph block exclusively.
    const second = codex.install('global', { autoAllow: false });
    const tomlEntry = second.files.find((f) => f.path.endsWith('config.toml'))!;
    expect(tomlEntry.action).toBe('updated');
    const after = fs.readFileSync(tomlPath, 'utf-8');
    expect(after).not.toContain('enabled = true');
  });
});

describe('Installer targets — registry', () => {
  it('getTarget returns the right target for each id', () => {
    expect(getTarget('claude')?.id).toBe('claude');
    expect(getTarget('cursor')?.id).toBe('cursor');
    expect(getTarget('codex')?.id).toBe('codex');
    expect(getTarget('opencode')?.id).toBe('opencode');
    expect(getTarget('not-a-real-target')).toBeUndefined();
  });

  it('resolveTargetFlag handles auto/all/none/csv', () => {
    expect(resolveTargetFlag('none', 'global')).toEqual([]);
    expect(resolveTargetFlag('all', 'global').length).toBe(ALL_TARGETS.length);
    const csv = resolveTargetFlag('claude,cursor', 'global');
    expect(csv.map((t) => t.id)).toEqual(['claude', 'cursor']);
  });

  it('resolveTargetFlag throws on unknown id', () => {
    expect(() => resolveTargetFlag('claude,bogus', 'global')).toThrow(/Unknown --target/);
  });
});

describe('Installer targets — TOML serializer (Codex backbone)', () => {
  it('builds a [mcp_servers.codegraph] block with command + args', () => {
    const block = buildTomlTable('mcp_servers.codegraph', {
      command: 'codegraph',
      args: ['serve', '--mcp'],
    });
    expect(block).toContain('[mcp_servers.codegraph]');
    expect(block).toContain('command = "codegraph"');
    expect(block).toContain('args = ["serve", "--mcp"]');
  });

  it('upsert inserts into empty content', () => {
    const block = buildTomlTable('mcp_servers.codegraph', { command: 'codegraph', args: ['serve'] });
    const { content, action } = upsertTomlTable('', 'mcp_servers.codegraph', block);
    expect(action).toBe('inserted');
    expect(content.startsWith('[mcp_servers.codegraph]')).toBe(true);
  });

  it('upsert is idempotent — second call returns unchanged', () => {
    const block = buildTomlTable('mcp_servers.codegraph', { command: 'codegraph', args: ['serve'] });
    const first = upsertTomlTable('', 'mcp_servers.codegraph', block);
    const second = upsertTomlTable(first.content, 'mcp_servers.codegraph', block);
    expect(second.action).toBe('unchanged');
    expect(second.content).toBe(first.content);
  });

  it('upsert replaces an existing block in place, preserving sibling tables', () => {
    const existing = [
      '[other_table]',
      'foo = "bar"',
      '',
      '[mcp_servers.codegraph]',
      'command = "old-codegraph"',
      'args = ["old"]',
      '',
      '[zzz]',
      'baz = "qux"',
      '',
    ].join('\n');
    const newBlock = buildTomlTable('mcp_servers.codegraph', {
      command: 'codegraph',
      args: ['serve', '--mcp'],
    });
    const { content, action } = upsertTomlTable(existing, 'mcp_servers.codegraph', newBlock);
    expect(action).toBe('replaced');
    expect(content).toContain('[other_table]');
    expect(content).toContain('foo = "bar"');
    expect(content).toContain('[zzz]');
    expect(content).toContain('baz = "qux"');
    expect(content).toContain('command = "codegraph"');
    expect(content).not.toContain('old-codegraph');
  });

  it('removeTomlTable strips the block and preserves siblings', () => {
    const existing = [
      '[other_table]',
      'foo = "bar"',
      '',
      '[mcp_servers.codegraph]',
      'command = "codegraph"',
      'args = ["serve"]',
    ].join('\n');
    const { content, action } = removeTomlTable(existing, 'mcp_servers.codegraph');
    expect(action).toBe('removed');
    expect(content).toContain('[other_table]');
    expect(content).toContain('foo = "bar"');
    expect(content).not.toContain('mcp_servers.codegraph');
  });

  it('removeTomlTable on missing table returns not-found, no content change', () => {
    const existing = '[other]\nfoo = "bar"\n';
    const { content, action } = removeTomlTable(existing, 'mcp_servers.codegraph');
    expect(action).toBe('not-found');
    expect(content).toBe(existing);
  });

  it('upsert preserves an array-of-tables sibling [[foo]]', () => {
    const existing = [
      '[[foo]]',
      'name = "a"',
      '',
      '[[foo]]',
      'name = "b"',
      '',
    ].join('\n');
    const block = buildTomlTable('mcp_servers.codegraph', { command: 'codegraph', args: ['serve'] });
    const { content } = upsertTomlTable(existing, 'mcp_servers.codegraph', block);
    expect(content.match(/\[\[foo\]\]/g)?.length).toBe(2);
    expect(content).toContain('[mcp_servers.codegraph]');
  });
});

function listAllFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listAllFiles(full));
    else out.push(full);
  }
  return out;
}
