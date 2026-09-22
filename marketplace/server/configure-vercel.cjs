// Run in a deployment copy before `vercel deploy`. Native external rewrites
// keep large packages out of the function request/response body-size limit.
const fs = require('node:fs'), path = require('node:path');
function configuration(origin) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Expected the public HTTPS origin of the persistent registry, without a path or credentials');
  const template = JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'));
  template.rewrites = [
    { source: '/api/:path*', destination: url.origin + '/api/:path*' },
    ...template.rewrites.filter(rule => !rule.source.startsWith('/api/')),
  ];
  return template;
}
module.exports = { configuration };
if (require.main === module) {
  const [origin, destination] = process.argv.slice(2);
  if (!origin || !destination) throw Error('Usage: configure-vercel.cjs <https-registry-origin> <new-vercel.json>');
  fs.writeFileSync(destination, JSON.stringify(configuration(origin), null, 2) + '\n', { flag: 'wx' });
}
