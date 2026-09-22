// Preview and production both use a durable registry service. Never store
// submissions on a Vercel function's ephemeral filesystem.
module.exports = async function handler(req, res) {
  const base = process.env.MARKETPLACE_API_ORIGIN;
  if (!base) return res.status(503).json({ error: 'Marketplace registry is not configured' });
  const route = new URL(req.url, 'https://marketplace.local');
  if (!/^\/api\/(extensions(?:\/[a-z0-9-]+)?|health|publish|download\/[a-z0-9-]+\/[^/]+)$/.test(route.pathname)) return res.status(404).end();
  const response = await fetch(new URL(route.pathname + route.search, base), {
    method: req.method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json' },
    body: req.method === 'POST' ? JSON.stringify(req.body) : undefined,
  });
  res.status(response.status).setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
  const cache = response.headers.get('cache-control'); if (cache) res.setHeader('Cache-Control', cache);
  res.end(Buffer.from(await response.arrayBuffer()));
};
