import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { hasSynthesisPattern } from '../src/resolution/callback-synthesizer';

const roots: string[] = []; const graphs: CodeGraph[] = [];
function write(root: string, file: string, source: string) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, source); }
const backend = '#[tauri::command]\nfn greet() {}\n#[tauri::command]\nfn unregistered() {}\nfn not_command() {}\nfn run() { tauri::Builder::default().invoke_handler(tauri::generate_handler![greet, not_command]).run(); }\n';
async function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tauri-')); roots.push(root);
  for (const [file, source] of Object.entries(files)) write(root, file, source);
  const graph = CodeGraph.initSync(root); graphs.push(graph); await graph.indexAll(); await graph.resolveReferences();
  return { root, graph };
}
function links(graph: CodeGraph) { return graph.getNodesByName('greet').flatMap(node => graph.getCallers(node.id)).filter(row => row.edge.metadata?.synthesizedBy === 'tauri-command'); }
afterEach(() => { for (const graph of graphs.splice(0)) graph.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
describe('Tauri IPC links', () => {
  it('links direct, aliased and namespace imports to registered decorated commands', async () => {
    const { graph } = await fixture({ 'src-tauri/src/lib.rs': backend, 'src/a.ts': 'import { invoke } from "@tauri-apps/api/core";\nexport async function click() { return invoke<string>("greet"); }', 'src/b.ts': 'import { invoke as callRust } from "@tauri-apps/api/tauri";\nexport function otherClick() { return callRust("greet"); }', 'src/c.ts': 'import * as core from "@tauri-apps/api/core";\nexport function namespaceClick() { return core.invoke("greet"); }' });
    const rows = links(graph); expect(rows.map(row => row.node.name).sort()).toEqual(['click', 'namespaceClick', 'otherClick']);
    expect(rows.every(row => row.edge.provenance === 'heuristic')).toBe(true);
    expect(rows.every(row => row.edge.metadata?.registeredAt === 'src-tauri/src/lib.rs:6')).toBe(true);
    expect(rows.every(row => row.edge.line === 2)).toBe(true);
  });
  it('rejects shadowed imports, dynamic keys, wrappers and absent registrations', async () => {
    const { graph } = await fixture({ 'src-tauri/src/lib.rs': backend, 'src/a.ts': [
      'import { invoke } from "@tauri-apps/api/core";',
      'function parameter(invoke: (key: string) => unknown) { return invoke("greet"); }',
      'function destructured() { const { invoke } = other; return invoke("greet"); }',
      'function dynamic(key: string) { return invoke(key); }',
      'function absent() { invoke("unregistered"); invoke("not_command"); invoke("plugin:store|get"); }',
      'function literal() { return "invoke(\\"greet\\")"; }',
      '// invoke("greet")',
    ].join('\n'), 'src/unrelated.ts': 'import { invoke } from "./wrapper"; export function wrapperClick() { return invoke("greet"); }' });
    expect(links(graph)).toEqual([]);
  });
  it('maps a qualified module command to its external bare key', async () => {
    const { graph } = await fixture({ 'src-tauri/src/lib.rs': 'mod commands; fn run() { tauri::Builder::default().invoke_handler(tauri::generate_handler![crate::commands::greet]); }', 'src-tauri/src/commands.rs': '#[tauri::command]\npub fn greet() {}', 'src/a.ts': 'import { invoke } from "@tauri-apps/api/core";\nexport function click() { return invoke("greet"); }' });
    expect(links(graph)).toHaveLength(1);
  });
  it('does not connect comment/string decoys or a detached macro', async () => {
    const { graph } = await fixture({ 'src-tauri/src/lib.rs': '#[tauri::command]\nfn greet() {}\nfn run() { let detached = tauri::generate_handler![greet]; let text = "tauri::Builder::default().invoke_handler(tauri::generate_handler![greet])"; /* tauri::Builder::default().invoke_handler(tauri::generate_handler![greet]); */ }', 'src/a.ts': 'import { invoke } from "@tauri-apps/api/core";\nexport function click() { return invoke("greet"); }' });
    expect(links(graph)).toEqual([]);
  });
  it('isolates sibling apps and a nested app without registration', async () => {
    const { graph } = await fixture({ 'src-tauri/src/lib.rs': backend, 'src/root.ts': 'import { invoke } from "@tauri-apps/api/core";\nexport function rootClick() { return invoke("greet"); }', 'apps/a/src-tauri/src/lib.rs': backend, 'apps/a/src/click.ts': 'import { invoke } from "@tauri-apps/api/core";\nexport function appClick() { return invoke("greet"); }', 'apps/b/src-tauri/src/lib.rs': '#[tauri::command]\nfn greet() {}', 'apps/b/src/click.ts': 'import { invoke } from "@tauri-apps/api/core";\nexport function unregisteredAppClick() { return invoke("greet"); }' });
    const rows = links(graph); expect(rows).toHaveLength(2);
    const targetOf = new Map(graph.getNodesByName('greet').map(node => [node.id, node.filePath]));
    for (const row of rows) expect(targetOf.get(row.edge.target)).toBe(row.node.name === 'appClick' ? 'apps/a/src-tauri/src/lib.rs' : 'src-tauri/src/lib.rs');
  });
  it('removes and restores unchanged callers when handler registration changes', async () => {
    const { graph, root } = await fixture({ 'src-tauri/src/lib.rs': backend, 'src/a.ts': 'import { invoke } from "@tauri-apps/api/core";\nexport function click() { return invoke("greet"); }' });
    expect(links(graph)).toHaveLength(1);
    write(root, 'src-tauri/src/lib.rs', backend.replace('generate_handler![greet, not_command]', 'generate_handler![not_command]')); await graph.sync();
    expect(links(graph)).toEqual([]);
    write(root, 'src-tauri/src/lib.rs', backend); await graph.sync(); expect(links(graph)).toHaveLength(1);
    write(root, 'src/a.ts', 'export function click() { return 0; }'); await graph.sync(); expect(links(graph)).toEqual([]);
  });
  it('rejects duplicate external command keys from distinct registered modules', async () => {
    const { graph } = await fixture({ 'src-tauri/src/lib.rs': 'mod one; mod two; fn run() { tauri::Builder::default().invoke_handler(tauri::generate_handler![one::greet, two::greet]); }', 'src-tauri/src/one.rs': '#[tauri::command]\nfn greet() {}', 'src-tauri/src/two.rs': '#[tauri::command]\nfn greet() {}', 'src/a.ts': 'import { invoke } from "@tauri-apps/api/core";\nexport function click() { return invoke("greet"); }' });
    expect(links(graph)).toEqual([]);
  });

  it('keeps namespace and destructured parameter shadows unresolved', async () => {
    const { graph } = await fixture({ 'src-tauri/src/lib.rs': backend, 'src/a.ts': 'import * as core from "@tauri-apps/api/core";\nfunction shadow(core: any) { return core.invoke("greet"); }', 'src/b.ts': 'import { invoke } from "@tauri-apps/api/core";\nfunction shadow({invoke}: {invoke: any}) { return invoke("greet"); }' });
    expect(links(graph)).toEqual([]);
  });

  it('attributes adjacent same-line calls to the correct callable', async () => {
    const { graph } = await fixture({ 'src-tauri/src/lib.rs': backend, 'src/a.ts': 'import { invoke } from "@tauri-apps/api/core";\nfunction first() { return invoke("greet"); } function second() { return 0; }' });
    expect(links(graph).map(row => row.node.name)).toEqual(['first']);
  });

  it('tracks aliased import and registration-only inputs for incremental synthesis', () => {
    expect(hasSynthesisPattern('src/a.ts', 'import { invoke as callRust } from "@tauri-apps/api/core"; callRust("greet");')).toBe(true);
    expect(hasSynthesisPattern('src-tauri/src/lib.rs', '#[tauri::command] fn greet() {}')).toBe(true);
  });
});
