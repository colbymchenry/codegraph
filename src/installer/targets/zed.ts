import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  readJsonFile,
  writeJsonFile,
  getMcpServerConfig,
} from './shared';

function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(xdg, 'zed');
}

function configPath(): string {
  return path.join(globalConfigDir(), 'zed-settings.json');
}

class ZedTarget implements AgentTarget {
  readonly id = 'zed' as const;
  readonly displayName = 'Zed Editor';
  readonly docsUrl = 'https://zed.dev/docs';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const file = configPath();
    const config = readJsonFile(file);
    const installed = fs.existsSync(file);
    const alreadyConfigured = !!config.mcpServers?.codegraph;
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Zed only supports global config. Re-run with --location=global.'],
      };
    }
    const file = configPath();
    const config = readJsonFile(file);

    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers.codegraph = getMcpServerConfig();

    writeJsonFile(file, config);

    return {
      files: [{ path: file, action: 'created' }],
      notes: ['Restart Zed for MCP server changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const file = configPath();
    const config = readJsonFile(file);
    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      writeJsonFile(file, config);
      return { files: [{ path: file, action: 'removed' }] };
    }
    return { files: [{ path: file, action: 'not-found' }] };
  }

  printConfig(_loc: Location): string {
    const snippet = JSON.stringify({ mcpServers: { codegraph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${configPath()}\n\n${snippet}\n`;
  }

  describePaths(_loc: Location): string[] {
    return [configPath()];
  }
}

export const zedTarget = new ZedTarget();