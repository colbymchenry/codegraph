const path = require('node:path');
const { startMarketplaceServer } = require('../../dist/plugins/marketplace');
startMarketplaceServer({
  database: process.env.MARKETPLACE_DATABASE || path.join(__dirname, '../.data/marketplace.db'),
  publicDirectory: path.join(__dirname, '../public'),
  officialArtifact: path.join(__dirname, '../../dist/extensions/drupal.cgext'),
  port: Number(process.env.PORT || 0),
}).then(server => console.log(`CodeGraph marketplace: http://127.0.0.1:${server.port}`));
