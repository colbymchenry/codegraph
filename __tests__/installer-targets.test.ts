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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { parse as parseJsonc } from 'jsonc-parser';
import { ALL_TARGETS, getTarget, resolveTargetFlag } from '../src/installer/targets/registry';
import { uninstallTargets, refreshTargets } from '../src/installer';
import { upsertTomlTable, removeTomlTable, buildTomlTable, tomlDefinesTable } from '../src/installer/targets/toml';
import { cleanupLegacyHooks, writePromptHookEntry, removePromptHookEntry } from '../src/installer/targets/claude';
import { configDirFromEnv, replaceOrAppendMarkedSection, removeMarkedSection } from '../src/installer/targets/shared';
import {
  CODEGRAPH_INSTRUCTIONS_BLOCK,
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
} from '../src/installer/instructions-template';

function mkTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cg-targets-${label}-`));
}

describe('standalone installer Windows shell guidance (#1294)', () => {
  const command = 'irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex';
  const source = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');

  // Stub uname and downloads, but execute the complete shipped installer.
  // This exercises shell dispatch on POSIX too without installing anything.
  it.runIf(process.platform !== 'win32').each([
    'MINGW64_NT-10.0-26200-ARM64', 'MSYS_NT-10.0-26200', 'CYGWIN_NT-10.0',
  ])('gives actionable guidance for %s before downloading', (platform) => {
    const result = spawnSync('sh', ['-s'], {
      input: `uname() { echo '${platform}'; }\ncurl() { echo UNEXPECTED_DOWNLOAD >&2; exit 99; }\n${source}`,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('open PowerShell');
    expect(result.stderr).toContain(command);
    expect(result.stderr).not.toContain('UNEXPECTED_DOWNLOAD');
    expect(result.stderr).not.toContain('unsupported OS');
  });

  it.runIf(process.platform === 'win32')('guides real Git Bash users to PowerShell', () => {
    const bash = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
    const result = spawnSync(bash, ['--noprofile', '--norc', '-s'], {
      input: `curl() { echo UNEXPECTED_DOWNLOAD >&2; exit 99; }\n${source}`,
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('open PowerShell');
    expect(result.stderr).toContain(command);
    expect(result.stderr).not.toContain('UNEXPECTED_DOWNLOAD');
    expect(result.stderr).not.toContain('unsupported OS');
  });
});

// `os.homedir` is non-configurable on Node, so we redirect it via the
// `$HOME` (POSIX) / `$USERPROFILE` (Windows) env vars that
// `os.homedir()` reads first. Same trick the rest of the suite uses
// when it needs a mock home.
const AGENT_HOME_OVERRIDES = ['QWEN_HOME', 'DSH_HOME', 'GROK_HOME', 'KIMI_CODE_HOME', 'QODER_CONFIG_DIR', 'PI_CODING_AGENT_DIR'];

function setHome(dir: string): { restore: () => void } {
  const overrides = AGENT_HOME_OVERRIDES.map((name) => [name, process.env[name]] as const);
  for (const [name] of overrides) delete process.env[name];
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    HERMES_HOME: process.env.HERMES_HOME,
    COPILOT_HOME: process.env.COPILOT_HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.APPDATA = path.join(dir, '.config');
  process.env.XDG_CONFIG_HOME = path.join(dir, '.config');
  delete process.env.HERMES_HOME;
  delete process.env.COPILOT_HOME;
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  return {
    restore() {
      if (prev.HOME === undefined) delete process.env.HOME; else process.env.HOME = prev.HOME;
      if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.USERPROFILE;
      if (prev.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = prev.APPDATA;
      if (prev.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME;
      if (prev.HERMES_HOME === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = prev.HERMES_HOME;
      if (prev.COPILOT_HOME === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = prev.COPILOT_HOME;
      if (prev.CODEX_HOME === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev.CODEX_HOME;
      if (prev.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev.CLAUDE_CONFIG_DIR;
      for (const [name, value] of overrides) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
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
              // Keep a v1-shaped sibling — real configs mix shapes during the
              // OpenCode 1→2 transition; install must not disturb it (#1698).
              seed.mcp = { other: { type: 'local', command: ['x'], enabled: true } };
            }
            // VS Code's mcp.json uses `servers`; the JetBrains Copilot
            // plugin's mcp.json is schema-compatible with it.
            if (target.id === 'copilot-vscode' || target.id === 'copilot-jetbrains') {
              delete seed.mcpServers;
              seed.servers = { other: { command: 'x' } };
            }
            fs.writeFileSync(jsonPath, JSON.stringify(seed, null, 2) + '\n');

            target.install(location, { autoAllow: true });

            const after = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
            if (target.id === 'opencode') {
              expect(after.mcp.other).toBeDefined();
              expect(after.mcp.servers.codegraph).toBeDefined();
              expect(after.mcp.servers.codegraph.codemode).toBe(false);
              expect(after.mcp.servers.codegraph.disabled).toBe(false);
              expect(after.mcp.codegraph).toBeUndefined();
            } else if (target.id === 'copilot-vscode' || target.id === 'copilot-jetbrains') {
              expect(after.servers.other).toBeDefined();
              expect(after.servers.codegraph).toBeDefined();
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

  it('codex: local install writes ./.codex/config.toml and the project-root ./AGENTS.md block (#1531)', () => {
    const codex = getTarget('codex')!;
    const result = codex.install('local', { autoAllow: false });
    const paths = result.files.map((f) => f.path.replace(/\\/g, '/'));
    // macOS realpath shenanigans (/var vs /private/var) — suffix match.
    expect(paths.some((p) => p.endsWith('/.codex/config.toml'))).toBe(true);
    // AGENTS.md sits at the project root, NOT under .codex/ — that's the
    // file Codex reads for repo instructions.
    expect(paths.some((p) => p.endsWith('/AGENTS.md') && !p.includes('/.codex/'))).toBe(true);

    const toml = fs.readFileSync(path.join(process.cwd(), '.codex', 'config.toml'), 'utf-8');
    expect(toml).toContain('[mcp_servers.codegraph]');
    expect(fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf-8')).toContain('codegraph explore');

    // The project layer is only applied in a trusted project, so say so
    // instead of reporting a silent success.
    expect(result.notes?.join(' ')).toMatch(/trusted/);

    // Global config is untouched by a local install.
    expect(fs.existsSync(path.join(tmpHome, '.codex', 'config.toml'))).toBe(false);
  });

  it('codex: local uninstall reverses the local install and leaves the global entry alone (#1531)', () => {
    const codex = getTarget('codex')!;
    codex.install('global', { autoAllow: false });
    codex.install('local', { autoAllow: false });
    expect(codex.detect('local').alreadyConfigured).toBe(true);

    codex.uninstall('local');

    expect(codex.detect('local').alreadyConfigured).toBe(false);
    expect(codex.detect('global').alreadyConfigured).toBe(true);
    expect(fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8'))
      .toContain('[mcp_servers.codegraph]');
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

  it('hermes: install adds the codegraph MCP server and leaves platform_toolsets alone, preserving existing yaml (#2485)', () => {
    const hermes = getTarget('hermes')!;
    const config = path.join(tmpHome, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const toolsets = [
      'platform_toolsets:',
      '  cli:',
      '    - hermes-cli',
      '  discord:',
      '    - hermes-discord',
      '',
    ].join('\n');
    fs.writeFileSync(config, ['model:', '  default: qwen-3.7', 'mcp_servers:', '  other:', '    command: other', toolsets].join('\n'));

    const result = hermes.install('global', { autoAllow: true });
    expect(result.files[0].action).toBe('updated');
    const body = fs.readFileSync(config, 'utf-8');
    expect(body).toContain('model:\n  default: qwen-3.7');
    expect(body).toContain('mcp_servers:\n  other:\n    command: other\n  codegraph:\n    command: codegraph');
    // No toolset entry: a list naming no MCP server loads every enabled one.
    expect(body.endsWith(toolsets)).toBe(true);
    expect(body).not.toContain('mcp-codegraph');

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
  // the next sibling key and truncated the cli block. Install no longer adds to
  // that list (#2485), but it still has to read it to take out the
  // `- mcp-codegraph` line an earlier install appended there.
  it('hermes: install reads the PyYAML-default list-at-same-indent style (issue #456)', () => {
    const hermes = getTarget('hermes')!;
    const config = path.join(tmpHome, '.hermes', 'config.yaml');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const lines = [
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
    ];
    // As an earlier install left it: our entry appended at the items' indent.
    fs.writeFileSync(config, [...lines.slice(0, 9), '  - mcp-codegraph', ...lines.slice(9)].join('\n'));

    hermes.install('global', { autoAllow: true });
    const body = fs.readFileSync(config, 'utf-8');

    // The old entry is gone and every other line is where it was.
    expect(body).not.toContain('mcp-codegraph');
    expect(body.startsWith(lines.join('\n'))).toBe(true);
    // No list items leaked to the platform_toolsets level (indent 0).
    expect(body).not.toMatch(/^- browser/m);
    expect(body).not.toMatch(/^- hermes-telegram/m);

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
    expect(installed).not.toContain('mcp-codegraph');
    expect(installed.startsWith(original)).toBe(true);
    expect(installed).toContain('codegraph:');

    hermes.uninstall('global');
    const body = fs.readFileSync(config, 'utf-8');
    expect(body).not.toContain('mcp-codegraph');
    expect(body).not.toContain('command: codegraph');
    expect(body.startsWith(original)).toBe(true);
  });

  it('opencode: uninstall removes only mcp.servers.codegraph, preserves comments and siblings', () => {
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
    const afterInstall = parseJsonc(fs.readFileSync(file, 'utf-8'));
    expect(afterInstall.mcp.servers.codegraph).toBeDefined();
    expect(afterInstall.mcp.servers.codegraph.codemode).toBe(false);
    expect(afterInstall.mcp.other).toBeDefined();

    opencode.uninstall('global');
    const afterUninstall = fs.readFileSync(file, 'utf-8');
    expect(afterUninstall).not.toContain('codegraph');
    expect(afterUninstall).not.toContain('"servers"');
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

  it('codex: install, re-install, and uninstall preserve trailing array-of-tables siblings', () => {
    const codex = getTarget('codex')!;
    const tomlPath = path.join(tmpHome, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
    const historyTables = [
      '[[history]]',
      'id = 1',
      'note = "keep first"',
      '',
      '[[history]]',
      'id = 2',
      'note = "keep second"',
      '',
    ].join('\n');
    fs.writeFileSync(tomlPath, [
      '[mcp_servers.codegraph]',
      'command = "old-codegraph"',
      'args = ["old"]',
      'description = """',
      'header-shaped text inside a multiline string:',
      '[[not-a-table]]',
      'still part of the string',
      '"""',
      '',
      historyTables,
    ].join('\n'));

    const first = codex.install('global', { autoAllow: false });
    expect(first.files.find((f) => f.path === tomlPath)?.action).toBe('updated');
    const afterInstall = fs.readFileSync(tomlPath, 'utf-8');
    expect(afterInstall).toContain('command = "codegraph"');
    expect(afterInstall).not.toContain('[[not-a-table]]');
    expect(afterInstall.endsWith(historyTables)).toBe(true);

    const second = codex.install('global', { autoAllow: false });
    expect(second.files.find((f) => f.path === tomlPath)?.action).toBe('unchanged');
    expect(fs.readFileSync(tomlPath, 'utf-8')).toBe(afterInstall);

    codex.uninstall('global');
    expect(fs.readFileSync(tomlPath, 'utf-8')).toBe(historyTables);
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
    // Exempt from Claude Code's tool-search deferral (#1696).
    expect(cfg.mcpServers.codegraph.alwaysLoad).toBe(true);
  });

  it('claude: re-running install on an entry that predates alwaysLoad adds the key (#1696)', () => {
    const claude = getTarget('claude')!;
    fs.writeFileSync(
      path.join(tmpCwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] } } }, null, 2),
    );
    const result = claude.install('local', { autoAllow: false });
    const mcp = result.files.find((f) => f.path.replace(/\\/g, '/').endsWith('/.mcp.json'));
    expect(mcp?.action).toBe('updated');
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.mcp.json'), 'utf-8'));
    expect(cfg.mcpServers.codegraph.alwaysLoad).toBe(true);
    expect(cfg.mcpServers.codegraph.args).toEqual(['serve', '--mcp']);
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
    expect(cfg.mcpServers.codegraph.alwaysLoad).toBe(true);
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
  // Platform-aware since #1466: Windows writes `codegraph.cmd prompt-hook`
  // (Git Bash applies no PATHEXT, so the bare form is exit 127 there), and
  // install self-heals the other platform's spelling in place.
  const HOOK_CMD = process.platform === 'win32' ? 'codegraph.cmd prompt-hook' : 'codegraph prompt-hook';
  const OTHER_PLATFORM_HOOK_CMD = process.platform === 'win32' ? 'codegraph prompt-hook' : 'codegraph.cmd prompt-hook';
  const promptCommands = (s: any): string[] =>
    (s.hooks?.UserPromptSubmit ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));

  it('claude: install with promptHook:true writes the UserPromptSubmit hook (alongside permissions)', () => {
    const claude = getTarget('claude')!;
    claude.install('global', { autoAllow: true, promptHook: true });
    const s = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude', 'settings.json'), 'utf-8'));
    expect(promptCommands(s)).toContain(HOOK_CMD);
    expect(s.permissions?.allow).toContain('mcp__codegraph__*');
  });

  it('claude: install without promptHook does NOT add the hook', () => {
    const claude = getTarget('claude')!;
    claude.install('global', { autoAllow: true });
    const s = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude', 'settings.json'), 'utf-8'));
    expect(promptCommands(s)).not.toContain(HOOK_CMD);
  });

  it('claude: install with promptHook:true is idempotent (no duplicate, byte-identical re-run)', () => {
    const claude = getTarget('claude')!;
    const file = path.join(tmpHome, '.claude', 'settings.json');
    claude.install('global', { autoAllow: true, promptHook: true });
    const first = fs.readFileSync(file, 'utf-8');
    claude.install('global', { autoAllow: true, promptHook: true });
    expect(fs.readFileSync(file, 'utf-8')).toBe(first);
    const s = JSON.parse(first);
    expect(promptCommands(s).filter((c: string) => c === HOOK_CMD)).toHaveLength(1);
  });

  it('claude: install with promptHook:false strips a hook a prior install wrote (opt-out round-trips)', () => {
    const claude = getTarget('claude')!;
    claude.install('global', { autoAllow: true, promptHook: true });
    claude.install('global', { autoAllow: true, promptHook: false });
    const s = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude', 'settings.json'), 'utf-8'));
    expect(promptCommands(s)).not.toContain(HOOK_CMD);
  });

  it('claude: writePromptHookEntry preserves a sibling UserPromptSubmit hook', () => {
    const file = seedSettings('global', {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'my-own-hook' }] }] },
    });
    expect(writePromptHookEntry('global').action).toBe('updated');
    const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(promptCommands(s)).toEqual(['my-own-hook', HOOK_CMD]);
  });

  it('claude: writePromptHookEntry migrates the other platform\'s spelling in place (#1466 self-heal)', () => {
    const file = seedSettings('global', {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: OTHER_PLATFORM_HOOK_CMD }] }] },
    });
    expect(writePromptHookEntry('global').action).toBe('updated');
    const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(promptCommands(s)).toEqual([HOOK_CMD]);
    // A re-run after migration is byte-identical.
    const healed = fs.readFileSync(file, 'utf-8');
    expect(writePromptHookEntry('global').action).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf-8')).toBe(healed);
  });

  it('claude: writePromptHookEntry leaves an npx-form hook untouched (no duplicate, no rewrite)', () => {
    const npxCmd = 'npx @colbymchenry/codegraph prompt-hook';
    const file = seedSettings('global', {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: npxCmd }] }] },
    });
    expect(writePromptHookEntry('global').action).toBe('unchanged');
    const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(promptCommands(s)).toEqual([npxCmd]);
  });

  it('claude: uninstall removes the prompt hook but keeps the user\'s sibling', () => {
    const file = seedSettings('global', {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: HOOK_CMD }] },
          { hooks: [{ type: 'command', command: 'my-own-hook' }] },
        ],
      },
    });
    getTarget('claude')!.uninstall('global');
    const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(promptCommands(s)).toEqual(['my-own-hook']);
  });

  it('claude: removePromptHookEntry removes the other platform\'s spelling too', () => {
    const file = seedSettings('global', {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: OTHER_PLATFORM_HOOK_CMD }] }],
      },
    });
    expect(removePromptHookEntry('global').action).toBe('removed');
    const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(promptCommands(s)).toEqual([]);
  });

  it('claude: removePromptHookEntry leaves the legacy auto-sync hook untouched', () => {
    const file = seedSettings('global', {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: HOOK_CMD }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'codegraph sync-if-dirty' }] }],
      },
    });
    expect(removePromptHookEntry('global').action).toBe('removed');
    const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(promptCommands(s)).not.toContain(HOOK_CMD);
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
    expect(getTarget('copilot-vscode')?.id).toBe('copilot-vscode');
    expect(getTarget('copilot-cli')?.id).toBe('copilot-cli');
    expect(getTarget('copilot-jetbrains')?.id).toBe('copilot-jetbrains');
    for (const id of ['bob', 'droid', 'windsurf', 'qwen', 'dsh', 'grok', 'kimi', 'qoder', 'pi']) {
      expect(getTarget(id)?.id).toBe(id);
    }
    expect(getTarget('not-a-real-target')).toBeUndefined();
  });

  it('resolveTargetFlag handles auto/all/none/csv', () => {
    expect(resolveTargetFlag('none', 'global')).toEqual([]);
    expect(resolveTargetFlag('all', 'global').length).toBe(ALL_TARGETS.length);
    const csv = resolveTargetFlag('claude,cursor', 'global');
    expect(csv.map((t) => t.id)).toEqual(['claude', 'cursor']);
  });

  it("resolveTargetFlag('all') includes every Copilot target", () => {
    const ids = resolveTargetFlag('all', 'global').map((t) => t.id);
    expect(ids).toContain('copilot-vscode');
    expect(ids).toContain('copilot-cli');
    expect(ids).toContain('copilot-jetbrains');
  });

  it('resolveTargetFlag resolves the Copilot ids from a csv list', () => {
    const csv = resolveTargetFlag('copilot-vscode,copilot-cli,copilot-jetbrains', 'global');
    expect(csv.map((t) => t.id)).toEqual(['copilot-vscode', 'copilot-cli', 'copilot-jetbrains']);
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

  it('upsert replaces the managed table without consuming trailing array-of-tables siblings', () => {
    const historyTables = [
      '[[history]]',
      'id = 1',
      'note = "keep first"',
      '',
      '[[history]]',
      'id = 2',
      'note = "keep second"',
      '',
    ].join('\n');
    const existing = [
      '[mcp_servers.codegraph]',
      'command = "old-codegraph"',
      'args = ["old"]',
      '',
      historyTables,
    ].join('\n');
    const block = buildTomlTable('mcp_servers.codegraph', {
      command: 'codegraph',
      args: ['serve', '--mcp'],
    });

    const { content, action } = upsertTomlTable(existing, 'mcp_servers.codegraph', block);

    expect(action).toBe('replaced');
    expect(content).toBe(`${block}\n\n${historyTables}`);
  });

  it('remove preserves trailing array-of-tables siblings byte-for-byte', () => {
    const historyTables = [
      '[[history]]',
      'id = 1',
      'note = "keep first"',
      '',
      '[[history]]',
      'id = 2',
      'note = "keep second"',
      '',
    ].join('\n');
    const existing = [
      '[mcp_servers.codegraph]',
      'command = "codegraph"',
      'args = ["serve", "--mcp"]',
      '',
      historyTables,
    ].join('\n');

    const { content, action } = removeTomlTable(existing, 'mcp_servers.codegraph');

    expect(action).toBe('removed');
    expect(content).toBe(historyTables);
  });

  it.each([
    ['table', '[ mcp_servers.other ]'],
    ['array-of-tables', '[[ history ]]'],
  ])('preserves a trailing %s header with inner whitespace', (_kind, siblingHeader) => {
    const siblingTable = `${siblingHeader}\nvalue = "keep"\n`;
    const existing = [
      '[mcp_servers.codegraph]',
      'command = "old-codegraph"',
      'args = ["old"]',
      '',
      siblingTable,
    ].join('\n');
    const block = buildTomlTable('mcp_servers.codegraph', {
      command: 'codegraph',
      args: ['serve', '--mcp'],
    });

    const upserted = upsertTomlTable(existing, 'mcp_servers.codegraph', block);
    const removed = removeTomlTable(existing, 'mcp_servers.codegraph');

    expect(upserted.content).toBe(`${block}\n\n${siblingTable}`);
    expect(removed.content).toBe(siblingTable);
  });

  it.each([
    ['basic', '"""'],
    ['literal', "'''"],
  ])('ignores header-shaped text inside a multiline %s string', (_kind, delimiter) => {
    const historyTable = '[[history]]\nid = 1\n';
    const existing = [
      '[mcp_servers.codegraph]',
      'command = "old-codegraph"',
      'args = [',
      `  ${delimiter}first line`,
      '[[not-a-table]]',
      `last line${delimiter},`,
      '  "serve",',
      ']',
      '',
      historyTable,
    ].join('\n');
    const block = buildTomlTable('mcp_servers.codegraph', {
      command: 'codegraph',
      args: ['serve', '--mcp'],
    });

    const upserted = upsertTomlTable(existing, 'mcp_servers.codegraph', block);
    const removed = removeTomlTable(existing, 'mcp_servers.codegraph');

    expect(upserted.content).toBe(`${block}\n\n${historyTable}`);
    expect(removed.content).toBe(historyTable);
  });
});

// ---------------------------------------------------------------------------
// The Codex table is found however it is written (#2562)
//
// The header search matched only a column-0 `[mcp_servers.codegraph]`, so an
// indented one (valid TOML, and what formatters that indent sub-tables
// write) was taken for absent and a second table was appended: a table
// defined twice is invalid TOML, and Codex then loaded none of its config.
// ---------------------------------------------------------------------------
describe('Installer — the Codex table is found however it is written (#2562)', () => {
  const HEADER = 'mcp_servers.codegraph';
  const BLOCK = buildTomlTable(HEADER, { command: 'codegraph', args: ['serve', '--mcp'] });
  const OLD_BODY = 'command = "codegraph"\nargs = ["serve"]';
  const BS = String.fromCharCode(92);
  const crlf = (s: string) => s.replace(/\n/g, '\r\n');
  const top = 'model = "o3"';
  const other = '[mcp_servers.other]\ncommand = "other-server"';

  it.each([
    ['indented with spaces (the report)', '  [mcp_servers.codegraph]', '    command = "codegraph"\n    args = ["serve"]'],
    ['indented with a tab', '\t[mcp_servers.codegraph]', OLD_BODY],
    ['spaces inside the brackets', '[ mcp_servers.codegraph ]', OLD_BODY],
    ['spaces around the dot', '[mcp_servers . codegraph]', OLD_BODY],
    ['a quoted key', '[mcp_servers."codegraph"]', OLD_BODY],
    ['a literal-quoted key', "['mcp_servers'.codegraph]", OLD_BODY],
    ['an escape in a quoted key', `[mcp_servers."code${BS}u0067raph"]`, OLD_BODY],
    ['a comment after it', '[mcp_servers.codegraph] # added by hand', OLD_BODY],
  ])('a header written with %s is replaced in place, once, and removed', (_form, header, body) => {
    const input = `${top}\n\n[mcp_servers]\n\n${header}\n${body}\n\n${other}\n`;

    const up = upsertTomlTable(input, HEADER, BLOCK);
    expect(up.action).toBe('replaced');
    expect(up.content).toBe(`${top}\n\n[mcp_servers]\n\n${BLOCK}\n\n${other}\n`);
    expect(upsertTomlTable(up.content, HEADER, BLOCK).action).toBe('unchanged');

    const rm = removeTomlTable(input, HEADER);
    expect(rm.action).toBe('removed');
    expect(rm.content).toBe(`${top}\n\n[mcp_servers]\n\n${other}\n`);
    expect(tomlDefinesTable(input, HEADER)).toBe(true);
  });

  it('a CRLF file stays CRLF, and an up-to-date CRLF table is unchanged', () => {
    const input = crlf(`${top}\n\n[mcp_servers.codegraph]\n${OLD_BODY}\n\n${other}\n`);
    const up = upsertTomlTable(input, HEADER, BLOCK);
    expect(up.content).toBe(crlf(`${top}\n\n${BLOCK}\n\n${other}\n`));
    expect(upsertTomlTable(up.content, HEADER, BLOCK).action).toBe('unchanged');
    expect(removeTomlTable(up.content, HEADER).content).toBe(crlf(`${top}\n\n${other}\n`));
    // Inserting into a CRLF file uses CRLF too.
    expect(upsertTomlTable(crlf(`${top}\n`), HEADER, BLOCK).content).toBe(crlf(`${top}\n\n${BLOCK}\n`));
  });

  it('a second table, as the old bug appended, is removed: the file parses again', () => {
    const input = `${top}\n\n  [mcp_servers.codegraph]\n    command = "codegraph"\n    args = ["serve"]\n\n${other}\n\n${BLOCK}\n`;
    const up = upsertTomlTable(input, HEADER, BLOCK);
    expect(up.action).toBe('replaced');
    expect(up.content).toBe(`${top}\n\n${BLOCK}\n\n${other}\n`);
    expect(removeTomlTable(input, HEADER).content).toBe(`${top}\n\n${other}\n`);
  });

  it('look-alikes are never taken for the table: other names, and header-shaped text inside values', () => {
    const lookalikes = [
      top,
      '',
      '[mcp_servers.codegraph2]',
      'command = "x"',
      '',
      '[mcp_servers.other]',
      'note = """',
      '[mcp_servers.codegraph]',
      '"""',
      "literal = '''",
      '[mcp_servers.codegraph]',
      "'''",
      'args = [',
      '  "[mcp_servers.codegraph]",',
      ']',
      '',
    ].join('\n');
    const up = upsertTomlTable(lookalikes, HEADER, BLOCK);
    expect(up.action).toBe('inserted');
    expect(up.content).toBe(`${lookalikes.trimEnd()}\n\n${BLOCK}\n`);
    expect(removeTomlTable(lookalikes, HEADER)).toEqual({ content: lookalikes, action: 'not-found' });
    expect(tomlDefinesTable(lookalikes, HEADER)).toBe(false);
  });

  it('a sub-table such as [mcp_servers.codegraph.env] is kept by install and removed with the table', () => {
    const env = '[mcp_servers.codegraph.env]\nCODEGRAPH_MCP_TOOLS = "all"';
    const input = `${top}\n\n[mcp_servers.codegraph]\n${OLD_BODY}\n\n${env}\n\n${other}\n`;
    expect(upsertTomlTable(input, HEADER, BLOCK).content).toBe(`${top}\n\n${BLOCK}\n\n${env}\n\n${other}\n`);
    expect(removeTomlTable(input, HEADER).content).toBe(`${top}\n\n${other}\n`);
    // Only the sub-table left (a server with no command): install adds the table.
    expect(tomlDefinesTable(`${top}\n\n${env}\n`, HEADER)).toBe(true);
    expect(upsertTomlTable(`${top}\n\n${env}\n`, HEADER, BLOCK).content).toBe(`${top}\n\n${env}\n\n${BLOCK}\n`);
  });

  it('a comment heading the next table stays with it', () => {
    const input = `${top}\n\n[mcp_servers.codegraph]\n${OLD_BODY}\n\n# the other server, set up by hand\n${other}\n`;
    expect(upsertTomlTable(input, HEADER, BLOCK).content).toBe(`${top}\n\n${BLOCK}\n\n# the other server, set up by hand\n${other}\n`);
    expect(removeTomlTable(input, HEADER).content).toBe(`${top}\n\n# the other server, set up by hand\n${other}\n`);
  });

  it.each([
    ['dotted keys at the top level', `mcp_servers.codegraph.command = "codegraph"\nmcp_servers.codegraph.args = ["serve", "--mcp"]\n${top}\n\n${other}\n`, 1, 'dotted keys', `${top}\n\n${other}\n`],
    ['dotted keys under [mcp_servers]', `${top}\n\n[mcp_servers]\ncodegraph.command = "codegraph"\ncodegraph.args = [\n  "serve",\n  "--mcp",\n]\nother.command = "x"\n`, 4, 'dotted keys', `${top}\n\n[mcp_servers]\nother.command = "x"\n`],
    ['an inline table under [mcp_servers]', `${top}\n\n[mcp_servers]\ncodegraph = { command = "codegraph", args = ["serve", "--mcp"] }\n`, 4, 'an inline table', `${top}\n\n[mcp_servers]\n`],
    ['[[mcp_servers.codegraph]]', `${top}\n\n[[mcp_servers.codegraph]]\ncommand = "codegraph"\n`, 3, 'an array of tables', `${top}\n`],
  ])('written with %s: install leaves it as is (no second table), uninstall removes it', (_form, input, line, form, removed) => {
    expect(upsertTomlTable(input, HEADER, BLOCK)).toEqual({
      content: input,
      action: 'conflict',
      conflict: expect.objectContaining({ kind: 'defined', line, form }),
    });
    const rm = removeTomlTable(input, HEADER);
    expect(rm.action).toBe('removed');
    expect(rm.content).toBe(removed);
    expect(tomlDefinesTable(input, HEADER)).toBe(true);
  });

  it.each([
    ['mcp_servers as an inline table', `${top}\nmcp_servers = { other = { command = "x" } }\n`, 'an inline table'],
    ['mcp_servers as an array of tables', `${top}\n\n[[mcp_servers]]\nname = "other"\n`, 'an array of tables'],
  ])('%s: a [mcp_servers.codegraph] table can\'t be added, so nothing is', (_form, input, form) => {
    expect(upsertTomlTable(input, HEADER, BLOCK)).toEqual({
      content: input,
      action: 'conflict',
      conflict: expect.objectContaining({ kind: 'blocked', key: 'mcp_servers', form }),
    });
    expect(removeTomlTable(input, HEADER).action).toBe('not-found');
    expect(tomlDefinesTable(input, HEADER)).toBe(false);
  });

  it('codegraph inside an inline mcp_servers table is reported, never edited', () => {
    const input = `${top}\nmcp_servers = { codegraph = { command = "codegraph", args = ["serve", "--mcp"] } }\n`;
    expect(upsertTomlTable(input, HEADER, BLOCK).action).toBe('conflict');
    expect(removeTomlTable(input, HEADER)).toEqual({
      content: input,
      action: 'conflict',
      conflict: expect.objectContaining({ key: 'mcp_servers', form: 'an inline table', line: 2 }),
    });
    expect(tomlDefinesTable(input, HEADER)).toBe(true);
  });
});

