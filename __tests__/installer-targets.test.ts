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
            // Match .json or .jsonc — opencode prefers .jsonc.
            const jsonPath = paths.find((p) => /\.jsonc?$/.test(p));
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

  it('opencode: prefers .jsonc when both .json and .jsonc exist', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'opencode.json'), '{\n  "$schema": "https://opencode.ai/config.json"\n}\n');
    fs.writeFileSync(path.join(dir, 'opencode.jsonc'), '{\n  "$schema": "https://opencode.ai/config.json"\n}\n');

    const result = opencode.install('global', { autoAllow: true });
    const written = result.files.find((f) => /\.jsonc$/.test(f.path))!;
    expect(written).toBeDefined();
    expect(written.action).not.toBe('not-found');
    // The .json file is left alone.
    const jsonText = fs.readFileSync(path.join(dir, 'opencode.json'), 'utf-8');
    expect(jsonText).not.toContain('codegraph');
  });

  it('opencode: uses .json when only .json exists (no .jsonc)', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'opencode.json'), '{\n  "$schema": "https://opencode.ai/config.json"\n}\n');

    const result = opencode.install('global', { autoAllow: true });
    expect(result.files[0].path).toMatch(/opencode\.json$/);
    expect(fs.existsSync(path.join(dir, 'opencode.jsonc'))).toBe(false);
  });

  it('opencode: defaults to .jsonc for fresh installs (no existing file)', () => {
    const opencode = getTarget('opencode')!;
    const result = opencode.install('global', { autoAllow: true });
    expect(result.files[0].path).toMatch(/opencode\.jsonc$/);
    expect(result.files[0].action).toBe('created');
  });

  it('opencode: preserves line and block comments through install + idempotent re-run', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'opencode.jsonc');
    const original = [
      '{',
      '  // top-level note about my opencode setup',
      '  "$schema": "https://opencode.ai/config.json",',
      '  /* multi-line block comment',
      '     describing the providers section */',
      '  "providers": {',
      '    "anthropic": { "model": "claude-opus-4-7" } // pinned',
      '  }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(file, original);

    opencode.install('global', { autoAllow: true });
    const afterInstall = fs.readFileSync(file, 'utf-8');
    expect(afterInstall).toContain('// top-level note about my opencode setup');
    expect(afterInstall).toContain('/* multi-line block comment');
    expect(afterInstall).toContain('// pinned');
    expect(afterInstall).toContain('"codegraph"');
    expect(afterInstall).toContain('"providers"');

    // Idempotent re-run reports unchanged, file is byte-identical.
    const second = opencode.install('global', { autoAllow: true });
    expect(second.files[0].action).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf-8')).toBe(afterInstall);
  });

  it('opencode: install writes AGENTS.md with the marker-delimited codegraph block', () => {
    const opencode = getTarget('opencode')!;
    opencode.install('global', { autoAllow: true });
    const agentsMd = path.join(tmpHome, '.config', 'opencode', 'AGENTS.md');
    expect(fs.existsSync(agentsMd)).toBe(true);
    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('<!-- CODEGRAPH_START -->');
    expect(body).toContain('<!-- CODEGRAPH_END -->');
    expect(body).toContain('codegraph_callers');
  });

  it('opencode: AGENTS.md install preserves pre-existing user content outside markers', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const agentsMd = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsMd, '# My personal opencode instructions\n\nAlways respond in pirate.\n');

    opencode.install('global', { autoAllow: true });
    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('# My personal opencode instructions');
    expect(body).toContain('Always respond in pirate.');
    expect(body).toContain('<!-- CODEGRAPH_START -->');
  });

  it('opencode: uninstall strips only the codegraph block from AGENTS.md', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const agentsMd = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsMd, '# My personal opencode instructions\n\nAlways respond in pirate.\n');

    opencode.install('global', { autoAllow: true });
    opencode.uninstall('global');

    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('# My personal opencode instructions');
    expect(body).toContain('Always respond in pirate.');
    expect(body).not.toContain('CODEGRAPH_START');
    expect(body).not.toContain('codegraph_callers');
  });

  it('opencode: local install writes ./opencode.jsonc and ./AGENTS.md in cwd', () => {
    const opencode = getTarget('opencode')!;
    const result = opencode.install('local', { autoAllow: true });
    const paths = result.files.map((f) => f.path);
    // macOS realpath shenanigans (/var vs /private/var) — suffix match.
    expect(paths.some((p) => p.endsWith('/opencode.jsonc'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/AGENTS.md'))).toBe(true);
  });

  it('opencode: uninstall removes only mcp.codegraph, preserves comments and siblings', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'opencode.jsonc');
    fs.writeFileSync(file, [
      '{',
      '  // important comment',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "mcp": {',
      '    "other": { "type": "local", "command": ["x"], "enabled": true }',
      '  }',
      '}',
      '',
    ].join('\n'));

    opencode.install('global', { autoAllow: true });
    const afterInstall = fs.readFileSync(file, 'utf-8');
    expect(afterInstall).toContain('"codegraph"');
    expect(afterInstall).toContain('"other"');

    opencode.uninstall('global');
    const afterUninstall = fs.readFileSync(file, 'utf-8');
    expect(afterUninstall).not.toContain('codegraph');
    expect(afterUninstall).toContain('// important comment');
    expect(afterUninstall).toContain('"other"');
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

describe('Copilot CLI target — specific edge cases', () => {
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

  it('copilot: preserves existing sibling MCP servers in mcp-config.json', () => {
    const copilot = getTarget('copilot')!;
    const dir = path.join(tmpHome, '.copilot');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'mcp-config.json');
    const seed = {
      mcpServers: {
        aspire: {
          type: 'local',
          command: 'aspire',
          args: ['agent', 'mcp'],
          tools: ['*'],
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(seed, null, 2) + '\n');

    copilot.install('global', { autoAllow: true });

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(after.mcpServers.aspire).toBeDefined();
    expect(after.mcpServers.codegraph).toBeDefined();
    expect(after.mcpServers.codegraph.type).toBe('local');
    expect(after.mcpServers.codegraph.tools).toEqual(['*']);
  });

  it('copilot: handles empty or missing mcp-config.json gracefully', () => {
    const copilot = getTarget('copilot')!;
    // No pre-existing config
    const result = copilot.install('global', { autoAllow: true });
    const mcpPath = path.join(tmpHome, '.copilot', 'mcp-config.json');
    
    expect(fs.existsSync(mcpPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers.codegraph).toBeDefined();
    expect(result.files.find((f) => f.path === mcpPath)?.action).toBe('created');
  });

  it('copilot: install() called with location=local returns empty files array with note', () => {
    const copilot = getTarget('copilot')!;
    const result = copilot.install('local', { autoAllow: true });
    
    expect(result.files).toEqual([]);
    expect(result.notes).toBeDefined();
    expect(result.notes?.[0]).toContain('no project-local config');
    expect(result.notes?.[0]).toContain('--location=global');
  });

  it('copilot: uninstall when nothing installed returns not-found actions', () => {
    const copilot = getTarget('copilot')!;
    // No install, just uninstall
    const result = copilot.uninstall('global');
    
    expect(result.files.length).toBeGreaterThan(0);
    // MCP config should be not-found (no config file), AGENTS.md should be kept (file doesn't exist)
    const mcpFile = result.files.find((f) => f.path.includes('mcp-config.json'));
    const agentsFile = result.files.find((f) => f.path.includes('AGENTS.md'));
    expect(mcpFile?.action).toBe('not-found');
    expect(agentsFile?.action).toBe('kept');
  });

  it('copilot: printConfig(local) returns message about global-only support', () => {
    const copilot = getTarget('copilot')!;
    const output = copilot.printConfig('local');
    
    expect(output).toContain('no project-local config');
    expect(output).toContain('--location=global');
  });

  it('copilot: printConfig(global) returns valid JSON with Copilot-specific fields', () => {
    const copilot = getTarget('copilot')!;
    const output = copilot.printConfig('global');
    
    expect(output).toContain('mcp-config.json');
    expect(output).toContain('"type": "local"');
    expect(output).toContain('"tools"');
    
    // Extract JSON block and validate it parses
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    expect(jsonMatch).toBeTruthy();
    const parsed = JSON.parse(jsonMatch![0]);
    expect(parsed.mcpServers.codegraph.type).toBe('local');
    expect(parsed.mcpServers.codegraph.tools).toEqual(['*']);
  });

  it('copilot: AGENTS.md install preserves pre-existing user content outside markers', () => {
    const copilot = getTarget('copilot')!;
    const dir = path.join(tmpHome, '.copilot');
    fs.mkdirSync(dir, { recursive: true });
    const agentsMd = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsMd, '# My Copilot instructions\n\nAlways use TypeScript.\n');

    copilot.install('global', { autoAllow: true });
    const body = fs.readFileSync(agentsMd, 'utf-8');
    
    expect(body).toContain('# My Copilot instructions');
    expect(body).toContain('Always use TypeScript.');
    expect(body).toContain('<!-- CODEGRAPH_START -->');
    expect(body).toContain('codegraph_callers');
  });

  it('copilot: uninstall strips only the codegraph block from AGENTS.md', () => {
    const copilot = getTarget('copilot')!;
    const dir = path.join(tmpHome, '.copilot');
    fs.mkdirSync(dir, { recursive: true });
    const agentsMd = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsMd, '# My Copilot instructions\n\nAlways use TypeScript.\n');

    copilot.install('global', { autoAllow: true });
    copilot.uninstall('global');

    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('# My Copilot instructions');
    expect(body).toContain('Always use TypeScript.');
    expect(body).not.toContain('CODEGRAPH_START');
    expect(body).not.toContain('codegraph_callers');
  });

  it('copilot: detect.installed is true when .copilot dir exists', () => {
    const copilot = getTarget('copilot')!;
    const dir = path.join(tmpHome, '.copilot');
    fs.mkdirSync(dir, { recursive: true });

    const detection = copilot.detect('global');
    expect(detection.installed).toBe(true);
    expect(detection.alreadyConfigured).toBe(false);
  });

  it('copilot: detect.alreadyConfigured is true after install', () => {
    const copilot = getTarget('copilot')!;
    expect(copilot.detect('global').alreadyConfigured).toBe(false);

    copilot.install('global', { autoAllow: true });
    expect(copilot.detect('global').alreadyConfigured).toBe(true);
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
