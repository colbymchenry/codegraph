import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import CodeGraph from '../src/index';
import { buildDeadCodeReport } from '../src/graph/dead-code';
import { buildDeadCode } from '../src/ui-server/api/deadcode';

let root: string;
let cg: CodeGraph | undefined;
afterEach(() => {
  cg?.close();
  cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('Tauri command dead-code exclusion (#1543)', () => {
  it('counts commands as decorated entry points while retaining unannotated helpers', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tauri-dead-'));
    fs.writeFileSync(path.join(root, 'commands.rs'), `
pub fn reached() {}
#[tauri::command]
fn get_mcp_port() -> u16 { 4000 }
#[tauri :: command(rename_all = "snake_case")]
// A comment between attributes and the function is allowed.
#[allow(non_snake_case)]
pub async fn readSettings() {}
fn unused_helper() {}
// #[tauri::command]
fn comment_only() {}
#[other::command]
fn unrelated_attribute() {}
const TEXT: &str = r#"#[tauri::command]"#;
fn string_only() {}
#[tauri::command]
fn outer_command() { fn nested_helper() {} }
fn next_function() {}
`);
    fs.writeFileSync(path.join(root, 'main.rs'), 'mod commands;\nfn main() { commands::reached(); }\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    const nodes = cg.getNodesInFile('commands.rs');
    for (const name of ['get_mcp_port', 'readSettings', 'outer_command']) {
      expect(nodes.find(n => n.name === name)?.decorators, name).toEqual(['tauri::command']);
    }
    // Rust export coverage is incomplete; includeExported exercises the actual
    // decorator rule rather than letting exportsUnknown hide the regression.
    const report = buildDeadCodeReport(cg, { includeExported: true });
    expect(report.excluded.decorated).toBe(3);
    const wire = buildDeadCode(cg, root, new URLSearchParams('exported=1'));
    expect(wire.excluded).toContainEqual({
      reason: 'decorated', count: 3, label: 'carrying a decorator, so a framework registers them',
    });
    expect(buildDeadCodeReport(cg, { includeExported: true, readSource: null }).excluded.decorated).toBe(3);
    expect(report.entries.map(e => e.node.name)).toEqual(expect.arrayContaining([
      'unused_helper', 'comment_only', 'unrelated_attribute', 'string_only', 'nested_helper', 'next_function',
    ]));
    expect(report.entries.some(e => ['get_mcp_port', 'readSettings', 'outer_command'].includes(e.node.name))).toBe(false);
  });
});