describe('Installer — Codex install, re-install, refresh and uninstall find the table however it is written (#2562)', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('codex2562-home');
    tmpCwd = mkTmpDir('codex2562-cwd');
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

  const configToml = () => path.join(tmpHome, '.codex', 'config.toml');
  function writeConfig(text: string): void {
    fs.mkdirSync(path.dirname(configToml()), { recursive: true });
    fs.writeFileSync(configToml(), text);
  }
  const block = buildTomlTable('mcp_servers.codegraph', { command: 'codegraph', args: ['serve', '--mcp'] });

  it('the reported indented table: detected, replaced once, unchanged after, refreshed in place, removed by uninstall', () => {
    const siblings = 'model = "o3"\n\n[mcp_servers]\n\n  [mcp_servers.other]\n    command = "other-server"\n';
    writeConfig(`${siblings}\n  [mcp_servers.codegraph]\n    command = "codegraph"\n    args = ["serve", "--mcp"]\n`);
    const codex = getTarget('codex')!;
    expect(codex.detect('global').alreadyConfigured).toBe(true);

    const first = codex.install('global', { autoAllow: false });
    expect(first.files.find((f) => f.path === configToml())!.action).toBe('updated');
    expect(fs.readFileSync(configToml(), 'utf-8')).toBe(`${siblings}\n${block}\n`);
    expect(codex.install('global', { autoAllow: false }).files.find((f) => f.path === configToml())!.action).toBe('unchanged');
    expect(refreshTargets(ALL_TARGETS, 'global').find((r) => r.id === 'codex')!.status).toBe('unchanged');

    codex.uninstall('global');
    expect(fs.readFileSync(configToml(), 'utf-8')).toBe(siblings);
    expect(codex.detect('global').alreadyConfigured).toBe(false);
  });

  it('a CRLF config keeps CRLF through install and uninstall', () => {
    writeConfig('model = "o3"\r\n\r\n[mcp_servers.codegraph]\r\ncommand = "codegraph"\r\nargs = ["serve"]\r\n');
    const codex = getTarget('codex')!;
    codex.install('global', { autoAllow: false });
    expect(fs.readFileSync(configToml(), 'utf-8')).toBe(`model = "o3"\r\n\r\n${block.replace(/\n/g, '\r\n')}\r\n`);
    codex.uninstall('global');
    expect(fs.readFileSync(configToml(), 'utf-8')).toBe('model = "o3"\r\n');
  });

  it('an entry written with dotted keys is left as written, with a note; uninstall removes it', () => {
    const input = 'model = "o3"\n\n[mcp_servers]\ncodegraph.command = "codegraph"\ncodegraph.args = ["serve", "--mcp"]\n';
    writeConfig(input);
    const codex = getTarget('codex')!;
    expect(codex.detect('global').alreadyConfigured).toBe(true);

    const result = codex.install('global', { autoAllow: false });
    expect(result.files.find((f) => f.path === configToml())!.action).toBe('unchanged');
    expect(result.notes?.join('\n')).toMatch(/Left the mcp_servers\.codegraph entry in .*config\.toml as you wrote it \(dotted keys, line 4\)/);
    expect(fs.readFileSync(configToml(), 'utf-8')).toBe(input);
    expect(fs.readFileSync(path.join(tmpHome, '.codex', 'AGENTS.md'), 'utf-8')).toContain('codegraph explore');
    expect(refreshTargets(ALL_TARGETS, 'global').find((r) => r.id === 'codex')!.status).toBe('unchanged');

    codex.uninstall('global');
    expect(fs.readFileSync(configToml(), 'utf-8')).toBe('model = "o3"\n\n[mcp_servers]\n');
  });

  it('mcp_servers as an inline table: install refuses with a clear error and changes nothing', () => {
    const input = 'model = "o3"\nmcp_servers = { other = { command = "x" } }\n';
    writeConfig(input);
    expect(() => getTarget('codex')!.install('global', { autoAllow: false })).toThrow(
      /config\.toml sets mcp_servers as an inline table \(line 2\), so a \[mcp_servers\.codegraph\] table can't be added without breaking the file\. Nothing was changed/,
    );
    expect(fs.readFileSync(configToml(), 'utf-8')).toBe(input);
  });

  it('codegraph inside an inline mcp_servers table: uninstall says it can\'t remove it, and leaves the file alone', () => {
    const input = 'model = "o3"\nmcp_servers = { codegraph = { command = "codegraph", args = ["serve", "--mcp"] } }\n';
    writeConfig(input);
    const [report] = uninstallTargets([getTarget('codex')!], 'global');
    expect(report!.notes.join('\n')).toMatch(/sets mcp_servers\.codegraph inside mcp_servers \(an inline table, line 2\), which CodeGraph can't edit safely/);
    expect(fs.readFileSync(configToml(), 'utf-8')).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// Hermes: no toolset entry, and the user's MCP entry is theirs (#2485)
//
// Install and refresh appended `mcp-codegraph` to `platform_toolsets.cli`.
// Hermes up to 0.22.2 rejects that name at startup ("Unknown toolsets"), and
// 0.22.4 reads it as naming codegraph, which turns the list into an MCP
// allowlist and hides every other server from CLI sessions
// (hermes_cli/tools_config.py `_merge_mcp_servers`). No entry is needed: a
// list that names no MCP server loads every enabled one. The refresh also
// replaced the whole `mcp_servers.codegraph` block with CodeGraph's template,
// undoing an absolute command path, timeouts, `enabled: false` and env.
// ---------------------------------------------------------------------------
describe('Installer — Hermes never writes platform_toolsets and keeps the user\'s MCP entry (#2485)', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('hermes2485-home');
    tmpCwd = mkTmpDir('hermes2485-cwd');
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

  const hermes = getTarget('hermes')!;
  const config = () => path.join(tmpHome, '.hermes', 'config.yaml');
  function writeConfig(text: string): void {
    fs.mkdirSync(path.dirname(config()), { recursive: true });
    fs.writeFileSync(config(), text);
  }
  const read = () => fs.readFileSync(config(), 'utf-8');
  const codegraphKeys = (text: string) => text.split(/\r?\n/).filter((l) => /^\s*["']?codegraph["']?\s*:/.test(l)).length;
  const OTHERS = 'mcp_servers:\n  agentmail:\n    command: npx\n    args:\n    - -y\n    - agentmail-mcp\n';
  const ENTRY = '  codegraph:\n    command: codegraph\n    args:\n      - serve\n      - --mcp\n    timeout: 120\n    connect_timeout: 60\n    enabled: true\n';

  it('a fresh install writes the server and no platform_toolsets', () => {
    hermes.install('global', { autoAllow: false });
    expect(read()).toBe(`mcp_servers:\n${ENTRY}`);
    expect(hermes.install('global', { autoAllow: false }).files[0]!.action).toBe('unchanged');
    expect(hermes.printConfig('global')).not.toContain('platform_toolsets');
  });

  it('the mcp-codegraph line an earlier install added is taken out, so every server loads again; a second refresh is unchanged', () => {
    const before = `model: big\n${OTHERS}${ENTRY}platform_toolsets:\n  cli:\n  - hermes-cli\n  - browser\n`;
    writeConfig(`model: big\n${OTHERS}${ENTRY}platform_toolsets:\n  cli:\n  - hermes-cli\n  - browser\n  - mcp-codegraph\n`);
    const report = refreshTargets(ALL_TARGETS, 'global').find((r) => r.id === 'hermes')!;
    expect(report.status).toBe('refreshed');
    expect(read()).toBe(before);
    expect(refreshTargets(ALL_TARGETS, 'global').find((r) => r.id === 'hermes')!.status).toBe('unchanged');
  });

  it('a line the user removed is not put back', () => {
    const text = `model: big\n${OTHERS}${ENTRY}platform_toolsets:\n  cli:\n  - hermes-cli\n`;
    writeConfig(text);
    expect(refreshTargets(ALL_TARGETS, 'global').find((r) => r.id === 'hermes')!.status).toBe('unchanged');
    expect(read()).toBe(text);
  });

  it('in an allowlist of MCP servers, mcp-codegraph becomes codegraph, the name every Hermes version reads', () => {
    writeConfig(`${OTHERS}${ENTRY}platform_toolsets:\n  cli:\n    - hermes-cli\n    - agentmail\n    - mcp-codegraph # added by codegraph\n`);
    hermes.install('global', { autoAllow: false });
    expect(read()).toBe(`${OTHERS}${ENTRY}platform_toolsets:\n  cli:\n    - hermes-cli\n    - agentmail\n    - codegraph\n`);
  });

  it('an allowlist that leaves CodeGraph out is left alone, with a note', () => {
    const text = `${OTHERS}${ENTRY}platform_toolsets:\n  cli:\n  - hermes-cli\n  - agentmail\n`;
    writeConfig(text);
    const result = hermes.install('global', { autoAllow: false });
    expect(result.files[0]!.action).toBe('unchanged');
    expect(result.notes?.join('\n')).toMatch(/platform_toolsets\.cli in .*config\.yaml names MCP servers, so CLI sessions load only those\. Add `codegraph`/);
    expect(read()).toBe(text);
  });

  it('a customized entry is kept byte-for-byte by install and refresh', () => {
    const text = `model: big\n${OTHERS}  codegraph:\n    command: /home/u/.local/bin/codegraph\n    args: [serve, --mcp]\n    timeout: 300\n    connect_timeout: 90\n    enabled: false\n    env:\n      CODEGRAPH_MCP_TOOLS: all\n`;
    writeConfig(text);
    expect(hermes.detect('global').alreadyConfigured).toBe(true);
    expect(hermes.install('global', { autoAllow: false }).files[0]!.action).toBe('unchanged');
    expect(refreshTargets(ALL_TARGETS, 'global').find((r) => r.id === 'hermes')!.status).toBe('unchanged');
    expect(read()).toBe(text);
  });

  it('an entry missing command or args gets only those, at its own indent', () => {
    writeConfig('mcp_servers:\n  codegraph:\n    enabled: true\n    timeout: 300\n');
    hermes.install('global', { autoAllow: false });
    expect(read()).toBe('mcp_servers:\n  codegraph:\n    enabled: true\n    timeout: 300\n    command: codegraph\n    args: [serve, --mcp]\n');
  });

  it('a 4-space-indented mcp_servers gets the new entry at 4 spaces', () => {
    writeConfig('mcp_servers:\n    agentmail:\n        command: npx\n');
    hermes.install('global', { autoAllow: false });
    expect(read()).toBe([
      'mcp_servers:', '    agentmail:', '        command: npx',
      '    codegraph:', '        command: codegraph', '        args:', '            - serve', '            - --mcp',
      '        timeout: 120', '        connect_timeout: 60', '        enabled: true', '',
    ].join('\n'));
  });

  it('an entry written on one line or with a quoted key is found, so no second codegraph key is added', () => {
    for (const entry of ['  codegraph: {command: /opt/bin/codegraph, args: [serve, --mcp]}\n', '  "codegraph":\n    command: /opt/bin/codegraph\n    args: [serve, --mcp]\n']) {
      const text = `mcp_servers:\n${entry}`;
      writeConfig(text);
      expect(hermes.detect('global').alreadyConfigured).toBe(true);
      hermes.install('global', { autoAllow: false });
      expect(read()).toBe(text);
      hermes.uninstall('global');
      expect(codegraphKeys(read())).toBe(0);
    }
  });

  it('mcp_servers written as a one-line mapping: install refuses with a clear error and changes nothing; {} becomes a block', () => {
    const text = 'model: big\nmcp_servers: {agentmail: {command: npx, args: [-y, agentmail-mcp]}}\n';
    writeConfig(text);
    expect(() => hermes.install('global', { autoAllow: false })).toThrow(
      /config\.yaml writes mcp_servers as a one-line mapping \(line 2\), so CodeGraph can't add its server without rewriting it\. Nothing was changed/,
    );
    expect(read()).toBe(text);

    writeConfig('model: big\nmcp_servers: {}\n');
    hermes.install('global', { autoAllow: false });
    expect(read()).toBe(`model: big\nmcp_servers:\n${ENTRY}`);
  });

  it('codegraph inside a one-line mcp_servers mapping is left as written; uninstall says it can\'t remove it', () => {
    const text = 'mcp_servers: {codegraph: {command: codegraph, args: [serve, --mcp]}}\n';
    writeConfig(text);
    expect(hermes.detect('global').alreadyConfigured).toBe(true);
    const result = hermes.install('global', { autoAllow: false });
    expect(result.notes?.join('\n')).toMatch(/Left the mcp_servers\.codegraph entry in .*config\.yaml \(line 1\) as you wrote it/);
    const removed = hermes.uninstall('global');
    expect(removed.notes?.join('\n')).toMatch(/inside a one-line mcp_servers mapping \(line 1\), which CodeGraph can't edit safely/);
    expect(read()).toBe(text);
  });

  it('a CRLF config stays CRLF', () => {
    writeConfig(`model: big\r\nplatform_toolsets:\r\n  cli:\r\n  - hermes-cli\r\n  - mcp-codegraph\r\n`);
    hermes.install('global', { autoAllow: false });
    expect(read()).toBe(`model: big\r\nplatform_toolsets:\r\n  cli:\r\n  - hermes-cli\r\n\r\nmcp_servers:\r\n${ENTRY.replace(/\n/g, '\r\n')}`);
  });

  it('uninstall removes the server and any codegraph toolset name, and keeps the rest', () => {
    writeConfig(`${OTHERS}${ENTRY}platform_toolsets:\n  cli:\n  - hermes-cli\n  - agentmail\n  - codegraph\n  telegram:\n  - hermes-telegram\n`);
    hermes.uninstall('global');
    expect(read()).toBe(`${OTHERS}platform_toolsets:\n  cli:\n  - hermes-cli\n  - agentmail\n  telegram:\n  - hermes-telegram\n`);
    expect(hermes.detect('global').alreadyConfigured).toBe(false);
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

describe('Installer — refreshTargets sweep (codegraph install --refresh)', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('rf-home');
    tmpCwd = mkTmpDir('rf-cwd');
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

  it('rewrites a stale instructions block a previous version left, and reports refreshed', () => {
    const claude = getTarget('claude')!;
    claude.install('global', { autoAllow: true });

    // Simulate the file as an old install left it: same markers, the old
    // multi-tool wording.
    const claudeMd = path.join(tmpHome, '.claude', 'CLAUDE.md');
    fs.writeFileSync(claudeMd, LEGACY_BLOCK + '\n');

    const reports = refreshTargets([claude], 'global');
    expect(reports[0].status).toBe('refreshed');
    expect(reports[0].changedPaths).toContain(claudeMd);

    const md = fs.readFileSync(claudeMd, 'utf-8');
    expect(md).not.toContain('codegraph_search');
    expect(md).toContain('codegraph_explore');
  });

  it('never performs a first install — unconfigured agents stay untouched', () => {
    const reports = refreshTargets(ALL_TARGETS, 'global');
    for (const t of ALL_TARGETS) {
      const r = reports.find((x) => x.id === t.id)!;
      expect(r.status).toBe(t.supportsLocation('global') ? 'not-configured' : 'unsupported');
      expect(r.changedPaths).toEqual([]);
      expect(t.detect('global').alreadyConfigured).toBe(false);
    }
  });

  it('preserves the user\'s permission choices (refresh never writes permissions)', () => {
    const claude = getTarget('claude')!;
    claude.install('global', { autoAllow: true });

    // The user has since trimmed the allowlist by hand.
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    settings.permissions.allow = [];
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    refreshTargets([claude], 'global');

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(after.permissions.allow).toEqual([]);
  });

  it('is idempotent — a second sweep on a current machine reports unchanged everywhere', () => {
    for (const t of ALL_TARGETS) {
      if (t.supportsLocation('global')) t.install('global', { autoAllow: true });
    }
    const first = refreshTargets(ALL_TARGETS, 'global');
    // Fresh installs are already current, so even the first sweep may be
    // all-unchanged; what matters is the second definitely is.
    const second = refreshTargets(ALL_TARGETS, 'global');
    for (const r of [...first, ...second]) {
      expect(['unchanged', 'refreshed']).toContain(r.status);
    }
    for (const r of second) {
      expect(r.status).toBe('unchanged');
      expect(r.changedPaths).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The instructions block never touches anything outside its markers (#2506)
//
// `codegraph upgrade` runs `install --refresh`, which rewrites the block in
// every configured agent's instructions file. The write paired the FIRST
// start marker with the FIRST end marker anywhere in the file, so one stray
// start marker above the real block — an older block whose end marker was
// deleted by hand, or the marker quoted in the user's own notes — made the
// refresh replace everything between the two. With the stray marker on the
// first line, the reported global AGENTS.md came back as just the block.
// ---------------------------------------------------------------------------
describe('Installer — the instructions block keeps everything outside its markers (#2506)', () => {
  const START = CODEGRAPH_SECTION_START;
  const END = CODEGRAPH_SECTION_END;
  const BLOCK = CODEGRAPH_INSTRUCTIONS_BLOCK;
  const BOM = String.fromCharCode(0xfeff);
  const crlf = (s: string) => s.replace(/\n/g, '\r\n');
  // A maintained guidance file like the reporter's, with text below the block too.
  const NOTES = [
    '# Global agent guidance',
    '',
    '## Toolset inventory',
    '- ripgrep, fd, jq',
    '',
    '## Commit policy',
    '- conventional commits',
  ].join('\n');
  const MORE = ['## Runtime notes', '', '- prefer the sandbox'].join('\n');
  // What is left of an older block whose end marker was deleted by hand.
  const STRAY = `${START}\n## CodeGraph\n\n`;

  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkTmpDir('marked');
    file = path.join(dir, 'AGENTS.md');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function upsert(content: string): { action: string; after: string } {
    fs.writeFileSync(file, content);
    const action = replaceOrAppendMarkedSection(file, BLOCK, START, END);
    return { action, after: fs.readFileSync(file, 'utf-8') };
  }
  function upsertAgain(): { action: string; after: string } {
    const action = replaceOrAppendMarkedSection(file, BLOCK, START, END);
    return { action, after: fs.readFileSync(file, 'utf-8') };
  }
  function remove(content: string): { action: string; after: string | null } {
    fs.writeFileSync(file, content);
    const action = removeMarkedSection(file, START, END);
    return { action, after: fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null };
  }

  it('a stray start marker on the first line no longer reduces the file to the block (the report)', () => {
    const { action, after } = upsert(`${STRAY}${NOTES}\n\n${LEGACY_BLOCK}\n`);
    expect(action).toBe('updated');
    expect(after).toBe(`${STRAY}${NOTES}\n\n${BLOCK}\n`);
    expect(upsertAgain()).toEqual({ action: 'unchanged', after });
  });

  it('a stray start marker with no block after it: the block is appended, and the next run keeps the text below the stray marker', () => {
    const content = `${NOTES}\n\n${STRAY}old text, end marker deleted\n\n${MORE}\n`;
    const first = upsert(content);
    expect(first.action).toBe('appended');
    expect(first.after).toBe(`${content}\n${BLOCK}\n`);
    expect(upsertAgain()).toEqual({ action: 'unchanged', after: first.after });
  });

  it('the start marker quoted in a sentence of the user\'s is their text, not the edge of a block', () => {
    const prose = `Keep your own notes above the ${START} line.\n\n`;
    const { after } = upsert(`${prose}${NOTES}\n\n${LEGACY_BLOCK}\n`);
    expect(after).toBe(`${prose}${NOTES}\n\n${BLOCK}\n`);
  });

  it('a lone end marker no longer makes every run append another block', () => {
    const content = `${NOTES}\n\nold text, start marker deleted\n${END}\n\n${MORE}\n`;
    const first = upsert(content);
    expect(first.after).toBe(`${content}\n${BLOCK}\n`);
    const second = upsertAgain();
    expect(second).toEqual({ action: 'unchanged', after: first.after });
  });

  it('two blocks: the first is refreshed, the duplicate removed, and the text between them kept', () => {
    const { action, after } = upsert(`${NOTES}\n\n${LEGACY_BLOCK}\n\n${MORE}\n\n${LEGACY_BLOCK}\n`);
    expect(action).toBe('updated');
    expect(after).toBe(`${NOTES}\n\n${BLOCK}\n\n${MORE}\n`);
    expect(upsertAgain()).toEqual({ action: 'unchanged', after });
  });

  it('a CRLF file stays CRLF: the text around the block is untouched and the block takes the file\'s line breaks', () => {
    const { action, after } = upsert(crlf(`${NOTES}\n\n${LEGACY_BLOCK}\n\n${MORE}\n`));
    expect(action).toBe('updated');
    expect(after).toBe(crlf(`${NOTES}\n\n${BLOCK}\n\n${MORE}\n`));
    expect(upsertAgain()).toEqual({ action: 'unchanged', after });
  });

  it('a CRLF file that already holds the current block is left alone', () => {
    const content = crlf(`${NOTES}\n\n${BLOCK}\n`);
    expect(upsert(content)).toEqual({ action: 'unchanged', after: content });
  });

  it('a file without a trailing newline keeps that shape', () => {
    expect(upsert(`${NOTES}\n\n${LEGACY_BLOCK}`).after).toBe(`${NOTES}\n\n${BLOCK}`);
  });

  it('appending keeps every existing byte: nothing is trimmed, only line breaks are added', () => {
    expect(upsert(NOTES).after).toBe(`${NOTES}\n\n${BLOCK}\n`);
    expect(upsert(`${NOTES}\n`).after).toBe(`${NOTES}\n\n${BLOCK}\n`);
    expect(upsert(`${NOTES}\n\n\n`).after).toBe(`${NOTES}\n\n\n${BLOCK}\n`);
    expect(upsert(crlf(`${NOTES}\n`)).after).toBe(crlf(`${NOTES}\n\n${BLOCK}\n`));
  });

  it('a byte-order mark survives', () => {
    expect(upsert(`${BOM}${NOTES}\n\n${LEGACY_BLOCK}\n`).after).toBe(`${BOM}${NOTES}\n\n${BLOCK}\n`);
    expect(upsert(`${BOM}${LEGACY_BLOCK}\n\n${NOTES}\n`).after).toBe(`${BOM}${BLOCK}\n\n${NOTES}\n`);
  });

  it('uninstall removes only the block, never the text after a stray start marker', () => {
    const { action, after } = remove(`${STRAY}${NOTES}\n\n${LEGACY_BLOCK}\n\n${MORE}\n`);
    expect(action).toBe('removed');
    expect(after).toBe(`${STRAY}${NOTES}\n\n${MORE}\n`);
  });

  it('uninstall removes every block, keeps CRLF, and leaves a file holding only stray markers alone', () => {
    expect(remove(crlf(`${NOTES}\n\n${LEGACY_BLOCK}\n\n${MORE}\n\n${LEGACY_BLOCK}\n`)).after).toBe(crlf(`${NOTES}\n\n${MORE}\n`));
    const strays = `${NOTES}\n${START}\n${MORE}\n${END}x\n`;
    expect(remove(strays)).toEqual({ action: 'not-found', after: strays });
    // A file that held nothing but the block is deleted, as before.
    expect(remove(`${LEGACY_BLOCK}\n`)).toEqual({ action: 'removed', after: null });
  });
});

describe('Installer — install --refresh keeps each agent\'s instructions file (#2506)', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('rf2506-home');
    tmpCwd = mkTmpDir('rf2506-cwd');
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

  // Every target that writes an instructions file, at its global path.
  const INSTRUCTIONS: Array<[string, (home: string) => string]> = [
    ['claude', (home) => path.join(home, '.claude', 'CLAUDE.md')],
    ['codex', (home) => path.join(home, '.codex', 'AGENTS.md')],
    ['gemini', (home) => path.join(home, '.gemini', 'GEMINI.md')],
    ['opencode', (home) => path.join(home, '.config', 'opencode', 'AGENTS.md')],
    ['droid', (home) => path.join(home, '.factory', 'AGENTS.md')],
    ['qwen', (home) => path.join(home, '.qwen', 'QWEN.md')],
    ['dsh', (home) => path.join(home, '.dsh', 'AGENTS.md')],
    ['grok', (home) => path.join(home, '.grok', 'rules', 'codegraph.md')],
    ['kimi', (home) => path.join(home, '.kimi-code', 'AGENTS.md')],
    ['pi', (home) => path.join(home, '.pi', 'agent', 'AGENTS.md')],
  ];
  const USER = `${CODEGRAPH_SECTION_START}\n## CodeGraph\n\n# My notes\n\nAlways run the tests first.\n\n`;

  for (const [id, instructionsFile] of INSTRUCTIONS) {
    it(`${id}: the refresh rewrites only the block, and uninstall removes only the block`, () => {
      const target = getTarget(id)!;
      target.install('global', { autoAllow: false });
      const file = instructionsFile(tmpHome);
      fs.writeFileSync(file, `${USER}${LEGACY_BLOCK}\n`);

      const report = refreshTargets(ALL_TARGETS, 'global').find((r) => r.id === id)!;
      expect(report.status).toBe('refreshed');
      expect(report.changedPaths).toContain(file);
      expect(fs.readFileSync(file, 'utf-8')).toBe(`${USER}${CODEGRAPH_INSTRUCTIONS_BLOCK}\n`);
      expect(refreshTargets(ALL_TARGETS, 'global').find((r) => r.id === id)!.status).toBe('unchanged');

      target.uninstall('global');
      expect(fs.readFileSync(file, 'utf-8')).toBe(USER.trimEnd() + '\n');
    });
  }
});

// ---------------------------------------------------------------------------
// A symbolic link is written through, never replaced (#2721)
//
// Instructions and config files are often symbolic links into a dotfiles or
// team repo (`~/.codex/AGENTS.md -> ~/dotfiles/AGENTS.md`). Every installer
// write went to `<path>.tmp.<pid>` and was renamed onto the path, and a
// rename replaces the link itself: install left a detached copy, so the
// shared file never got CodeGraph's entry and later edits to it never reached
// the agent. Uninstall deleted a link whose file it had emptied.
// ---------------------------------------------------------------------------

/**
 * Whether this machine can create a file symlink. On Windows that needs
 * Developer Mode or admin rights; where it can't, the link tests are skipped,
 * with the reason in their name, rather than passing without running.
 */
function canCreateFileSymlink(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'target'), '');
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const FILE_SYMLINKS = canCreateFileSymlink();
const NO_FILE_SYMLINKS = ' — skipped: creating a file symlink needs Developer Mode or admin rights on Windows';

describe.skipIf(!FILE_SYMLINKS)(`Installer — a symbolic link is written through, never replaced (#2721)${FILE_SYMLINKS ? '' : NO_FILE_SYMLINKS}`, () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };
  let restoreWritable: Array<() => void>;

  beforeEach(() => {
    tmpHome = mkTmpDir('link-home');
    tmpCwd = mkTmpDir('link-cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
    restoreWritable = [];
  });

  afterEach(() => {
    for (const restore of restoreWritable) restore();
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  const isLink = (p: string): boolean => {
    try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
  };
  /** Make `linkPath` a file symlink whose text is `text`, creating the folder that holds it. */
  function link(linkPath: string, text: string): void {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(text, linkPath, 'file');
  }
  /** A file in the shared folder the links point into, written with `content` when given. */
  function sharedFile(name: string, content?: string): string {
    const file = path.join(tmpHome, 'dotfiles', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (content !== undefined) fs.writeFileSync(file, content);
    return file;
  }

  // Every file each agent's install writes, at both locations: whatever the
  // installer does, it never replaces or removes a link.
  for (const target of ALL_TARGETS) {
    for (const location of (['global', 'local'] as const).filter((l) => target.supportsLocation(l))) {
      it(`${target.id} (${location}): install and uninstall keep every one of its files that is a link`, () => {
        const links = target.describePaths(location).map((p, i) => {
          const dest = sharedFile(`${i}-${path.basename(p)}`);
          link(p, dest);
          return { path: p, dest };
        });

        const result = target.install(location, { autoAllow: true });
        for (const l of links) {
          expect(isLink(l.path), l.path).toBe(true);
          expect(fs.readlinkSync(l.path)).toBe(l.dest);
        }
        for (const f of result.files.filter((x) => x.action === 'created' || x.action === 'updated')) {
          const written = links.find((l) => l.path === f.path);
          expect(written, f.path).toBeDefined();
          expect(fs.existsSync(written!.dest), written!.dest).toBe(true);
        }
        expect(target.detect(location).alreadyConfigured).toBe(true);

        target.uninstall(location);
        for (const l of links) {
          expect(isLink(l.path), l.path).toBe(true);
          expect(fs.readlinkSync(l.path)).toBe(l.dest);
        }
        expect(target.detect(location).alreadyConfigured).toBe(false);
      });
    }
  }

  it('the shared files get CodeGraph\'s entries next to the user\'s own, and uninstall takes only those out again', () => {
    const files = {
      claudeJson: sharedFile('claude.json', '{\n  "numStartups": 3\n}\n'),
      claudeMd: sharedFile('CLAUDE.md', '# my claude notes\n'),
      agentsMd: sharedFile('AGENTS.md', '# shared rules\n\nBe terse.\n'),
      codexToml: sharedFile('codex.toml', 'model = "o3"\n'),
      opencode: sharedFile('opencode.jsonc', '{\n  // my theme\n  "theme": "tokyonight"\n}\n'),
      cursor: sharedFile('cursor-mcp.json', '{\n  "mcpServers": {\n    "other": {\n      "command": "x"\n    }\n  }\n}\n'),
    };
    const original = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, fs.readFileSync(f, 'utf-8')]));
    link(path.join(tmpHome, '.claude.json'), files.claudeJson);
    link(path.join(tmpHome, '.claude', 'CLAUDE.md'), files.claudeMd);
    // Two agents sharing one instructions file.
    link(path.join(tmpHome, '.codex', 'AGENTS.md'), files.agentsMd);
    link(path.join(tmpHome, '.config', 'opencode', 'AGENTS.md'), files.agentsMd);
    link(path.join(tmpHome, '.codex', 'config.toml'), files.codexToml);
    link(path.join(tmpHome, '.config', 'opencode', 'opencode.jsonc'), files.opencode);
    link(path.join(tmpHome, '.cursor', 'mcp.json'), files.cursor);
    const ids = ['claude', 'codex', 'opencode', 'cursor'] as const;

    for (const id of ids) getTarget(id)!.install('global', { autoAllow: false });

    const read = (f: string) => fs.readFileSync(f, 'utf-8');
    expect(JSON.parse(read(files.claudeJson))).toMatchObject({ numStartups: 3, mcpServers: { codegraph: {} } });
    expect(read(files.claudeMd)).toBe(`# my claude notes\n\n${CODEGRAPH_INSTRUCTIONS_BLOCK}\n`);
    expect(read(files.agentsMd)).toBe(`# shared rules\n\nBe terse.\n\n${CODEGRAPH_INSTRUCTIONS_BLOCK}\n`);
    expect(read(files.codexToml)).toContain('model = "o3"');
    expect(read(files.codexToml)).toContain('[mcp_servers.codegraph]');
    expect(read(files.opencode)).toContain('// my theme');
    expect(parseJsonc(read(files.opencode)).mcp.servers.codegraph).toBeDefined();
    expect(JSON.parse(read(files.cursor)).mcpServers).toMatchObject({ other: { command: 'x' }, codegraph: {} });
    // Re-running is a no-op through the links too.
    for (const id of ids) {
      for (const f of getTarget(id)!.install('global', { autoAllow: false }).files) expect(f.action, f.path).toBe('unchanged');
    }

    for (const id of ids) getTarget(id)!.uninstall('global');

    expect(JSON.parse(read(files.claudeJson))).toEqual({ numStartups: 3 });
    expect(read(files.claudeMd)).toBe(original.claudeMd);
    expect(read(files.agentsMd)).toBe(original.agentsMd);
    expect(read(files.codexToml)).toBe(original.codexToml);
    expect(parseJsonc(read(files.opencode))).toEqual({ $schema: 'https://opencode.ai/config.json', theme: 'tokyonight' });
    expect(read(files.opencode)).toContain('// my theme');
    expect(JSON.parse(read(files.cursor))).toEqual({ mcpServers: { other: { command: 'x' } } });
  });

  it('a relative link keeps its text, and is followed from the folder that really holds it', () => {
    // `~/.codex` is itself a folder link into the dotfiles repo, and the
    // config inside it points one level up, relative to the real folder.
    const realCodex = path.join(tmpHome, 'dotfiles', 'codex');
    fs.mkdirSync(realCodex, { recursive: true });
    fs.symlinkSync(realCodex, path.join(tmpHome, '.codex'), 'junction');
    const agentsText = path.join('..', 'AGENTS.md');
    const tomlText = path.join('..', 'codex.toml');
    link(path.join(realCodex, 'AGENTS.md'), agentsText);
    link(path.join(realCodex, 'config.toml'), tomlText);
    fs.writeFileSync(path.join(tmpHome, 'dotfiles', 'codex.toml'), 'model = "o3"\n');
    // Only the AGENTS.md target is missing, so it is created where the link
    // really points: dotfiles/AGENTS.md, not a lexical ~/AGENTS.md.

    getTarget('codex')!.install('global', { autoAllow: false });

    expect(fs.readlinkSync(path.join(realCodex, 'AGENTS.md'))).toBe(agentsText);
    expect(fs.readlinkSync(path.join(realCodex, 'config.toml'))).toBe(tomlText);
    expect(isLink(path.join(tmpHome, '.codex'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpHome, 'dotfiles', 'AGENTS.md'), 'utf-8')).toBe(`${CODEGRAPH_INSTRUCTIONS_BLOCK}\n`);
    expect(fs.existsSync(path.join(tmpHome, 'AGENTS.md'))).toBe(false);
    expect(fs.readFileSync(path.join(tmpHome, 'dotfiles', 'codex.toml'), 'utf-8')).toContain('[mcp_servers.codegraph]');
  });

  it('a link into a folder that does not exist is an error naming the link, and nothing is created', () => {
    const agentsMd = path.join(tmpHome, '.codex', 'AGENTS.md');
    const missing = path.join(tmpHome, 'dotfiles-not-cloned-yet', 'AGENTS.md');
    link(agentsMd, missing);

    expect(() => getTarget('codex')!.install('global', { autoAllow: false })).toThrow(
      /AGENTS\.md is a symbolic link to .*dotfiles-not-cloned-yet.*its folder does not exist.*never replaces one with a copy/,
    );
    expect(isLink(agentsMd)).toBe(true);
    expect(fs.readlinkSync(agentsMd)).toBe(missing);
    expect(fs.existsSync(path.dirname(missing))).toBe(false);
  });

  // POSIX refuses the write in a read-only folder, except to root; Windows
  // refuses replacing a file whose read-only attribute is set.
  const POSIX_ROOT = process.platform !== 'win32' && process.getuid?.() === 0;
  it.skipIf(POSIX_ROOT)(`a link to a read-only file is an error naming the link; the file is unchanged and no temp file is left${POSIX_ROOT ? ' — skipped: root can write into a read-only folder' : ''}`, () => {
    const shared = sharedFile(path.join('managed', 'AGENTS.md'), '# managed by home-manager\n');
    const lock = process.platform === 'win32' ? shared : path.dirname(shared);
    fs.chmodSync(lock, process.platform === 'win32' ? 0o444 : 0o555);
    restoreWritable.push(() => fs.chmodSync(lock, process.platform === 'win32' ? 0o666 : 0o755));
    const agentsMd = path.join(tmpHome, '.codex', 'AGENTS.md');
    link(agentsMd, shared);

    expect(() => getTarget('codex')!.install('global', { autoAllow: false })).toThrow(/AGENTS\.md is a symbolic link to .*it is read-only/);
    expect(isLink(agentsMd)).toBe(true);
    expect(fs.readFileSync(shared, 'utf-8')).toBe('# managed by home-manager\n');
    expect(fs.readdirSync(path.dirname(shared)).filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('uninstall empties a linked file that held only CodeGraph\'s part, instead of deleting the link', () => {
    const agentsMd = sharedFile('AGENTS.md');
    const codexToml = sharedFile('codex.toml');
    const copilot = sharedFile('copilot.json');
    const droid = sharedFile('droid.json');
    const grokToml = sharedFile('grok.toml');
    const dshPatch = sharedFile('cordis.patch.yml');
    link(path.join(tmpHome, '.codex', 'AGENTS.md'), agentsMd);
    link(path.join(tmpHome, '.codex', 'config.toml'), codexToml);
    link(path.join(tmpHome, '.copilot', 'mcp-config.json'), copilot);
    link(path.join(tmpHome, '.factory', 'mcp.json'), droid);
    link(path.join(tmpHome, '.grok', 'config.toml'), grokToml);
    link(path.join(tmpHome, '.dsh', 'cordis.patch.yml'), dshPatch);
    const ids = ['codex', 'copilot-cli', 'droid', 'grok', 'dsh'] as const;
    for (const id of ids) getTarget(id)!.install('global', { autoAllow: false });
    expect(fs.readFileSync(agentsMd, 'utf-8')).toBe(`${CODEGRAPH_INSTRUCTIONS_BLOCK}\n`);

    for (const id of ids) getTarget(id)!.uninstall('global');

    for (const p of ['.codex/AGENTS.md', '.codex/config.toml', '.copilot/mcp-config.json', '.factory/mcp.json', '.grok/config.toml', '.dsh/cordis.patch.yml']) {
      expect(isLink(path.join(tmpHome, p)), p).toBe(true);
    }
    expect(fs.readFileSync(agentsMd, 'utf-8')).toBe('');
    expect(fs.readFileSync(codexToml, 'utf-8')).toBe('');
    expect(fs.readFileSync(grokToml, 'utf-8')).toBe('');
    expect(JSON.parse(fs.readFileSync(copilot, 'utf-8'))).toEqual({});
    expect(JSON.parse(fs.readFileSync(droid, 'utf-8'))).toEqual({});
    expect(fs.readFileSync(dshPatch, 'utf-8')).toBe('[]\n');
  });

  it('a link that can\'t be written fails only its own agent in a refresh: the others are still refreshed', () => {
    getTarget('codex')!.install('global', { autoAllow: false });
    getTarget('gemini')!.install('global', { autoAllow: false });
    // Codex's instructions file is now a link into a folder that is gone,
    // and Gemini's block is stale.
    const agentsMd = path.join(tmpHome, '.codex', 'AGENTS.md');
    fs.unlinkSync(agentsMd);
    link(agentsMd, path.join(tmpHome, 'gone', 'AGENTS.md'));
    const geminiMd = path.join(tmpHome, '.gemini', 'GEMINI.md');
    fs.writeFileSync(geminiMd, `${LEGACY_BLOCK}\n`);

    const reports = refreshTargets(ALL_TARGETS, 'global');

    const codex = reports.find((r) => r.id === 'codex')!;
    expect(codex.status).toBe('failed');
    expect(codex.error).toMatch(/AGENTS\.md is a symbolic link to .*gone.*its folder does not exist/);
    const gemini = reports.find((r) => r.id === 'gemini')!;
    expect(gemini.status).toBe('refreshed');
    expect(fs.readFileSync(geminiMd, 'utf-8')).toBe(`${CODEGRAPH_INSTRUCTIONS_BLOCK}\n`);
    expect(isLink(agentsMd)).toBe(true);
  });
});

describe('Installer — a config folder that is a link keeps working (#2721)', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('dirlink-home');
    tmpCwd = mkTmpDir('dirlink-cwd');
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

  // A folder link needs no special rights: a junction on Windows, a symlink elsewhere.
  it('~/.codex as a folder link: files are written inside the real folder and the link stays', () => {
    const real = path.join(tmpHome, 'dotfiles', 'codex');
    fs.mkdirSync(real, { recursive: true });
    const dirLink = path.join(tmpHome, '.codex');
    fs.symlinkSync(real, dirLink, 'junction');

    getTarget('codex')!.install('global', { autoAllow: false });
    expect(fs.lstatSync(dirLink).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(real, 'config.toml'), 'utf-8')).toContain('[mcp_servers.codegraph]');
    expect(fs.readFileSync(path.join(real, 'AGENTS.md'), 'utf-8')).toBe(`${CODEGRAPH_INSTRUCTIONS_BLOCK}\n`);

    getTarget('codex')!.uninstall('global');
    expect(fs.lstatSync(dirLink).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(real, 'AGENTS.md'))).toBe(false);
  });
});

describe('Installer — detection never writes (#1870)', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  // Antigravity present with an MCP config JSON.parse rejects, and
  // codegraph never installed into it — the reported setup: an empty
  // (0-byte) `~/.gemini/config/mcp_config.json`.
  function plantUnparseableAntigravityConfig(content: string): string {
    const dir = path.join(tmpHome, '.gemini', 'config');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'mcp_config.json');
    fs.writeFileSync(file, content);
    return file;
  }

  beforeEach(() => {
    tmpHome = mkTmpDir('detect-home');
    tmpCwd = mkTmpDir('detect-cwd');
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

  it('a refresh leaves an unconfigured agent\'s unparseable config alone — no backup, no warning', () => {
    const file = plantUnparseableAntigravityConfig('');

    // Asserted inside the spy: `mockRestore` also clears the recorded
    // calls, so a `not.toHaveBeenCalled()` after it always passes.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const reports = refreshTargets(ALL_TARGETS, 'global');
      expect(reports.find((r) => r.id === 'antigravity')!.status).toBe('not-configured');
      expect(fs.readdirSync(path.dirname(file))).toEqual(['mcp_config.json']);
      expect(fs.readFileSync(file, 'utf-8')).toBe('');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('detect() on its own touches nothing', () => {
    const file = plantUnparseableAntigravityConfig('{ half a config');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(getTarget('antigravity')!.detect('global').alreadyConfigured).toBe(false);
      expect(fs.readdirSync(path.dirname(file))).toEqual(['mcp_config.json']);
      expect(fs.readFileSync(file, 'utf-8')).toBe('{ half a config');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('an install that really overwrites an unparseable config still backs it up first', () => {
    const file = plantUnparseableAntigravityConfig('{ half a config');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getTarget('antigravity')!.install('global', { autoAllow: false });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }

    expect(fs.readFileSync(file + '.backup', 'utf-8')).toBe('{ half a config');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).mcpServers.codegraph).toBeDefined();
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

  it('a stray start marker above the block never takes the user\'s rules with it (#2506)', () => {
    fs.mkdirSync(path.dirname(rulesFile()), { recursive: true });
    const userRules = `${CODEGRAPH_SECTION_START}\n## My own rule\nkeep me\n`;
    fs.writeFileSync(rulesFile(), `${MDC_FRONTMATTER}${userRules}\n${LEGACY_BLOCK}\n`);

    cursor.uninstall('local');

    expect(fs.existsSync(rulesFile())).toBe(true);
    expect(fs.readFileSync(rulesFile(), 'utf-8')).toBe(`${MDC_FRONTMATTER}${userRules}`);
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
// opencode OpenCode 2 native MCP shape (#1698)
//
// OpenCode 2 reads `mcp.servers.<name>` with `disabled` / `codemode`. The
// v1 `mcp.<name>` + `enabled` shape still connects but drops `codemode`
// during normalization — so the installer must write the native shape and
// migrate/uninstall either.
// ---------------------------------------------------------------------------
describe('Installer targets — opencode native MCP shape (#1698)', () => {
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

  const configFile = () => path.join(tmpHome, '.config', 'opencode', 'opencode.jsonc');

  it('install writes mcp.servers.codegraph with disabled:false and codemode:false', () => {
    const opencode = getTarget('opencode')!;
    opencode.install('global', { autoAllow: true });
    const cfg = JSON.parse(fs.readFileSync(configFile(), 'utf-8'));
    expect(cfg.mcp.codegraph).toBeUndefined();
    expect(cfg.mcp.servers.codegraph).toEqual({
      type: 'local',
      command: ['codegraph', 'serve', '--mcp'],
      disabled: false,
      codemode: false,
    });
  });

  it('printConfig shows the native OpenCode 2 shape', () => {
    const out = getTarget('opencode')!.printConfig('global');
    expect(out).toContain('"servers"');
    expect(out).toContain('"codemode": false');
    expect(out).toContain('"disabled": false');
    expect(out).not.toContain('"enabled"');
    // No v1 top-level mcp.codegraph key in the snippet.
    expect(out).not.toMatch(/"mcp"\s*:\s*\{\s*"codegraph"/);
  });

  it('re-install migrates a v1 mcp.codegraph entry to mcp.servers.codegraph', () => {
    const dir = path.dirname(configFile());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configFile(), [
      '{',
      '  // keep me',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "mcp": {',
      '    "codegraph": { "type": "local", "command": ["codegraph", "serve", "--mcp"], "enabled": true },',
      '    "other": { "type": "local", "command": ["x"], "enabled": true }',
      '  }',
      '}',
      '',
    ].join('\n'));

    const opencode = getTarget('opencode')!;
    expect(opencode.detect('global').alreadyConfigured).toBe(true);

    const result = opencode.install('global', { autoAllow: true });
    expect(result.files.find((f) => f.path === configFile())!.action).toBe('updated');

    const text = fs.readFileSync(configFile(), 'utf-8');
    expect(text).toContain('// keep me');
    const cfg = parseJsonc(text);
    expect(cfg.mcp.codegraph).toBeUndefined();
    expect(cfg.mcp.other).toBeDefined();
    expect(cfg.mcp.servers.codegraph).toEqual({
      type: 'local',
      command: ['codegraph', 'serve', '--mcp'],
      disabled: false,
      codemode: false,
    });

    // Idempotent after migration.
    const second = opencode.install('global', { autoAllow: true });
    expect(second.files.find((f) => f.path === configFile())!.action).toBe('unchanged');
  });

  it('uninstall removes a leftover v1 mcp.codegraph entry', () => {
    const dir = path.dirname(configFile());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configFile(), [
      '{',
      '  // keep me',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "mcp": {',
      '    "codegraph": { "type": "local", "command": ["codegraph", "serve", "--mcp"], "enabled": true },',
      '    "other": { "type": "local", "command": ["x"], "enabled": true }',
      '  }',
      '}',
      '',
    ].join('\n'));

    const opencode = getTarget('opencode')!;
    opencode.uninstall('global');
    const text = fs.readFileSync(configFile(), 'utf-8');
    expect(text).toContain('// keep me');
    expect(text).toContain('"other"');
    expect(text).not.toContain('codegraph');
    expect(opencode.detect('global').alreadyConfigured).toBe(false);
  });

  it('uninstall removes a native mcp.servers.codegraph entry and an emptied servers wrapper', () => {
    const dir = path.dirname(configFile());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        servers: {
          codegraph: {
            type: 'local',
            command: ['codegraph', 'serve', '--mcp'],
            disabled: false,
            codemode: false,
          },
        },
      },
    }, null, 2) + '\n');

    const opencode = getTarget('opencode')!;
    opencode.uninstall('global');
    const text = fs.readFileSync(configFile(), 'utf-8');
    expect(text).not.toContain('codegraph');
    expect(text).not.toContain('"servers"');
    expect(text).not.toContain('"mcp"');
    expect(opencode.detect('global').alreadyConfigured).toBe(false);
  });
});

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

// ---------------------------------------------------------------------------
// Copilot family — copilot-vscode / copilot-cli / copilot-jetbrains (CG-5)
//
// The registry-driven contract suite above covers the shared surface
// (install/idempotency/sibling/uninstall/printConfig). These pin the
// target-specific behavior: OS-specific global paths, `--path` injection
// (copilot-vscode mirrors Cursor), global-only skip semantics (cli +
// jetbrains, Codex pattern), COPILOT_HOME resolution, JSONC comment
// preservation, empty-`servers`-wrapper cleanup, and printConfig parity
// with what install writes.
// ---------------------------------------------------------------------------
describe('Installer targets — Copilot family', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('cop-home');
    tmpCwd = mkTmpDir('cop-cwd');
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

  // printConfig embeds the paste-able snippet after a `# Add to <path>`
  // header — extract and parse just the JSON body.
  function snippetJson(out: string): any {
    const start = out.indexOf('{');
    expect(start).toBeGreaterThanOrEqual(0);
    return JSON.parse(out.slice(start));
  }

  // ---- copilot-vscode ----

  it('copilot-vscode: local install writes ./.vscode/mcp.json with servers.codegraph and an absolute --path pin', () => {
    const t = getTarget('copilot-vscode')!;
    const result = t.install('local', { autoAllow: true });

    const file = path.join(process.cwd(), '.vscode', 'mcp.json');
    expect(result.files[0].path).toBe(file);
    expect(result.files[0].action).toBe('created');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(cfg.servers.codegraph.type).toBe('stdio');
    expect(cfg.servers.codegraph.command).toBe('codegraph');
    // Cursor-mirror: local installs pin the project with an absolute path.
    expect(cfg.servers.codegraph.args).toEqual(['serve', '--mcp', '--path', process.cwd()]);
    // No mcpServers wrapper — VS Code's mcp.json uses `servers`.
    expect(cfg.mcpServers).toBeUndefined();
  });

  it('copilot-vscode: global install writes a variable-free entry — no --path, no ${workspaceFolder}', () => {
    // VS Code refuses to start a user-level server whose entry uses
    // ${workspaceFolder} in any window with no folder open, toasting
    // "Variable workspaceFolder can not be resolved" (hit live). VS Code
    // documents cwd = workspace folder for stdio servers, and the
    // codegraph server resolves the project from roots/cwd — so the
    // global entry must carry no --path and no variables at all.
    const t = getTarget('copilot-vscode')!;
    const result = t.install('global', { autoAllow: true });
    const cfg = JSON.parse(fs.readFileSync(result.files[0].path, 'utf-8'));
    expect(cfg.servers.codegraph.args).toEqual(['serve', '--mcp']);
    expect(JSON.stringify(cfg)).not.toContain('${');
  });

  it.runIf(process.platform === 'darwin')('copilot-vscode: global path is ~/Library/Application Support/Code/User/mcp.json on macOS', () => {
    const t = getTarget('copilot-vscode')!;
    const expected = path.join(tmpHome, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
    expect(t.describePaths('global')).toEqual([expected]);
    const result = t.install('global', { autoAllow: true });
    expect(result.files[0].path).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
  });

  it.runIf(process.platform === 'linux')('copilot-vscode: global path honors XDG_CONFIG_HOME on Linux', () => {
    const t = getTarget('copilot-vscode')!;
    // setHome() points XDG_CONFIG_HOME at <home>/.config.
    const expected = path.join(tmpHome, '.config', 'Code', 'User', 'mcp.json');
    expect(t.describePaths('global')).toEqual([expected]);
    const result = t.install('global', { autoAllow: true });
    expect(result.files[0].path).toBe(expected);
  });

  it.runIf(process.platform === 'win32')('copilot-vscode: global path is %APPDATA%\\Code\\User\\mcp.json on Windows', () => {
    const t = getTarget('copilot-vscode')!;
    // setHome() points APPDATA at <home>/.config.
    const expected = path.join(process.env.APPDATA!, 'Code', 'User', 'mcp.json');
    expect(t.describePaths('global')).toEqual([expected]);
    const result = t.install('global', { autoAllow: true });
    expect(result.files[0].path).toBe(expected);
  });

  it('copilot-vscode: supports both global and local locations', () => {
    const t = getTarget('copilot-vscode')!;
    expect(t.supportsLocation('global')).toBe(true);
    expect(t.supportsLocation('local')).toBe(true);
  });

  it('copilot-vscode: preserves comments and sibling servers through install + idempotent re-run (JSONC)', () => {
    const t = getTarget('copilot-vscode')!;
    const dir = path.join(tmpCwd, '.vscode');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'mcp.json');
    fs.writeFileSync(file, [
      '{',
      '  // my MCP servers',
      '  "servers": {',
      '    "other": { "type": "stdio", "command": "other-server" } // keep',
      '  }',
      '}',
      '',
    ].join('\n'));

    t.install('local', { autoAllow: true });
    const afterInstall = fs.readFileSync(file, 'utf-8');
    expect(afterInstall).toContain('// my MCP servers');
    expect(afterInstall).toContain('// keep');
    expect(afterInstall).toContain('"other-server"');
    expect(afterInstall).toContain('"codegraph"');

    const second = t.install('local', { autoAllow: true });
    expect(second.files[0].action).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf-8')).toBe(afterInstall);
  });

  it('copilot-vscode: uninstall drops an emptied servers wrapper but keeps the file and its siblings (e.g. inputs)', () => {
    const t = getTarget('copilot-vscode')!;
    const dir = path.join(tmpCwd, '.vscode');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'mcp.json');
    fs.writeFileSync(file, [
      '{',
      '  // prompt-time inputs',
      '  "inputs": [{ "id": "api-key", "type": "promptString" }]',
      '}',
      '',
    ].join('\n'));

    t.install('local', { autoAllow: true });
    const result = t.uninstall('local');
    expect(result.files[0].action).toBe('removed');

    // File survives; our entry and the now-empty `servers` wrapper are gone.
    expect(fs.existsSync(file)).toBe(true);
    const text = fs.readFileSync(file, 'utf-8');
    expect(text).toContain('// prompt-time inputs');
    const cfg = parseJsonc(text);
    expect(cfg.inputs).toBeDefined();
    expect(cfg.servers).toBeUndefined();
    expect(text).not.toContain('codegraph');
  });

  it('copilot-vscode: uninstall keeps a non-empty servers wrapper (sibling server survives)', () => {
    const t = getTarget('copilot-vscode')!;
    const file = path.join(tmpCwd, '.vscode', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      servers: { other: { type: 'stdio', command: 'other-server' } },
    }, null, 2) + '\n');

    t.install('local', { autoAllow: true });
    t.uninstall('local');

    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(cfg.servers.other).toBeDefined();
    expect(cfg.servers.codegraph).toBeUndefined();
  });

  it('copilot-vscode: uninstall when never installed reports not-found for both locations, no throw', () => {
    const t = getTarget('copilot-vscode')!;
    for (const loc of ['global', 'local'] as const) {
      const result = t.uninstall(loc);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].action).toBe('not-found');
    }
  });

  it('copilot-vscode: detect() local reports installed only when a .vscode dir exists', () => {
    const t = getTarget('copilot-vscode')!;
    expect(t.detect('local').installed).toBe(false);
    fs.mkdirSync(path.join(tmpCwd, '.vscode'), { recursive: true });
    expect(t.detect('local').installed).toBe(true);
    expect(t.detect('local').alreadyConfigured).toBe(false);
  });

  it('copilot-vscode: detect() global falls back to ~/.vscode (extensions dir) as the installed heuristic', () => {
    const t = getTarget('copilot-vscode')!;
    expect(t.detect('global').installed).toBe(false);
    fs.mkdirSync(path.join(tmpHome, '.vscode'), { recursive: true });
    expect(t.detect('global').installed).toBe(true);
  });

  it('copilot-vscode: printConfig matches what install writes, at both locations', () => {
    const t = getTarget('copilot-vscode')!;
    for (const loc of ['global', 'local'] as const) {
      const printed = snippetJson(t.printConfig(loc));
      const result = t.install(loc, { autoAllow: true });
      const onDisk = JSON.parse(fs.readFileSync(result.files[0].path, 'utf-8'));
      expect(printed.servers.codegraph).toEqual(onDisk.servers.codegraph);
    }
  });

  it('copilot-vscode: install note tells the user to restart VS Code', () => {
    const t = getTarget('copilot-vscode')!;
    const result = t.install('local', { autoAllow: true });
    expect(result.notes?.join(' ')).toMatch(/[Rr]estart VS Code/);
  });


  // ---- copilot-cli ----

  it('copilot-cli: global install writes ~/.copilot/mcp-config.json with the documented entry shape (tools: ["*"], deferTools: "never")', () => {
    const t = getTarget('copilot-cli')!;
    const result = t.install('global', { autoAllow: true });

    const file = path.join(tmpHome, '.copilot', 'mcp-config.json');
    expect(result.files[0].path).toBe(file);
    expect(result.files[0].action).toBe('created');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(cfg.mcpServers.codegraph).toEqual({
      type: 'stdio',
      command: 'codegraph',
      args: ['serve', '--mcp'],
      tools: ['*'],
      // Exempt from Copilot CLI's tool search, the same way `alwaysLoad` exempts it in Claude Code (#1696).
      deferTools: 'never',
    });
  });

  it('copilot-cli: re-running install on an entry that predates deferTools adds the key (#1696)', () => {
    const t = getTarget('copilot-cli')!;
    const file = path.join(tmpHome, '.copilot', 'mcp-config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ mcpServers: { codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'], tools: ['*'] } } }, null, 2),
    );
    const result = t.install('global', { autoAllow: true });
    expect(result.files[0].action).toBe('updated');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(cfg.mcpServers.codegraph.deferTools).toBe('never');
    expect(cfg.mcpServers.codegraph.tools).toEqual(['*']);
  });

  it('copilot-cli: is global-only — local install skips with a clear note, uninstall is a no-op', () => {
    const t = getTarget('copilot-cli')!;
    expect(t.supportsLocation('local')).toBe(false);
    expect(t.supportsLocation('global')).toBe(true);

    const install = t.install('local', { autoAllow: true });
    expect(install.files).toEqual([]);
    expect(install.notes?.join(' ')).toMatch(/no project-local config/);

    expect(t.uninstall('local').files).toEqual([]);
    expect(t.describePaths('local')).toEqual([]);
    expect(t.detect('local').installed).toBe(false);
  });

  it('copilot-cli: honors the COPILOT_HOME override for install, detect, and uninstall', () => {
    const t = getTarget('copilot-cli')!;
    const custom = path.join(tmpHome, 'copilot-custom');
    process.env.COPILOT_HOME = custom;

    const result = t.install('global', { autoAllow: true });
    const expected = path.join(custom, 'mcp-config.json');
    expect(result.files[0].path).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
    expect(t.detect('global').alreadyConfigured).toBe(true);
    // The default location was never touched.
    expect(fs.existsSync(path.join(tmpHome, '.copilot'))).toBe(false);

    t.uninstall('global');
    expect(t.detect('global').alreadyConfigured).toBe(false);
  });

  it('copilot-cli: uninstall removes only codegraph — sibling server and unrelated keys survive', () => {
    const t = getTarget('copilot-cli')!;
    const file = path.join(tmpHome, '.copilot', 'mcp-config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      mcpServers: { other: { type: 'stdio', command: 'other-server' } },
      banner: 'never',
    }, null, 2) + '\n');

    t.install('global', { autoAllow: true });
    t.uninstall('global');

    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(after.mcpServers.other).toBeDefined();
    expect(after.mcpServers.codegraph).toBeUndefined();
    expect(after.banner).toBe('never');
  });

  it('copilot-cli: uninstall of a from-scratch install deletes the file — no `{}` husk to fool detect()', () => {
    const t = getTarget('copilot-cli')!;
    t.install('global', { autoAllow: true });
    t.uninstall('global');
    const file = path.join(tmpHome, '.copilot', 'mcp-config.json');
    // A leftover empty mcp-config.json would count as a CLI footprint
    // and keep the target showing as detected after uninstall.
    expect(fs.existsSync(file)).toBe(false);
  });

  it('copilot-cli: uninstall keeps the file when unrelated top-level keys remain', () => {
    const t = getTarget('copilot-cli')!;
    const file = path.join(tmpHome, '.copilot', 'mcp-config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ banner: 'never' }, null, 2) + '\n');
    t.install('global', { autoAllow: true });
    t.uninstall('global');
    const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(after.mcpServers).toBeUndefined();
    expect(after.banner).toBe('never');
  });

  it('copilot-cli: uninstall when never installed reports not-found, no throw', () => {
    const t = getTarget('copilot-cli')!;
    const result = t.uninstall('global');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].action).toBe('not-found');

    // Same when the file exists but holds no codegraph entry.
    const file = path.join(tmpHome, '.copilot', 'mcp-config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } } }) + '\n');
    expect(t.uninstall('global').files[0].action).toBe('not-found');
  });

  it('copilot-cli: detect() reports installed from CLI artifacts in ~/.copilot', () => {
    const t = getTarget('copilot-cli')!;
    // The tmp PATH may or may not carry a real `copilot` binary; only
    // assert the positive signal we control. The CLI writes config.json
    // on first run — that's the footprint.
    fs.mkdirSync(path.join(tmpHome, '.copilot'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.copilot', 'config.json'), '{}');
    expect(t.detect('global').installed).toBe(true);
    expect(t.detect('global').alreadyConfigured).toBe(false);
  });

  it('copilot-cli: detect() is NOT fooled by the VS Code extension\'s ~/.copilot/ide/ locks', () => {
    // The VS Code Copilot Chat extension writes MCP socket-handoff lock
    // files into ~/.copilot/ide/ on every launch — a machine with only
    // the extension has ~/.copilot with a lone `ide` entry and no CLI.
    const t = getTarget('copilot-cli')!;
    const ideDir = path.join(tmpHome, '.copilot', 'ide');
    fs.mkdirSync(ideDir, { recursive: true });
    fs.writeFileSync(path.join(ideDir, 'some-uuid.lock'), '{"socketPath":"/tmp/mcp.sock"}');

    // Pin PATH to an empty dir so a real `copilot` binary on the host
    // can't turn this negative assertion into a false failure.
    const prevPath = process.env.PATH;
    process.env.PATH = ideDir;
    try {
      expect(t.detect('global').installed).toBe(false);

      // An empty ~/.copilot (no CLI footprint at all) is also not enough.
      fs.rmSync(ideDir, { recursive: true });
      expect(t.detect('global').installed).toBe(false);
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it('copilot-cli: printConfig matches what install writes; local variant points at --location=global', () => {
    const t = getTarget('copilot-cli')!;
    const printed = snippetJson(t.printConfig('global'));
    const result = t.install('global', { autoAllow: true });
    const onDisk = JSON.parse(fs.readFileSync(result.files[0].path, 'utf-8'));
    expect(printed.mcpServers.codegraph).toEqual(onDisk.mcpServers.codegraph);

    expect(t.printConfig('local')).toMatch(/--location=global/);
  });

  // ---- copilot-jetbrains ----

  it('copilot-jetbrains: global install writes github-copilot/intellij/mcp.json with the VS Code-compatible servers shape', () => {
    const t = getTarget('copilot-jetbrains')!;
    const result = t.install('global', { autoAllow: true });

    // setHome() sets XDG_CONFIG_HOME, honored on every platform.
    const file = path.join(tmpHome, '.config', 'github-copilot', 'intellij', 'mcp.json');
    expect(result.files[0].path).toBe(file);
    expect(result.files[0].action).toBe('created');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // Plain entry — no --path injection for this user-global config.
    expect(cfg.servers.codegraph).toEqual({ type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] });
    expect(cfg.mcpServers).toBeUndefined();
  });

  it.runIf(process.platform !== 'win32')('copilot-jetbrains: falls back to ~/.config/github-copilot when XDG_CONFIG_HOME is unset', () => {
    delete process.env.XDG_CONFIG_HOME;
    const t = getTarget('copilot-jetbrains')!;
    const expected = path.join(tmpHome, '.config', 'github-copilot', 'intellij', 'mcp.json');
    expect(t.describePaths('global')).toEqual([expected]);
    const result = t.install('global', { autoAllow: true });
    expect(result.files[0].path).toBe(expected);
  });

  it.runIf(process.platform === 'win32')('copilot-jetbrains: falls back to %LOCALAPPDATA%\\github-copilot on Windows when XDG_CONFIG_HOME is unset', () => {
    const prevLocal = process.env.LOCALAPPDATA;
    delete process.env.XDG_CONFIG_HOME;
    process.env.LOCALAPPDATA = path.join(tmpHome, 'AppData', 'Local');
    try {
      const t = getTarget('copilot-jetbrains')!;
      const expected = path.join(tmpHome, 'AppData', 'Local', 'github-copilot', 'intellij', 'mcp.json');
      expect(t.describePaths('global')).toEqual([expected]);
      const result = t.install('global', { autoAllow: true });
      expect(result.files[0].path).toBe(expected);
    } finally {
      if (prevLocal === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prevLocal;
    }
  });

  it('copilot-jetbrains: is global-only — local install skips with a clear note, uninstall is a no-op', () => {
    const t = getTarget('copilot-jetbrains')!;
    expect(t.supportsLocation('local')).toBe(false);
    expect(t.supportsLocation('global')).toBe(true);

    const install = t.install('local', { autoAllow: true });
    expect(install.files).toEqual([]);
    expect(install.notes?.join(' ')).toMatch(/no project-local MCP config/);

    expect(t.uninstall('local').files).toEqual([]);
    expect(t.describePaths('local')).toEqual([]);
    expect(t.detect('local').installed).toBe(false);
  });

  it('copilot-jetbrains: preserves comments and sibling servers through install + idempotent re-run (JSONC)', () => {
    const t = getTarget('copilot-jetbrains')!;
    const file = path.join(tmpHome, '.config', 'github-copilot', 'intellij', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      '{',
      '  // hand-edited via Settings → Tools → GitHub Copilot',
      '  "servers": {',
      '    "other": { "type": "stdio", "command": "other-server" }',
      '  }',
      '}',
      '',
    ].join('\n'));

    t.install('global', { autoAllow: true });
    const afterInstall = fs.readFileSync(file, 'utf-8');
    expect(afterInstall).toContain('// hand-edited via Settings');
    expect(afterInstall).toContain('"other-server"');
    expect(afterInstall).toContain('"codegraph"');

    const second = t.install('global', { autoAllow: true });
    expect(second.files[0].action).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf-8')).toBe(afterInstall);
  });

  it('copilot-jetbrains: uninstall removes only codegraph and drops an emptied servers wrapper, keeping the file', () => {
    const t = getTarget('copilot-jetbrains')!;
    t.install('global', { autoAllow: true });
    const file = path.join(tmpHome, '.config', 'github-copilot', 'intellij', 'mcp.json');

    const result = t.uninstall('global');
    expect(result.files[0].action).toBe('removed');
    expect(fs.existsSync(file)).toBe(true);
    const cfg = parseJsonc(fs.readFileSync(file, 'utf-8'));
    expect(cfg.servers).toBeUndefined();
  });

  it('copilot-jetbrains: uninstall keeps a sibling server (wrapper not dropped when non-empty)', () => {
    const t = getTarget('copilot-jetbrains')!;
    const file = path.join(tmpHome, '.config', 'github-copilot', 'intellij', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      servers: { other: { type: 'stdio', command: 'other-server' } },
    }, null, 2) + '\n');

    t.install('global', { autoAllow: true });
    t.uninstall('global');

    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(cfg.servers.other).toBeDefined();
    expect(cfg.servers.codegraph).toBeUndefined();
  });

  it('copilot-jetbrains: uninstall when never installed reports not-found, no throw', () => {
    const t = getTarget('copilot-jetbrains')!;
    const result = t.uninstall('global');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].action).toBe('not-found');
  });

  it('copilot-jetbrains: detect() reports installed from the intellij config dir', () => {
    const t = getTarget('copilot-jetbrains')!;
    expect(t.detect('global').installed).toBe(false);
    fs.mkdirSync(path.join(tmpHome, '.config', 'github-copilot', 'intellij'), { recursive: true });
    expect(t.detect('global').installed).toBe(true);
    expect(t.detect('global').alreadyConfigured).toBe(false);
  });

  it('copilot-jetbrains: printConfig matches what install writes and names the IDE settings path', () => {
    const t = getTarget('copilot-jetbrains')!;
    const out = t.printConfig('global');
    expect(out).toContain('Settings → Tools → GitHub Copilot');
    const printed = snippetJson(out);
    const result = t.install('global', { autoAllow: true });
    const onDisk = JSON.parse(fs.readFileSync(result.files[0].path, 'utf-8'));
    expect(printed.servers.codegraph).toEqual(onDisk.servers.codegraph);

    expect(t.printConfig('local')).toMatch(/--location=global/);
  });

  it('copilot-jetbrains: install note tells the user to restart the IDE', () => {
    const t = getTarget('copilot-jetbrains')!;
    const result = t.install('global', { autoAllow: true });
    expect(result.notes?.join(' ')).toMatch(/[Rr]estart your JetBrains IDE/);
  });

  it('copilot family: all three coexist — uninstalling one leaves the others configured', () => {
    const vscode = getTarget('copilot-vscode')!;
    const cli = getTarget('copilot-cli')!;
    const jetbrains = getTarget('copilot-jetbrains')!;
    vscode.install('global', { autoAllow: true });
    cli.install('global', { autoAllow: true });
    jetbrains.install('global', { autoAllow: true });

    cli.uninstall('global');

    expect(cli.detect('global').alreadyConfigured).toBe(false);
    expect(vscode.detect('global').alreadyConfigured).toBe(true);
    expect(jetbrains.detect('global').alreadyConfigured).toBe(true);
  });
});

describe('Installer targets — Claude CLAUDE_CONFIG_DIR override (#1627)', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    // chdir resolves symlinks (macOS /var -> /private/var). Build the
    // expected paths from the same canonical roots without relaxing equality.
    tmpHome = fs.realpathSync(mkTmpDir('home'));
    tmpCwd = fs.realpathSync(mkTmpDir('cwd'));
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

  it.each(['absolute', 'relative'])('global install honors %s CLAUDE_CONFIG_DIR paths', (kind) => {
    const custom = path.join(tmpHome, 'claude profile');
    process.env.CLAUDE_CONFIG_DIR = kind === 'relative' ? path.relative(tmpCwd, custom) : custom;

    const claude = getTarget('claude')!;
    const result = claude.install('global', { autoAllow: true });
    const paths = [
      path.join(custom, '.claude.json'),
      path.join(custom, 'settings.json'),
      path.join(custom, 'CLAUDE.md'),
    ] as const;

    expect(result.files.map((f) => f.path)).toEqual(paths);
    const mcp = JSON.parse(fs.readFileSync(paths[0], 'utf-8'));
    expect(mcp.mcpServers.codegraph.alwaysLoad).toBe(true);
    const settings = JSON.parse(fs.readFileSync(paths[1], 'utf-8'));
    expect(settings.permissions.allow).toContain('mcp__codegraph__*');
    expect(fs.readFileSync(paths[2], 'utf-8')).toContain('codegraph explore');
    expect(claude.describePaths('global')).toEqual(paths);
    expect(claude.printConfig('global')).toContain(`# Add to ${paths[0]}`);

    const before = paths.map((p) => fs.readFileSync(p, 'utf-8'));
    expect(claude.install('global', { autoAllow: true }).files.every((f) => f.action === 'unchanged')).toBe(true);
    expect(paths.map((p) => fs.readFileSync(p, 'utf-8'))).toEqual(before);
    expect(fs.existsSync(path.join(tmpHome, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.claude.json'))).toBe(false);
  });

  it('detect and uninstall follow CLAUDE_CONFIG_DIR without touching the default profile', () => {
    const claude = getTarget('claude')!;
    claude.install('global', { autoAllow: true });
    const defaults = claude.describePaths('global');
    const before = defaults.map((p) => fs.readFileSync(p, 'utf-8'));

    const custom = path.join(tmpHome, 'claude-profile');
    process.env.CLAUDE_CONFIG_DIR = custom;
    const mcpPath = path.join(custom, '.claude.json');
    expect(claude.detect('global')).toEqual({
      installed: false, alreadyConfigured: false, configPath: mcpPath,
    });

    claude.install('global', { autoAllow: true });
    expect(claude.detect('global')).toEqual({
      installed: true, alreadyConfigured: true, configPath: mcpPath,
    });

    const removed = claude.uninstall('global');
    expect(removed.files).toEqual([
      { path: mcpPath, action: 'removed' },
      { path: path.join(custom, 'settings.json'), action: 'removed' },
      { path: path.join(custom, 'CLAUDE.md'), action: 'removed' },
    ]);
    expect(JSON.parse(fs.readFileSync(mcpPath, 'utf-8')).mcpServers).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(custom, 'settings.json'), 'utf-8')).permissions).toBeUndefined();
    expect(fs.existsSync(path.join(custom, 'CLAUDE.md'))).toBe(false);
    expect(claude.detect('global').alreadyConfigured).toBe(false);
    expect(defaults.map((p) => fs.readFileSync(p, 'utf-8'))).toEqual(before);
  });

  it.each([undefined, '', '   '])('falls back to the default profile when CLAUDE_CONFIG_DIR is %j', (override) => {
    if (override !== undefined) process.env.CLAUDE_CONFIG_DIR = override;
    const claude = getTarget('claude')!;
    const result = claude.install('global', { autoAllow: true });

    expect(result.files.map((f) => f.path)).toEqual([
      path.join(tmpHome, '.claude.json'),
      path.join(tmpHome, '.claude', 'settings.json'),
      path.join(tmpHome, '.claude', 'CLAUDE.md'),
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf-8')).mcpServers.codegraph).toBeDefined();
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'CLAUDE.md'))).toBe(true);
    // Claude Code keeps the default MCP JSON beside ~/.claude, not inside it.
    expect(fs.existsSync(path.join(tmpHome, '.claude', '.claude.json'))).toBe(false);
  });

  it('leaves local install, detect, and uninstall unaffected by CLAUDE_CONFIG_DIR', () => {
    const custom = path.join(tmpHome, 'claude-profile');
    process.env.CLAUDE_CONFIG_DIR = custom;
    const claude = getTarget('claude')!;
    const result = claude.install('local', { autoAllow: true });
    const mcpPath = path.join(tmpCwd, '.mcp.json');

    expect(result.files.map((f) => f.path)).toEqual([
      mcpPath,
      path.join(tmpCwd, '.claude', 'settings.json'),
      path.join(tmpCwd, '.claude', 'CLAUDE.md'),
    ]);
    expect(JSON.parse(fs.readFileSync(mcpPath, 'utf-8')).mcpServers.codegraph).toBeDefined();
    expect(claude.detect('local')).toEqual({
      installed: true, alreadyConfigured: true, configPath: mcpPath,
    });
    claude.uninstall('local');
    expect(claude.detect('local').alreadyConfigured).toBe(false);
    expect(fs.existsSync(custom)).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.claude.json'))).toBe(false);
  });
});

describe('Installer targets — Codex CODEX_HOME override (#1627)', () => {
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

  const defaultDir = () => path.join(tmpHome, '.codex');

  it('global install writes to $CODEX_HOME, not ~/.codex', () => {
    const custom = path.join(tmpHome, 'codex-profile');
    process.env.CODEX_HOME = custom;

    const codex = getTarget('codex')!;
    const result = codex.install('global', { autoAllow: false });

    const toml = result.files.find((f) => f.path.endsWith('config.toml'))!;
    expect(path.resolve(toml.path)).toBe(path.resolve(path.join(custom, 'config.toml')));
    expect(fs.readFileSync(path.join(custom, 'config.toml'), 'utf-8')).toContain('[mcp_servers.codegraph]');
    // The global AGENTS.md follows the config dir.
    expect(fs.existsSync(path.join(custom, 'AGENTS.md'))).toBe(true);
    // Nothing of ours may land in the default profile Codex is not reading.
    expect(fs.existsSync(defaultDir())).toBe(false);
  });

  it('detect and uninstall follow $CODEX_HOME too', () => {
    const custom = path.join(tmpHome, 'codex-profile');
    process.env.CODEX_HOME = custom;
    const codex = getTarget('codex')!;

    expect(codex.detect('global').alreadyConfigured).toBe(false);
    codex.install('global', { autoAllow: false });

    const detected = codex.detect('global');
    expect(detected.alreadyConfigured).toBe(true);
    expect(path.resolve(detected.configPath!)).toBe(path.resolve(path.join(custom, 'config.toml')));

    const removed = codex.uninstall('global');
    expect(path.resolve(removed.files.find((f) => f.path.endsWith('config.toml'))!.path))
      .toBe(path.resolve(path.join(custom, 'config.toml')));
    // Our table was the only content, so the file goes with it.
    expect(fs.existsSync(path.join(custom, 'config.toml'))).toBe(false);
  });

  it('falls back to ~/.codex when CODEX_HOME is unset or blank', () => {
    const codex = getTarget('codex')!;
    codex.install('global', { autoAllow: false });
    expect(fs.existsSync(path.join(defaultDir(), 'config.toml'))).toBe(true);

    fs.rmSync(defaultDir(), { recursive: true, force: true });
    process.env.CODEX_HOME = '   '; // set-but-empty must not become the config dir
    codex.install('global', { autoAllow: false });
    expect(fs.existsSync(path.join(defaultDir(), 'config.toml'))).toBe(true);
  });

  it('leaves the local install alone — CODEX_HOME is the user layer only (#1531)', () => {
    const custom = path.join(tmpHome, 'codex-profile');
    process.env.CODEX_HOME = custom;

    const codex = getTarget('codex')!;
    const result = codex.install('local', { autoAllow: false });

    const paths = result.files.map((f) => f.path.replace(/\\/g, '/'));
    expect(paths.some((p) => p.endsWith('/.codex/config.toml'))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), '.codex', 'config.toml'))).toBe(true);
    // The project layer lives beside the project, never under the user profile.
    expect(fs.existsSync(path.join(custom, 'config.toml'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The agents that keep `mcpServers.codegraph` in a JSON file: each one's
// documented paths and entry, and what the shared editor promises all of them.
// ---------------------------------------------------------------------------

interface JsonTargetCase {
  id: string;
  /** Path of the MCP config under the home (global) or the project (local), and the entry written there. */
  global: string[];
  local: string[] | null;
  entry: Record<string, unknown>;
  /** Instructions file under the home; null when the target writes none. */
  globalInstructions: string[] | null;
  /** Instructions file under the project. */
  localInstructions: string[] | null;
}

const STDIO_ENTRY = { command: 'codegraph', args: ['serve', '--mcp'] };

const JSON_TARGETS: JsonTargetCase[] = [
  { id: 'bob', global: ['.bob', 'settings', 'mcp.json'], local: ['.bob', 'mcp.json'], entry: STDIO_ENTRY, globalInstructions: null, localInstructions: null },
  { id: 'droid', global: ['.factory', 'mcp.json'], local: ['.factory', 'mcp.json'], entry: { type: 'stdio', ...STDIO_ENTRY }, globalInstructions: ['.factory', 'AGENTS.md'], localInstructions: ['AGENTS.md'] },
  { id: 'windsurf', global: ['.codeium', 'windsurf', 'mcp_config.json'], local: null, entry: STDIO_ENTRY, globalInstructions: null, localInstructions: null },
  { id: 'qwen', global: ['.qwen', 'settings.json'], local: ['.qwen', 'settings.json'], entry: STDIO_ENTRY, globalInstructions: ['.qwen', 'QWEN.md'], localInstructions: ['QWEN.md'] },
  { id: 'kimi', global: ['.kimi-code', 'mcp.json'], local: ['.kimi-code', 'mcp.json'], entry: STDIO_ENTRY, globalInstructions: ['.kimi-code', 'AGENTS.md'], localInstructions: ['AGENTS.md'] },
  { id: 'qoder', global: ['.qoder', 'settings.json'], local: ['.qoder', 'settings.local.json'], entry: STDIO_ENTRY, globalInstructions: null, localInstructions: null },
  { id: 'pi', global: ['.pi', 'agent', 'mcp.json'], local: ['.pi', 'mcp.json'], entry: { ...STDIO_ENTRY, exposure: 'direct' }, globalInstructions: ['.pi', 'agent', 'AGENTS.md'], localInstructions: ['AGENTS.md'] },
];

/** Runs each test with a throwaway home and working directory. */
function useTmpDirs(label: string): { home: () => string; cwd: () => string } {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir(`${label}-home`);
    tmpCwd = mkTmpDir(`${label}-cwd`);
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

  return { home: () => tmpHome, cwd: () => tmpCwd };
}

describe('Installer targets — agents with a JSON mcpServers file', () => {
  const dirs = useTmpDirs('jsoncfg');

  for (const c of JSON_TARGETS) {
    const locations = (['global', 'local'] as const).filter((l) => c[l] !== null);

    for (const location of locations) {
      const file = () => path.join(location === 'global' ? dirs.home() : dirs.cwd(), ...c[location]!);
      const instructions = location === 'global' ? c.globalInstructions : c.localInstructions;
      const instructionsFile = () => path.join(location === 'global' ? dirs.home() : dirs.cwd(), ...instructions!);

      describe(`${c.id} (${location})`, () => {
        it('writes the documented entry to the documented file, and nothing else for the MCP config', () => {
          const result = getTarget(c.id)!.install(location, { autoAllow: false });

          expect(JSON.parse(fs.readFileSync(file(), 'utf-8'))).toEqual({ mcpServers: { codegraph: c.entry } });
          expect(result.files.find((f) => f.path === file())?.action).toBe('created');
        });

        it(instructions ? 'writes the instructions block where the agent reads it' : 'writes no instructions file', () => {
          const result = getTarget(c.id)!.install(location, { autoAllow: false });

          if (instructions) {
            expect(fs.readFileSync(instructionsFile(), 'utf-8')).toBe(`${CODEGRAPH_INSTRUCTIONS_BLOCK}\n`);
            expect(result.files.map((f) => f.path)).toEqual([file(), instructionsFile()]);
          } else {
            expect(result.files.map((f) => f.path)).toEqual([file()]);
          }
        });

        it('an entry the user changed stays as it is through a re-install and a refresh', () => {
          const pinned = { ...c.entry, command: '/opt/bin/codegraph', args: ['serve', '--mcp', '--path', '/work'], cwd: '/work', disabled: true, alwaysAllow: ['codegraph_explore'], exposure: 'deferred' };
          const content = `${JSON.stringify({ mcpServers: { codegraph: pinned } }, null, 2)}\n`;
          fs.mkdirSync(path.dirname(file()), { recursive: true });
          fs.writeFileSync(file(), content);

          const target = getTarget(c.id)!;
          expect(target.detect(location).alreadyConfigured).toBe(true);
          const again = target.install(location, { autoAllow: false });

          expect(again.files.find((f) => f.path === file())?.action).toBe('unchanged');
          expect(fs.readFileSync(file(), 'utf-8')).toBe(content);
          if (location === 'global') {
            expect(refreshTargets([target], 'global')[0]!.status).not.toBe('failed');
            expect(fs.readFileSync(file(), 'utf-8')).toBe(content);
          }
        });

        it('an entry missing a key gets only that key', () => {
          fs.mkdirSync(path.dirname(file()), { recursive: true });
          fs.writeFileSync(file(), JSON.stringify({ mcpServers: { codegraph: { disabled: true } } }));

          getTarget(c.id)!.install(location, { autoAllow: false });

          expect(JSON.parse(fs.readFileSync(file(), 'utf-8')).mcpServers.codegraph).toEqual({ ...c.entry, disabled: true });
        });

        it('the rest of the file is not reformatted, and uninstall gives its values back', () => {
          const content = '{\n    "theme": "dark",\n    "mcpServers": {\n        "other": { "command": "x" }\n    },\n    "tail": [1, 2]\n}\n';
          fs.mkdirSync(path.dirname(file()), { recursive: true });
          fs.writeFileSync(file(), content);
          const target = getTarget(c.id)!;

          target.install(location, { autoAllow: false });

          const installed = fs.readFileSync(file(), 'utf-8');
          expect(installed).toContain('{\n    "theme": "dark",\n    "mcpServers": {\n');
          expect(installed).toContain('    "tail": [1, 2]\n}\n');
          expect(installed).toContain('\n        "codegraph": {\n            "');
          expect(JSON.parse(installed).mcpServers.other).toEqual({ command: 'x' });
          expect(JSON.parse(installed).mcpServers.codegraph).toEqual(c.entry);

          target.uninstall(location);
          expect(JSON.parse(fs.readFileSync(file(), 'utf-8'))).toEqual(JSON.parse(content));
        });

        it('uninstall deletes a file left with nothing in it, and is then a no-op', () => {
          const target = getTarget(c.id)!;
          target.install(location, { autoAllow: false });

          const result = target.uninstall(location);

          expect(result.files.find((f) => f.path === file())?.action).toBe('removed');
          expect(fs.existsSync(file())).toBe(false);
          if (instructions) expect(fs.existsSync(instructionsFile())).toBe(false);
          expect(target.uninstall(location).files.find((f) => f.path === file())?.action).toBe('not-found');
        });

        it('a config that does not parse is backed up before it is replaced', () => {
          fs.mkdirSync(path.dirname(file()), { recursive: true });
          fs.writeFileSync(file(), '{ half a config');
          const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
          try {
            expect(getTarget(c.id)!.detect(location).alreadyConfigured).toBe(false);
            expect(warn).not.toHaveBeenCalled();
            getTarget(c.id)!.install(location, { autoAllow: false });
            expect(warn).toHaveBeenCalled();
          } finally {
            warn.mockRestore();
          }
          expect(fs.readFileSync(`${file()}.backup`, 'utf-8')).toBe('{ half a config');
          expect(JSON.parse(fs.readFileSync(file(), 'utf-8')).mcpServers.codegraph).toEqual(c.entry);
        });

        it('uninstall leaves a config that does not parse alone', () => {
          fs.mkdirSync(path.dirname(file()), { recursive: true });
          fs.writeFileSync(file(), '{ half a config');

          const result = getTarget(c.id)!.uninstall(location);

          expect(result.files.find((f) => f.path === file())?.action).toBe('not-found');
          expect(fs.readFileSync(file(), 'utf-8')).toBe('{ half a config');
        });

        it('an mcpServers that is not an object stops the install with nothing changed', () => {
          const content = '{ "mcpServers": ["not", "an", "object"] }\n';
          fs.mkdirSync(path.dirname(file()), { recursive: true });
          fs.writeFileSync(file(), content);

          expect(() => getTarget(c.id)!.install(location, { autoAllow: false })).toThrow(/mcpServers.*Nothing was changed/);
          expect(fs.readFileSync(file(), 'utf-8')).toBe(content);
        });

        it('keeps CRLF line endings and a byte order mark', () => {
          const content = '\uFEFF{\r\n  "theme": "dark"\r\n}\r\n';
          fs.mkdirSync(path.dirname(file()), { recursive: true });
          fs.writeFileSync(file(), content);

          getTarget(c.id)!.install(location, { autoAllow: false });

          const text = fs.readFileSync(file(), 'utf-8');
          expect(text.startsWith('\uFEFF')).toBe(true);
          expect(text.replace(/\r\n/g, '')).not.toContain('\n');
          expect(JSON.parse(text.slice(1)).mcpServers.codegraph).toEqual(c.entry);
          expect(fs.existsSync(`${file()}.backup`)).toBe(false);
        });
      });
    }
  }

  it('bob: a global file under the earlier name is the one used, while mcp.json is absent', () => {
    const settings = path.join(dirs.home(), '.bob', 'settings');
    const earlier = path.join(settings, 'mcp_settings.json');
    fs.mkdirSync(settings, { recursive: true });
    fs.writeFileSync(earlier, '{\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n');
    const bob = getTarget('bob')!;

    bob.install('global', { autoAllow: false });

    expect(JSON.parse(fs.readFileSync(earlier, 'utf-8')).mcpServers.codegraph).toEqual(STDIO_ENTRY);
    expect(fs.existsSync(path.join(settings, 'mcp.json'))).toBe(false);
    expect(bob.detect('global').alreadyConfigured).toBe(true);

    bob.uninstall('global');
    expect(JSON.parse(fs.readFileSync(earlier, 'utf-8'))).toEqual({ mcpServers: { other: { command: 'x' } } });
  });

  it('bob: mcp.json wins as soon as it exists', () => {
    const settings = path.join(dirs.home(), '.bob', 'settings');
    fs.mkdirSync(settings, { recursive: true });
    fs.writeFileSync(path.join(settings, 'mcp_settings.json'), '{}\n');
    fs.writeFileSync(path.join(settings, 'mcp.json'), '{}\n');

    getTarget('bob')!.install('global', { autoAllow: false });

    expect(JSON.parse(fs.readFileSync(path.join(settings, 'mcp.json'), 'utf-8')).mcpServers.codegraph).toEqual(STDIO_ENTRY);
    expect(fs.readFileSync(path.join(settings, 'mcp_settings.json'), 'utf-8')).toBe('{}\n');
  });

  it('droid: a local install says the file is meant to be committed; a global one has nothing to say', () => {
    const droid = getTarget('droid')!;
    expect(droid.install('global', { autoAllow: false }).notes).toBeUndefined();
    expect(droid.install('local', { autoAllow: false }).notes?.join(' ')).toMatch(/committed/);
  });

  it('windsurf: global only, with a clear note', () => {
    const windsurf = getTarget('windsurf')!;
    expect(windsurf.supportsLocation('local')).toBe(false);
    expect(windsurf.detect('local')).toEqual({ installed: false, alreadyConfigured: false });
    expect(windsurf.describePaths('local')).toEqual([]);
    const result = windsurf.install('local', { autoAllow: false });
    expect(result.files).toEqual([]);
    expect(result.notes?.join(' ')).toMatch(/no project-local/);
    expect(windsurf.uninstall('local').files).toEqual([]);
    expect(windsurf.printConfig('local')).toMatch(/no project-local/);
  });

  it('kimi, pi, qoder: a local install says the folder has to be trusted first', () => {
    for (const id of ['kimi', 'pi', 'qoder']) {
      expect(getTarget(id)!.install('local', { autoAllow: false }).notes?.join(' '), id).toMatch(/trust/i);
      expect(getTarget(id)!.install('global', { autoAllow: false }).notes?.join(' '), id).not.toMatch(/trust/i);
    }
  });

  it('qoder: a local install stays out of the .mcp.json Claude Code shares', () => {
    const shared = path.join(dirs.cwd(), '.mcp.json');
    getTarget('claude')!.install('local', { autoAllow: false });
    const before = fs.readFileSync(shared, 'utf-8');
    const qoder = getTarget('qoder')!;

    qoder.install('local', { autoAllow: false });
    qoder.uninstall('local');

    expect(fs.readFileSync(shared, 'utf-8')).toBe(before);
  });

  it.each([
    ['qwen', 'QWEN_HOME', ['settings.json', 'QWEN.md']],
    ['kimi', 'KIMI_CODE_HOME', ['mcp.json', 'AGENTS.md']],
    ['qoder', 'QODER_CONFIG_DIR', ['settings.json']],
    ['pi', 'PI_CODING_AGENT_DIR', ['mcp.json', 'AGENTS.md']],
    ['dsh', 'DSH_HOME', ['cordis.patch.yml', 'AGENTS.md']],
    ['grok', 'GROK_HOME', ['config.toml', path.join('rules', 'codegraph.md')]],
  ] as const)('%s: a global install follows %s', (id, name, files) => {
    process.env[name] = path.join(dirs.home(), 'moved');
    try {
      const target = getTarget(id)!;
      const result = target.install('global', { autoAllow: false });

      const expected = files.map((f) => path.join(dirs.home(), 'moved', f));
      expect(result.files.map((f) => f.path)).toEqual(expected);
      for (const file of expected) expect(fs.existsSync(file), file).toBe(true);
      expect(fs.readdirSync(dirs.home())).toEqual(['moved']);
      expect(target.detect('global').alreadyConfigured).toBe(true);
    } finally {
      delete process.env[name];
    }
  });

  it.each([
    ['a blank value is unset', '   ', (home: string) => path.join(home, 'fallback')],
    ['~ is the home', '~', (home: string) => home],
    ['~/ starts in the home', '~/moved/here', (home: string) => path.join(home, 'moved', 'here')],
  ])('configDirFromEnv: %s', (_name, value, expected) => {
    process.env.CODEGRAPH_TEST_HOME_DIR = value;
    try {
      expect(configDirFromEnv('CODEGRAPH_TEST_HOME_DIR', path.join(dirs.home(), 'fallback'))).toBe(expected(dirs.home()));
    } finally {
      delete process.env.CODEGRAPH_TEST_HOME_DIR;
    }
  });

  it('configDirFromEnv: a relative path starts in the working directory', () => {
    process.env.CODEGRAPH_TEST_HOME_DIR = path.join('some', 'dir');
    try {
      expect(configDirFromEnv('CODEGRAPH_TEST_HOME_DIR', 'unused')).toBe(path.join(process.cwd(), 'some', 'dir'));
    } finally {
      delete process.env.CODEGRAPH_TEST_HOME_DIR;
    }
  });
});

describe('Installer targets — settings files that hold comments', () => {
  const dirs = useTmpDirs('jsonc');

  const SETTINGS = [
    '{',
    '  // my setup',
    '  "general": { "language": "zh" }, // keep Chinese replies',
    '  /* providers below */',
    '  "model": { "name": "qwen3-max" },',
    '}',
    '',
  ].join('\n');

  for (const [id, relative] of [['qwen', ['.qwen', 'settings.json']], ['qoder', ['.qoder', 'settings.json']]] as const) {
    it(`${id}: comments survive install, re-install and uninstall, and detect sees through them`, () => {
      const file = path.join(dirs.home(), ...relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, SETTINGS);
      const target = getTarget(id)!;
      expect(target.detect('global').alreadyConfigured).toBe(false);

      target.install('global', { autoAllow: false });

      const installed = fs.readFileSync(file, 'utf-8');
      for (const kept of ['// my setup', '// keep Chinese replies', '/* providers below */', '"qwen3-max"']) {
        expect(installed).toContain(kept);
      }
      expect(parseJsonc(installed).mcpServers.codegraph).toEqual(STDIO_ENTRY);
      expect(target.detect('global').alreadyConfigured).toBe(true);
      expect(fs.existsSync(`${file}.backup`)).toBe(false);

      for (const f of target.install('global', { autoAllow: false }).files) expect(f.action, f.path).toBe('unchanged');
      expect(fs.readFileSync(file, 'utf-8')).toBe(installed);

      target.uninstall('global');
      const after = fs.readFileSync(file, 'utf-8');
      expect(after).toContain('// my setup');
      expect(parseJsonc(after)).toEqual(parseJsonc(SETTINGS));
    });
  }
});

describe('Installer targets — Qwen Code auto-allow', () => {
  const dirs = useTmpDirs('qwen');
  const settings = () => path.join(dirs.home(), '.qwen', 'settings.json');
  const read = () => parseJsonc(fs.readFileSync(settings(), 'utf-8'));
  const seed = (content: string) => {
    fs.mkdirSync(path.dirname(settings()), { recursive: true });
    fs.writeFileSync(settings(), content);
  };

  it('autoAllow adds the rule for the whole server, in the one write of the settings file', () => {
    const result = getTarget('qwen')!.install('global', { autoAllow: true });

    expect(read().permissions).toEqual({ allow: ['mcp__codegraph'] });
    expect(result.files.filter((f) => f.path === settings())).toEqual([{ path: settings(), action: 'created' }]);
  });

  it('without autoAllow no permissions are written', () => {
    getTarget('qwen')!.install('global', { autoAllow: false });
    expect(read().permissions).toBeUndefined();
  });

  it('the rule joins the rules already there, with comments kept, and only once', () => {
    seed('{\n  "permissions": {\n    // team rules\n    "allow": ["Bash(git *)"],\n    "deny": ["Read(.env)"]\n  }\n}\n');
    const qwen = getTarget('qwen')!;

    qwen.install('global', { autoAllow: true });
    const installed = fs.readFileSync(settings(), 'utf-8');
    expect(read().permissions).toEqual({ allow: ['Bash(git *)', 'mcp__codegraph'], deny: ['Read(.env)'] });
    expect(installed).toContain('// team rules');

    for (const f of qwen.install('global', { autoAllow: true }).files) expect(f.action, f.path).toBe('unchanged');
    expect(fs.readFileSync(settings(), 'utf-8')).toBe(installed);
  });

  it('a permissions.allow that is not a list is left alone', () => {
    seed('{ "permissions": { "allow": "Bash" } }\n');
    getTarget('qwen')!.install('global', { autoAllow: true });
    expect(read().permissions).toEqual({ allow: 'Bash' });
  });

  it('a refresh never adds the rule back', () => {
    const qwen = getTarget('qwen')!;
    qwen.install('global', { autoAllow: true });
    const trimmed = read();
    trimmed.permissions.allow = [];
    fs.writeFileSync(settings(), `${JSON.stringify(trimmed, null, 2)}\n`);

    refreshTargets([qwen], 'global');

    expect(read().permissions.allow).toEqual([]);
  });

  it('uninstall takes out only the rule and the server', () => {
    seed(`${JSON.stringify({
      model: { name: 'qwen3-max' },
      mcpServers: { idea: { command: 'java' } },
      permissions: { allow: ['mcp__idea', 'Read'], deny: ['Read(.env)'] },
    }, null, 2)}\n`);
    const qwen = getTarget('qwen')!;

    qwen.install('global', { autoAllow: true });
    qwen.uninstall('global');

    expect(read()).toEqual({
      model: { name: 'qwen3-max' },
      mcpServers: { idea: { command: 'java' } },
      permissions: { allow: ['mcp__idea', 'Read'], deny: ['Read(.env)'] },
    });
  });

  it('uninstall removes a rule left without its server, and the wrappers that held only it', () => {
    seed(`${JSON.stringify({ theme: 'dark', permissions: { allow: ['mcp__codegraph'] } }, null, 2)}\n`);

    const result = getTarget('qwen')!.uninstall('global');

    expect(result.files[0]).toEqual({ path: settings(), action: 'removed' });
    expect(read()).toEqual({ theme: 'dark' });
  });
});

describe('Installer targets — Grok Build', () => {
  const dirs = useTmpDirs('grok');
  const tomlPath = () => path.join(dirs.home(), '.grok', 'config.toml');
  const rulesPath = () => path.join(dirs.home(), '.grok', 'rules', 'codegraph.md');
  const seed = (content: string) => {
    fs.mkdirSync(path.dirname(tomlPath()), { recursive: true });
    fs.writeFileSync(tomlPath(), content);
  };
  const TABLE = '[mcp_servers.codegraph]\ncommand = "codegraph"\nargs = ["serve", "--mcp"]\n';

  it('a global install writes the table and the rules file', () => {
    const grok = getTarget('grok')!;
    const result = grok.install('global', { autoAllow: true });

    expect(fs.readFileSync(tomlPath(), 'utf-8')).toBe(TABLE);
    expect(fs.readFileSync(rulesPath(), 'utf-8')).toBe(`${CODEGRAPH_INSTRUCTIONS_BLOCK}\n`);
    expect(result.files.map((f) => f.path)).toEqual([tomlPath(), rulesPath()]);
    expect(result.notes?.join(' ')).toMatch(/\/mcps/);
    expect(result.notes?.join(' ')).not.toMatch(/trusted/);

    for (const f of grok.install('global', { autoAllow: true }).files) expect(f.action, f.path).toBe('unchanged');
  });

  it('a local install writes under ./.grok, says it needs trust, and leaves the global entry', () => {
    const grok = getTarget('grok')!;
    grok.install('global', { autoAllow: false });

    const result = grok.install('local', { autoAllow: false });

    expect(fs.readFileSync(path.join(dirs.cwd(), '.grok', 'config.toml'), 'utf-8')).toBe(TABLE);
    expect(fs.existsSync(path.join(dirs.cwd(), '.grok', 'rules', 'codegraph.md'))).toBe(true);
    expect(result.notes?.join(' ')).toMatch(/trusted/);

    grok.uninstall('local');
    expect(grok.detect('local').alreadyConfigured).toBe(false);
    expect(grok.detect('global').alreadyConfigured).toBe(true);
  });

  it('siblings survive, and uninstall gives the file back', () => {
    const content = '[models]\ndefault = "grok-4"\n\n[mcp_servers.other]\ncommand = "other"\n';
    seed(content);
    const grok = getTarget('grok')!;

    grok.install('global', { autoAllow: false });
    expect(fs.readFileSync(tomlPath(), 'utf-8')).toBe(`${content}\n${TABLE}`);

    grok.uninstall('global');
    expect(fs.readFileSync(tomlPath(), 'utf-8')).toBe(content);
  });

  it('uninstall deletes a file holding only our table', () => {
    const grok = getTarget('grok')!;
    grok.install('global', { autoAllow: false });

    grok.uninstall('global');

    expect(fs.existsSync(tomlPath())).toBe(false);
    expect(fs.existsSync(rulesPath())).toBe(false);
  });

  it('a table the user changed stays as it is through a re-install and a refresh', () => {
    const content = '[mcp_servers.codegraph]\ncommand = "/opt/bin/codegraph"\nargs = ["serve", "--mcp"]\nenabled = false\nstartup_timeout_sec = 60\n';
    seed(content);
    const grok = getTarget('grok')!;

    expect(grok.install('global', { autoAllow: false }).files[0]).toEqual({ path: tomlPath(), action: 'unchanged' });
    refreshTargets([grok], 'global');

    expect(fs.readFileSync(tomlPath(), 'utf-8')).toBe(content);
  });

  it('a table written with an indent or quoted keys is found, and never defined twice', () => {
    const content = '  [ "mcp_servers" . codegraph ]\n  command = "codegraph"\n  args = ["serve", "--mcp"]\n';
    seed(content);
    const grok = getTarget('grok')!;

    expect(grok.detect('global').alreadyConfigured).toBe(true);
    grok.install('global', { autoAllow: false });

    expect(fs.readFileSync(tomlPath(), 'utf-8')).toBe(content);
  });

  it('dotted keys or an inline table are left as written, with a note', () => {
    for (const content of [
      'mcp_servers.codegraph.command = "codegraph"\n',
      '[mcp_servers]\ncodegraph = { command = "codegraph", args = ["serve", "--mcp"] }\n',
    ]) {
      seed(content);
      const grok = getTarget('grok')!;

      const result = grok.install('global', { autoAllow: false });

      expect(result.files[0]).toEqual({ path: tomlPath(), action: 'unchanged' });
      expect(result.notes?.join(' ')).toMatch(/Left the mcp_servers\.codegraph entry/);
      expect(fs.readFileSync(tomlPath(), 'utf-8')).toBe(content);
    }
  });

  it('an inline mcp_servers stops the install with nothing changed', () => {
    const content = 'mcp_servers = { other = { command = "x" } }\n';
    seed(content);

    expect(() => getTarget('grok')!.install('global', { autoAllow: false })).toThrow(/Nothing was changed/);
    expect(fs.readFileSync(tomlPath(), 'utf-8')).toBe(content);
  });

  it('uninstall reports an entry inside an inline mcp_servers instead of touching it', () => {
    const content = 'mcp_servers = { codegraph = { command = "codegraph" } }\n';
    seed(content);
    const grok = getTarget('grok')!;

    const result = grok.uninstall('global');

    expect(result.files[0]).toEqual({ path: tomlPath(), action: 'not-found' });
    expect(result.notes?.join(' ')).toMatch(/Remove it from there yourself/);
    expect(fs.readFileSync(tomlPath(), 'utf-8')).toBe(content);
  });

  it('the rules file keeps what the user wrote around the block', () => {
    fs.mkdirSync(path.dirname(rulesPath()), { recursive: true });
    fs.writeFileSync(rulesPath(), `# My notes\n\nBe terse.\n\n${LEGACY_BLOCK}\n`);
    const grok = getTarget('grok')!;

    grok.install('global', { autoAllow: false });
    expect(fs.readFileSync(rulesPath(), 'utf-8')).toBe(`# My notes\n\nBe terse.\n\n${CODEGRAPH_INSTRUCTIONS_BLOCK}\n`);

    grok.uninstall('global');
    expect(fs.readFileSync(rulesPath(), 'utf-8')).toBe('# My notes\n\nBe terse.\n');
  });
});

describe('Installer targets — DeepSeek Harness', () => {
  const dirs = useTmpDirs('dsh');
  const dsh = () => getTarget('dsh')!;
  const patchPath = () => path.join(dirs.home(), '.dsh', 'cordis.patch.yml');
  const agentsPath = () => path.join(dirs.home(), '.dsh', 'AGENTS.md');
  const seed = (content: string, file = patchPath()) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const read = (file = patchPath()) => fs.readFileSync(file, 'utf-8');
  const ENTRY = [
    '- insert:',
    '    - id: mcp-codegraph',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: codegraph',
    '        transport: stdio',
    '        command: codegraph',
    '        args:',
    '          - serve',
    '          - --mcp',
    '',
  ].join('\n');
  const USER_ROW = [
    '    - id: mcp-github',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: github',
    '        transport: stdio',
    '        command: npx',
    "        args: ['-y', '@modelcontextprotocol/server-github']",
    '',
  ].join('\n');
  const profilePatch = (name: string) => path.join(dirs.home(), '.dsh', 'profiles', name, 'cordis.patch.yml');

  it('a fresh install writes the patch and the AGENTS.md block; uninstall removes both', () => {
    const result = dsh().install('global', { autoAllow: true });

    expect(read()).toBe(ENTRY);
    expect(read(agentsPath())).toBe(`${CODEGRAPH_INSTRUCTIONS_BLOCK}\n`);
    expect(result.files.map((f) => f.path)).toEqual([patchPath(), agentsPath()]);
    expect(dsh().detect('global').alreadyConfigured).toBe(true);
    for (const f of dsh().install('global', { autoAllow: true }).files) expect(f.action, f.path).toBe('unchanged');

    dsh().uninstall('global');
    expect(fs.existsSync(patchPath())).toBe(false);
    expect(fs.existsSync(agentsPath())).toBe(false);
  });

  it('the documented empty list is replaced, and comes back on uninstall', () => {
    const content = '# my patches\n[]\n# the end\n';
    seed(content);

    dsh().install('global', { autoAllow: false });
    expect(read()).toBe(`# my patches\n${ENTRY}# the end\n`);

    dsh().uninstall('global');
    expect(read()).toBe('# my patches\n# the end\n[]\n');
  });

  it('a comments-only file, which stops dsh from starting, is repaired, and uninstall keeps it valid', () => {
    seed('# nothing here yet\n');

    dsh().install('global', { autoAllow: false });
    expect(read()).toBe(`# nothing here yet\n${ENTRY}`);

    dsh().uninstall('global');
    expect(read()).toBe('# nothing here yet\n[]\n');
  });

  it('an empty file gets the patch, and goes away with it', () => {
    seed('');
    dsh().install('global', { autoAllow: false });
    expect(read()).toBe(ENTRY);
    dsh().uninstall('global');
    expect(fs.existsSync(patchPath())).toBe(false);
  });

  it('the patch goes after the user\'s own, and uninstall gives the file back byte for byte', () => {
    const content = `# overrides\n- id: tool-bash\n  disabled: true\n\n- insert:\n${USER_ROW}`;
    seed(content);

    dsh().install('global', { autoAllow: false });
    expect(read()).toBe(`${content}\n${ENTRY}`);

    dsh().uninstall('global');
    expect(read()).toBe(content);
  });

  it('a row the user wrote stays as it is through a re-install and a refresh: a pinned cwd is not reset', () => {
    const row = [
      '- insert:',
      '    - id: my-codegraph',
      '      name: "@deepseek-ai/dsh-mcp-client"',
      '      config:',
      '        serverName: "codegraph"',
      '        transport: stdio',
      '        command: /opt/bin/codegraph',
      '        args: [serve, --mcp, --path, /work]',
      '        cwd: /work',
      '',
    ].join('\n');
    seed(row);

    expect(dsh().detect('global').alreadyConfigured).toBe(true);
    expect(dsh().install('global', { autoAllow: false }).files[0]).toEqual({ path: patchPath(), action: 'unchanged' });
    refreshTargets([dsh()], 'global');

    expect(read()).toBe(row);
  });

  it('a row merged into the user\'s insert list is found, and uninstall takes out only that row', () => {
    const ours = [
      '    - id: mcp-codegraph',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: codegraph',
      '        transport: stdio',
      '        command: codegraph',
      '        args: [serve, --mcp]',
      '',
    ].join('\n');
    seed(`- insert:\n${USER_ROW}${ours}${USER_ROW.replace(/github/g, 'gitlab')}`);

    dsh().install('global', { autoAllow: false });
    expect(read().match(/serverName: codegraph/g)).toHaveLength(1);

    dsh().uninstall('global');
    expect(read()).toBe(`- insert:\n${USER_ROW}${USER_ROW.replace(/github/g, 'gitlab')}`);
  });

  it('a row written on one line is a row like any other', () => {
    const flow = "    - { id: mcp-codegraph, name: '@deepseek-ai/dsh-mcp-client', config: { serverName: codegraph, transport: stdio, command: codegraph, args: [serve, --mcp] } }\n";
    seed(`- insert:\n${USER_ROW}${flow}`);

    expect(dsh().detect('global').alreadyConfigured).toBe(true);
    dsh().install('global', { autoAllow: false });
    expect(read()).toBe(`- insert:\n${USER_ROW}${flow}`);

    dsh().uninstall('global');
    expect(read()).toBe(`- insert:\n${USER_ROW}`);
  });

  it('a comment that mentions the server is not an entry', () => {
    const content = "# serverName: codegraph\n- id: tool-bash\n  disabled: true\n";
    seed(content);

    expect(dsh().detect('global').alreadyConfigured).toBe(false);
    dsh().install('global', { autoAllow: false });
    expect(read()).toBe(`${content}\n${ENTRY}`);
  });

  it('a file that is not a block list stops the install with nothing changed', () => {
    for (const content of ['[{ id: tool-bash, disabled: true }]\n', 'not: a list\n', '  - id: indented\n    disabled: true\n']) {
      seed(content);
      expect(() => dsh().install('global', { autoAllow: false }), content).toThrow(/Nothing was changed/);
      expect(read()).toBe(content);
    }
  });

  it('an entry in a form it can\'t edit is left alone, and uninstall says so', () => {
    const content = "[{ insert: [{ id: mcp-codegraph, name: '@deepseek-ai/dsh-mcp-client', config: { serverName: codegraph } }] }]\n";
    seed(content);

    expect(dsh().detect('global').alreadyConfigured).toBe(true);
    expect(dsh().install('global', { autoAllow: false }).files[0]).toEqual({ path: patchPath(), action: 'unchanged' });

    const result = dsh().uninstall('global');
    expect(result.files[0]).toEqual({ path: patchPath(), action: 'not-found' });
    expect(result.notes?.join(' ')).toMatch(/Remove it from there yourself/);
    expect(read()).toBe(content);
  });

  it('a row nested in a group is not mistaken for the group, and the group stays', () => {
    const content = [
      '- insert:',
      '    - id: my-group',
      '      name: group',
      '      config:',
      '        - id: mcp-codegraph',
      "          name: '@deepseek-ai/dsh-mcp-client'",
      '          config: { serverName: codegraph }',
      '',
    ].join('\n');
    seed(content);

    const result = dsh().uninstall('global');

    expect(result.notes?.join(' ')).toMatch(/Remove it from there yourself/);
    expect(read()).toBe(content);
  });

  it('an insert item with keys of its own stays when its only row is ours', () => {
    const content = `${ENTRY}  note: mine\n`;
    seed(content);

    const result = dsh().uninstall('global');

    expect(result.notes?.join(' ')).toMatch(/Remove it from there yourself/);
    expect(read()).toBe(content);
  });

  it('a profile\'s own entry counts: nothing is added beside it, and uninstall removes it, keeping the file', () => {
    const profile = profilePatch('web');
    seed(`# my profile\n${ENTRY}`, profile);

    expect(dsh().detect('global').alreadyConfigured).toBe(true);
    const result = dsh().install('global', { autoAllow: false });
    expect(result.files[0]).toEqual({ path: patchPath(), action: 'unchanged' });
    expect(result.notes?.join(' ')).toMatch(/Left the CodeGraph entry in .*web/);
    expect(fs.existsSync(patchPath())).toBe(false);

    const removed = dsh().uninstall('global');
    expect(removed.files.map((f) => f.path)).toContain(profile);
    expect(read(profile)).toBe('# my profile\n[]\n');
    expect(dsh().detect('global').alreadyConfigured).toBe(false);
  });

  it('a profile that was only emptied by uninstall keeps a valid file', () => {
    const profile = profilePatch('web');
    seed(ENTRY, profile);

    dsh().uninstall('global');

    expect(read(profile)).toBe('[]\n');
  });

  it('CRLF is kept', () => {
    const content = '# mine\r\n- id: tool-bash\r\n  disabled: true\r\n';
    seed(content);

    dsh().install('global', { autoAllow: false });
    expect(read()).toBe(`${content}\r\n${ENTRY.replace(/\n/g, '\r\n')}`);

    dsh().uninstall('global');
    expect(read()).toBe(content);
  });

  it('global only', () => {
    expect(dsh().supportsLocation('local')).toBe(false);
    expect(dsh().install('local', { autoAllow: false }).files).toEqual([]);
    expect(dsh().uninstall('local').files).toEqual([]);
    expect(dsh().describePaths('local')).toEqual([]);
  });

  it('printConfig prints the patch to paste', () => {
    expect(dsh().printConfig('global')).toBe(`# Add to ${patchPath()}\n\n${ENTRY}`);
  });
});

describe('Antigravity macOS command persistence (#1443)', () => {
  let tmpHome: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = fs.realpathSync(mkTmpDir('antigravity-command'));
    homeRestore = setHome(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    homeRestore.restore();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function makeCommand(): string {
    const bin = path.join(tmpHome, 'node-versions', 'v22', 'installation', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const shim = path.join(tmpHome, 'npm-shim.js');
    fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.symlinkSync(shim, path.join(bin, 'codegraph'));
    return bin;
  }

  function installCommand(): string {
    getTarget('antigravity')!.install('global', { autoAllow: true });
    const file = path.join(tmpHome, '.gemini', 'antigravity', 'mcp_config.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8')).mcpServers.codegraph.command;
  }

  it.runIf(process.platform === 'darwin')('keeps the saved command usable after the fnm shell symlink is removed', () => {
    const bin = makeCommand();
    const shell = path.join(tmpHome, 'fnm_multishells', 'shell');
    fs.mkdirSync(path.dirname(shell), { recursive: true });
    fs.symlinkSync(path.dirname(bin), shell);
    vi.stubEnv('PATH', path.join(shell, 'bin'));

    const command = installCommand();
    fs.unlinkSync(shell);
    expect(fs.existsSync(command)).toBe(true);
    expect(command).toBe(path.join(bin, 'codegraph'));
    expect(path.basename(command)).toBe('codegraph');
    vi.stubEnv('PATH', bin);
    expect(getTarget('antigravity')!.install('global', { autoAllow: true }).files[0].action).toBe('unchanged');
    expect(getTarget('antigravity')!.printConfig('global')).toContain(JSON.stringify(command));
  });

  it.runIf(process.platform === 'darwin')('preserves a stable command path without resolving the npm shim filename', () => {
    const bin = makeCommand();
    vi.stubEnv('PATH', bin);
    expect(installCommand()).toBe(path.join(bin, 'codegraph'));
  });

  it.runIf(process.platform === 'darwin')('keeps the discovered path if directory canonicalization fails', () => {
    const bin = makeCommand();
    vi.stubEnv('PATH', bin);
    const realpath = fs.realpathSync;
    vi.spyOn(require('fs') as typeof fs, 'realpathSync').mockImplementation((...args) => {
      if (args[0] === bin) throw new Error('directory unavailable');
      return realpath(...args);
    });
    expect(installCommand()).toBe(path.join(bin, 'codegraph'));
  });

  it.runIf(process.platform === 'darwin')('falls back to the bare command when lookup fails', () => {
    vi.stubEnv('PATH', tmpHome);
    expect(installCommand()).toBe('codegraph');
  });
});
