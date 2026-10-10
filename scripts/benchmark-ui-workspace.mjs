#!/usr/bin/env node
/*
 * 合成规模基准：只测真实 HTTP/Worker/SQLite，不声明浏览器绘制或内存指标。
 * 先执行 npx tsc && npm run copy-assets。
 * node scripts/benchmark-ui-workspace.mjs --scenario balanced
 * node scripts/benchmark-ui-workspace.mjs --scenario skewed --stress
 * --reuse <上次输出目录> 跳过生成，在独立进程测量服务内存。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CodeGraph } = require('../dist/index.js');
const { DatabaseConnection, getDatabasePath } = require('../dist/db/index.js');
const { startUiServer } = require('../dist/ui-server/index.js');
const { createWorkspaceApi } = require('../dist/ui-server/workspace/index.js');

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const scenario = option('--scenario', 'balanced');
if (!['balanced', 'skewed'].includes(scenario)) throw new Error('--scenario 只能为 balanced 或 skewed');
const nodesTotal = Number(option('--nodes', '100000'));
const edgesTotal = Number(option('--edges', args.includes('--stress') ? '2000000' : '1000000'));
if (!Number.isInteger(nodesTotal) || nodesTotal < 1000 || !Number.isInteger(edgesTotal) || edgesTotal < 10000) throw new Error('节点/边规模不合法');
const reuse = option('--reuse', null);
const directory = reuse ?? option('--output', null) ?? fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-workspace-benchmark-'));
fs.mkdirSync(directory, { recursive: true });
const nodeCounts = scenario === 'skewed'
  ? [Math.floor(nodesTotal * .8), ...Array(9).fill(Math.floor(nodesTotal * .2 / 9))]
  : Array(10).fill(Math.floor(nodesTotal / 10));
nodeCounts[9] += nodesTotal - nodeCounts.reduce((a, b) => a + b, 0);
const edgeCounts = nodeCounts.map(count => Math.floor(edgesTotal * count / nodesTotal));
edgeCounts[9] += edgesTotal - edgeCounts.reduce((a, b) => a + b, 0);
const projectSpecs = nodeCounts.map((count, i) => ({ id: `project-${i}`, name: `合成项目 ${i}`, path: path.join(directory, `project-${i}`), nodes: count, edges: edgeCounts[i] }));
const idOf = i => `symbol:${String(i).padStart(7, '0')}`;
const fileOf = i => {
  const file = Math.floor(i / 100);
  const deep = file % 11 === 0 ? 'deep/a/b/c/d/e/f/g/' : '';
  return `src/module-${file % 24}/${deep}${file % 13 === 0 ? 'generated/' : ''}file-${file}.ts`;
};
if (reuse && projectSpecs.some(project => !fs.existsSync(getDatabasePath(project.path)))) throw new Error('--reuse 目录缺少已生成索引');
const generationStart = performance.now();
for (const project of reuse ? [] : projectSpecs) {
  fs.mkdirSync(project.path, { recursive: true });
  CodeGraph.initSync(project.path).close();
  const connection = DatabaseConnection.open(getDatabasePath(project.path));
  const db = connection.getDb();
  const insertNode = db.prepare(`INSERT INTO nodes
    (id,kind,name,qualified_name,file_path,language,start_line,end_line,start_column,end_column,is_exported,updated_at)
    VALUES (?,?,?,?,?,'typescript',?,?,0,1,1,?)`);
  const insertFile = db.prepare(`INSERT INTO files
    (path,content_hash,language,size,modified_at,indexed_at,node_count,generated) VALUES (?,?,'typescript',100,?,?,?,?)`);
  const now = Date.now();
  db.transaction(() => {
    for (let i = 0; i < project.nodes; i++) {
      const name = i % 97 === 0 ? 'sharedName' : `handler${i % 1000}`;
      insertNode.run(idOf(i), i % 100 === 0 ? 'file' : 'function', name, `Module${i % 24}.${name}`, fileOf(i), i % 100 + 1, i % 100 + 2, now);
      if (i % 100 === 0) {
        const file = fileOf(i);
        insertFile.run(file, 'synthetic-benchmark', now, now, Math.min(100, project.nodes - i), file.includes('/generated/') ? 1 : 0);
      }
    }
  })();
  const insertEdge = db.prepare('INSERT INTO edges(source,target,kind,line,col,metadata) VALUES (?,?,?,?,0,?)');
  const metadata = JSON.stringify({ confidence: 1, resolvedBy: 'qualified-name' });
  // 前一万条构造高连接点；循环偏移边保证图含环，line 令重复调用保持独立。
  for (let start = 0; start < project.edges; start += 10000) {
    db.transaction(() => {
      for (let e = start; e < Math.min(start + 10000, project.edges); e++) {
        const source = e % project.nodes;
        const target = e < 10000 ? 0 : (source + 1 + Math.floor(e / project.nodes) * 101) % project.nodes;
        insertEdge.run(idOf(source), idOf(target), e % 7 === 0 ? 'imports' : 'calls', e + 1, metadata);
      }
    })();
  }
  db.exec('ANALYZE');
  db.pragma('wal_checkpoint(TRUNCATE)');
  connection.close();
  process.stderr.write(`已生成 ${project.id}: ${project.nodes} 节点 / ${project.edges} 边\n`);
}
const workspace = { name: `规模基准 ${scenario}`, projects: projectSpecs.map(({ id, name, path: root }) => ({ id, name, path: root })) };
const configFile = path.join(directory, 'workspace.json');
fs.writeFileSync(configFile, JSON.stringify(workspace, null, 2));
const viewerDir = path.join(directory, 'viewer'); fs.mkdirSync(viewerDir, { recursive: true }); fs.writeFileSync(path.join(viewerDir, 'index.html'), '<!doctype html><title>规模基准</title>');
const generationMs = performance.now() - generationStart;
const memoryBefore = process.memoryUsage();
let rssPeak = memoryBefore.rss;
const sampleMemory = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 25);
const api = createWorkspaceApi({ workspace });
const server = await startUiServer({ projectRoot: projectSpecs[0].path, viewerDir, port: 0, api: api.handler });
const measured = async (endpoint, init) => {
  const start = performance.now();
  const response = await fetch(server.url + endpoint, init);
  const body = await response.json();
  return { ms: performance.now() - start, status: response.status, body };
};
const compact = result => ({ ms: result.ms, status: result.status });
let report;
try {
  const cold = await measured('/api/workspace');
  const warm = await measured('/api/workspace');
  const searches = [];
  for (let i = 0; i < 15; i++) {
    const q = ['sharedName', 'handler', 'handler123', 'kind:function handler9', 'notPresentAnywhere'][i % 5];
    const result = await measured(`/api/workspace/search?q=${encodeURIComponent(q)}&limit=60`);
    searches.push({ q, ...compact(result), count: result.body.results?.length, incomplete: result.body.incomplete?.length, limited: result.body.limited });
  }
  const searchTimes = searches.map(row => row.ms).sort((a, b) => a - b);
  const mapCold = await measured('/api/projects/project-0/map?bounded=1');
  const mapWarm = await measured('/api/projects/project-0/map?bounded=1');
  const cancellations = [];
  const started = performance.now();
  await Promise.all(Array.from({ length: 6 }, async (_, i) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    const start = performance.now();
    try { const result = await measured(`/api/projects/project-${i}/map?bounded=1&depth=3`, { signal: controller.signal }); cancellations.push({ ...compact(result), cancelled: false }); }
    catch (error) { cancellations.push({ ms: performance.now() - start, cancelled: error.name === 'AbortError', error: error.message }); }
    finally { clearTimeout(timer); }
  }));
  const recovery = await measured('/api/workspace/search?q=sharedName&project=project-0');
  const memoryAfter = process.memoryUsage();
  rssPeak = Math.max(rssPeak, memoryAfter.rss);
  report = {
    scenario, nodes: nodesTotal, edges: edgesTotal, projects: projectSpecs.map(({ path: _, ...rest }) => rest),
    configFile, directory, generationMs, reusedFixture: Boolean(reuse),
    environment: { date: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() },
    overview: { cold: { ...compact(cold), available: cold.body.projects?.filter(project => project.available).length }, warm: { ...compact(warm), available: warm.body.projects?.filter(project => project.available).length } },
    search: { p95Ms: searchTimes[Math.ceil(searchTimes.length * .95) - 1], samples: searches },
    map: { cold: { ...compact(mapCold), nodes: mapCold.body.modules?.length, edges: mapCold.body.links?.length, budget: mapCold.body.budget }, warm: { ...compact(mapWarm), nodes: mapWarm.body.modules?.length, edges: mapWarm.body.links?.length, budget: mapWarm.body.budget }, coldError: mapCold.body.error, warmError: mapWarm.body.error, secondRequestIsRetry: mapCold.status !== 200 },
    cancellation: { totalMs: performance.now() - started, samples: cancellations, recovery: { ...compact(recovery), incomplete: recovery.body.incomplete?.length } },
    memory: { before: memoryBefore, after: memoryAfter, rssPeakBytes: rssPeak, note: `RSS 包含当前 Node 进程与 Worker；heapUsed 仅主线程。${reuse ? '复用已有数据，本次进程没有生成数据的内存残留。' : '生成数据的内存残留包含在基线。'}未测浏览器。` },
    limitations: ['冷请求指新启动 Worker；操作系统文件缓存未清空。', '本基准只测真实服务端 HTTP，不代表浏览器 FPS、绘制或堆占用。'],
  };
} finally {
  clearInterval(sampleMemory); api.close(); await server.close();
}
fs.writeFileSync(path.join(directory, 'metrics.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
