/**
 * User defined installer targets: the family factories a spec is built on,
 * the paths a spec can name, and the servers path `json-config.ts` takes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseJsonc } from 'jsonc-parser';
import { createMcpJsonFamilyTarget, nestUnder } from '../src/installer/targets/mcp-json-family';
import { createTomlFamilyTarget } from '../src/installer/targets/toml-family';
import { createOpencodeFamilyTarget } from '../src/installer/targets/opencode-family';
import { hasCodegraphServer, removeCodegraphServer, upsertCodegraphServer } from '../src/installer/targets/json-config';
import { expandHomeDir, isRootedDir, resolveSpecDir } from '../src/installer/targets/spec-paths';
import { CODEGRAPH_INSTRUCTIONS_BLOCK } from '../src/installer/instructions-template';

const STDIO = { command: 'codegraph', args: ['serve', '--mcp'] };
const TYPED = { type: 'stdio', ...STDIO };
const OPENCODE_ENTRY = { type: 'local', command: ['codegraph', 'serve', '--mcp'], disabled: false, codemode: false };
const OTHER_PLATFORM = process.platform === 'linux' ? 'darwin' : 'linux';

function mkTmpDir(label: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cg-custom-${label}-`)));
}

const CLEARED = [
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'HERMES_HOME', 'QWEN_HOME', 'DSH_HOME', 'GROK_HOME',
  'KIMI_CODE_HOME', 'QODER_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'CODEGRAPH_TARGETS_FILE',
];

/** Point every home lookup at `dir`, as the installer suite does. */
function setHome(dir: string): { restore: () => void } {
  const prev = Object.fromEntries(
    ['HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME', ...CLEARED].map((name) => [name, process.env[name]]),
  );
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.APPDATA = path.join(dir, '.config');
  process.env.XDG_CONFIG_HOME = path.join(dir, '.config');
  for (const name of CLEARED) delete process.env[name];
  return {
    restore() {
      for (const [name, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    },
  };
}

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
    vi.unstubAllEnvs();
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  return { home: () => tmpHome, cwd: () => tmpCwd };
}

function readJson(file: string): any {
  return parseJsonc(fs.readFileSync(file, 'utf-8'));
}

function seed(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('json-config: a servers map below the top level', () => {
  const dirs = useTmpDirs('jsonpath');
  const file = () => path.join(dirs.home(), 'agent', 'config.json');
  const MCP_SERVERS = ['mcp', 'servers'];

  it('creates mcp.servers in a new file, and removal takes the wrappers back out', () => {
    expect(upsertCodegraphServer(file(), TYPED, undefined, MCP_SERVERS).action).toBe('created');
    expect(readJson(file())).toEqual({ mcp: { servers: { codegraph: TYPED } } });
    expect(hasCodegraphServer(file(), MCP_SERVERS)).toBe(true);
    expect(hasCodegraphServer(file())).toBe(false);

    expect(removeCodegraphServer(file(), undefined, MCP_SERVERS).action).toBe('removed');
    expect(fs.existsSync(file())).toBe(false);
  });

  it('keeps a sibling server and the wrapper\'s other keys, and gives the file back on removal', () => {
    const content = '{\n  "mcp": {\n    "timeout": 5,\n    "servers": {\n      "other": { "command": "x" }\n    }\n  }\n}\n';
    seed(file(), content);

    upsertCodegraphServer(file(), TYPED, undefined, MCP_SERVERS);
    expect(readJson(file()).mcp).toEqual({ timeout: 5, servers: { other: { command: 'x' }, codegraph: TYPED } });

    removeCodegraphServer(file(), undefined, MCP_SERVERS);
    expect(readJson(file())).toEqual(parseJsonc(content));
    expect(fs.readFileSync(file(), 'utf-8')).toContain('    "timeout": 5,\n');
  });

  it('removes an emptied servers map but keeps a wrapper that holds something else', () => {
    seed(file(), '{ "mcp": { "timeout": 5 } }\n');

    upsertCodegraphServer(file(), TYPED, undefined, MCP_SERVERS);
    expect(readJson(file())).toEqual({ mcp: { timeout: 5, servers: { codegraph: TYPED } } });

    removeCodegraphServer(file(), undefined, MCP_SERVERS);
    expect(readJson(file())).toEqual({ mcp: { timeout: 5 } });
  });

  it('a step on the path set to something other than an object stops the install with nothing changed', () => {
    const content = '{ "mcp": "no" }\n';
    seed(file(), content);
    expect(() => upsertCodegraphServer(file(), TYPED, undefined, MCP_SERVERS)).toThrow(/sets mcp to .*Nothing was changed/);
    expect(fs.readFileSync(file(), 'utf-8')).toBe(content);
  });

  it('a top level key other than mcpServers works the same way', () => {
    seed(file(), '{\n  "theme": "dark"\n}\n');
    upsertCodegraphServer(file(), STDIO, undefined, ['context_servers']);
    expect(readJson(file())).toEqual({ theme: 'dark', context_servers: { codegraph: STDIO } });
    removeCodegraphServer(file(), undefined, ['context_servers']);
    expect(readJson(file())).toEqual({ theme: 'dark' });
  });

  it('nestUnder builds the shape printConfig shows', () => {
    expect(nestUnder(['mcp', 'servers'], { codegraph: STDIO })).toEqual({ mcp: { servers: { codegraph: STDIO } } });
    expect(nestUnder(['mcpServers'], { codegraph: STDIO })).toEqual({ mcpServers: { codegraph: STDIO } });
  });
});

describe('mcp-json family', () => {
  const dirs = useTmpDirs('mcpjson');

  const zcode = () => createMcpJsonFamilyTarget({
    id: 'zcode',
    displayName: 'ZCode',
    configDir: '~/.zcode/cli',
    configFileName: 'config.json',
    localConfigDir: '.zcode',
    serversKey: 'mcp.servers',
    instructionsFile: null,
  });

  const zed = () => createMcpJsonFamilyTarget({
    id: 'zed',
    displayName: 'Zed',
    configDir: { darwin: '~/.config/zed', linux: '~/.config/zed', win32: '${APPDATA}/Zed' },
    configFileName: 'settings.json',
    serversKey: 'context_servers',
    omitTypeField: true,
    instructionsFile: null,
  });

  const devin = () => createMcpJsonFamilyTarget({
    id: 'devin',
    displayName: 'Devin',
    configDir: { darwin: '~/.config/devin', linux: '~/.config/devin', win32: '${APPDATA}/devin' },
    configFileName: 'mcp_config.json',
    localConfigDir: '.devin',
    omitTypeField: true,
  });

  it('ZCode: the entry goes under mcp.servers in the documented files, and uninstall reverses it', () => {
    const target = zcode();
    const file = path.join(dirs.home(), '.zcode', 'cli', 'config.json');
    expect(target.detect('global')).toEqual({ installed: false, alreadyConfigured: false, configPath: file });

    const result = target.install('global', { autoAllow: false });
    expect(result.files).toEqual([{ path: file, action: 'created' }]);
    expect(readJson(file)).toEqual({ mcp: { servers: { codegraph: TYPED } } });
    expect(target.detect('global')).toEqual({ installed: true, alreadyConfigured: true, configPath: file });
    expect(target.describePaths('global')).toEqual([file]);
    expect(target.printConfig('global')).toBe(`# Add to ${file}\n\n${JSON.stringify({ mcp: { servers: { codegraph: TYPED } } }, null, 2)}\n`);

    for (const f of target.install('global', { autoAllow: false }).files) expect(f.action).toBe('unchanged');

    target.uninstall('global');
    expect(fs.existsSync(file)).toBe(false);
    expect(target.detect('global').alreadyConfigured).toBe(false);
  });

  it('ZCode: a local install writes the workspace file', () => {
    const file = path.join(dirs.cwd(), '.zcode', 'config.json');
    expect(zcode().install('local', { autoAllow: false }).files).toEqual([{ path: file, action: 'created' }]);
    expect(readJson(file)).toEqual({ mcp: { servers: { codegraph: TYPED } } });
  });

  it('Zed: a context_servers entry with no type key, with the comments in settings.json kept', () => {
    const file = path.join(dirs.home(), '.config', 'zed', 'settings.json');
    const content = '{\n  // my theme\n  "theme": "One Dark"\n}\n';
    seed(file, content);

    zed().install('global', { autoAllow: false });
    const installed = fs.readFileSync(file, 'utf-8');
    expect(installed).toContain('// my theme');
    expect(parseJsonc(installed)).toEqual({ theme: 'One Dark', context_servers: { codegraph: STDIO } });

    zed().uninstall('global');
    expect(fs.readFileSync(file, 'utf-8')).toBe(content);
  });

  it('Zed: global only, and every call says so for a local location', () => {
    const target = zed();
    expect(target.supportsLocation('local')).toBe(false);
    expect(target.detect('local')).toEqual({ installed: false, alreadyConfigured: false });
    const result = target.install('local', { autoAllow: false });
    expect(result.files).toEqual([]);
    expect(result.notes?.join(' ')).toMatch(/no project local config/);
    expect(target.uninstall('local').files).toEqual([]);
    expect(target.printConfig('local')).toMatch(/no project local config/);
    expect(target.describePaths('local')).toEqual([]);
  });

  it('Devin: the config and the AGENTS.md block at both locations, and uninstall removes both', () => {
    const target = devin();
    const globalDir = path.join(dirs.home(), '.config', 'devin');
    const expected = {
      global: [path.join(globalDir, 'mcp_config.json'), path.join(globalDir, 'AGENTS.md')],
      local: [path.join(dirs.cwd(), '.devin', 'mcp_config.json'), path.join(dirs.cwd(), 'AGENTS.md')],
    };
    for (const loc of ['global', 'local'] as const) {
      const result = target.install(loc, { autoAllow: false });
      expect(result.files.map((f) => f.path)).toEqual(expected[loc]);
      expect(readJson(expected[loc][0]!)).toEqual({ mcpServers: { codegraph: STDIO } });
      expect(fs.readFileSync(expected[loc][1]!, 'utf-8')).toBe(`${CODEGRAPH_INSTRUCTIONS_BLOCK}\n`);
      expect(target.describePaths(loc)).toEqual(expected[loc]);

      target.uninstall(loc);
      for (const file of expected[loc]) expect(fs.existsSync(file), file).toBe(false);
    }
  });

  it('instructionsLocal "config" puts a local instructions file under the local config dir', () => {
    const target = createMcpJsonFamilyTarget({
      id: 'myagent',
      displayName: 'My Agent',
      configDir: '~/.myagent',
      localConfigDir: '.myagent',
      instructionsFile: 'rules/codegraph.md',
      instructionsLocal: 'config',
    });
    expect(target.install('local', { autoAllow: false }).files.map((f) => f.path)).toEqual([
      path.join(dirs.cwd(), '.myagent', 'settings.json'),
      path.join(dirs.cwd(), '.myagent', 'rules', 'codegraph.md'),
    ]);
    expect(target.install('global', { autoAllow: false }).files.map((f) => f.path)).toEqual([
      path.join(dirs.home(), '.myagent', 'settings.json'),
      path.join(dirs.home(), '.myagent', 'rules', 'codegraph.md'),
    ]);
  });

  it('a different local file name, as the Qoder CLI uses', () => {
    const target = createMcpJsonFamilyTarget({
      id: 'myagent',
      displayName: 'My Agent',
      configDir: '~/.myagent',
      localConfigDir: '.myagent',
      localConfigFileName: 'settings.local.json',
      instructionsFile: null,
    });
    expect(target.describePaths('global')).toEqual([path.join(dirs.home(), '.myagent', 'settings.json')]);
    expect(target.describePaths('local')).toEqual([path.join(dirs.cwd(), '.myagent', 'settings.local.json')]);
  });

  it('homeEnvVar: a set variable names the global dir, a blank one is unset', () => {
    const target = createMcpJsonFamilyTarget({
      id: 'myagent',
      displayName: 'My Agent',
      configDir: '~/.myagent',
      homeEnvVar: 'CG_TEST_AGENT_HOME',
      instructionsFile: null,
    });
    vi.stubEnv('CG_TEST_AGENT_HOME', path.join(dirs.home(), 'moved'));
    expect(target.install('global', { autoAllow: false }).files.map((f) => f.path)).toEqual([path.join(dirs.home(), 'moved', 'settings.json')]);
    expect(target.detect('global').alreadyConfigured).toBe(true);

    vi.stubEnv('CG_TEST_AGENT_HOME', '   ');
    expect(target.describePaths('global')).toEqual([path.join(dirs.home(), '.myagent', 'settings.json')]);
  });

  it('an entry the user changed stays as it is; a key it lacks is filled in', () => {
    const target = devin();
    const file = path.join(dirs.home(), '.config', 'devin', 'mcp_config.json');
    const pinned = { command: '/opt/bin/codegraph', args: ['serve', '--mcp', '--path', '/work'], cwd: '/work' };
    const content = `${JSON.stringify({ mcpServers: { codegraph: pinned } }, null, 2)}\n`;
    seed(file, content);

    expect(target.install('global', { autoAllow: false }).files[0]!.action).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf-8')).toBe(content);

    seed(file, JSON.stringify({ mcpServers: { codegraph: { disabled: true } } }));
    target.install('global', { autoAllow: false });
    expect(readJson(file).mcpServers.codegraph).toEqual({ ...STDIO, disabled: true });
  });

  it('notes are shown on every install, never on uninstall', () => {
    const target = createMcpJsonFamilyTarget({
      id: 'myagent',
      displayName: 'My Agent',
      configDir: '~/.myagent',
      instructionsFile: null,
      notes: ['Open Settings > MCP and press Refresh.'],
    });
    expect(target.install('global', { autoAllow: false }).notes).toEqual(['Open Settings > MCP and press Refresh.']);
    expect(target.install('global', { autoAllow: false }).notes).toEqual(['Open Settings > MCP and press Refresh.']);
    expect(target.uninstall('global').notes).toBeUndefined();
  });

  it('a config dir map with no entry for this platform degrades to not installed, with a note', () => {
    const target = createMcpJsonFamilyTarget({
      id: 'myagent',
      displayName: 'My Agent',
      configDir: { [OTHER_PLATFORM]: '~/.myagent' },
      instructionsFile: null,
    });
    expect(target.detect('global')).toEqual({ installed: false, alreadyConfigured: false });
    const result = target.install('global', { autoAllow: false });
    expect(result.files).toEqual([]);
    expect(result.notes?.join(' ')).toMatch(/cannot locate its config dir \(no config dir is declared for this platform/);
    expect(target.uninstall('global').files).toEqual([]);
    expect(target.printConfig('global')).toMatch(/cannot locate/);
    expect(target.describePaths('global')).toEqual([]);
    expect(fs.readdirSync(dirs.home())).toEqual([]);
  });

  it('a leading ${ENV} token is the variable\'s value, and an unset one is a note', () => {
    const target = createMcpJsonFamilyTarget({
      id: 'myagent',
      displayName: 'My Agent',
      configDir: '${CG_TEST_ROOT}/agent',
      instructionsFile: null,
    });
    const result = target.install('global', { autoAllow: false });
    expect(result.files).toEqual([]);
    expect(result.notes?.join(' ')).toMatch(/CG_TEST_ROOT environment variable is not set/);

    vi.stubEnv('CG_TEST_ROOT', dirs.home());
    expect(target.install('global', { autoAllow: false }).files.map((f) => f.path)).toEqual([path.join(dirs.home(), 'agent', 'settings.json')]);
  });

  it('without absoluteCommand the command is the bare name on every platform', () => {
    const target = devin();
    target.install('global', { autoAllow: false });
    expect(readJson(path.join(dirs.home(), '.config', 'devin', 'mcp_config.json')).mcpServers.codegraph.command).toBe('codegraph');
  });

  it.runIf(process.platform === 'darwin')('absoluteCommand writes the resolved path of the binary on PATH', () => {
    const bin = path.join(dirs.home(), 'node', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'codegraph'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    vi.stubEnv('PATH', bin);
    const target = createMcpJsonFamilyTarget({
      id: 'desk',
      displayName: 'Desk App',
      configDir: '~/Library/Application Support/Desk',
      configFileName: 'desk_config.json',
      absoluteCommand: true,
      omitTypeField: true,
      instructionsFile: null,
    });

    target.install('global', { autoAllow: false });
    const file = path.join(dirs.home(), 'Library', 'Application Support', 'Desk', 'desk_config.json');
    expect(readJson(file).mcpServers.codegraph).toEqual({ command: path.join(bin, 'codegraph'), args: ['serve', '--mcp'] });
    expect(target.printConfig('global')).toContain(JSON.stringify(path.join(bin, 'codegraph')));
    expect(target.install('global', { autoAllow: false }).files[0]!.action).toBe('unchanged');
  });
});

describe('toml family', () => {
  const dirs = useTmpDirs('toml');
  const TABLE = '[mcp_servers.codegraph]\ncommand = "codegraph"\nargs = ["serve", "--mcp"]\n';

  const agent = () => createTomlFamilyTarget({
    id: 'mytoml',
    displayName: 'My TOML Agent',
    configDir: '~/.mytoml',
    homeEnvVar: 'CG_TEST_TOML_HOME',
    localConfigDir: '.mytoml',
    instructionsFile: 'rules/codegraph.md',
    instructionsLocal: 'config',
  });
  const tomlPath = () => path.join(dirs.home(), '.mytoml', 'config.toml');
  const rulesPath = () => path.join(dirs.home(), '.mytoml', 'rules', 'codegraph.md');

  it('a global install writes the table and the instructions file, and is then unchanged', () => {
    const target = agent();
    const result = target.install('global', { autoAllow: true });
    expect(fs.readFileSync(tomlPath(), 'utf-8')).toBe(TABLE);
    expect(fs.readFileSync(rulesPath(), 'utf-8')).toBe(`${CODEGRAPH_INSTRUCTIONS_BLOCK}\n`);
    expect(result.files.map((f) => f.path)).toEqual([tomlPath(), rulesPath()]);
    expect(result.notes).toBeUndefined();
    expect(target.detect('global')).toEqual({ installed: true, alreadyConfigured: true, configPath: tomlPath() });
    for (const f of target.install('global', { autoAllow: true }).files) expect(f.action).toBe('unchanged');
    expect(target.printConfig('global')).toBe(`# Add to ${tomlPath()}\n\n${TABLE}`);
  });

  it('a local install writes under the local config dir, with the instructions file there too', () => {
    const result = agent().install('local', { autoAllow: false });
    expect(result.files.map((f) => f.path)).toEqual([
      path.join(dirs.cwd(), '.mytoml', 'config.toml'),
      path.join(dirs.cwd(), '.mytoml', 'rules', 'codegraph.md'),
    ]);
    expect(fs.readFileSync(path.join(dirs.cwd(), '.mytoml', 'config.toml'), 'utf-8')).toBe(TABLE);
  });

  it('homeEnvVar moves the global install', () => {
    vi.stubEnv('CG_TEST_TOML_HOME', path.join(dirs.home(), 'moved'));
    const result = agent().install('global', { autoAllow: false });
    expect(result.files.map((f) => f.path)).toEqual([
      path.join(dirs.home(), 'moved', 'config.toml'),
      path.join(dirs.home(), 'moved', 'rules', 'codegraph.md'),
    ]);
  });

  it('siblings survive, and uninstall gives the file back', () => {
    const content = '[models]\ndefault = "big"\n\n[mcp_servers.other]\ncommand = "other"\n';
    seed(tomlPath(), content);
    const target = agent();
    target.install('global', { autoAllow: false });
    expect(fs.readFileSync(tomlPath(), 'utf-8')).toBe(`${content}\n${TABLE}`);
    target.uninstall('global');
    expect(fs.readFileSync(tomlPath(), 'utf-8')).toBe(content);
  });

  it('a table the user changed stays as it is', () => {
    const content = '[mcp_servers.codegraph]\ncommand = "/opt/bin/codegraph"\nargs = ["serve", "--mcp"]\nenabled = false\n';
    seed(tomlPath(), content);
    const target = agent();
    expect(target.detect('global').alreadyConfigured).toBe(true);
    expect(target.install('global', { autoAllow: false }).files[0]).toEqual({ path: tomlPath(), action: 'unchanged' });
    expect(fs.readFileSync(tomlPath(), 'utf-8')).toBe(content);
  });

  it('uninstall deletes a file holding only our table, and the instructions file', () => {
    const target = agent();
    target.install('global', { autoAllow: false });
    target.uninstall('global');
    expect(fs.existsSync(tomlPath())).toBe(false);
    expect(fs.existsSync(rulesPath())).toBe(false);
    expect(target.detect('global').alreadyConfigured).toBe(false);
  });

  it('an inline mcp_servers stops the install with nothing changed', () => {
    const content = 'mcp_servers = { other = { command = "x" } }\n';
    seed(tomlPath(), content);
    expect(() => agent().install('global', { autoAllow: false })).toThrow(/Nothing was changed/);
    expect(fs.readFileSync(tomlPath(), 'utf-8')).toBe(content);
  });

  it('a spec without localConfigDir is global only, and one with instructionsFile null writes no block', () => {
    const target = createTomlFamilyTarget({ id: 'globaltoml', displayName: 'Global TOML', configDir: '~/.globaltoml', instructionsFile: null });
    expect(target.supportsLocation('local')).toBe(false);
    expect(target.install('local', { autoAllow: false }).notes?.join(' ')).toMatch(/no project local config/);
    expect(target.install('global', { autoAllow: false }).files.map((f) => f.path)).toEqual([path.join(dirs.home(), '.globaltoml', 'config.toml')]);
    expect(target.describePaths('global')).toEqual([path.join(dirs.home(), '.globaltoml', 'config.toml')]);
  });
});

describe('opencode family: a fork of opencode', () => {
  const dirs = useTmpDirs('fork');
  const codev = () => createOpencodeFamilyTarget({
    id: 'codev',
    displayName: 'CoDev Code',
    appName: 'codev',
    schemaUrl: 'https://opencode.ai/config.json',
  });
  const globalConfig = () => path.join(dirs.home(), '.config', 'codev', 'codev.jsonc');

  it('writes the OpenCode 2 shape under the fork\'s own name, with the AGENTS.md block', () => {
    const target = codev();
    const result = target.install('global', { autoAllow: false });
    expect(result.files.map((f) => f.path)).toEqual([globalConfig(), path.join(dirs.home(), '.config', 'codev', 'AGENTS.md')]);
    expect(readJson(globalConfig())).toEqual({ $schema: 'https://opencode.ai/config.json', mcp: { servers: { codegraph: OPENCODE_ENTRY } } });
    expect(target.detect('global')).toEqual({ installed: true, alreadyConfigured: true, configPath: globalConfig() });
    for (const f of target.install('global', { autoAllow: false }).files) expect(f.action).toBe('unchanged');
    expect(target.printConfig('global')).toContain('"$schema": "https://opencode.ai/config.json"');

    target.uninstall('global');
    expect(readJson(globalConfig())).toEqual({ $schema: 'https://opencode.ai/config.json' });
    expect(fs.existsSync(path.join(dirs.home(), '.config', 'codev', 'AGENTS.md'))).toBe(false);
  });

  it('a local install writes ./codev.jsonc, or an existing ./codev.json', () => {
    const target = codev();
    expect(target.install('local', { autoAllow: false }).files[0]!.path).toBe(path.join(dirs.cwd(), 'codev.jsonc'));
    fs.unlinkSync(path.join(dirs.cwd(), 'codev.jsonc'));
    fs.writeFileSync(path.join(dirs.cwd(), 'codev.json'), '{}\n');
    expect(target.install('local', { autoAllow: false }).files[0]!.path).toBe(path.join(dirs.cwd(), 'codev.json'));
  });

  it('a fork never touches %APPDATA%: a stale file there is neither swept nor counted as installed', () => {
    const appData = path.join(dirs.home(), 'appdata');
    vi.stubEnv('APPDATA', appData);
    const stale = path.join(appData, 'codev', 'codev.jsonc');
    const content = `${JSON.stringify({ mcp: { servers: { codegraph: OPENCODE_ENTRY } } }, null, 2)}\n`;
    seed(stale, content);
    const target = codev();

    expect(target.detect('global').installed).toBe(false);
    const result = target.install('global', { autoAllow: false });
    expect(result.files.map((f) => f.path)).not.toContain(stale);
    target.uninstall('global');
    expect(fs.readFileSync(stale, 'utf-8')).toBe(content);
  });

  it('without a schema URL nothing is stamped', () => {
    const target = createOpencodeFamilyTarget({ id: 'plain', displayName: 'Plain', appName: 'plain' });
    target.install('global', { autoAllow: false });
    expect(readJson(path.join(dirs.home(), '.config', 'plain', 'plain.jsonc'))).toEqual({ mcp: { servers: { codegraph: OPENCODE_ENTRY } } });
    expect(target.printConfig('global')).not.toContain('$schema');
  });
});

describe('spec paths', () => {
  it('expands ~ alone and ~/ at the start, and nothing else', () => {
    expect(expandHomeDir('~')).toBe(os.homedir());
    expect(expandHomeDir('~/x/y')).toBe(path.join(os.homedir(), 'x', 'y'));
    expect(expandHomeDir('~x/y')).toBe('~x/y');
    expect(expandHomeDir('/abs')).toBe('/abs');
  });

  it('a rooted dir is absolute, in the home, or one leading ${ENV} token', () => {
    expect(isRootedDir('~', 'linux')).toBe(true);
    expect(isRootedDir('~/.agent', 'linux')).toBe(true);
    expect(isRootedDir('/opt/agent', 'linux')).toBe(true);
    expect(isRootedDir('C:\\Users\\me\\agent', 'win32')).toBe(true);
    expect(isRootedDir('${APPDATA}/Agent', 'win32')).toBe(true);
    expect(isRootedDir('${APPDATA}\\Agent', 'win32')).toBe(true);
    expect(isRootedDir('${APPDATA}', 'win32')).toBe(true);
    for (const bad of ['~x/agent', 'agent', './agent', '${APPDATA}Agent', '$APPDATA/Agent', 'C:\\agent']) {
      expect(isRootedDir(bad, 'linux'), bad).toBe(false);
    }
  });

  it('resolves a map by platform and a token by the environment, and says why it cannot', () => {
    const env = { CG_ROOT: '/roots/here' };
    expect(resolveSpecDir({ linux: '/a', darwin: '/b' }, 'linux', env)).toEqual({ dir: '/a' });
    expect(resolveSpecDir({ linux: '/a' }, 'darwin', env)).toEqual({ dir: null, reason: 'no config dir is declared for this platform (darwin)' });
    expect(resolveSpecDir('${CG_ROOT}/agent', 'linux', env)).toEqual({ dir: path.resolve('/roots/here/agent') });
    expect(resolveSpecDir('${CG_ROOT}', 'linux', env)).toEqual({ dir: path.resolve('/roots/here') });
    expect(resolveSpecDir('${CG_MISSING}/agent', 'linux', env)).toEqual({ dir: null, reason: 'the CG_MISSING environment variable is not set' });
    expect(resolveSpecDir('~/agent', 'linux', env)).toEqual({ dir: path.join(os.homedir(), 'agent') });
  });
});

// ---------------------------------------------------------------------------
// Specs: checked on `targets add` and on load, then merged into the registry.
// ---------------------------------------------------------------------------

import {
  addCustomTargetSpec,
  loadCustomTargets,
  removeCustomTargetSpec,
  resetCustomTargetsCache,
  targetsFilePath,
  validateCustomTargetSpec,
  MAX_CUSTOM_TARGETS,
} from '../src/installer/targets/custom';
import {
  ALL_TARGETS,
  detectAll,
  getAllTargets,
  getTarget,
  listTargetIds,
  resolveTargetFlag,
  telemetryTargetId,
} from '../src/installer/targets/registry';
import { refreshTargets, uninstallTargets } from '../src/installer';

const ZCODE_SPEC = {
  id: 'zcode',
  displayName: 'ZCode',
  family: 'mcp-json',
  docsUrl: 'https://zcode.z.ai',
  configDir: '~/.zcode/cli',
  configFileName: 'config.json',
  localConfigDir: '.zcode',
  serversKey: 'mcp.servers',
  instructionsFile: null,
};
const CODEV_SPEC = { id: 'codev', displayName: 'CoDev Code', family: 'opencode', appName: 'codev', schemaUrl: 'https://opencode.ai/config.json' };
const TOML_SPEC = {
  id: 'mytoml',
  displayName: 'My TOML Agent',
  family: 'toml',
  configDir: '~/.mytoml',
  homeEnvVar: 'MYTOML_HOME',
  localConfigDir: '.mytoml',
  instructionsFile: 'rules/codegraph.md',
  instructionsLocal: 'config',
};
const DESKTOP_SPEC = {
  id: 'desk',
  displayName: 'Desk App',
  family: 'mcp-json',
  configDir: { darwin: '~/Library/Application Support/Desk', linux: '~/.config/desk', win32: '${APPDATA}/Desk' },
  configFileName: 'desk_config.json',
  absoluteCommand: true,
  omitTypeField: true,
  instructionsFile: null,
  notes: ['Quit and reopen Desk App to load CodeGraph.'],
};

const errorsOf = (spec: unknown) => validateCustomTargetSpec(spec, ALL_TARGETS);

describe('custom target specs: validation', () => {
  useTmpDirs('validate');

  it('accepts the reference specs', () => {
    for (const spec of [ZCODE_SPEC, CODEV_SPEC, TOML_SPEC, DESKTOP_SPEC]) {
      expect(errorsOf(spec), spec.id).toEqual([]);
    }
  });

  it('rejects an id that is malformed, reserved, or a builtin', () => {
    for (const [id, reason] of [
      ['Bad Id', /must be 1 to 32 lowercase/],
      ['-x', /must be 1 to 32 lowercase/],
      ['a'.repeat(33), /must be 1 to 32 lowercase/],
      ['all', /is reserved/],
      ['custom', /is reserved/],
      ['qwen', /is a builtin target/],
      [undefined, /must be 1 to 32 lowercase/],
    ] as const) {
      expect(errorsOf({ ...ZCODE_SPEC, id }).join('\n'), String(id)).toMatch(reason);
    }
  });

  it('rejects an unknown family, and keys another family reads', () => {
    expect(errorsOf({ ...ZCODE_SPEC, family: 'yaml' }).join('\n')).toMatch(/"family" must be one of opencode, toml, mcp-json/);
    expect(errorsOf({ ...TOML_SPEC, omitTypeField: true }).join('\n')).toMatch(/"omitTypeField" is not a key the toml family reads/);
    expect(errorsOf({ ...CODEV_SPEC, configDir: '~/.codev' }).join('\n')).toMatch(/"configDir" is not a key the opencode family reads/);
    expect(errorsOf({ ...ZCODE_SPEC, extra: 1 }).join('\n')).toMatch(/"extra" is not a key/);
  });

  it('rejects a config dir that is missing, relative, under another user\'s home, or climbing out', () => {
    expect(errorsOf({ ...ZCODE_SPEC, configDir: undefined }).join('\n')).toMatch(/"configDir" is required/);
    for (const dir of ['agent', './agent', '~x/agent', '$HOME/agent', '${APPDATA}Agent']) {
      expect(errorsOf({ ...ZCODE_SPEC, configDir: dir }).join('\n'), dir).toMatch(/"configDir" must be absolute, start with ~\/ or start with one \$\{ENV\} token/);
    }
    expect(errorsOf({ ...ZCODE_SPEC, configDir: '~/agent/../other' }).join('\n')).toMatch(/must not contain "\.\."/);
    expect(errorsOf({ ...ZCODE_SPEC, configDir: ['~/agent'] }).join('\n')).toMatch(/must be a path or a/);
  });

  it('a platform map covers this machine and names only known platforms', () => {
    expect(errorsOf({ ...ZCODE_SPEC, configDir: { [OTHER_PLATFORM]: '~/agent' } }).join('\n')).toMatch(/no entry for this platform/);
    expect(errorsOf({ ...ZCODE_SPEC, configDir: { [process.platform]: '~/agent', freebsd: '/x' } }).join('\n')).toMatch(/unknown platform\(s\) freebsd/);
    expect(errorsOf({ ...ZCODE_SPEC, configDir: { [process.platform]: '~/agent', win32: 'Agent' } }).join('\n')).toMatch(/"configDir\.win32" must be absolute/);
    expect(errorsOf({ ...ZCODE_SPEC, configDir: { [process.platform]: '~/agent', win32: 'C:\\Users\\me\\Agent' } })).toEqual([]);
  });

  it('checks every other value', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...ZCODE_SPEC, homeEnvVar: 'not a name' }, /"homeEnvVar" must be an environment variable name/],
      [{ ...ZCODE_SPEC, docsUrl: 'zcode.z.ai' }, /"docsUrl" must be an http or https URL/],
      [{ ...ZCODE_SPEC, docsUrl: 'file:///etc/passwd' }, /"docsUrl" must be an http or https URL/],
      [{ ...CODEV_SPEC, schemaUrl: 'javascript:alert(1)' }, /"schemaUrl" must be an http or https URL/],
      [{ ...CODEV_SPEC, appName: '../codev' }, /"appName" must be one path segment/],
      [{ ...CODEV_SPEC, appName: undefined }, /"appName" must be one path segment/],
      [{ ...ZCODE_SPEC, displayName: '' }, /"displayName" must be one line/],
      [{ ...ZCODE_SPEC, displayName: 'a\u001b[31mred' }, /"displayName" must be one line/],
      [{ ...ZCODE_SPEC, notes: ['a', 'b', 'c', 'd', 'e', 'f'] }, /"notes" must be up to 5 lines/],
      [{ ...ZCODE_SPEC, notes: ['x'.repeat(201)] }, /"notes" must be up to 5 lines/],
      [{ ...ZCODE_SPEC, notes: ['two\nlines'] }, /"notes" must be up to 5 lines/],
      [{ ...ZCODE_SPEC, notes: 'one' }, /"notes" must be up to 5 lines/],
      [{ ...ZCODE_SPEC, serversKey: '$schema' }, /"serversKey" must be 1 to 3 identifiers/],
      [{ ...ZCODE_SPEC, serversKey: 'a.b.c.d' }, /"serversKey" must be 1 to 3 identifiers/],
      [{ ...ZCODE_SPEC, serversKey: 'mcp..servers' }, /"serversKey" must be 1 to 3 identifiers/],
      [{ ...ZCODE_SPEC, serversKey: '' }, /"serversKey" must be 1 to 3 identifiers/],
      [{ ...ZCODE_SPEC, configFileName: 'config.toml' }, /"configFileName" must be a file name ending in \.json or \.jsonc/],
      [{ ...ZCODE_SPEC, configFileName: 'dir/config.json' }, /"configFileName" must be a file name/],
      [{ ...TOML_SPEC, configFileName: 'config.json' }, /"configFileName" must be a file name ending in \.toml/],
      [{ ...ZCODE_SPEC, localConfigFileName: '..' }, /"localConfigFileName" must be a file name/],
      [{ ...ZCODE_SPEC, localConfigDir: '/abs' }, /"localConfigDir" must be a relative path/],
      [{ ...ZCODE_SPEC, localConfigDir: '../up' }, /"localConfigDir" must be a relative path/],
      [{ ...ZCODE_SPEC, localConfigDir: '' }, /"localConfigDir" must be a relative path/],
      [{ ...ZCODE_SPEC, instructionsFile: '/etc/AGENTS.md' }, /"instructionsFile" must be null or a relative path/],
      [{ ...ZCODE_SPEC, instructionsFile: '../AGENTS.md' }, /"instructionsFile" must be null or a relative path/],
      [{ ...ZCODE_SPEC, instructionsLocal: 'root' }, /"instructionsLocal" must be "project" or "config"/],
      [{ ...ZCODE_SPEC, omitTypeField: 'yes' }, /"omitTypeField" must be true or false/],
      [{ ...ZCODE_SPEC, absoluteCommand: 1 }, /"absoluteCommand" must be true or false/],
    ];
    for (const [spec, reason] of cases) {
      expect(errorsOf(spec).join('\n'), JSON.stringify(spec)).toMatch(reason);
    }
    expect(errorsOf(null)).toEqual(['spec must be a JSON object']);
    expect(errorsOf([ZCODE_SPEC])).toEqual(['spec must be a JSON object']);
  });

  it('refuses a spec that would write a file a builtin target owns', () => {
    const qwenFile = { id: 'myqwen', family: 'mcp-json', configDir: '~/.qwen', instructionsFile: null };
    expect(errorsOf(qwenFile).join('\n')).toMatch(/would write .*settings\.json, which the Qwen Code target owns/);
    const codexToml = { id: 'mycodex', family: 'toml', configDir: '~/.codex', instructionsFile: null };
    expect(errorsOf(codexToml).join('\n')).toMatch(/config\.toml, which the Codex CLI target owns/);
    const localClash = { id: 'myclaude', family: 'mcp-json', configDir: '~/.myclaude', localConfigDir: '.', configFileName: '.mcp.json', instructionsFile: null };
    expect(errorsOf(localClash).join('\n')).toMatch(/\.mcp\.json, which the Claude Code target owns/);
  });
});

