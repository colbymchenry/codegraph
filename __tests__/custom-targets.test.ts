/**
 * Custom installer targets (docs/design/custom-installer-targets.md).
 *
 * Covers:
 *   - spec validation (ids, reserved words, builtin collisions,
 *     family-required fields, path shape rules)
 *   - the tolerant loader (malformed file, duplicate ids, skip-with-warning)
 *   - the same install contract the built-ins get, per family, driven
 *     by synthetic specs mirroring the two motivating PRs:
 *     #1272 (codev, opencode family) and #1324 (grok, toml family),
 *     plus an mcp-json spec
 *   - registry merge: `--target <custom-id>`, `all`, unknown-id errors
 *   - `addCustomTargetSpec` / `removeCustomTargetSpec` round-trip
 *
 * Same sandboxing as installer-targets.test.ts: HOME redirected via
 * env vars, CWD via `process.chdir`, and the spec file via
 * `CODEGRAPH_TARGETS_FILE`. No real user config ever touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseJsonc } from 'jsonc-parser';
import {
  addCustomTargetSpec,
  buildCustomTarget,
  loadCustomTargets,
  removeCustomTargetSpec,
  resetCustomTargetsCache,
  targetsFilePath,
  validateCustomTargetSpec,
  CustomTargetSpec,
} from '../src/installer/targets/custom';
import { ALL_TARGETS, getAllTargets, getTarget, resolveTargetFlag } from '../src/installer/targets/registry';

const BUILTIN_IDS = ALL_TARGETS.map((t) => t.id);

function mkTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cg-custom-${label}-`));
}

function setHome(dir: string): { restore: () => void } {
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.APPDATA = path.join(dir, '.config');
  process.env.XDG_CONFIG_HOME = path.join(dir, '.config');
  return {
    restore() {
      if (prev.HOME === undefined) delete process.env.HOME; else process.env.HOME = prev.HOME;
      if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prev.USERPROFILE;
      if (prev.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = prev.APPDATA;
      if (prev.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME;
    },
  };
}

function writeSpecs(file: string, specs: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ targets: specs }, null, 2));
  resetCustomTargetsCache();
}

const CODEV_SPEC: CustomTargetSpec = {
  id: 'codev',
  displayName: 'CoDev Code',
  family: 'opencode',
  appName: 'codev',
  schemaUrl: 'https://opencode.ai/config.json',
};

const GROK_SPEC: CustomTargetSpec = {
  id: 'grok',
  displayName: 'Grok Build',
  family: 'toml',
  configDir: '~/.grok',
  homeEnvVar: 'GROK_HOME',
  localConfigDir: '.grok',
};

const MCP_JSON_SPEC: CustomTargetSpec = {
  id: 'myagent',
  family: 'mcp-json',
  configDir: '~/.myagent',
  localConfigDir: '.myagent',
};

describe('Custom targets', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };
  let specFile: string;
  let prevSpecFile: string | undefined;
  let prevGrokHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkTmpDir('home');
    tmpCwd = mkTmpDir('cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
    specFile = path.join(tmpHome, '.codegraph', 'targets.json');
    prevSpecFile = process.env.CODEGRAPH_TARGETS_FILE;
    process.env.CODEGRAPH_TARGETS_FILE = specFile;
    prevGrokHome = process.env.GROK_HOME;
    delete process.env.GROK_HOME;
    resetCustomTargetsCache();
  });

  afterEach(() => {
    if (prevSpecFile === undefined) delete process.env.CODEGRAPH_TARGETS_FILE;
    else process.env.CODEGRAPH_TARGETS_FILE = prevSpecFile;
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    resetCustomTargetsCache();
  });

  describe('spec validation', () => {
    it('accepts the three reference specs', () => {
      expect(validateCustomTargetSpec(CODEV_SPEC, BUILTIN_IDS)).toEqual([]);
      expect(validateCustomTargetSpec(GROK_SPEC, BUILTIN_IDS)).toEqual([]);
      expect(validateCustomTargetSpec(MCP_JSON_SPEC, BUILTIN_IDS)).toEqual([]);
    });

    it('rejects malformed ids, reserved words, and builtin collisions', () => {
      expect(validateCustomTargetSpec({ ...CODEV_SPEC, id: 'My Agent' }, BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec({ ...CODEV_SPEC, id: '9lives' }, BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec({ ...CODEV_SPEC, id: 'all' }, BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec({ ...CODEV_SPEC, id: 'auto' }, BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec({ ...CODEV_SPEC, id: 'opencode' }, BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec({ ...CODEV_SPEC, id: 'claude' }, BUILTIN_IDS)).not.toEqual([]);
    });

    it('rejects unknown families and missing family-required fields', () => {
      expect(validateCustomTargetSpec({ id: 'x', family: 'yaml' }, BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec({ id: 'x', family: 'opencode' }, BUILTIN_IDS)).not.toEqual([]); // no appName
      expect(validateCustomTargetSpec({ id: 'x', family: 'toml' }, BUILTIN_IDS)).not.toEqual([]); // no configDir
      expect(validateCustomTargetSpec({ id: 'x', family: 'mcp-json' }, BUILTIN_IDS)).not.toEqual([]);
    });

    it('accepts well-formed notes and rejects malformed ones', () => {
      expect(validateCustomTargetSpec({ ...MCP_JSON_SPEC, notes: ['Hit Refresh in the MCP panel.'] }, BUILTIN_IDS)).toEqual([]);
      expect(validateCustomTargetSpec({ ...MCP_JSON_SPEC, notes: 'not an array' }, BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec({ ...MCP_JSON_SPEC, notes: ['  '] }, BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec({ ...MCP_JSON_SPEC, notes: ['multi\nline'] }, BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec({ ...MCP_JSON_SPEC, notes: ['x'.repeat(201)] }, BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec({ ...MCP_JSON_SPEC, notes: ['a', 'b', 'c', 'd', 'e', 'f'] }, BUILTIN_IDS)).not.toEqual([]);
    });

    it('accepts platform-map configDir and env-token paths; rejects malformed ones', () => {
      const withDir = (configDir: unknown) => ({ id: 'x', family: 'mcp-json', configDir });
      // Map covering this platform (plus others) is fine.
      expect(validateCustomTargetSpec(withDir({
        darwin: '~/Library/Application Support/X', win32: '${APPDATA}/X', linux: '~/.config/X',
      }), BUILTIN_IDS)).toEqual([]);
      // Env-token string form is fine.
      expect(validateCustomTargetSpec(withDir('${APPDATA}/X'), BUILTIN_IDS)).toEqual([]);
      // Map missing this platform can never work here.
      const otherPlatform = process.platform === 'win32' ? 'darwin' : 'win32';
      expect(validateCustomTargetSpec(withDir({ [otherPlatform]: '~/x' }), BUILTIN_IDS)).not.toEqual([]);
      // Unknown platform keys, bad values, non-env relative paths.
      expect(validateCustomTargetSpec(withDir({ [process.platform]: '~/x', freebsd: '~/y' }), BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec(withDir({ [process.platform]: 'relative/x' }), BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec(withDir('$APPDATA/X'), BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec(withDir(['~/x']), BUILTIN_IDS)).not.toEqual([]);
    });

    it('restricts absoluteCommand to booleans on the mcp-json family', () => {
      expect(validateCustomTargetSpec({ ...MCP_JSON_SPEC, absoluteCommand: true }, BUILTIN_IDS)).toEqual([]);
      expect(validateCustomTargetSpec({ ...MCP_JSON_SPEC, absoluteCommand: 'yes' }, BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec({ ...GROK_SPEC, absoluteCommand: true }, BUILTIN_IDS)).not.toEqual([]);
    });

    it('restricts omitTypeField to booleans on the mcp-json family', () => {
      expect(validateCustomTargetSpec({ ...MCP_JSON_SPEC, omitTypeField: true }, BUILTIN_IDS)).toEqual([]);
      expect(validateCustomTargetSpec({ ...MCP_JSON_SPEC, omitTypeField: 'yes' }, BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec({ ...GROK_SPEC, omitTypeField: true }, BUILTIN_IDS)).not.toEqual([]);
    });

    it('rejects path shapes that could escape the agent config dir', () => {
      expect(validateCustomTargetSpec({ id: 'x', family: 'opencode', appName: '../evil' }, BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec({ id: 'x', family: 'opencode', appName: 'a/b' }, BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec({ id: 'x', family: 'toml', configDir: 'relative/dir' }, BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec({ id: 'x', family: 'toml', configDir: '~/.x', localConfigDir: '../up' }, BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec({ id: 'x', family: 'toml', configDir: '~/.x', localConfigDir: '/abs' }, BUILTIN_IDS)).not.toEqual([]);
      expect(validateCustomTargetSpec({ id: 'x', family: 'mcp-json', configDir: '~/.x', configFileName: 'a/b.json' }, BUILTIN_IDS)).not.toEqual([]);
    });
  });

  describe('loader', () => {
    it('returns nothing when no spec file exists', () => {
      const { targets, warnings } = loadCustomTargets(BUILTIN_IDS);
      expect(targets).toEqual([]);
      expect(warnings).toEqual([]);
    });

    it('degrades a malformed file to a warning, never a crash', () => {
      fs.mkdirSync(path.dirname(specFile), { recursive: true });
      fs.writeFileSync(specFile, '{ not json');
      resetCustomTargetsCache();
      const { targets, warnings } = loadCustomTargets(BUILTIN_IDS);
      expect(targets).toEqual([]);
      expect(warnings.length).toBe(1);
      // The installer keeps working on the built-ins.
      expect(getAllTargets().map((t) => t.id)).toEqual(BUILTIN_IDS);
    });

    it('skips invalid specs with a warning and keeps valid ones', () => {
      writeSpecs(specFile, [CODEV_SPEC, { id: 'BAD ID', family: 'toml', configDir: '~/.x' }]);
      const { targets, warnings } = loadCustomTargets(BUILTIN_IDS);
      expect(targets.map((t) => t.id)).toEqual(['codev']);
      expect(warnings.length).toBe(1);
    });

    it('first definition wins on duplicate ids', () => {
      writeSpecs(specFile, [CODEV_SPEC, { ...CODEV_SPEC, displayName: 'Impostor' }]);
      const { targets, warnings } = loadCustomTargets(BUILTIN_IDS);
      expect(targets.length).toBe(1);
      expect(targets[0]!.displayName).toBe('CoDev Code');
      expect(warnings.length).toBe(1);
    });
  });

  describe('registry merge', () => {
    beforeEach(() => {
      writeSpecs(specFile, [CODEV_SPEC, GROK_SPEC]);
    });

    it('resolves a custom id via --target and getTarget', () => {
      expect(getTarget('codev')?.displayName).toBe('CoDev Code');
      const resolved = resolveTargetFlag('codev,grok', 'global');
      expect(resolved.map((t) => t.id)).toEqual(['codev', 'grok']);
    });

    it('includes customs in --target=all, after the built-ins', () => {
      const all = resolveTargetFlag('all', 'global');
      expect(all.map((t) => t.id)).toEqual([...BUILTIN_IDS, 'codev', 'grok']);
    });

    it('lists custom ids in the unknown-id error message', () => {
      expect(() => resolveTargetFlag('nonexistent', 'global')).toThrowError(/codev.*grok|grok.*codev/s);
    });
  });

  describe('opencode family (codev, #1272)', () => {
    const target = () => {
      writeSpecs(specFile, [CODEV_SPEC]);
      return getTarget('codev')!;
    };

    it('install writes <XDG>/codev/codev.jsonc with the opencode wrapper shape', () => {
      const t = target();
      const res = t.install('global', { autoAllow: false });
      const cfgPath = path.join(tmpHome, '.config', 'codev', 'codev.jsonc');
      expect(res.files.some((f) => f.path === cfgPath && f.action === 'created')).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      expect(parsed.$schema).toBe('https://opencode.ai/config.json');
      expect(parsed.mcp.codegraph).toEqual({
        type: 'local',
        command: ['codegraph', 'serve', '--mcp'],
        enabled: true,
      });
      expect(fs.existsSync(path.join(tmpHome, '.config', 'codev', 'AGENTS.md'))).toBe(true);
      expect(t.detect('global').alreadyConfigured).toBe(true);
    });

    it('re-run is byte-identical and reports unchanged', () => {
      const t = target();
      t.install('global', { autoAllow: false });
      const cfgPath = path.join(tmpHome, '.config', 'codev', 'codev.jsonc');
      const before = fs.readFileSync(cfgPath, 'utf-8');
      const res = t.install('global', { autoAllow: false });
      expect(res.files.find((f) => f.path === cfgPath)?.action).toBe('unchanged');
      expect(fs.readFileSync(cfgPath, 'utf-8')).toBe(before);
    });

    it('preserves sibling servers and jsonc comments; uninstall reverses install', () => {
      const t = target();
      const dir = path.join(tmpHome, '.config', 'codev');
      const cfgPath = path.join(dir, 'codev.jsonc');
      fs.mkdirSync(dir, { recursive: true });
      const original = [
        '{',
        '  // my hand-written comment',
        '  "mcp": {',
        '    "other-server": { "type": "local", "command": ["other"], "enabled": true }',
        '  }',
        '}',
        '',
      ].join('\n');
      fs.writeFileSync(cfgPath, original);

      t.install('global', { autoAllow: false });
      const afterInstall = fs.readFileSync(cfgPath, 'utf-8');
      expect(afterInstall).toContain('// my hand-written comment');
      expect(afterInstall).toContain('"other-server"');
      expect(parseJsonc(afterInstall).mcp.codegraph).toBeTruthy();

      t.uninstall('global');
      const afterUninstall = fs.readFileSync(cfgPath, 'utf-8');
      expect(afterUninstall).toContain('// my hand-written comment');
      expect(afterUninstall).toContain('"other-server"');
      expect(afterUninstall).not.toContain('codegraph');
      expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).toBe(false);
    });

    it('supports local installs at ./codev.jsonc', () => {
      const t = target();
      t.install('local', { autoAllow: false });
      const cfgPath = path.join(tmpCwd, 'codev.jsonc');
      expect(fs.existsSync(cfgPath)).toBe(true);
      expect(t.detect('local').alreadyConfigured).toBe(true);
      t.uninstall('local');
      expect(t.detect('local').alreadyConfigured).toBe(false);
    });
  });

  describe('toml family (grok, #1324)', () => {
    const target = () => {
      writeSpecs(specFile, [GROK_SPEC]);
      return getTarget('grok')!;
    };

    it('install writes ~/.grok/config.toml with the mcp_servers table', () => {
      const t = target();
      const res = t.install('global', { autoAllow: false });
      const cfgPath = path.join(tmpHome, '.grok', 'config.toml');
      expect(res.files.some((f) => f.path === cfgPath && f.action === 'created')).toBe(true);
      const content = fs.readFileSync(cfgPath, 'utf-8');
      expect(content).toContain('[mcp_servers.codegraph]');
      expect(content).toContain('command = "codegraph"');
      expect(fs.existsSync(path.join(tmpHome, '.grok', 'AGENTS.md'))).toBe(true);
      expect(t.detect('global').alreadyConfigured).toBe(true);
    });

    it('honors the homeEnvVar override (GROK_HOME)', () => {
      const custom = mkTmpDir('grokhome');
      try {
        process.env.GROK_HOME = custom;
        const t = target();
        t.install('global', { autoAllow: false });
        expect(fs.existsSync(path.join(custom, 'config.toml'))).toBe(true);
        expect(fs.existsSync(path.join(tmpHome, '.grok', 'config.toml'))).toBe(false);
        expect(t.detect('global').configPath).toBe(path.join(custom, 'config.toml'));
      } finally {
        delete process.env.GROK_HOME;
        fs.rmSync(custom, { recursive: true, force: true });
      }
    });

    it('preserves sibling TOML tables through install + uninstall', () => {
      const t = target();
      const dir = path.join(tmpHome, '.grok');
      const cfgPath = path.join(dir, 'config.toml');
      fs.mkdirSync(dir, { recursive: true });
      const original = '[cli]\ntheme = "dark"\n\n[mcp_servers.other]\ncommand = "other"\n';
      fs.writeFileSync(cfgPath, original);

      t.install('global', { autoAllow: false });
      let content = fs.readFileSync(cfgPath, 'utf-8');
      expect(content).toContain('[cli]');
      expect(content).toContain('[mcp_servers.other]');
      expect(content).toContain('[mcp_servers.codegraph]');

      t.uninstall('global');
      content = fs.readFileSync(cfgPath, 'utf-8');
      expect(content).toContain('[cli]');
      expect(content).toContain('[mcp_servers.other]');
      expect(content).not.toContain('[mcp_servers.codegraph]');
    });

    it('idempotent re-run reports unchanged', () => {
      const t = target();
      t.install('global', { autoAllow: false });
      const cfgPath = path.join(tmpHome, '.grok', 'config.toml');
      const res = t.install('global', { autoAllow: false });
      expect(res.files.find((f) => f.path === cfgPath)?.action).toBe('unchanged');
    });

    it('supports local installs at ./.grok/config.toml and cleans up on uninstall', () => {
      const t = target();
      expect(t.supportsLocation('local')).toBe(true);
      t.install('local', { autoAllow: false });
      const cfgPath = path.join(tmpCwd, '.grok', 'config.toml');
      expect(fs.readFileSync(cfgPath, 'utf-8')).toContain('[mcp_servers.codegraph]');
      // Local install writes no local AGENTS.md (family follows Codex).
      expect(fs.existsSync(path.join(tmpCwd, 'AGENTS.md'))).toBe(false);
      t.uninstall('local');
      // Only codegraph was in the file → file and now-empty dir removed.
      expect(fs.existsSync(path.join(tmpCwd, '.grok'))).toBe(false);
    });

    it('a spec without localConfigDir is global-only, like the codex built-in', () => {
      writeSpecs(specFile, [{ ...GROK_SPEC, localConfigDir: undefined }]);
      const t = getTarget('grok')!;
      expect(t.supportsLocation('local')).toBe(false);
      expect(t.install('local', { autoAllow: false }).files).toEqual([]);
    });
  });

  describe('mcp-json family', () => {
    const target = (spec: CustomTargetSpec = MCP_JSON_SPEC) => {
      writeSpecs(specFile, [spec]);
      return getTarget(spec.id)!;
    };

    it('install writes mcpServers.codegraph with the standard stdio shape', () => {
      const t = target();
      t.install('global', { autoAllow: false });
      const cfgPath = path.join(tmpHome, '.myagent', 'settings.json');
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      expect(parsed.mcpServers.codegraph).toEqual({
        type: 'stdio',
        command: 'codegraph',
        args: ['serve', '--mcp'],
      });
      expect(fs.existsSync(path.join(tmpHome, '.myagent', 'AGENTS.md'))).toBe(true);
      expect(t.detect('global').alreadyConfigured).toBe(true);
    });

    it('preserves sibling servers and unrelated settings; uninstall reverses', () => {
      const t = target();
      const dir = path.join(tmpHome, '.myagent');
      fs.mkdirSync(dir, { recursive: true });
      const cfgPath = path.join(dir, 'settings.json');
      fs.writeFileSync(cfgPath, JSON.stringify({
        theme: 'dark',
        mcpServers: { other: { command: 'other' } },
      }, null, 2));

      t.install('global', { autoAllow: false });
      let parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      expect(parsed.theme).toBe('dark');
      expect(parsed.mcpServers.other).toEqual({ command: 'other' });

      t.uninstall('global');
      parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      expect(parsed.theme).toBe('dark');
      expect(parsed.mcpServers.other).toEqual({ command: 'other' });
      expect(parsed.mcpServers.codegraph).toBeUndefined();
    });

    it('honors serversKey, configFileName, and instructionsFileName: null', () => {
      const t = target({
        id: 'quiet',
        family: 'mcp-json',
        configDir: '~/.quiet',
        configFileName: 'mcp.json',
        serversKey: 'servers',
        instructionsFileName: null,
      });
      const res = t.install('global', { autoAllow: false });
      const cfgPath = path.join(tmpHome, '.quiet', 'mcp.json');
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      expect(parsed.servers.codegraph).toBeTruthy();
      expect(res.files.length).toBe(1); // no instructions write
      expect(fs.existsSync(path.join(tmpHome, '.quiet', 'AGENTS.md'))).toBe(false);
    });

    it('idempotent re-run reports unchanged; printConfig round-trips', () => {
      const t = target();
      t.install('global', { autoAllow: false });
      const cfgPath = path.join(tmpHome, '.myagent', 'settings.json');
      expect(t.install('global', { autoAllow: false }).files.find((f) => f.path === cfgPath)?.action).toBe('unchanged');
      const printed = t.printConfig('global');
      expect(printed).toContain(cfgPath);
      expect(JSON.parse(printed.split('\n\n')[1]!).mcpServers.codegraph).toBeTruthy();
    });
  });

  describe('add / remove persistence', () => {
    it('addCustomTargetSpec round-trips through the loader', () => {
      const { replaced } = addCustomTargetSpec(CODEV_SPEC, BUILTIN_IDS);
      expect(replaced).toBe(false);
      expect(fs.existsSync(targetsFilePath())).toBe(true);
      expect(getTarget('codev')?.displayName).toBe('CoDev Code');

      const { replaced: second } = addCustomTargetSpec({ ...CODEV_SPEC, displayName: 'CoDev v2' }, BUILTIN_IDS);
      expect(second).toBe(true);
      expect(getTarget('codev')?.displayName).toBe('CoDev v2');
    });

    it('addCustomTargetSpec rejects invalid specs and never writes', () => {
      expect(() => addCustomTargetSpec({ ...CODEV_SPEC, id: 'claude' }, BUILTIN_IDS)).toThrowError(/collides/);
      expect(fs.existsSync(targetsFilePath())).toBe(false);
    });

    it('addCustomTargetSpec refuses to clobber an unparseable file', () => {
      fs.mkdirSync(path.dirname(specFile), { recursive: true });
      fs.writeFileSync(specFile, '{ broken');
      resetCustomTargetsCache();
      expect(() => addCustomTargetSpec(CODEV_SPEC, BUILTIN_IDS)).toThrowError(/fix or remove/);
      expect(fs.readFileSync(specFile, 'utf-8')).toBe('{ broken');
    });

    it('removeCustomTargetSpec removes only the named id', () => {
      addCustomTargetSpec(CODEV_SPEC, BUILTIN_IDS);
      addCustomTargetSpec(GROK_SPEC, BUILTIN_IDS);
      expect(removeCustomTargetSpec('codev').removed).toBe(true);
      expect(getTarget('codev')).toBeUndefined();
      expect(getTarget('grok')).toBeTruthy();
      expect(removeCustomTargetSpec('codev').removed).toBe(false);
    });
  });

  describe('buildCustomTarget', () => {
    it('defaults displayName to the id', () => {
      const t = buildCustomTarget(MCP_JSON_SPEC);
      expect(t.displayName).toBe('myagent');
    });
  });

  describe('platform-map configDir + env tokens (Qoder-style, #1277)', () => {
    it('resolves the current platform entry of a configDir map', () => {
      writeSpecs(specFile, [{
        id: 'qoderish',
        family: 'mcp-json',
        configDir: {
          [process.platform]: '~/qoderish/SharedClientCache',
          [process.platform === 'win32' ? 'darwin' : 'win32']: '/somewhere/else',
        } as any,
        instructionsFileName: null,
      }]);
      const t = getTarget('qoderish')!;
      t.install('global', { autoAllow: false });
      const cfgPath = path.join(tmpHome, 'qoderish', 'SharedClientCache', 'settings.json');
      expect(fs.existsSync(cfgPath)).toBe(true);
      expect(t.detect('global').configPath).toBe(cfgPath);
    });

    it('expands a leading ${ENV} token', () => {
      const envRoot = mkTmpDir('envroot');
      try {
        process.env.CG_TEST_AGENT_DIR = envRoot;
        writeSpecs(specFile, [{
          id: 'envish',
          family: 'mcp-json',
          configDir: '${CG_TEST_AGENT_DIR}/agent',
          instructionsFileName: null,
        }]);
        const t = getTarget('envish')!;
        t.install('global', { autoAllow: false });
        expect(fs.existsSync(path.join(envRoot, 'agent', 'settings.json'))).toBe(true);
      } finally {
        delete process.env.CG_TEST_AGENT_DIR;
        fs.rmSync(envRoot, { recursive: true, force: true });
      }
    });

    it('degrades gracefully when the env token is unset — never throws, never writes', () => {
      delete process.env.CG_TEST_AGENT_DIR;
      writeSpecs(specFile, [{
        id: 'envish',
        family: 'mcp-json',
        configDir: '${CG_TEST_AGENT_DIR}/agent',
        instructionsFileName: null,
      }]);
      const t = getTarget('envish')!;
      expect(t.detect('global')).toEqual({ installed: false, alreadyConfigured: false });
      const res = t.install('global', { autoAllow: false });
      expect(res.files).toEqual([]);
      expect(res.notes?.[0]).toContain('CG_TEST_AGENT_DIR');
      expect(t.uninstall('global').files).toEqual([]);
      expect(t.describePaths('global')).toEqual([]);
      expect(t.printConfig('global')).toContain('CG_TEST_AGENT_DIR');
    });
  });

  describe('absoluteCommand (GUI-app PATH stripping, Antigravity-style)', () => {
    it('writes a resolved codegraph command; bare name without the knob', () => {
      writeSpecs(specFile, [
        { ...MCP_JSON_SPEC, id: 'guiapp', configDir: '~/.guiapp', absoluteCommand: true },
        MCP_JSON_SPEC,
      ]);
      getTarget('guiapp')!.install('global', { autoAllow: false });
      getTarget('myagent')!.install('global', { autoAllow: false });

      const gui = JSON.parse(fs.readFileSync(path.join(tmpHome, '.guiapp', 'settings.json'), 'utf-8'));
      // Resolution is machine-dependent (absolute path when `codegraph`
      // is on the shell PATH on macOS, bare name otherwise) — assert
      // the invariant, not the machine.
      expect(gui.mcpServers.codegraph.command).toMatch(/codegraph(\.(cmd|exe|bat))?$/);
      expect(gui.mcpServers.codegraph.args).toEqual(['serve', '--mcp']);

      const plain = JSON.parse(fs.readFileSync(path.join(tmpHome, '.myagent', 'settings.json'), 'utf-8'));
      expect(plain.mcpServers.codegraph.command).toBe('codegraph');
    });
  });

  describe('omitTypeField (Windsurf-style no-type entry, #952)', () => {
    it('drops the type field when set; keeps type: stdio by default', () => {
      writeSpecs(specFile, [
        { ...MCP_JSON_SPEC, id: 'notype', configDir: '~/.notype', omitTypeField: true },
        MCP_JSON_SPEC,
      ]);
      getTarget('notype')!.install('global', { autoAllow: false });
      getTarget('myagent')!.install('global', { autoAllow: false });

      const lean = JSON.parse(fs.readFileSync(path.join(tmpHome, '.notype', 'settings.json'), 'utf-8'));
      expect(lean.mcpServers.codegraph).toEqual({ command: 'codegraph', args: ['serve', '--mcp'] });
      expect('type' in lean.mcpServers.codegraph).toBe(false);

      const standard = JSON.parse(fs.readFileSync(path.join(tmpHome, '.myagent', 'settings.json'), 'utf-8'));
      expect(standard.mcpServers.codegraph.type).toBe('stdio');
    });

    it('printConfig reflects the leaner shape', () => {
      writeSpecs(specFile, [{ ...MCP_JSON_SPEC, id: 'notype', configDir: '~/.notype', omitTypeField: true }]);
      const printed = getTarget('notype')!.printConfig('global');
      const entry = JSON.parse(printed.split('\n\n')[1]!).mcpServers.codegraph;
      expect(entry.type).toBeUndefined();
      expect(entry.command).toBe('codegraph');
    });
  });

  describe('spec notes (Windsurf-style refresh quirks, #952)', () => {
    const NOTE = "Windsurf doesn't reload mcp_config.json live — open the MCP panel and hit Refresh.";
    const spec: CustomTargetSpec = {
      id: 'windsurfish',
      family: 'mcp-json',
      configDir: '~/.windsurfish',
      notes: [NOTE],
    };
    const target = () => {
      writeSpecs(specFile, [spec]);
      return getTarget('windsurfish')!;
    };

    it('surfaces notes on install, including idempotent re-runs', () => {
      const t = target();
      expect(t.install('global', { autoAllow: false }).notes).toContain(NOTE);
      // The quirk applies whenever the user (re-)ran install, not just
      // the first time — an unchanged re-run still surfaces it.
      expect(t.install('global', { autoAllow: false }).notes).toContain(NOTE);
    });

    it('does not surface notes on uninstall or unsupported locations', () => {
      const t = target();
      t.install('global', { autoAllow: false });
      expect(t.uninstall('global').notes ?? []).not.toContain(NOTE);
      // No localConfigDir → local unsupported → family's own note only.
      const local = t.install('local', { autoAllow: false });
      expect(local.files).toEqual([]);
      expect(local.notes ?? []).not.toContain(NOTE);
    });

    it('leaves targets without notes unwrapped', () => {
      writeSpecs(specFile, [MCP_JSON_SPEC]);
      const t = getTarget('myagent')!;
      expect(t.install('global', { autoAllow: false }).notes).toBeUndefined();
    });
  });
});
