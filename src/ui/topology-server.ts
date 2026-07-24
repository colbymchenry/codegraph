import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';
import {
  EDGE_KINDS,
  GraphStats,
  NODE_KINDS,
  NodeKind,
  SearchOptions,
  SearchResult,
  TopologyNeighborhood,
  TopologySnapshot,
  TopologySnapshotOptions,
} from '../types';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7474;
const DEFAULT_NODE_LIMIT = 800;
const MAX_NODE_LIMIT = 2000;
const MAX_SEARCH_LIMIT = 50;
const MAX_NEIGHBOR_EDGES = 1000;

const STATIC_FILES = new Map<string, { file: string; contentType: string }>([
  ['/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', contentType: 'text/css; charset=utf-8' }],
  ['/favicon.ico', { file: 'favicon.svg', contentType: 'image/svg+xml' }],
  ['/favicon.svg', { file: 'favicon.svg', contentType: 'image/svg+xml' }],
]);

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

/**
 * The topology server intentionally depends on this read-only structural
 * interface instead of the concrete CodeGraph class. It cannot index, sync,
 * watch, or mutate a project.
 */
export interface TopologyGraphReader {
  getTopologySnapshot(options?: TopologySnapshotOptions): TopologySnapshot;
  getStats(): GraphStats;
  searchNodes(query: string, options?: SearchOptions): SearchResult[];
  getTopologyNeighborhood(nodeId: string, limit?: number): TopologyNeighborhood | null;
}

export interface TopologyServerOptions {
  /** Bind address. Defaults to loopback. */
  host?: string;
  /** TCP port. Use 0 to request an ephemeral port in tests. */
  port?: number;
  /** Default and maximum node count returned by `/api/graph`. */
  nodeLimit?: number;
}

export interface TopologyServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

function clampInteger(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function queryInteger(
  raw: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === null || raw.trim() === '') return fallback;
  return clampInteger(Number(raw), fallback, min, max);
}

function parseKinds(raw: string | null): NodeKind[] | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const allowed = new Set<NodeKind>(NODE_KINDS);
  const kinds = [...new Set(raw.split(',').map((part) => part.trim()))];
  if (kinds.some((kind) => !allowed.has(kind as NodeKind))) {
    throw new HttpError(400, 'Unknown node kind');
  }
  return kinds as NodeKind[];
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function writeHeaders(
  response: http.ServerResponse,
  status: number,
  contentType: string,
  contentLength?: number
): void {
  response.statusCode = status;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
  if (contentLength !== undefined) {
    response.setHeader('Content-Length', contentLength);
  }
}

function sendJson(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  status: number,
  value: unknown
): void {
  const body = Buffer.from(JSON.stringify(value));
  writeHeaders(response, status, 'application/json; charset=utf-8', body.length);
  response.end(request.method === 'HEAD' ? undefined : body);
}

function sendText(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  status: number,
  value: string
): void {
  const body = Buffer.from(value);
  writeHeaders(response, status, 'text/plain; charset=utf-8', body.length);
  response.end(request.method === 'HEAD' ? undefined : body);
}

function createRequestHandler(
  graph: TopologyGraphReader,
  nodeLimit: number
): http.RequestListener {
  const assetsDir = path.join(__dirname, 'assets');

  return (request, response) => {
    void (async () => {
      try {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.setHeader('Allow', 'GET, HEAD');
          throw new HttpError(405, 'Method not allowed');
        }

        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

        if (url.pathname === '/api/stats') {
          sendJson(request, response, 200, graph.getStats());
          return;
        }

        if (url.pathname === '/api/contract') {
          sendJson(request, response, 200, {
            nodeKinds: NODE_KINDS,
            edgeKinds: EDGE_KINDS,
            readOnly: true,
          });
          return;
        }

        if (url.pathname === '/api/graph') {
          const limit = queryInteger(url.searchParams.get('limit'), nodeLimit, 1, nodeLimit);
          const kinds = parseKinds(url.searchParams.get('kinds'));
          sendJson(request, response, 200, graph.getTopologySnapshot({ limit, kinds }));
          return;
        }

        if (url.pathname === '/api/search') {
          const query = (url.searchParams.get('q') ?? '').trim();
          if (query.length < 1 || query.length > 200) {
            throw new HttpError(400, 'Search query must contain 1 to 200 characters');
          }
          const limit = queryInteger(
            url.searchParams.get('limit'),
            20,
            1,
            MAX_SEARCH_LIMIT
          );
          const results = graph.searchNodes(query, { limit });
          sendJson(request, response, 200, {
            results: results.map((result) => ({
              node: result.node,
              score: result.score,
              highlights: result.highlights,
            })),
          });
          return;
        }

        if (url.pathname === '/api/node') {
          const id = url.searchParams.get('id') ?? '';
          if (id.length < 1 || id.length > 2048) {
            throw new HttpError(400, 'Node id must contain 1 to 2048 characters');
          }
          const neighborhood = graph.getTopologyNeighborhood(id, MAX_NEIGHBOR_EDGES);
          if (!neighborhood) throw new HttpError(404, 'Node not found');
          sendJson(request, response, 200, neighborhood);
          return;
        }

        const staticAsset = STATIC_FILES.get(url.pathname);
        if (staticAsset) {
          const body = fs.readFileSync(path.join(assetsDir, staticAsset.file));
          writeHeaders(response, 200, staticAsset.contentType, body.length);
          response.end(request.method === 'HEAD' ? undefined : body);
          return;
        }

        sendText(request, response, 404, 'Not found');
      } catch (error) {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof HttpError ? error.message : 'Internal server error';
        sendJson(request, response, status, { error: message });
      }
    })();
  };
}

/**
 * Start the bundled, read-only CodeGraph topology UI service.
 */
export async function startTopologyServer(
  graph: TopologyGraphReader,
  options: TopologyServerOptions = {}
): Promise<TopologyServer> {
  const host = options.host?.trim() || DEFAULT_HOST;
  const port = clampInteger(options.port ?? DEFAULT_PORT, DEFAULT_PORT, 0, 65535);
  const nodeLimit = clampInteger(
    options.nodeLimit ?? DEFAULT_NODE_LIMIT,
    DEFAULT_NODE_LIMIT,
    1,
    MAX_NODE_LIMIT
  );
  const server = http.createServer(createRequestHandler(graph, nodeLimit));

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Topology server did not bind to a TCP address');
  }
  const actualPort = (address as AddressInfo).port;
  const displayHost = host.includes(':') ? `[${host}]` : host;

  return {
    host,
    port: actualPort,
    url: `http://${displayHost}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