describe('custom target specs: loading and the registry', () => {
  const dirs = useTmpDirs('load');
  const file = () => path.join(dirs.home(), '.codegraph', 'targets.json');
  const write = (content: unknown) => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    resetCustomTargetsCache();
  };
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  beforeEach(() => resetCustomTargetsCache());

  it('the file lives under ~/.codegraph, or where CODEGRAPH_TARGETS_FILE points', () => {
    expect(targetsFilePath()).toBe(file());
    vi.stubEnv('CODEGRAPH_TARGETS_FILE', path.join(dirs.home(), 'elsewhere.json'));
    expect(targetsFilePath()).toBe(path.join(dirs.home(), 'elsewhere.json'));
  });

  it('no file: no custom targets, and the registry is the builtin list', () => {
    expect(loadCustomTargets(ALL_TARGETS)).toEqual({ targets: [], specs: [], warnings: [] });
    expect(getAllTargets().map((t) => t.id)).toEqual(ALL_TARGETS.map((t) => t.id));
    expect(getTarget('zcode')).toBeUndefined();
  });

  it('a file that cannot be read is a warning, printed once, never a throw', () => {
    write('{ "targets": [ half');
    const warn = quiet();
    try {
      expect(loadCustomTargets(ALL_TARGETS).warnings).toEqual([expect.stringMatching(/^Ignoring .*targets\.json: not valid JSON/)]);
      expect(getAllTargets().length).toBe(ALL_TARGETS.length);
      loadCustomTargets(ALL_TARGETS);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
    write({ targets: { not: 'a list' } });
    const again = quiet();
    try {
      expect(loadCustomTargets(ALL_TARGETS).warnings).toEqual([expect.stringMatching(/"targets" must be an array/)]);
    } finally {
      again.mockRestore();
    }
  });

  it('a spec that fails a check is skipped with its first problem, and the valid ones are kept', () => {
    write({ targets: [{ ...ZCODE_SPEC, id: 'Bad' }, CODEV_SPEC, 'not an object'] });
    const warn = quiet();
    try {
      const loaded = loadCustomTargets(ALL_TARGETS);
      expect(loaded.specs.map((s) => s.id)).toEqual(['codev']);
      expect(loaded.warnings).toEqual([
        expect.stringMatching(/^Skipping custom target "Bad": "id" must be/),
        expect.stringMatching(/^Skipping custom target "<no id>": spec must be a JSON object/),
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('the first of two specs with one id wins', () => {
    write({ targets: [ZCODE_SPEC, { ...ZCODE_SPEC, displayName: 'Second' }] });
    const warn = quiet();
    try {
      const loaded = loadCustomTargets(ALL_TARGETS);
      expect(loaded.targets.map((t) => t.displayName)).toEqual(['ZCode']);
      expect(loaded.warnings).toEqual([expect.stringMatching(/Skipping a second custom target "zcode"/)]);
    } finally {
      warn.mockRestore();
    }
  });

  it('at most 50 specs are loaded', () => {
    const many = Array.from({ length: MAX_CUSTOM_TARGETS + 1 }, (_, i) => ({ ...ZCODE_SPEC, id: `agent${i}`, configDir: `~/.agent${i}` }));
    write({ targets: many });
    const warn = quiet();
    try {
      const loaded = loadCustomTargets(ALL_TARGETS);
      expect(loaded.specs.length).toBe(MAX_CUSTOM_TARGETS);
      expect(loaded.warnings).toEqual([expect.stringMatching(/at most 50 custom targets are loaded/)]);
    } finally {
      warn.mockRestore();
    }
  });

  it('a changed file is read again without a reset', () => {
    write({ targets: [ZCODE_SPEC] });
    expect(getTarget('zcode')?.displayName).toBe('ZCode');
    fs.writeFileSync(file(), JSON.stringify({ targets: [{ ...ZCODE_SPEC, displayName: 'ZCode 2' }] }));
    const stat = fs.statSync(file());
    fs.utimesSync(file(), stat.atime, new Date(stat.mtimeMs + 2000));
    expect(getTarget('zcode')?.displayName).toBe('ZCode 2');
  });

  it('a loaded target is in every registry lookup, after the builtin ones', () => {
    write({ targets: [ZCODE_SPEC, TOML_SPEC] });
    expect(listTargetIds().slice(-2)).toEqual(['zcode', 'mytoml']);
    expect(resolveTargetFlag('all', 'global').map((t) => t.id)).toEqual([...ALL_TARGETS.map((t) => t.id), 'zcode', 'mytoml']);
    expect(resolveTargetFlag('zcode,codex', 'global').map((t) => t.id)).toEqual(['zcode', 'codex']);
    expect(detectAll('global').map(({ target }) => target.id)).toContain('mytoml');
    expect(() => resolveTargetFlag('nope', 'global')).toThrow(/Unknown --target id\(s\): nope\. Known: .*zcode, mytoml, plus/);
  });

  it('auto picks a custom target whose config dir exists', () => {
    write({ targets: [ZCODE_SPEC] });
    fs.mkdirSync(path.join(dirs.home(), '.zcode', 'cli'), { recursive: true });
    expect(resolveTargetFlag('auto', 'global').map((t) => t.id)).toEqual(['zcode']);
  });

  it('telemetry records the family, never the name', () => {
    write({ targets: [ZCODE_SPEC, CODEV_SPEC, TOML_SPEC] });
    expect(telemetryTargetId('zcode')).toBe('custom-mcp-json');
    expect(telemetryTargetId('codev')).toBe('custom-opencode');
    expect(telemetryTargetId('mytoml')).toBe('custom-toml');
    expect(telemetryTargetId('codex')).toBe('codex');
  });

  it('refresh and uninstall sweeps include a custom target', () => {
    write({ targets: [ZCODE_SPEC] });
    const zcode = getTarget('zcode')!;
    expect(refreshTargets(getAllTargets(), 'global').find((r) => r.id === 'zcode')!.status).toBe('not-configured');

    zcode.install('global', { autoAllow: false });
    expect(refreshTargets(getAllTargets(), 'global').find((r) => r.id === 'zcode')!.status).toBe('unchanged');

    const report = uninstallTargets(getAllTargets(), 'global').find((r) => r.id === 'zcode')!;
    expect(report.status).toBe('removed');
    expect(report.removedPaths).toEqual([path.join(dirs.home(), '.zcode', 'cli', 'config.json')]);
  });
});

describe('custom target specs: add and remove', () => {
  const dirs = useTmpDirs('persist');
  const file = () => path.join(dirs.home(), '.codegraph', 'targets.json');

  beforeEach(() => resetCustomTargetsCache());

  it('add writes the spec, the loader sees it, and add again replaces it', () => {
    expect(addCustomTargetSpec(ZCODE_SPEC, ALL_TARGETS)).toEqual({ replaced: false });
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8'))).toEqual({ targets: [ZCODE_SPEC] });
    expect(getTarget('zcode')?.displayName).toBe('ZCode');

    expect(addCustomTargetSpec({ ...ZCODE_SPEC, displayName: 'ZCode 2' }, ALL_TARGETS)).toEqual({ replaced: true });
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8')).targets).toHaveLength(1);
    expect(getTarget('zcode')?.displayName).toBe('ZCode 2');
  });

  it('add keeps other keys in the file, and comments are read', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{\n  // mine\n  "note": "keep",\n  "targets": [],\n}\n');
    addCustomTargetSpec(CODEV_SPEC, ALL_TARGETS);
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8'))).toEqual({ note: 'keep', targets: [CODEV_SPEC] });
  });

  it('add refuses an invalid spec with every problem listed, and writes nothing', () => {
    expect(() => addCustomTargetSpec({ ...ZCODE_SPEC, id: 'Bad', serversKey: '$x' }, ALL_TARGETS))
      .toThrow(/Invalid custom target spec:\n  - "id" must be[^\n]*\n  - "serversKey" must be/);
    expect(fs.existsSync(file())).toBe(false);
  });

  it('add and remove refuse to touch a file they cannot read', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{ half');
    expect(() => addCustomTargetSpec(ZCODE_SPEC, ALL_TARGETS)).toThrow(/Cannot update .*targets\.json, fix or remove it first/);
    expect(() => removeCustomTargetSpec('zcode')).toThrow(/Cannot update/);
    expect(fs.readFileSync(file(), 'utf-8')).toBe('{ half');
  });

  it('remove takes out only the named id, and says when there was none', () => {
    addCustomTargetSpec(ZCODE_SPEC, ALL_TARGETS);
    addCustomTargetSpec(CODEV_SPEC, ALL_TARGETS);
    expect(removeCustomTargetSpec('zcode')).toEqual({ removed: true });
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8'))).toEqual({ targets: [CODEV_SPEC] });
    expect(getTarget('zcode')).toBeUndefined();
    expect(getTarget('codev')).toBeDefined();
    expect(removeCustomTargetSpec('zcode')).toEqual({ removed: false });
    expect(removeCustomTargetSpec('never')).toEqual({ removed: false });
  });
});

// ---------------------------------------------------------------------------
// Parity: a spec for each JSON and TOML builtin target writes what the
// builtin writes. Where a builtin has a quirk a spec cannot express, the test
// names it.
// ---------------------------------------------------------------------------

import { buildCustomTarget, type CustomTargetSpec } from '../src/installer/targets/custom';

describe('a spec built target writes what the builtin target writes', () => {
  const dirs = useTmpDirs('parity');

  const PARITY: Array<{ spec: CustomTargetSpec; only?: 'global' }> = [
    { spec: { id: 'droid', family: 'mcp-json', configDir: '~/.factory', configFileName: 'mcp.json', localConfigDir: '.factory' } },
    { spec: { id: 'kimi', family: 'mcp-json', configDir: '~/.kimi-code', homeEnvVar: 'KIMI_CODE_HOME', configFileName: 'mcp.json', localConfigDir: '.kimi-code', omitTypeField: true } },
    { spec: { id: 'windsurf', family: 'mcp-json', configDir: '~/.codeium/windsurf', configFileName: 'mcp_config.json', omitTypeField: true, instructionsFile: null }, only: 'global' },
    { spec: { id: 'bob', family: 'mcp-json', configDir: '~/.bob/settings', configFileName: 'mcp.json', localConfigDir: '.bob', omitTypeField: true, instructionsFile: null } },
    { spec: { id: 'qoder', family: 'mcp-json', configDir: '~/.qoder', homeEnvVar: 'QODER_CONFIG_DIR', localConfigDir: '.qoder', localConfigFileName: 'settings.local.json', omitTypeField: true, instructionsFile: null } },
    { spec: { id: 'qwen', family: 'mcp-json', configDir: '~/.qwen', homeEnvVar: 'QWEN_HOME', localConfigDir: '.qwen', instructionsFile: 'QWEN.md', omitTypeField: true } },
    { spec: { id: 'grok', family: 'toml', configDir: '~/.grok', homeEnvVar: 'GROK_HOME', localConfigDir: '.grok', instructionsFile: 'rules/codegraph.md', instructionsLocal: 'config' } },
    { spec: { id: 'codex', family: 'toml', configDir: '~/.codex', homeEnvVar: 'CODEX_HOME', localConfigDir: '.codex' } },
  ];

  function snapshot(paths: string[]): Record<string, string | null> {
    return Object.fromEntries(paths.map((p) => [p, fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null]));
  }

  function wipe(paths: string[]): void {
    for (const p of paths) fs.rmSync(p, { force: true });
  }

  for (const { spec, only } of PARITY) {
    for (const loc of (only ? ['global'] : ['global', 'local']) as Array<'global' | 'local'>) {
      it(`${spec.id} (${loc}): same files, same bytes, same detection, same snippet`, () => {
        const builtin = getTarget(spec.id)!;
        const mine = buildCustomTarget(spec);
        expect(mine.supportsLocation('local')).toBe(builtin.supportsLocation('local'));
        expect(mine.describePaths(loc)).toEqual(builtin.describePaths(loc));
        const paths = builtin.describePaths(loc);

        const theirs = builtin.install(loc, { autoAllow: false });
        const theirFiles = snapshot(paths);
        const theirDetect = builtin.detect(loc);
        const theirUninstall = builtin.uninstall(loc).files;
        wipe(paths);

        const ours = mine.install(loc, { autoAllow: false });
        expect(ours.files).toEqual(theirs.files);
        expect(snapshot(paths)).toEqual(theirFiles);
        expect(mine.detect(loc)).toEqual(theirDetect);
        expect(mine.printConfig(loc)).toBe(builtin.printConfig(loc));
        expect(mine.uninstall(loc).files).toEqual(theirUninstall);
        expect(snapshot(paths)).toEqual(Object.fromEntries(paths.map((p) => [p, null])));
      });
    }
  }

  it('pi: the same files, except that only the builtin adds exposure: direct to the entry', () => {
    const spec: CustomTargetSpec = { id: 'pi', family: 'mcp-json', configDir: '~/.pi/agent', homeEnvVar: 'PI_CODING_AGENT_DIR', configFileName: 'mcp.json', localConfigDir: '.pi', omitTypeField: true };
    const builtin = getTarget('pi')!;
    const mine = buildCustomTarget(spec);
    for (const loc of ['global', 'local'] as const) {
      expect(mine.describePaths(loc)).toEqual(builtin.describePaths(loc));
      const [file] = builtin.describePaths(loc);
      builtin.install(loc, { autoAllow: false });
      const theirs = readJson(file!);
      wipe(builtin.describePaths(loc));
      mine.install(loc, { autoAllow: false });
      expect({ ...readJson(file!), mcpServers: { codegraph: { ...readJson(file!).mcpServers.codegraph, exposure: 'direct' } } }).toEqual(theirs);
      wipe(builtin.describePaths(loc));
    }
  });

  it('qwen: the same files, except that only the builtin writes the auto allow rule', () => {
    const spec: CustomTargetSpec = { id: 'qwen', family: 'mcp-json', configDir: '~/.qwen', homeEnvVar: 'QWEN_HOME', localConfigDir: '.qwen', instructionsFile: 'QWEN.md', omitTypeField: true };
    const builtin = getTarget('qwen')!;
    const file = path.join(dirs.home(), '.qwen', 'settings.json');
    builtin.install('global', { autoAllow: true });
    const theirs = readJson(file);
    wipe(builtin.describePaths('global'));
    buildCustomTarget(spec).install('global', { autoAllow: true });
    expect({ ...readJson(file), permissions: { allow: ['mcp__codegraph'] } }).toEqual(theirs);
  });
});
