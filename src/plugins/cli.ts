import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExtensionManager, downloadPackage } from './manager';
import { startExtensionBridge } from './bridge';
import { parsePackage, type ExtensionPackage } from './package';

export function registerExtensionCommands(program: Command): void {
  const extensions = program.command('extensions').description('Install and manage framework extensions');
  extensions.command('list').option('--path <path>', 'Project directory', '.').action(options => {
    console.log(JSON.stringify(new ExtensionManager(options.path).list(), null, 2));
  });
  for (const action of ['install', 'update']) extensions.command(`${action} <package>`)
    .description('Install a .cgext package or HTTPS release; extension code runs with your permissions')
    .option('--path <path>', 'Project directory', '.')
    .option('--replaces <frameworks>', 'Explicitly replace comma-separated built-in resolvers')
    .action(async (source, options) => {
      const bytes = /^https?:/.test(source) ? await downloadPackage(source) : fs.readFileSync(path.resolve(source));
      await new ExtensionManager(options.path, p => console.error(`${p.state}: ${p.message}`)).install({ bytes,
        source: /^https?:/.test(source) ? source : undefined, replaces: options.replaces?.split(',') });
    });
  for (const action of ['disable', 'enable', 'remove']) extensions.command(`${action} <id>`)
    .option('--path <path>', 'Project directory', '.').action(async (id, options) => {
      const manager = new ExtensionManager(options.path, p => console.error(`${p.state}: ${p.message}`));
      if (action === 'remove') await manager.remove(id); else await manager.setEnabled(id, action === 'enable');
    });
  extensions.command('connect [projects...]').description('Connect selected local projects to a marketplace; keep this process running')
    .requiredOption('--marketplace <url>', 'Marketplace website URL')
    .option('--port <port>', 'Local companion port', '0').action(async (projects: string[], options) => {
      const bridge = await startExtensionBridge(projects.length ? projects : ['.'], options.marketplace, Number(options.port));
      console.log(`Open this connection link in your browser:\n${bridge.connectionUrl}\n\nKeep this process running. Press Ctrl+C to disconnect.`);
      process.once('SIGINT', () => { void bridge.close(); });
      process.once('SIGTERM', () => { void bridge.close(); });
    });
  extensions.command('pack <directory>').description('Bundle an extension directory; validates metadata without executing code')
    .requiredOption('--out <file>', 'Output .cgext file').action((directory, options) => {
      const root = path.resolve(directory);
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const files: Record<string, string> = {};
      function walk(dir: string): void {
        for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
          if (file.name.startsWith('.') || file.name === 'node_modules' || (dir === root && file.name === 'package.json')) continue;
          const absolute = path.join(dir, file.name);
          if (file.isSymbolicLink()) throw new Error('Package symlinks are unsupported');
          if (file.isDirectory()) walk(absolute);
          else files[path.relative(root, absolute).split(path.sep).join('/')] = fs.readFileSync(absolute, 'utf8');
        }
      }
      walk(root);
      const artifact: ExtensionPackage = { format: 'codegraph-extension-1', package: pkg, files };
      const bytes = Buffer.from(JSON.stringify(artifact)); parsePackage(bytes);
      fs.writeFileSync(options.out, bytes); console.log(`Packed ${pkg.name}@${pkg.version} into ${options.out}`);
    });
}
