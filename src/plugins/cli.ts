import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExtensionManager, downloadPackage } from './manager';
import { startExtensionBridge } from './bridge';
import { packExtension } from './package';
import { recoverExtensions } from './recovery';
import { createExtensionProject, testExtension } from './author';

export function registerExtensionCommands(program: Command): void {
  const extensions = program.command('extensions').description('Install and manage framework extensions');
  extensions.command('create <directory>').description('Create a portable Python event-map extension starter and author tests')
    .requiredOption('--id <id>', 'Unique lowercase extension id')
    .action((directory, options) => {
      createExtensionProject(directory, options.id);
      console.log(`Created ${path.resolve(directory)}. Next: codegraph extensions test ${directory}`);
    });
  extensions.command('test <directory>').description('Check compatibility, graph assertions, determinism and removal in disposable projects; executes your extension')
    .option('--fixtures <file>', 'Author fixture JSON relative to extension directory', 'extension.test.json')
    .action(async (directory, options) => {
      console.log(JSON.stringify(await testExtension(directory, { fixtures: options.fixtures }), null, 2));
    });
  extensions.command('recover').description('Reconcile an interrupted extension lifecycle without executing extension code')
    .option('--path <path>', 'Project directory', '.').action(options => {
      const recovered = recoverExtensions(path.resolve(options.path));
      console.log(recovered ? 'Extension transaction recovered' : 'No interrupted extension transaction');
    });
  extensions.command('list').option('--path <path>', 'Project directory', '.').action(options => {
    console.log(JSON.stringify(new ExtensionManager(options.path).list(), null, 2));
  });
  for (const action of ['install', 'update']) extensions.command(`${action} <package>`)
    .description('Install an exact .cgext file/URL, or resolve an id with --registry; extension code runs with your permissions')
    .option('--path <path>', 'Project directory', '.')
    .option('--registry <url>', 'Resolve the package argument as an extension id from this registry')
    .option('--version <version>', 'Exact registry version (required to opt into a prerelease); never substitutes')
    .option('--replaces <frameworks>', 'Explicitly replace comma-separated built-in resolvers')
    .action(async (source, options) => {
      const manager = new ExtensionManager(options.path, p => console.error(`${p.state}: ${p.message}`));
      if (options.registry) {
        const installed = await manager.installFromRegistry({ registry: options.registry, id: source, version: options.version,
          update: action === 'update', replaces: options.replaces?.split(',') });
        console.log(`Installed ${source} ${installed.version}`); return;
      }
      if (options.version) throw new Error('--version requires --registry; file and URL installs already select an exact artifact');
      const bytes = /^https?:/.test(source) ? await downloadPackage(source) : fs.readFileSync(path.resolve(source));
      await manager.install({ bytes,
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
      const bytes = packExtension(directory);
      fs.writeFileSync(options.out, bytes); console.log(`Packed extension into ${options.out}`);
    });
}
