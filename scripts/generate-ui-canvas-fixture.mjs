#!/usr/bin/env node
/** 生成恰好400个模块/2000条关系的真实索引，供浏览器最大画布验证。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CodeGraph } = require('../dist/index.js');
const { DatabaseConnection, getDatabasePath } = require('../dist/db/index.js');
const directory = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-canvas-budget-'));
const root = path.join(directory, 'canvas-project');
fs.mkdirSync(root, { recursive: true });
CodeGraph.initSync(root).close();
const connection = DatabaseConnection.open(getDatabasePath(root));
const db = connection.getDb();
const now = Date.now();
const fileOf = i => `src/module-${String(i).padStart(3, '0')}/index.ts`;
const nodeOf = i => `function:${fileOf(i)}:run:1`;
const insertNode = db.prepare(`INSERT INTO nodes(id,kind,name,qualified_name,file_path,language,start_line,end_line,start_column,end_column,is_exported,updated_at) VALUES (?,?,?,?,?,'typescript',1,1,0,30,1,?)`);
const insertFile = db.prepare(`INSERT INTO files(path,content_hash,language,size,modified_at,indexed_at,node_count) VALUES (?,?,'typescript',30,?,?,2)`);
const insertEdge = db.prepare('INSERT INTO edges(source,target,kind,line,col,metadata) VALUES (?,?,\'imports\',1,0,?)');
db.transaction(() => {
  for (let i = 0; i < 400; i++) {
    const file = fileOf(i);
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `export function run${i}() { return ${i}; }\n`);
    insertFile.run(file, 'canvas-fixture', now, now);
    insertNode.run(`file:${file}`, 'file', 'index.ts', file, file, now);
    insertNode.run(nodeOf(i), 'function', `run${i}`, `module${i}.run${i}`, file, now);
  }
  for (let i = 0; i < 400; i++) {
    for (let offset = 1; offset <= 5; offset++) insertEdge.run(nodeOf(i), nodeOf((i + offset) % 400), JSON.stringify({ confidence: 1, resolvedBy: 'import' }));
  }
})();
db.pragma('wal_checkpoint(TRUNCATE)');
const counts = { nodes: db.prepare('SELECT count(*) AS count FROM nodes').get().count, edges: db.prepare('SELECT count(*) AS count FROM edges').get().count };
connection.close();
const configFile = path.join(directory, 'workspace.json');
fs.writeFileSync(configFile, JSON.stringify({ name: '最大画布预算验证', projects: [{ id: 'canvas', name: '400 模块 / 2000 关系', path: root }] }, null, 2));
console.log(JSON.stringify({ configFile, projectRoot: root, ...counts, expectedMapNodes: 400, expectedMapEdges: 2000, mapQuery: '/api/projects/canvas/map?root=src&depth=1&bounded=1' }, null, 2));
