// Production entry point. A mounted persistent volume is an operator prerequisite.
const path = require('node:path');
const { startMarketplaceServer } = require('../../dist/plugins/marketplace');
const storage = require('../../dist/plugins/marketplace-storage');
async function main() {
  const [command, argument] = process.argv.slice(2);
  const directory = process.env.MARKETPLACE_DATA_DIR;
  if (!directory || !path.isAbsolute(directory)) throw Error('Set MARKETPLACE_DATA_DIR to an absolute dedicated persistent volume directory');
  if (command === 'init') return storage.initializeMarketplaceVolume(directory);
  if (command === 'verify') return storage.openMarketplaceVolume(directory);
  if (command === 'backup' && argument) return storage.backupMarketplaceVolume(directory, argument);
  if (command === 'restore' && argument) return storage.restoreMarketplaceVolume(argument, directory);
  if (command !== 'serve') throw Error('Usage: registry.cjs init|verify|serve|backup <new-directory>|restore <backup-directory>');
  if (process.env.VERCEL) throw Error('SQLite registry requires a persistent disk host; Vercel Functions are not a registry volume');
  const volume = storage.openMarketplaceVolume(directory);
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid PORT');
  const server = await startMarketplaceServer({ database: volume.database, publicDirectory: path.join(__dirname, '../dist'),
    officialArtifact: process.env.MARKETPLACE_OFFICIAL_ARTIFACT, port, host: process.env.HOST || '127.0.0.1' });
  console.log(JSON.stringify({ ready: true, port: server.port, registryId: volume.id, storage: 'sqlite-persistent-volume' }));
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await server.close(); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
}
main().then(result => { if (result) console.log(JSON.stringify(result)); }).catch(error => { console.error(error.message); process.exitCode = 1; });
