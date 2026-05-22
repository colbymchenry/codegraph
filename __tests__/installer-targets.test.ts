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
import { uninstallTargets } from '../src/installer';
import { upsertTomlTable, removeTomlTable, buildTomlTable } from '../src/installer/targets/toml';
import { cleanupLegacyHooks } from '../src/installer/targets/claude';

function mkTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cg-targets-${label}-`));
}

// `os.homedir` is non-configurable on Node, so we redirect it via the
// `$HOME` (POSIX) / `$USERPROFILE` (Windows) env vars that
// `os.homedir()` reads first. Same trick the rest of the suite uses
// when it needs a mock home.
function setHome(dir: string): { restore: () => void } {
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    HERMES_HOME: process.env.HERMES_HOME,
  };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.APPDATA = path.join(dir, '.config');
  process.env.XDG_CONFIG_HOME = path.join(dir, '.config');
  delete process.env.HERMES_HOME;
  return {
    restore() {
      if (prev.HOME === undefined) delete process.env.HOME; else process.env.HOME = prev.HOME;
      if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.USERPROFILE;
      if (prev.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = prev.APPDATA;
      if (prev.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME;
      if (prev.HERMES_HOME === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = prev.HERMES_HOME;
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
    const paths = result.files.map((f) => f.path.replace(/\\/g, '/'));
    // macOS realpath shenanigans (/var vs /private/var) — suffix match.
    expect(paths.some((p) => p.endsWith('/opencode.jsonc'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/AGENTS.md'))).toBe(true);
  });

  it('hermes: install adds codegraph MCP server and cli toolset, preserving existing yaml', () => {
    const hermes = getTarget('hermes')!;
    const config = path.join(tmpHome, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, [
      'model:',
      '  default: qwen-3.7',
      'mcp_servers:',
      '  other:',
      '    command: other',
      'platform_toolsets:',
      '  cli:',
      '    - hermes-cli',
      '  discord:',
      '    - hermes-discord',
      '',
    ].join('\n'));

    const result = hermes.install('global', { autoAllow: true });
    expect(result.files[0].action).toBe('updated');
    const body = fs.readFileSync(config, 'utf-8');
    expect(body).toContain('model:\n  default: qwen-3.7');
    expect(body).toContain('mcp_servers:\n  other:\n    command: other');
    expect(body).toContain('  codegraph:\n    command: codegraph');
    expect(body).toContain('    - hermes-cli');
    expect(body).toContain('    - mcp-codegraph');
    expect(body).toContain('  discord:\n    - hermes-discord');

    const second = hermes.install('global', { autoAllow: true });
    expect(second.files[0].action).toBe('unchanged');
  });

  it('hermes: uninstall removes only codegraph MCP server and toolset entry', () => {
    const hermes = getTarget('hermes')!;
    const config = path.join(tmpHome, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(config), { recursive: true });

    hermes.install('global', { autoAllow: true });
    fs.appendFileSync(config, 'custom:\n  keep: true\n');

    hermes.uninstall('global');
    const body = fs.readFileSync(config, 'utf-8');
    expect(body).not.toContain('codegraph:');
    expect(body).not.toContain('mcp-codegraph');
    expect(body).toContain('custom:\n  keep: true');
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

  it('claude: local install writes ./.mcp.json (project scope), not ./.claude.json', () => {
    const claude = getTarget('claude')!;
    const result = claude.install('local', { autoAllow: false });
    // The MCP entry lands in ./.mcp.json — the file Claude Code reads.
    expect(result.files.some((f) => f.path.replace(/\\/g, '/').endsWith('/.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpCwd, '.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpCwd, '.claude.json'))).toBe(false);
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.mcp.json'), 'utf-8'));
    expect(cfg.mcpServers.codegraph).toBeDefined();
  });

  it('claude: global install targets ~/.claude.json (user scope)', () => {
    const claude = getTarget('claude')!;
    claude.install('global', { autoAllow: false });
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf-8'));
    expect(cfg.mcpServers.codegraph).toBeDefined();
  });

  it('claude: local install migrates a legacy ./.claude.json codegraph entry into ./.mcp.json', () => {
    const claude = getTarget('claude')!;
    const legacy = path.join(tmpCwd, '.claude.json');
    fs.writeFileSync(
      legacy,
      JSON.stringify({ mcpServers: { codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] } } }, null, 2),
    );

    claude.install('local', { autoAllow: false });

    // codegraph now lives in .mcp.json; the legacy file (which held only
    // codegraph) is gone.
    const mcp = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.codegraph).toBeDefined();
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('claude: legacy ./.claude.json migration preserves sibling servers and unrelated keys', () => {
    const claude = getTarget('claude')!;
    const legacy = path.join(tmpCwd, '.claude.json');
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        mcpServers: {
          codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] },
          other: { command: 'x' },
        },
        somethingElse: true,
      }, null, 2),
    );

    claude.install('local', { autoAllow: false });

    // Only codegraph is stripped from the legacy file; siblings survive.
    const after = JSON.parse(fs.readFileSync(legacy, 'utf-8'));
    expect(after.mcpServers.codegraph).toBeUndefined();
    expect(after.mcpServers.other).toBeDefined();
    expect(after.somethingElse).toBe(true);
    const mcp = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.codegraph).toBeDefined();
  });

  it('claude: uninstall strips codegraph from ./.mcp.json and a legacy ./.claude.json', () => {
    const claude = getTarget('claude')!;
    // A user left with both the working .mcp.json and a stale .claude.json.
    fs.writeFileSync(
      path.join(tmpCwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { codegraph: { command: 'codegraph' } } }, null, 2),
    );
    fs.writeFileSync(
      path.join(tmpCwd, '.claude.json'),
      JSON.stringify({ mcpServers: { codegraph: { command: 'codegraph' }, other: { command: 'x' } } }, null, 2),
    );

    claude.uninstall('local');

    const mcp = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.mcp.json'), 'utf-8'));
    expect(mcp.mcpServers).toBeUndefined();
    const legacy = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.claude.json'), 'utf-8'));
    expect(legacy.mcpServers.codegraph).toBeUndefined();
    expect(legacy.mcpServers.other).toBeDefined();
  });

  // ---- Legacy auto-sync hook cleanup ----
  // Pre-0.8 installs wrote `codegraph mark-dirty` / `sync-if-dirty`
  // hooks to settings.json. Both subcommands were removed from the CLI,
  // so the Stop hook fails every turn ("unknown command
  // 'sync-if-dirty'"). The installer must strip them on upgrade and
  // uninstall — without touching the user's unrelated hooks.

  function seedSettings(loc: 'global' | 'local', settings: Record<string, any>): string {
    const dir = path.join(loc === 'global' ? tmpHome : tmpCwd, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    return file;
  }

  // Realistic pre-0.8 settings.json: our two auto-sync hooks plus an
  // unrelated GitKraken Stop hook the user added (matches the report).
  function legacyHookSettings(): Record<string, any> {
    return {
      hooks: {
        PostToolUse: [
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'codegraph mark-dirty', async: true }] },
        ],
        Stop: [
          { hooks: [{ type: 'command', command: 'codegraph sync-if-dirty' }] },
          { hooks: [{ type: 'command', command: '"/Users/me/gk" ai hook run --host claude-code' }] },
        ],
      },
    };
  }

  it('claude: install strips stale codegraph auto-sync hooks but keeps the user\'s GitKraken hook', () => {
    const claude = getTarget('claude')!;
    const file = seedSettings('global', legacyHookSettings());

    claude.install('global', { autoAllow: true });

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // The only PostToolUse group held mark-dirty → the event is gone.
    expect(after.hooks?.PostToolUse).toBeUndefined();
    const stopCommands = (after.hooks?.Stop ?? []).flatMap((g: any) =>
      (g.hooks ?? []).map((h: any) => h.command),
    );
    expect(stopCommands).not.toContain('codegraph sync-if-dirty');
    // The unrelated GitKraken hook survives untouched.
    expect(stopCommands.some((c: string) => c.includes('gk') && c.includes('ai hook run'))).toBe(true);
    // Permissions still written as normal alongside the cleanup.
    expect(after.permissions?.allow).toContain('mcp__codegraph__codegraph_search');
  });

  it('claude: cleanupLegacyHooks preserves a sibling hook sharing our matcher group', () => {
    const file = seedSettings('global', {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'codegraph sync-if-dirty' },
              { type: 'command', command: 'gk ai hook run --host claude-code' },
            ],
          },
        ],
      },
    });

    expect(cleanupLegacyHooks('global').action).toBe('removed');

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(after.hooks.Stop[0].hooks.map((h: any) => h.command)).toEqual([
      'gk ai hook run --host claude-code',
    ]);
  });

  it('claude: cleanupLegacyHooks is a byte-for-byte no-op without codegraph hooks', () => {
    const original =
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'gk ai hook run' }] }] } }, null, 2) + '\n';
    const file = seedSettings('global', JSON.parse(original));

    expect(cleanupLegacyHooks('global').action).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf-8')).toBe(original);
  });

  it('claude: cleanupLegacyHooks reports not-found when settings.json is absent', () => {
    expect(cleanupLegacyHooks('global').action).toBe('not-found');
  });

  it('claude: re-running install after a legacy cleanup leaves settings.json unchanged', () => {
    const claude = getTarget('claude')!;
    const file = seedSettings('global', legacyHookSettings());
    claude.install('global', { autoAllow: true });
    const firstPass = fs.readFileSync(file, 'utf-8');
    claude.install('global', { autoAllow: true });
    expect(fs.readFileSync(file, 'utf-8')).toBe(firstPass);
  });

  it('claude: uninstall strips stale hooks written in the npx form (local)', () => {
    const claude = getTarget('claude')!;
    const file = seedSettings('local', {
      hooks: {
        PostToolUse: [
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'npx @colbymchenry/codegraph mark-dirty', async: true }] },
        ],
        Stop: [
          { hooks: [{ type: 'command', command: 'npx @colbymchenry/codegraph sync-if-dirty' }] },
        ],
      },
    });

    claude.uninstall('local');

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // Both events emptied → the whole `hooks` object is removed.
    expect(after.hooks).toBeUndefined();
  });
});

describe('Installer targets — registry', () => {
  it('getTarget returns the right target for each id', () => {
    expect(getTarget('claude')?.id).toBe('claude');
    expect(getTarget('cursor')?.id).toBe('cursor');
    expect(getTarget('codex')?.id).toBe('codex');
    expect(getTarget('opencode')?.id).toBe('opencode');
    expect(getTarget('hermes')?.id).toBe('hermes');
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

describe('Installer — uninstallTargets sweep (codegraph uninstall)', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('un-home');
    tmpCwd = mkTmpDir('un-cwd');
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

  it('sweeps every agent it was installed on and reports removed for each (global)', () => {
    for (const t of ALL_TARGETS) {
      if (t.supportsLocation('global')) t.install('global', { autoAllow: true });
    }

    const reports = uninstallTargets(ALL_TARGETS, 'global');

    for (const t of ALL_TARGETS) {
      const r = reports.find((x) => x.id === t.id)!;
      expect(r.status).toBe('removed');
      expect(r.removedPaths.length).toBeGreaterThan(0);
      // The actual config is gone afterward.
      expect(t.detect('global').alreadyConfigured).toBe(false);
    }
  });

  it('is safe on a clean slate — every agent reports not-configured, nothing removed', () => {
    const reports = uninstallTargets(ALL_TARGETS, 'global');
    for (const r of reports) {
      expect(r.status).toBe('not-configured');
      expect(r.removedPaths).toEqual([]);
    }
  });

  it('reports removed only for agents that were actually configured', () => {
    // Install on Claude only; the rest stay untouched.
    getTarget('claude')!.install('global', { autoAllow: true });

    const reports = uninstallTargets(ALL_TARGETS, 'global');

    const claude = reports.find((r) => r.id === 'claude')!;
    expect(claude.status).toBe('removed');
    expect(claude.displayName).toBe(getTarget('claude')!.displayName);

    for (const r of reports.filter((x) => x.id !== 'claude')) {
      expect(r.status).toBe('not-configured');
    }
  });

  it('marks global-only agents as unsupported for a local sweep (and never touches them)', () => {
    const reports = uninstallTargets(ALL_TARGETS, 'local');
    for (const t of ALL_TARGETS) {
      const r = reports.find((x) => x.id === t.id)!;
      if (t.supportsLocation('local')) {
        expect(r.status).toBe('not-configured');
      } else {
        expect(r.status).toBe('unsupported');
        expect(r.removedPaths).toEqual([]);
        expect(r.notes[0]).toMatch(/global-only/);
      }
    }
  });

  it('is idempotent — a second sweep finds nothing left to remove', () => {
    for (const t of ALL_TARGETS) {
      if (t.supportsLocation('global')) t.install('global', { autoAllow: true });
    }
    const first = uninstallTargets(ALL_TARGETS, 'global');
    expect(first.some((r) => r.status === 'removed')).toBe(true);

    const second = uninstallTargets(ALL_TARGETS, 'global');
    for (const r of second) {
      expect(r.status).toBe('not-configured');
      expect(r.removedPaths).toEqual([]);
    }
  });

  it('a --target subset removes only the chosen agents, leaving siblings configured', () => {
    getTarget('claude')!.install('global', { autoAllow: true });
    getTarget('cursor')!.install('global', { autoAllow: true });

    const reports = uninstallTargets(resolveTargetFlag('claude', 'global'), 'global');

    expect(reports.map((r) => r.id)).toEqual(['claude']);
    expect(reports[0].status).toBe('removed');
    // Cursor was not in the subset — still configured.
    expect(getTarget('cursor')!.detect('global').alreadyConfigured).toBe(true);
    expect(getTarget('claude')!.detect('global').alreadyConfigured).toBe(false);
  });
});

describe('Installer — Cursor rules file cleanup on uninstall', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };
  const cursor = getTarget('cursor')!;

  beforeEach(() => {
    tmpHome = mkTmpDir('cur-home');
    tmpCwd = mkTmpDir('cur-cwd');
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

  const rulesFile = () => path.join(process.cwd(), '.cursor', 'rules', 'codegraph.mdc');

  it('deletes the dedicated codegraph.mdc entirely (no orphaned frontmatter left behind)', () => {
    cursor.install('local', { autoAllow: true });
    expect(fs.existsSync(rulesFile())).toBe(true);

    cursor.uninstall('local');

    // The whole file — frontmatter included — is gone, not just the block.
    expect(fs.existsSync(rulesFile())).toBe(false);
    expect(cursor.detect('local').alreadyConfigured).toBe(false);
  });

  it('preserves user content added outside the codegraph markers (strips only our block)', () => {
    cursor.install('local', { autoAllow: true });
    const withUserContent =
      fs.readFileSync(rulesFile(), 'utf-8') + '\n## My own rule\nkeep me\n';
    fs.writeFileSync(rulesFile(), withUserContent);

    cursor.uninstall('local');

    expect(fs.existsSync(rulesFile())).toBe(true);
    const after = fs.readFileSync(rulesFile(), 'utf-8');
    expect(after).toContain('keep me');
    // Our tool-usage block is gone.
    expect(after).not.toContain('codegraph_search');
    expect(after).not.toContain('CODEGRAPH_START');
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
