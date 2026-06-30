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
import { cleanupLegacyHooks, writePromptHookEntry, removePromptHookEntry } from '../src/installer/targets/claude';

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

// A marker-delimited CodeGraph block exactly as a previous installer
// wrote it. Issue #529: the installer no longer writes an instructions
// file, but install (self-heal on upgrade) and uninstall both still
// strip a block a prior install left, so we plant this to exercise it.
const LEGACY_BLOCK = [
  '<!-- CODEGRAPH_START -->',
  '## CodeGraph',
  '',
  'Prefer `codegraph_search` / `codegraph_callers` over grep.',
  '<!-- CODEGRAPH_END -->',
].join('\n');

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

  it('codex: install writes config.toml AND the AGENTS.md codegraph block (#704)', () => {
    const codex = getTarget('codex')!;
    const first = codex.install('global', { autoAllow: false });
    const agentsMd = path.join(tmpHome, '.codex', 'AGENTS.md');
    expect(first.files.some((f) => f.path.endsWith('config.toml'))).toBe(true);
    // The short instructions block IS written (subagents / non-MCP
    // harnesses read AGENTS.md but never the MCP initialize instructions).
    expect(fs.existsSync(agentsMd)).toBe(true);
    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('## CodeGraph');
    expect(body).toContain('codegraph explore');
    // Re-install is fully unchanged (byte-equal block → idempotent).
    const second = codex.install('global', { autoAllow: false });
    for (const f of second.files) expect(f.action).toBe('unchanged');
  });

  it('codex: install replaces a legacy AGENTS.md codegraph block with the current one, keeping user content', () => {
    const codex = getTarget('codex')!;
    const dir = path.join(tmpHome, '.codex');
    fs.mkdirSync(dir, { recursive: true });
    const agentsMd = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsMd, `# My codex notes\n\nBe terse.\n\n${LEGACY_BLOCK}\n`);

    const result = codex.install('global', { autoAllow: false });

    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('# My codex notes');
    expect(body).toContain('Be terse.');
    // Self-heal: the stale pre-#529 body is gone, the current block is in.
    expect(body).not.toContain('Prefer `codegraph_search`');
    expect(body).toContain('codegraph explore');
    const mdEntry = result.files.find((f) => f.path.endsWith('AGENTS.md'));
    expect(mdEntry?.action).toBe('updated');
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

  it('opencode: install writes the AGENTS.md codegraph block (#704)', () => {
    const opencode = getTarget('opencode')!;
    const result = opencode.install('global', { autoAllow: true });
    const agentsMd = path.join(tmpHome, '.config', 'opencode', 'AGENTS.md');
    expect(fs.existsSync(agentsMd)).toBe(true);
    expect(fs.readFileSync(agentsMd, 'utf-8')).toContain('codegraph explore');
    expect(result.files.find((f) => f.path.endsWith('AGENTS.md'))?.action).toBe('created');
  });

  it('opencode: install replaces a legacy AGENTS.md codegraph block, preserving user content', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const agentsMd = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsMd, `# My personal opencode instructions\n\nAlways respond in pirate.\n\n${LEGACY_BLOCK}\n`);

    const result = opencode.install('global', { autoAllow: true });

    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('# My personal opencode instructions');
    expect(body).toContain('Always respond in pirate.');
    expect(body).not.toContain('Prefer `codegraph_search`');
    expect(body).toContain('codegraph explore');
    expect(result.files.find((f) => f.path.endsWith('AGENTS.md'))?.action).toBe('updated');
  });

  it('opencode: uninstall strips a leftover codegraph block from AGENTS.md, keeping user content', () => {
    const opencode = getTarget('opencode')!;
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const agentsMd = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsMd, `# My personal opencode instructions\n\nAlways respond in pirate.\n\n${LEGACY_BLOCK}\n`);

    opencode.uninstall('global');

    const body = fs.readFileSync(agentsMd, 'utf-8');
    expect(body).toContain('# My personal opencode instructions');
    expect(body).toContain('Always respond in pirate.');
    expect(body).not.toContain('CODEGRAPH_START');
  });

  it('opencode: local install writes ./opencode.jsonc and the ./AGENTS.md block (#704)', () => {
    const opencode = getTarget('opencode')!;
    const result = opencode.install('local', { autoAllow: true });
    const paths = result.files.map((f) => f.path.replace(/\\/g, '/'));
    // macOS realpath shenanigans (/var vs /private/var) — suffix match.
    expect(paths.some((p) => p.endsWith('/opencode.jsonc'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), 'AGENTS.md'))).toBe(true);
  });

  it('gemini: install writes settings.json (mcpServers.codegraph) and the GEMINI.md block (#704)', () => {
    const gemini = getTarget('gemini')!;
    const result = gemini.install('global', { autoAllow: true });
    const settings = path.join(tmpHome, '.gemini', 'settings.json');
    const geminiMd = path.join(tmpHome, '.gemini', 'GEMINI.md');
    expect(result.files.some((f) => f.path === settings)).toBe(true);
    expect(result.files.some((f) => f.path === geminiMd)).toBe(true);
    expect(fs.existsSync(geminiMd)).toBe(true);
    expect(fs.readFileSync(geminiMd, 'utf-8')).toContain('codegraph explore');

    const cfg = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    expect(cfg.mcpServers.codegraph).toEqual({ type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] });
  });

  it('gemini: install preserves pre-existing settings (security.auth survives)', () => {
    const gemini = getTarget('gemini')!;
    const settings = path.join(tmpHome, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({
      security: { auth: { selectedType: 'oauth-personal' } },
    }, null, 2) + '\n');

    gemini.install('global', { autoAllow: true });

    const after = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    expect(after.security?.auth?.selectedType).toBe('oauth-personal');
    expect(after.mcpServers?.codegraph).toBeDefined();
  });

  it('gemini: uninstall strips codegraph but leaves pre-existing settings (security.auth) intact', () => {
    const gemini = getTarget('gemini')!;
    const settings = path.join(tmpHome, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({
      security: { auth: { selectedType: 'oauth-personal' } },
    }, null, 2) + '\n');

    gemini.install('global', { autoAllow: true });
    gemini.uninstall('global');

    const after = JSON.parse(fs.readFileSync(settings, 'utf-8'));
    expect(after.security?.auth?.selectedType).toBe('oauth-personal');
    expect(after.mcpServers).toBeUndefined();
  });

  it('gemini: local install writes ./.gemini/settings.json and the project-root ./GEMINI.md block (#704)', () => {
    const gemini = getTarget('gemini')!;
    const result = gemini.install('local', { autoAllow: true });
    const paths = result.files.map((f) => f.path.replace(/\\/g, '/'));
    expect(paths.some((p) => p.endsWith('/.gemini/settings.json'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/GEMINI.md'))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), 'GEMINI.md'))).toBe(true);
  });

  it('gemini: uninstall strips a leftover GEMINI.md codegraph block, keeping user content', () => {
    const gemini = getTarget('gemini')!;
    const geminiMd = path.join(tmpHome, '.gemini', 'GEMINI.md');
    fs.mkdirSync(path.dirname(geminiMd), { recursive: true });
    fs.writeFileSync(geminiMd, `# My personal Gemini context\n\nAlways respond concisely.\n\n${LEGACY_BLOCK}\n`);

    gemini.uninstall('global');

    const body = fs.readFileSync(geminiMd, 'utf-8');
    expect(body).toContain('# My personal Gemini context');
    expect(body).toContain('Always respond concisely.');
    expect(body).not.toContain('CODEGRAPH_START');
  });

  it('kiro: install writes settings/mcp.json (mcpServers.codegraph) and no steering doc (#529)', () => {
    const kiro = getTarget('kiro')!;
    const result = kiro.install('global', { autoAllow: true });
    const mcp = path.join(tmpHome, '.kiro', 'settings', 'mcp.json');
    const steering = path.join(tmpHome, '.kiro', 'steering', 'codegraph.md');
    expect(result.files.some((f) => f.path === mcp)).toBe(true);
    expect(result.files.some((f) => f.path === steering)).toBe(false);
    expect(fs.existsSync(steering)).toBe(false);

    const cfg = JSON.parse(fs.readFileSync(mcp, 'utf-8'));
    expect(cfg.mcpServers.codegraph).toEqual({ type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] });
  });

  it('kiro: install deletes a leftover steering codegraph.md (self-heal) (#529)', () => {
    const kiro = getTarget('kiro')!;
    const steering = path.join(tmpHome, '.kiro', 'steering', 'codegraph.md');
    fs.mkdirSync(path.dirname(steering), { recursive: true });
    fs.writeFileSync(steering, `${LEGACY_BLOCK}\n`);

    const result = kiro.install('global', { autoAllow: true });
    expect(fs.existsSync(steering)).toBe(false);
    expect(result.files.find((f) => f.path === steering)?.action).toBe('removed');
  });

  it('kiro: install preserves a pre-existing sibling MCP server in mcp.json', () => {
    const kiro = getTarget('kiro')!;
    const mcp = path.join(tmpHome, '.kiro', 'settings', 'mcp.json');
    fs.mkdirSync(path.dirname(mcp), { recursive: true });
    fs.writeFileSync(mcp, JSON.stringify({
      mcpServers: { other: { command: 'uvx', args: ['other-server'] } },
    }, null, 2) + '\n');

    kiro.install('global', { autoAllow: true });

    const after = JSON.parse(fs.readFileSync(mcp, 'utf-8'));
    expect(after.mcpServers.other).toBeDefined();
    expect(after.mcpServers.codegraph).toBeDefined();
  });

  it('kiro: uninstall strips codegraph but leaves sibling MCP servers intact', () => {
    const kiro = getTarget('kiro')!;
    const mcp = path.join(tmpHome, '.kiro', 'settings', 'mcp.json');
    fs.mkdirSync(path.dirname(mcp), { recursive: true });
    fs.writeFileSync(mcp, JSON.stringify({
      mcpServers: { other: { command: 'uvx', args: ['other-server'] } },
    }, null, 2) + '\n');

    kiro.install('global', { autoAllow: true });
    kiro.uninstall('global');

    const after = JSON.parse(fs.readFileSync(mcp, 'utf-8'));
    expect(after.mcpServers.other).toBeDefined();
    expect(after.mcpServers.codegraph).toBeUndefined();
  });

  it('kiro: uninstall removes a leftover steering codegraph.md file outright', () => {
    const kiro = getTarget('kiro')!;
    const steering = path.join(tmpHome, '.kiro', 'steering', 'codegraph.md');
    fs.mkdirSync(path.dirname(steering), { recursive: true });
    fs.writeFileSync(steering, `${LEGACY_BLOCK}\n`);

    kiro.uninstall('global');
    expect(fs.existsSync(steering)).toBe(false);
  });

  it('kiro: uninstall removes our steering doc but leaves a sibling (product.md) untouched', () => {
    const kiro = getTarget('kiro')!;
    const sibling = path.join(tmpHome, '.kiro', 'steering', 'product.md');
    const ours = path.join(tmpHome, '.kiro', 'steering', 'codegraph.md');
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(sibling, '# Product\n\nMy team practices.\n');
    fs.writeFileSync(ours, `${LEGACY_BLOCK}\n`);

    kiro.uninstall('global');

    expect(fs.existsSync(ours)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
    expect(fs.readFileSync(sibling, 'utf-8')).toContain('My team practices.');
  });

  it('kiro: local install writes ./.kiro/settings/mcp.json and no steering doc (#529)', () => {
    const kiro = getTarget('kiro')!;
    const result = kiro.install('local', { autoAllow: true });
    const paths = result.files.map((f) => f.path.replace(/\\/g, '/'));
    expect(paths.some((p) => p.endsWith('/.kiro/settings/mcp.json'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/.kiro/steering/codegraph.md'))).toBe(false);
  });

  it('antigravity: install writes to LEGACY ~/.gemini/antigravity/mcp_config.json when no migration marker', () => {
    const antigravity = getTarget('antigravity')!;
    antigravity.install('global', { autoAllow: true });

    const legacyFile = path.join(tmpHome, '.gemini', 'antigravity', 'mcp_config.json');
    expect(fs.existsSync(legacyFile)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(legacyFile, 'utf-8'));
    expect(cfg.mcpServers.codegraph).toBeDefined();
    // Crucially: does NOT touch the Gemini CLI's settings.json.
    expect(fs.existsSync(path.join(tmpHome, '.gemini', 'settings.json'))).toBe(false);
  });

  it('antigravity: install writes to UNIFIED ~/.gemini/config/mcp_config.json when .migrated marker present', () => {
    const antigravity = getTarget('antigravity')!;
    // Plant the migration marker — same signal Antigravity itself drops
    // when it migrates a user's config.
    const unifiedDir = path.join(tmpHome, '.gemini', 'config');
    fs.mkdirSync(unifiedDir, { recursive: true });
    fs.writeFileSync(path.join(unifiedDir, '.migrated'), '');

    antigravity.install('global', { autoAllow: true });

    const unifiedFile = path.join(unifiedDir, 'mcp_config.json');
    expect(fs.existsSync(unifiedFile)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(unifiedFile, 'utf-8'));
    expect(cfg.mcpServers.codegraph).toBeDefined();
    // Legacy path is NOT touched when the marker tells us migration happened.
    expect(fs.existsSync(path.join(tmpHome, '.gemini', 'antigravity', 'mcp_config.json'))).toBe(false);
  });

  it('antigravity: install writes to UNIFIED path when ~/.gemini/config/mcp_config.json already exists (even without marker)', () => {
    const antigravity = getTarget('antigravity')!;
    // Antigravity creates this file on first launch post-migration — its
    // presence is the second signal we accept, in case the .migrated
    // marker semantics change across Antigravity versions.
    const unifiedFile = path.join(tmpHome, '.gemini', 'config', 'mcp_config.json');
    fs.mkdirSync(path.dirname(unifiedFile), { recursive: true });
    fs.writeFileSync(unifiedFile, JSON.stringify({ mcpServers: {} }, null, 2) + '\n');

    antigravity.install('global', { autoAllow: true });

    const cfg = JSON.parse(fs.readFileSync(unifiedFile, 'utf-8'));
    expect(cfg.mcpServers.codegraph).toBeDefined();
  });

  it('antigravity: entry has NO `type` field (Antigravity rejects entries with it)', () => {
    const antigravity = getTarget('antigravity')!;
    // Marker → unified path; doesn't matter which path, just inspect the entry shape.
    fs.mkdirSync(path.join(tmpHome, '.gemini', 'config'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.gemini', 'config', '.migrated'), '');

    antigravity.install('global', { autoAllow: true });

    const cfg = JSON.parse(fs.readFileSync(
      path.join(tmpHome, '.gemini', 'config', 'mcp_config.json'), 'utf-8'
    ));
    expect(cfg.mcpServers.codegraph.type).toBeUndefined();
    expect(cfg.mcpServers.codegraph.command).toBeDefined();
    expect(cfg.mcpServers.codegraph.args).toEqual(['serve', '--mcp']);
  });

  it('antigravity: install migrates a legacy codegraph entry to the unified path when marker appears', () => {
    const antigravity = getTarget('antigravity')!;
    // Simulate: user installed on the legacy path, then Antigravity
    // migrated their config (dropped the `.migrated` marker + created
    // the unified file). Re-running codegraph install should land
    // codegraph in the new file AND strip the stale legacy entry.
    const legacyFile = path.join(tmpHome, '.gemini', 'antigravity', 'mcp_config.json');
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({
      mcpServers: { codegraph: { command: 'codegraph', args: ['serve', '--mcp'] } },
    }, null, 2) + '\n');
    fs.mkdirSync(path.join(tmpHome, '.gemini', 'config'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.gemini', 'config', '.migrated'), '');

    antigravity.install('global', { autoAllow: true });

    const unified = JSON.parse(fs.readFileSync(
      path.join(tmpHome, '.gemini', 'config', 'mcp_config.json'), 'utf-8'
    ));
    expect(unified.mcpServers.codegraph).toBeDefined();
    // Legacy file's codegraph entry got stripped.
    const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf-8'));
    expect(legacy.mcpServers).toBeUndefined();
  });

  it('antigravity: install preserves a sibling MCP server in mcp_config.json (legacy path)', () => {
    const antigravity = getTarget('antigravity')!;
    const mcpFile = path.join(tmpHome, '.gemini', 'antigravity', 'mcp_config.json');
    fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
    fs.writeFileSync(mcpFile, JSON.stringify({
      mcpServers: { other: { command: 'uvx', args: ['other-server'] } },
    }, null, 2) + '\n');

    antigravity.install('global', { autoAllow: true });

    const after = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
    expect(after.mcpServers.other).toBeDefined();
    expect(after.mcpServers.codegraph).toBeDefined();
  });

  it('antigravity: install preserves Antigravity-managed fields on sibling servers (e.g. disabled flag)', () => {
    const antigravity = getTarget('antigravity')!;
    // Antigravity adds `"disabled": true` to entries the user disables via
    // the IDE. Install must not clobber that on sibling entries.
    fs.mkdirSync(path.join(tmpHome, '.gemini', 'config'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.gemini', 'config', '.migrated'), '');
    const unified = path.join(tmpHome, '.gemini', 'config', 'mcp_config.json');
    fs.writeFileSync(unified, JSON.stringify({
      mcpServers: {
        'code-review-graph': {
          command: 'uvx', args: ['code-review-graph', 'serve'], disabled: true,
        },
      },
    }, null, 2) + '\n');

    antigravity.install('global', { autoAllow: true });

    const after = JSON.parse(fs.readFileSync(unified, 'utf-8'));
    expect(after.mcpServers['code-review-graph'].disabled).toBe(true);
    expect(after.mcpServers.codegraph).toBeDefined();
  });

  it('antigravity: uninstall removes only codegraph, sibling MCP server survives', () => {
    const antigravity = getTarget('antigravity')!;
    const mcpFile = path.join(tmpHome, '.gemini', 'antigravity', 'mcp_config.json');
    fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
    fs.writeFileSync(mcpFile, JSON.stringify({
      mcpServers: { other: { command: 'uvx', args: ['other-server'] } },
    }, null, 2) + '\n');

    antigravity.install('global', { autoAllow: true });
    antigravity.uninstall('global');

    const after = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
    expect(after.mcpServers.other).toBeDefined();
    expect(after.mcpServers.codegraph).toBeUndefined();
  });

  it('antigravity: uninstall sweeps BOTH legacy and unified paths (handles migration half-state)', () => {
    const antigravity = getTarget('antigravity')!;
    // User had codegraph in BOTH files (e.g. legacy install + post-migration
    // re-install before our migration cleanup landed). Uninstall must clean
    // both so a "fresh slate" really is fresh.
    const legacy = path.join(tmpHome, '.gemini', 'antigravity', 'mcp_config.json');
    const unified = path.join(tmpHome, '.gemini', 'config', 'mcp_config.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.mkdirSync(path.dirname(unified), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({
      mcpServers: { codegraph: { command: 'codegraph', args: ['serve', '--mcp'] } },
    }, null, 2) + '\n');
    fs.writeFileSync(unified, JSON.stringify({
      mcpServers: { codegraph: { command: 'codegraph', args: ['serve', '--mcp'] } },
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(path.dirname(unified), '.migrated'), '');

    antigravity.uninstall('global');

    const legacyAfter = JSON.parse(fs.readFileSync(legacy, 'utf-8'));
    const unifiedAfter = JSON.parse(fs.readFileSync(unified, 'utf-8'));
    expect(legacyAfter.mcpServers).toBeUndefined();
    expect(unifiedAfter.mcpServers).toBeUndefined();
  });

  it('antigravity: rejects --location=local with a clear note (global-only IDE)', () => {
    const antigravity = getTarget('antigravity')!;
    expect(antigravity.supportsLocation('local')).toBe(false);
    const result = antigravity.install('local', { autoAllow: true });
    expect(result.files).toEqual([]);
    expect(result.notes?.join(' ')).toMatch(/no project-local config/);
  });

  it('antigravity: does not write GEMINI.md (only gemini target owns instructions)', () => {
    const antigravity = getTarget('antigravity')!;
    antigravity.install('global', { autoAllow: true });
    const geminiMd = path.join(tmpHome, '.gemini', 'GEMINI.md');
    expect(fs.existsSync(geminiMd)).toBe(false);
  });

  it('gemini + antigravity: both installed coexist (separate MCP files, shared GEMINI.md)', () => {
    const gemini = getTarget('gemini')!;
    const antigravity = getTarget('antigravity')!;
    gemini.install('global', { autoAllow: true });
    antigravity.install('global', { autoAllow: true });

    const cliCfg = JSON.parse(fs.readFileSync(path.join(tmpHome, '.gemini', 'settings.json'), 'utf-8'));
    // Antigravity lands on the LEGACY path here since no .migrated marker
    // was planted — same end-to-end check either way.
    const ideCfg = JSON.parse(fs.readFileSync(path.join(tmpHome, '.gemini', 'antigravity', 'mcp_config.json'), 'utf-8'));
    expect(cliCfg.mcpServers.codegraph).toBeDefined();
    expect(ideCfg.mcpServers.codegraph).toBeDefined();

    // Uninstall one — the other's MCP entry must survive.
    antigravity.uninstall('global');
    const cliAfter = JSON.parse(fs.readFileSync(path.join(tmpHome, '.gemini', 'settings.json'), 'utf-8'));
    expect(cliAfter.mcpServers.codegraph).toBeDefined();
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

  // Regression for #456: PyYAML's default block style writes list items at the
  // SAME indent as the parent key (`cli:` and its `- hermes-cli` are both at
  // indent 2). The pre-fix line-based patcher mistook that first list item for
  // the next sibling key, truncated the cli block, and spliced `- mcp-codegraph`
  // at indent 4 BEFORE the existing items — producing unparseable YAML.
  it('hermes: install preserves PyYAML-default list-at-same-indent style (issue #456)', () => {
    const hermes = getTarget('hermes')!;
    const config = path.join(tmpHome, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const original = [
      'model:',
      '  default: gpt-4o',
      'platform_toolsets:',
      '  cli:',
      '  - hermes-cli',
      '  - browser',
      '  - clarify',
      '  - terminal',
      '  - web',
      '  telegram:',
      '  - hermes-telegram',
      '  discord:',
      '  - hermes-discord',
      '',
    ].join('\n');
    fs.writeFileSync(config, original);

    hermes.install('global', { autoAllow: true });
    const body = fs.readFileSync(config, 'utf-8');

    // mcp-codegraph appended at the same 2-space indent as existing items
    expect(body).toContain('\n  - mcp-codegraph\n');
    // hermes-cli preserved
    expect(body).toContain('\n  - hermes-cli\n');
    // Sibling sections kept their indent — `telegram:` is still a key under
    // platform_toolsets, not promoted up.
    expect(body).toContain('\n  telegram:\n  - hermes-telegram\n');
    expect(body).toContain('\n  discord:\n  - hermes-discord\n');
    // No list items leaked to the platform_toolsets level (indent 0).
    expect(body).not.toMatch(/^- browser/m);
    expect(body).not.toMatch(/^- hermes-telegram/m);

    // The whole platform_toolsets block extracted by line search should
    // start with `cli:` and not contain a stray 4-space `mcp-codegraph`
    // appearing before the rest of the existing items.
    expect(body).toContain('  cli:\n  - hermes-cli\n  - browser');

    // Idempotent
    const second = hermes.install('global', { autoAllow: true });
    expect(second.files[0]?.action).toBe('unchanged');
  });

  it('hermes: uninstall reverses the install on a PyYAML-default config', () => {
    const hermes = getTarget('hermes')!;
    const config = path.join(tmpHome, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const original = [
      'platform_toolsets:',
      '  cli:',
      '  - hermes-cli',
      '  - browser',
      '  telegram:',
      '  - hermes-telegram',
      '',
    ].join('\n');
    fs.writeFileSync(config, original);

    hermes.install('global', { autoAllow: true });
    const installed = fs.readFileSync(config, 'utf-8');
    expect(installed).toContain('- mcp-codegraph');
    expect(installed).toContain('codegraph:');

    hermes.uninstall('global');
    const body = fs.readFileSync(config, 'utf-8');
    expect(body).not.toContain('mcp-codegraph');
    expect(body).not.toContain('command: codegraph');
    expect(body).toContain('  cli:\n  - hermes-cli\n  - browser');
    expect(body).toContain('  telegram:\n  - hermes-telegram');
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

  it('claude: install creates the CLAUDE.md codegraph block (#704)', () => {
    const claude = getTarget('claude')!;
    const result = claude.install('local', { autoAllow: false });
    const claudeMd = path.join(tmpCwd, '.claude', 'CLAUDE.md');
    expect(fs.existsSync(claudeMd)).toBe(true);
    const body = fs.readFileSync(claudeMd, 'utf-8');
    expect(body).toContain('## CodeGraph');
    expect(body).toContain('codegraph explore');
    expect(result.files.find((f) => f.path.endsWith('CLAUDE.md'))?.action).toBe('created');
  });

  it('claude: install replaces a legacy CLAUDE.md codegraph block, keeping user content', () => {
    const claude = getTarget('claude')!;
    const claudeMd = path.join(tmpCwd, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
    fs.writeFileSync(claudeMd, `# My project rules\n\nUse tabs.\n\n${LEGACY_BLOCK}\n`);

    const result = claude.install('local', { autoAllow: false });

    const body = fs.readFileSync(claudeMd, 'utf-8');
    expect(body).toContain('# My project rules');
    expect(body).toContain('Use tabs.');
    expect(body).not.toContain('Prefer `codegraph_search`');
    expect(body).toContain('codegraph explore');
    expect(result.files.find((f) => f.path.endsWith('CLAUDE.md'))?.action).toBe('updated');
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
    expect(after.permissions?.allow).toContain('mcp__codegraph__*');
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

  // ---- Front-load prompt hook (UserPromptSubmit) — #841 follow-up ----
  // Opt-in (default-yes in the installer) UserPromptSubmit hook that runs
  // `codegraph prompt-hook`. Must write/remove surgically, be idempotent, and
  // round-trip an opt-out — without disturbing the user's own hooks.
  const promptCommands = (s: any): string[] =>
    (s.hooks?.UserPromptSubmit ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));

  it('claude: install with promptHook:true writes the UserPromptSubmit hook (alongside permissions)', () => {
    const claude = getTarget('claude')!;
    claude.install('global', { autoAllow: true, promptHook: true });
    const s = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude', 'settings.json'), 'utf-8'));
    expect(promptCommands(s)).toContain('codegraph prompt-hook');
    expect(s.permissions?.allow).toContain('mcp__codegraph__*');
  });

  it('claude: install without promptHook does NOT add the hook', () => {
    const claude = getTarget('claude')!;
    claude.install('global', { autoAllow: true });
    const s = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude', 'settings.json'), 'utf-8'));
    expect(promptCommands(s)).not.toContain('codegraph prompt-hook');
  });

  it('claude: install with promptHook:true is idempotent (no duplicate, byte-identical re-run)', () => {
    const claude = getTarget('claude')!;
    const file = path.join(tmpHome, '.claude', 'settings.json');
    claude.install('global', { autoAllow: true, promptHook: true });
    const first = fs.readFileSync(file, 'utf-8');
    claude.install('global', { autoAllow: true, promptHook: true });
    expect(fs.readFileSync(file, 'utf-8')).toBe(first);
    const s = JSON.parse(first);
    expect(promptCommands(s).filter((c: string) => c === 'codegraph prompt-hook')).toHaveLength(1);
  });

  it('claude: install with promptHook:false strips a hook a prior install wrote (opt-out round-trips)', () => {
    const claude = getTarget('claude')!;
    claude.install('global', { autoAllow: true, promptHook: true });
    claude.install('global', { autoAllow: true, promptHook: false });
    const s = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude', 'settings.json'), 'utf-8'));
    expect(promptCommands(s)).not.toContain('codegraph prompt-hook');
  });

  it('claude: writePromptHookEntry preserves a sibling UserPromptSubmit hook', () => {
    const file = seedSettings('global', {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'my-own-hook' }] }] },
    });
    expect(writePromptHookEntry('global').action).toBe('updated');
    const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(promptCommands(s)).toEqual(['my-own-hook', 'codegraph prompt-hook']);
  });

  it('claude: uninstall removes the prompt hook but keeps the user\'s sibling', () => {
    const file = seedSettings('global', {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'codegraph prompt-hook' }] },
          { hooks: [{ type: 'command', command: 'my-own-hook' }] },
        ],
      },
    });
    getTarget('claude')!.uninstall('global');
    const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(promptCommands(s)).toEqual(['my-own-hook']);
  });

  it('claude: removePromptHookEntry leaves the legacy auto-sync hook untouched', () => {
    const file = seedSettings('global', {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codegraph prompt-hook' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'codegraph sync-if-dirty' }] }],
      },
    });
    expect(removePromptHookEntry('global').action).toBe('removed');
    const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(promptCommands(s)).not.toContain('codegraph prompt-hook');
    const stopCmds = (s.hooks?.Stop ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));
    expect(stopCmds).toContain('codegraph sync-if-dirty');
  });
});

describe('Installer targets — registry', () => {
  it('getTarget returns the right target for each id', () => {
    expect(getTarget('claude')?.id).toBe('claude');
    expect(getTarget('cursor')?.id).toBe('cursor');
    expect(getTarget('codex')?.id).toBe('codex');
    expect(getTarget('opencode')?.id).toBe('opencode');
    expect(getTarget('hermes')?.id).toBe('hermes');
    expect(getTarget('gemini')?.id).toBe('gemini');
    expect(getTarget('antigravity')?.id).toBe('antigravity');
    expect(getTarget('kiro')?.id).toBe('kiro');
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

  // The frontmatter a previous install wrote ahead of the marked block.
  // `removeRulesEntry` recognizes it to decide whether the leftover .mdc
  // is ours-to-delete or carries user content worth keeping.
  const MDC_FRONTMATTER = [
    '---',
    'description: CodeGraph MCP usage guide — when to use which tool',
    'alwaysApply: true',
    '---',
    '',
  ].join('\n');

  function plantLegacyRulesFile(extra = ''): void {
    fs.mkdirSync(path.dirname(rulesFile()), { recursive: true });
    fs.writeFileSync(rulesFile(), MDC_FRONTMATTER + LEGACY_BLOCK + '\n' + extra);
  }

  it('uninstall deletes a leftover codegraph.mdc entirely (no orphaned frontmatter left behind)', () => {
    plantLegacyRulesFile();
    expect(fs.existsSync(rulesFile())).toBe(true);

    cursor.uninstall('local');

    // The whole file — frontmatter included — is gone, not just the block.
    expect(fs.existsSync(rulesFile())).toBe(false);
  });

  it('install self-heals a leftover codegraph.mdc (#529)', () => {
    plantLegacyRulesFile();
    const result = cursor.install('local', { autoAllow: true });
    expect(fs.existsSync(rulesFile())).toBe(false);
    expect(result.files.some((f) => f.path.endsWith('codegraph.mdc') && f.action === 'removed')).toBe(true);
  });

  it('uninstall preserves user content added outside the codegraph markers (strips only our block)', () => {
    plantLegacyRulesFile('## My own rule\nkeep me\n');

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

// ---------------------------------------------------------------------------
// opencode global config path — XDG on every platform (#535)
//
// opencode resolves its config dir with `xdg-basedir`: XDG_CONFIG_HOME if
// set, else ~/.config — on ALL platforms, Windows included. It never reads
// %APPDATA%; we used to write there on Windows, so opencode never saw the
// entry. The suite-wide setHome() points APPDATA and XDG_CONFIG_HOME at the
// SAME directory (which is exactly how this bug stayed invisible), so these
// tests deliberately split them.
// ---------------------------------------------------------------------------
describe('Installer targets — opencode XDG config path (#535)', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };
  let appDataDir: string; // distinct from ~/.config, like real Windows

  beforeEach(() => {
    tmpHome = mkTmpDir('home');
    tmpCwd = mkTmpDir('cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
    appDataDir = path.join(tmpHome, 'AppData', 'Roaming');
    process.env.APPDATA = appDataDir; // realistic split: APPDATA ≠ ~/.config
    delete process.env.XDG_CONFIG_HOME; // default resolution: ~/.config
  });

  afterEach(() => {
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  const xdgConfigFile = () => path.join(tmpHome, '.config', 'opencode', 'opencode.jsonc');
  const legacyDir = () => path.join(appDataDir, 'opencode');
  // NOTE: never match on an 'AppData' substring — on Windows os.tmpdir()
  // itself lives under AppData\Local\Temp, so EVERY harness path contains
  // it. Match on the legacy dir prefix instead.
  const inLegacyDir = (p: string) => path.resolve(p).startsWith(path.resolve(legacyDir()) + path.sep);

  it('global install writes to ~/.config/opencode, never %APPDATA% (#535)', () => {
    const opencode = getTarget('opencode')!;
    const result = opencode.install('global', { autoAllow: true });

    const written = result.files.find((f) => f.path.endsWith('opencode.jsonc'))!;
    expect(written.action).toBe('created');
    expect(path.resolve(written.path)).toBe(path.resolve(xdgConfigFile()));
    expect(fs.existsSync(xdgConfigFile())).toBe(true);
    // Nothing of ours may land in the legacy location.
    expect(fs.existsSync(legacyDir())).toBe(false);
  });

  it('greenfield: targets ~/.config/opencode even when the dir does not exist yet (#535)', () => {
    // The rejected fallback design (#670) would send this install to
    // %APPDATA% — where opencode would never find it. opencode creates
    // ~/.config/opencode itself on first run; installing codegraph FIRST
    // must land where opencode will look.
    expect(fs.existsSync(path.join(tmpHome, '.config', 'opencode'))).toBe(false);
    const opencode = getTarget('opencode')!;
    const result = opencode.install('global', { autoAllow: true });
    expect(path.resolve(result.files[0]!.path)).toBe(path.resolve(xdgConfigFile()));
    expect(fs.existsSync(xdgConfigFile())).toBe(true);
    expect(fs.existsSync(legacyDir())).toBe(false);
  });

  it('honors XDG_CONFIG_HOME for the global path, like opencode does', () => {
    const custom = path.join(tmpHome, 'xdg-custom');
    process.env.XDG_CONFIG_HOME = custom;
    const opencode = getTarget('opencode')!;
    const result = opencode.install('global', { autoAllow: true });
    expect(path.resolve(result.files[0]!.path))
      .toBe(path.resolve(path.join(custom, 'opencode', 'opencode.jsonc')));
  });

  it('install self-heals a pre-#535 %APPDATA% entry, preserving siblings and comments', () => {
    // A previous codegraph version wrote into %APPDATA%/opencode. The user
    // also has another MCP server and a comment there — those must survive.
    fs.mkdirSync(legacyDir(), { recursive: true });
    fs.writeFileSync(path.join(legacyDir(), 'opencode.jsonc'), [
      '{',
      '  // my servers',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "mcp": {',
      '    "codegraph": { "type": "local", "command": ["codegraph", "serve", "--mcp"], "enabled": true },',
      '    "other": { "type": "local", "command": ["other"], "enabled": true }',
      '  }',
      '}',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(legacyDir(), 'AGENTS.md'), LEGACY_BLOCK + '\n');

    const opencode = getTarget('opencode')!;
    const result = opencode.install('global', { autoAllow: true });

    // New entry in the right place…
    expect(fs.existsSync(xdgConfigFile())).toBe(true);
    // …stale entry swept out of the legacy file, siblings + comment intact.
    const legacyText = fs.readFileSync(path.join(legacyDir(), 'opencode.jsonc'), 'utf-8');
    expect(legacyText).not.toContain('codegraph');
    expect(legacyText).toContain('"other"');
    expect(legacyText).toContain('// my servers');
    // …and the legacy AGENTS.md — block-only, so emptied — removed outright
    // (removeMarkedSection unlinks a file it leaves empty).
    expect(fs.existsSync(path.join(legacyDir(), 'AGENTS.md'))).toBe(false);
    // Both cleanups are reported.
    const removed = result.files.filter((f) => f.action === 'removed').map((f) => f.path);
    expect(removed.some((p) => inLegacyDir(p) && p.endsWith('opencode.jsonc'))).toBe(true);
    expect(removed.some((p) => inLegacyDir(p) && p.endsWith('AGENTS.md'))).toBe(true);
  });

  it('uninstall sweeps the legacy %APPDATA% entry too (no prior re-install needed)', () => {
    // A user on the broken version goes straight to `codegraph uninstall`:
    // the only entry that exists is the stale %APPDATA% one.
    fs.mkdirSync(legacyDir(), { recursive: true });
    fs.writeFileSync(path.join(legacyDir(), 'opencode.json'),
      '{\n  "mcp": {\n    "codegraph": { "type": "local", "command": ["codegraph", "serve", "--mcp"], "enabled": true }\n  }\n}\n');

    const opencode = getTarget('opencode')!;
    const result = opencode.uninstall('global');

    expect(fs.readFileSync(path.join(legacyDir(), 'opencode.json'), 'utf-8')).not.toContain('codegraph');
    expect(result.files.some((f) => f.action === 'removed' && inLegacyDir(f.path))).toBe(true);
  });

  it('install after install sweeps only once — second run reports no legacy changes', () => {
    fs.mkdirSync(legacyDir(), { recursive: true });
    fs.writeFileSync(path.join(legacyDir(), 'opencode.json'),
      '{\n  "mcp": {\n    "codegraph": { "type": "local", "command": ["codegraph", "serve", "--mcp"], "enabled": true }\n  }\n}\n');

    const opencode = getTarget('opencode')!;
    const first = opencode.install('global', { autoAllow: true });
    expect(first.files.some((f) => f.action === 'removed' && inLegacyDir(f.path))).toBe(true);

    const second = opencode.install('global', { autoAllow: true });
    expect(second.files.some((f) => inLegacyDir(f.path))).toBe(false);
    expect(second.files.find((f) => f.path.endsWith('opencode.jsonc'))!.action).toBe('unchanged');
  });

  it('detects opencode as installed from a legacy-only %APPDATA% dir (so install can heal it)', () => {
    fs.mkdirSync(legacyDir(), { recursive: true });
    const opencode = getTarget('opencode')!;
    expect(opencode.detect('global').installed).toBe(true);
    // But configuration state is read from the REAL path only.
    expect(opencode.detect('global').alreadyConfigured).toBe(false);
  });
});
