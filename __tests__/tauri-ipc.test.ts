/**
 * Tauri IPC: a frontend's `invoke('cmd')` onto the Rust `#[tauri::command]`
 * that answers it, tauri-specta's typed client, and events across that seam.
 * Each fixture is indexed for real, so the extraction of both languages, the
 * pass and the merge are all under test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { hasSynthesisPattern } from '../src/resolution/callback-synthesizer';
import { describeSynthesizedHop } from '../src/graph/synthesized-hop';
import { ToolHandler } from '../src/mcp/tools';
import type { Edge, Node } from '../src/types';

const roots: string[] = [];
const graphs: CodeGraph[] = [];

function write(root: string, file: string, source: string): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
}

async function index(files: Record<string, string>): Promise<{ root: string; graph: CodeGraph }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tauri-'));
  roots.push(root);
  for (const [file, source] of Object.entries(files)) write(root, file, source);
  const graph = CodeGraph.initSync(root);
  graphs.push(graph);
  await graph.indexAll();
  return { root, graph };
}

afterEach(() => {
  for (const graph of graphs.splice(0)) graph.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Everything the pass drew, in edge order. */
function links(graph: CodeGraph, by = 'tauri-command'): Array<{ from: Node; to: Node; edge: Edge }> {
  const db = (graph as unknown as { db: { db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } } } }).db.db;
  const rows = db.prepare(
    `SELECT source, target, kind, line, col AS "column", provenance, metadata FROM edges WHERE json_extract(metadata, '$.synthesizedBy') = ?`
  ).all(by) as Array<Omit<Edge, 'metadata'> & { metadata: string }>;
  return rows.map((row) => {
    const edge = { ...row, metadata: JSON.parse(row.metadata) as Record<string, unknown> };
    return { from: graph.getNode(row.source)!, to: graph.getNode(row.target)!, edge };
  });
}

const names = (rows: ReadonlyArray<{ from: Node; to: Node }>): string[] => rows.map((r) => `${r.from.name} > ${r.to.name}`).sort();

const CORE = `#[tauri::command]
fn greet() {}
#[tauri::command]
fn unregistered() {}
fn not_command() {}
fn run() { tauri::Builder::default().invoke_handler(tauri::generate_handler![greet, not_command]).run(); }
`;

describe('Tauri commands', () => {
  it('links direct, aliased and namespace imports to the registered command', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': CORE,
      'src/a.ts': 'import { invoke } from "@tauri-apps/api/core";\nexport async function click() { return invoke<string>("greet"); }\n',
      'src/b.ts': 'import { invoke as callRust } from "@tauri-apps/api/tauri";\nexport function otherClick() { return callRust("greet"); }\n',
      'src/c.ts': 'import * as core from "@tauri-apps/api/core";\nexport function namespaceClick() { return core.invoke("greet"); }\n',
    });
    const rows = links(graph);
    expect(names(rows)).toEqual(['click > greet', 'namespaceClick > greet', 'otherClick > greet']);
    for (const { edge } of rows) {
      expect(edge.provenance).toBe('heuristic');
      expect(edge.kind).toBe('calls');
      expect(edge.line).toBe(2);
      expect(edge.metadata?.registeredAt).toBe('src-tauri/src/lib.rs:6');
      expect(edge.metadata?.command).toBe('greet');
      expect(edge.metadata?.tier).toBe('client→server');
    }
  });

  it('reads an API imported where it is used', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': [CORE, 'use tauri::Listener;', 'fn wire(app: tauri::AppHandle) { app.listen("ready", |_e| {}); }'].join('\n'),
      'src/a.ts': [
        'export async function lazy() {',
        "  const { invoke } = await import('@tauri-apps/api/core');",
        "  return invoke('greet');",
        '}',
        'export async function tell() {',
        "  const { emit, emitTo: toWindow } = await import('@tauri-apps/api/event');",
        "  await emit('ready');",
        "  await toWindow('main', 'other', 1);",
        '}',
      ].join('\n'),
    });
    expect(names(links(graph))).toEqual(['lazy > greet']);
    expect(names(links(graph, 'tauri-event'))).toEqual(['tell > wire']);
  });

  it('reads the v1 API root and its tauri namespace', async () => {
    const { graph } = await index({
      'src-tauri/src/main.rs': CORE,
      'src/a.jsx': "import { invoke } from '@tauri-apps/api';\nexport function Rooted() { invoke('greet'); return null; }\n",
      'src/b.js': "import { tauri } from '@tauri-apps/api';\nexport function holder() { return tauri.invoke('greet'); }\n",
    });
    expect(names(links(graph))).toEqual(['Rooted > greet', 'holder > greet']);
  });

  it('reads the global API of an app built with no bundler', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': CORE,
      'src/main.js': [
        'const { invoke } = window.__TAURI__.core;',
        'function viaDestructure() { return invoke("greet"); }',
        'function viaGlobal() { return window.__TAURI__.core.invoke("greet"); }',
        'function viaV1Global() { return window.__TAURI__.invoke("greet"); }',
      ].join('\n'),
    });
    expect(names(links(graph))).toEqual(['viaDestructure > greet', 'viaGlobal > greet', 'viaV1Global > greet']);
  });

  it('links nothing a call cannot prove', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': CORE,
      'src/a.ts': [
        'import { invoke } from "@tauri-apps/api/core";',
        'function parameter(invoke: (key: string) => unknown) { return invoke("greet"); }',
        'function destructured(other: any) { const { invoke } = other; return invoke("greet"); }',
        'function arrowParam() { return [1].map((invoke: any) => invoke("greet")); }',
        'function dynamic(key: string) { return invoke(key); }',
        'function templated(id: string) { return invoke(`greet_${id}`); }',
        'function concatenated(id: string) { return invoke("greet" + id); }',
        'function absent() { invoke("unregistered"); invoke("not_command"); invoke("plugin:store|get"); }',
        'function literal() { return "invoke(\\"greet\\")"; }',
        '// invoke("greet")',
        '/* invoke("greet") */',
      ].join('\n'),
      'src/wrapped.ts': 'import { invoke } from "./wrapper";\nexport function wrapperClick() { return invoke("greet"); }\n',
      'src/other.ts': 'function invoke(key: string) { return key; }\nexport function localClick() { return invoke("greet"); }\n',
    });
    expect(names(links(graph))).toEqual([]);
  });

  it('keeps a namespace or destructured parameter that hides the import unlinked', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': CORE,
      'src/a.ts': 'import * as core from "@tauri-apps/api/core";\nfunction shadow(core: any) { return core.invoke("greet"); }\n',
      'src/b.ts': 'import { invoke } from "@tauri-apps/api/core";\nfunction shadow({ invoke }: { invoke: any }) { return invoke("greet"); }\n',
    });
    expect(names(links(graph))).toEqual([]);
  });

  it('does not take a comment, a string or an unrelated macro for a registration', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': [
        '#[tauri::command]',
        'fn greet() {}',
        'fn run() {',
        '  let text = "tauri::generate_handler![greet]";',
        '  // tauri::generate_handler![greet]',
        '  /* tauri::generate_handler![greet] */',
        '  other_handler![greet];',
        '}',
      ].join('\n'),
      'src/a.ts': 'import { invoke } from "@tauri-apps/api/core";\nexport function click() { return invoke("greet"); }\n',
    });
    expect(names(links(graph))).toEqual([]);
  });

  it('reads a list that is built apart from the builder and tauri-specta collectors', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': [
        'mod cmd;',
        'fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool { tauri::generate_handler![cmd::listed] }',
        'pub fn builder() -> tauri_specta::Builder<tauri::Wry> {',
        '  tauri_specta::Builder::new().commands(tauri_specta::collect_commands![',
        '    cmd::typed,',
        '    #[cfg(target_os = "macos")]',
        '    cmd::conditional,',
        '    cmd::generic::<tauri::Wry>,',
        '  ])',
        '}',
      ].join('\n'),
      // A module's commands are re-exported by its parent: the path names the parent.
      'src-tauri/src/cmd/mod.rs': 'mod system;\npub use system::*;\n',
      'src-tauri/src/cmd/system.rs': [
        '#[tauri::command] pub fn listed() {}',
        '#[tauri::command] #[specta::specta] pub fn typed() {}',
        '#[tauri::command] pub fn conditional() {}',
        '#[tauri::command] pub fn generic<R: tauri::Runtime>() {}',
      ].join('\n'),
      'src/a.ts': [
        'import { invoke } from "@tauri-apps/api/core";',
        'export function a() { return invoke("listed"); }',
        'export function b() { return invoke("typed"); }',
        'export function c() { return invoke("conditional"); }',
        'export function d() { return invoke("generic"); }',
      ].join('\n'),
    });
    expect(names(links(graph))).toEqual(['a > listed', 'b > typed', 'c > conditional', 'd > generic']);
  });

  it('walks through a generated tauri-specta client to the command', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': [
        '#[tauri::command] #[specta::specta] fn get_mcp_port() -> u16 { 0 }',
        'fn run() { tauri_specta::Builder::new().commands(tauri_specta::collect_commands![get_mcp_port]); }',
      ].join('\n'),
      'src/bindings.ts': [
        '// This file was generated by [tauri-specta](https://github.com/oscartbeaumont/tauri-specta). Do not edit this file manually.',
        'export const commands = {',
        '  async getMcpPort(): Promise<number> {',
        '    return await TAURI_INVOKE("get_mcp_port");',
        '  },',
        '  getMcpPortArrow: () => __TAURI_INVOKE<{ a: string; b: Array<number> }>("get_mcp_port"),',
        '};',
        'import { invoke as TAURI_INVOKE, invoke as __TAURI_INVOKE } from "@tauri-apps/api/core";',
      ].join('\n'),
      'src/settings.ts': 'import { commands } from "./bindings";\nexport async function loadPort() { return commands.getMcpPort(); }\n',
    });
    expect(names(links(graph))).toEqual(['getMcpPort > get_mcp_port', 'getMcpPortArrow > get_mcp_port']);
    const getMcpPort = graph.getNodesByName('getMcpPort')[0]!;
    expect(graph.getCallers(getMcpPort.id).map((c) => c.node.name)).toContain('loadPort');
  });

  it('reads commands.fooBar() by name when the bindings are not in the index', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': [
        '#[tauri::command] #[specta::specta] fn get_mcp_port() -> u16 { 0 }',
        'fn run() { tauri_specta::Builder::new().commands(tauri_specta::collect_commands![get_mcp_port]); }',
      ].join('\n'),
      'src/settings.ts': [
        'import { commands } from "./bindings";',
        'import { commands as other } from "some-package";',
        'export async function loadPort() { return commands.getMcpPort(); }',
        'export function notACommand() { return commands.somethingElse(); }',
        'export function notBindings() { return other.getMcpPort(); }',
      ].join('\n'),
    });
    expect(names(links(graph))).toEqual(['loadPort > get_mcp_port']);
  });

  it('answers from what the app declares when a macro builds its handler list', async () => {
    const { graph } = await index({
      'apps/desktop/src-tauri/src/ipc.rs': [
        'macro_rules! build_invoke_handler {',
        '  ($($($typed:ident)::+,)*) => { tauri::generate_handler![ $($($typed)::+,)* ] };',
        '}',
        '#[tauri::command] pub fn from_manifest() {}',
      ].join('\n'),
      'apps/desktop/src-tauri/src/commands/other.rs': '#[tauri::command]\npub fn from_another_file() {}\n',
      'apps/desktop/src/a.ts': [
        'import { invoke } from "@tauri-apps/api/core";',
        'export function click() { return invoke("from_manifest"); }',
        'export function other() { return invoke("from_another_file"); }',
      ].join('\n'),
    });
    const rows = links(graph);
    expect(names(rows)).toEqual(['click > from_manifest', 'other > from_another_file']);
    expect(rows[0]!.edge.metadata?.registeredAt).toBe('apps/desktop/src-tauri/src/ipc.rs:2');
  });

  it('accepts a command an attribute macro makes, and no plain namesake of an outside entry', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': [
        'use tauri::command;',
        'use tauri_plugin_x::commands::version;',
        '#[command]',
        'async fn short_form() {}',
        '#[app_api(try_from = Thing)]',
        '#[tracing::instrument]',
        'pub fn macro_made() {}',
        'fn version() {}',
        'fn run() { tauri::Builder::default().invoke_handler(tauri::generate_handler![short_form, api::tauri_macro_made::macro_made, tauri_plugin_x::commands::version]); }',
      ].join('\n'),
      'src/a.ts': [
        'import { invoke } from "@tauri-apps/api/core";',
        'export function a() { return invoke("short_form"); }',
        'export function b() { return invoke("macro_made"); }',
        'export function c() { return invoke("version"); }',
      ].join('\n'),
    });
    expect(names(links(graph))).toEqual(['a > short_form', 'b > macro_made']);
  });

  it('keeps two apps of one repository apart, and a key two handlers claim unlinked', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': CORE,
      'src/root.ts': 'import { invoke } from "@tauri-apps/api/core";\nexport function rootClick() { return invoke("greet"); }\n',
      'apps/a/src-tauri/src/lib.rs': CORE,
      'apps/a/src/click.ts': 'import { invoke } from "@tauri-apps/api/core";\nexport function appClick() { return invoke("greet"); }\n',
      'apps/b/src-tauri/src/lib.rs': '#[tauri::command]\nfn greet() {}\n',
      'apps/b/src/click.ts': 'import { invoke } from "@tauri-apps/api/core";\nexport function unregisteredAppClick() { return invoke("greet"); }\n',
      'apps/c/src-tauri/src/lib.rs': [
        'mod one; mod two;',
        'fn run() { tauri::Builder::default().invoke_handler(tauri::generate_handler![one::greet, two::greet]); }',
      ].join('\n'),
      'apps/c/src-tauri/src/one.rs': '#[tauri::command]\npub fn greet() {}\n',
      'apps/c/src-tauri/src/two.rs': '#[tauri::command]\npub fn greet() {}\n',
      'apps/c/src/click.ts': 'import { invoke } from "@tauri-apps/api/core";\nexport function tiedClick() { return invoke("greet"); }\n',
    });
    const rows = links(graph);
    expect(names(rows)).toEqual(['appClick > greet', 'rootClick > greet']);
    for (const row of rows) {
      expect(row.to.filePath).toBe(row.from.name === 'appClick' ? 'apps/a/src-tauri/src/lib.rs' : 'src-tauri/src/lib.rs');
    }
  });

  it('finds a crate and frontend that sit apart', async () => {
    const { graph } = await index({
      'crates/app-tauri/Cargo.toml': '[package]\nname = "app-tauri"\nversion = "0.1.0"\n',
      'crates/app-tauri/src/main.rs': 'fn main() { tauri::Builder::default().invoke_handler(tauri::generate_handler![api::save]); }\n',
      'crates/api/Cargo.toml': '[package]\nname = "api"\nversion = "0.1.0"\n',
      'crates/api/src/lib.rs': '#[tauri::command]\npub fn save() {}\n',
      'apps/desktop/src/a.ts': 'import { invoke } from "@tauri-apps/api/core";\nexport function click() { return invoke("save"); }\n',
    });
    expect(names(links(graph))).toEqual(['click > save']);
  });

  it('routes a plugin command to the plugin that registers it', async () => {
    const { graph } = await index({
      'src-tauri/src/main.rs': 'fn main() { tauri::Builder::default().invoke_handler(tauri::generate_handler![list]); }\n#[tauri::command] fn list() {}\n',
      'plugins/fonts/Cargo.toml': '[package]\nname = "fonts"\nversion = "0.1.0"\n',
      'plugins/fonts/src/lib.rs': [
        'use tauri::{generate_handler, plugin::{Builder, TauriPlugin}, Runtime};',
        '#[tauri::command] pub fn list() {}',
        'pub fn init<R: Runtime>() -> TauriPlugin<R> { Builder::new("fonts").invoke_handler(generate_handler![list]).build() }',
      ].join('\n'),
      'src/a.ts': [
        'import { invoke } from "@tauri-apps/api/core";',
        'export function pluginList() { return invoke("plugin:fonts|list"); }',
        'export function appList() { return invoke("list"); }',
      ].join('\n'),
    });
    const rows = links(graph);
    expect(names(rows)).toEqual(['appList > list', 'pluginList > list']);
    expect(rows.find((r) => r.from.name === 'pluginList')!.to.filePath).toBe('plugins/fonts/src/lib.rs');
    expect(rows.find((r) => r.from.name === 'appList')!.to.filePath).toBe('src-tauri/src/main.rs');
  });

  it('reads a plugin named through a constant and tauri-specta\'s builder', async () => {
    const { graph } = await index({
      'src-tauri/src/main.rs': 'fn main() { tauri::Builder::default().plugin(my_plugin::init()); }\n',
      'plugins/mine/Cargo.toml': '[package]\nname = "my_plugin"\nversion = "0.1.0"\n',
      'plugins/mine/src/lib.rs': [
        'const PLUGIN_NAME: &str = "my-plugin";',
        '#[tauri::command] #[specta::specta] fn add_numbers() {}',
        'fn builder<R: tauri::Runtime>() -> tauri_specta::Builder<R> {',
        '  tauri_specta::Builder::new().plugin_name(PLUGIN_NAME).commands(tauri_specta::collect_commands![add_numbers::<tauri::Wry>])',
        '}',
      ].join('\n'),
      'plugins/mine/guest-js/index.ts': [
        'import { invoke } from "@tauri-apps/api/core";',
        'export function add() { return invoke("plugin:my-plugin|add_numbers"); }',
      ].join('\n'),
    });
    expect(names(links(graph))).toEqual(['add > add_numbers']);
  });

  it('reads Svelte and Vue components, in their scripts and their markup', async () => {
    const { graph } = await index({
      'src-tauri/src/main.rs': CORE,
      'src/Page.svelte': [
        '<script lang="ts">',
        '  import { invoke } from "@tauri-apps/api/core";',
        '  async function save() { await invoke("greet"); }',
        '</script>',
        '<button on:click={save}>Save</button>',
      ].join('\n'),
      'src/Top.svelte': [
        '<script>',
        '  import { invoke } from "@tauri-apps/api/core";',
        '  invoke("greet");',
        '</script>',
      ].join('\n'),
      'src/Panel.vue': [
        '<template><button @click="load">Load</button></template>',
        '<script setup lang="ts">',
        'import { invoke } from "@tauri-apps/api/core";',
        'async function load() { return invoke("greet"); }',
        '</script>',
      ].join('\n'),
    });
    const rows = links(graph);
    expect(names(rows)).toEqual(['Top > greet', 'load > greet', 'save > greet']);
    expect(rows.find((r) => r.from.name === 'save')!.edge.line).toBe(3);
    expect(rows.find((r) => r.from.name === 'load')!.edge.line).toBe(4);
  });

  it('attributes a call to the function it is in when two share a line', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': CORE,
      'src/a.ts': 'import { invoke } from "@tauri-apps/api/core";\nfunction first() { return invoke("greet"); } function second() { return 0; }\n',
    });
    expect(names(links(graph))).toEqual(['first > greet']);
  });

  it('links a command written for each platform to every one of them', async () => {
    const { graph } = await index({
      'src-tauri/src/main.rs': [
        'mod ocr;',
        'mod stubs;',
        'fn main() { tauri::Builder::default().invoke_handler(tauri::generate_handler![ocr::read_text, stubs::only_stub]); }',
      ].join('\n'),
      'src-tauri/src/ocr.rs': [
        '#[tauri::command(async)]',
        '#[cfg(target_os = "windows")]',
        'pub fn read_text() {}',
        '#[tauri::command(async)]',
        '#[cfg(target_os = "macos")]',
        'pub fn read_text() {}',
      ].join('\n'),
      'src-tauri/src/stubs.rs': '#[tauri::command]\npub fn only_stub() {}\n',
      'src/a.ts': [
        'import { invoke } from "@tauri-apps/api/core";',
        'export function read() { return invoke("read_text"); }',
      ].join('\n'),
    });
    const rows = links(graph);
    expect(names(rows)).toEqual(['read > read_text', 'read > read_text']);
    expect(rows.map((r) => r.to.startLine).sort()).toEqual([3, 6]);
  });

  it('follows the project\'s own functions around invoke, and a field set to one', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': CORE,
      'src/ipc.ts': [
        'import { invoke as tauriInvoke } from "@tauri-apps/api/core";',
        'export async function safeInvoke<T>(command: string, args?: unknown): Promise<T> {',
        '  return await tauriInvoke<T>(command, args as never);',
        '}',
        'export const logged = (command: string) => { console.log(command); return safeInvoke(command); };',
        'export function notAWrapper(command: string, other: string) { return tauriInvoke(other); }',
        'export class Backend { invoke = safeInvoke; }',
      ].join('\n'),
      'src/a.ts': 'import { safeInvoke } from "./ipc";\nexport function click() { return safeInvoke("greet"); }\n',
      'src/b.ts': 'import { logged as log } from "./ipc";\nexport function twice() { return log("greet"); }\n',
      'src/c.ts': [
        'export class Service {',
        '  constructor(private backend: { invoke(c: string): unknown }) {}',
        '  load() { return this.backend.invoke("greet"); }',
        '}',
      ].join('\n'),
      'src/d.ts': 'import { notAWrapper } from "./ipc";\nexport function notLinked() { return notAWrapper("greet", "x"); }\n',
      'src/settings.ts': [
        'export class Settings {',
        '  constructor(private backend: { invoke(c: string): unknown }) {}',
        '  async update() { await this.invokeAndRefresh("greet"); }',
        '  private async invokeAndRefresh(command: string) { await this.backend.invoke(command); }',
        '}',
      ].join('\n'),
      'src/api.ts': [
        'import { invoke } from "@tauri-apps/api/core";',
        'export function plain(cmd: string) { return invoke(cmd); }',
        'export class Api { call(cmd: string) { return invoke(cmd); } }',
        'export function noParameter() { const cmd = "greet"; return invoke(cmd); }',
      ].join('\n'),
      'src/e.ts': [
        'import { plain, Api } from "./api";',
        'export function viaPlain() { return plain("greet"); }',
        'export function viaMethod(api: Api) { return api.call("greet"); }',
      ].join('\n'),
    });
    expect(names(links(graph))).toEqual(['click > greet', 'load > greet', 'noParameter > greet', 'twice > greet', 'update > greet', 'viaMethod > greet', 'viaPlain > greet']);
  });

  it('leaves test code out, where the backend is mocked', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': CORE,
      'src/a.test.ts': 'import { invoke } from "@tauri-apps/api/core";\nexport function testClick() { return invoke("greet"); }\n',
    });
    expect(names(links(graph))).toEqual([]);
  });

  it('follows a registration and a call through sync, as a fresh index would', async () => {
    const { graph, root } = await index({
      'src-tauri/src/lib.rs': CORE,
      'src/a.ts': 'import { invoke } from "@tauri-apps/api/core";\nexport function click() { return invoke("greet"); }\n',
    });
    expect(names(links(graph))).toEqual(['click > greet']);
    write(root, 'src-tauri/src/lib.rs', CORE.replace('generate_handler![greet, not_command]', 'generate_handler![not_command]'));
    await graph.sync();
    expect(names(links(graph))).toEqual([]);
    write(root, 'src-tauri/src/lib.rs', CORE);
    await graph.sync();
    expect(names(links(graph))).toEqual(['click > greet']);
    write(root, 'src/a.ts', 'export function click() { return 0; }\n');
    await graph.sync();
    expect(names(links(graph))).toEqual([]);
    write(root, 'src/late.ts', 'import { invoke } from "@tauri-apps/api/core";\nexport function late() { return invoke("greet"); }\n');
    await graph.sync();
    expect(names(links(graph))).toEqual(['late > greet']);
  });

  it('marks what a sync must read again', () => {
    expect(hasSynthesisPattern('src/a.ts', 'import { invoke as callRust } from "@tauri-apps/api/core"; callRust("greet");')).toBe(true);
    expect(hasSynthesisPattern('src/a.js', 'const x = window.__TAURI__;')).toBe(true);
    expect(hasSynthesisPattern('src-tauri/src/lib.rs', '#[tauri::command] fn greet() {}')).toBe(true);
    expect(hasSynthesisPattern('src-tauri/src/lib.rs', 'fn run() { b.invoke_handler(generate_handler![greet]); }')).toBe(true);
  });

  it('draws nothing in a Rust and TypeScript project that is not a Tauri app', async () => {
    const { graph } = await index({
      'native/src/lib.rs': 'pub fn greet() {}\n#[derive(Clone)]\npub struct Saved;\n',
      'src/a.ts': 'import { invoke } from "./rpc";\nexport function click() { return invoke("greet"); }\n',
      'src/rpc.ts': 'export function invoke(name: string) { return name; }\n',
    });
    expect(names(links(graph))).toEqual([]);
    expect(names(links(graph, 'tauri-event'))).toEqual([]);
  });
});

describe('Tauri events', () => {
  it('links a raw emit to a named or inline listener, across languages', async () => {
    const { graph } = await index({
      'src-tauri/src/main.rs': [
        'use tauri::Emitter;',
        'const CHANGED: &str = "theme-changed";',
        'fn notify(window: tauri::Window) { window.emit("new_text", "x").unwrap(); }',
        'fn broadcast(app: tauri::AppHandle) { app.emit_all("new_text", ()).unwrap(); }',
        'fn targeted(app: tauri::AppHandle) { app.emit_to("main", "new_text", ()).unwrap(); }',
        'fn constant(app: tauri::AppHandle) { app.emit(CHANGED, ()).unwrap(); }',
      ].join('\n'),
      'src/a.ts': [
        "import { listen, once } from '@tauri-apps/api/event';",
        "function onText(e: unknown) { return e; }",
        "export function named() { listen('new_text', onText); }",
        "export function inline() { void once('theme-changed', (e) => console.log(e)); }",
        "export function unknown(name: string) { listen(name, onText); }",
      ].join('\n'),
    });
    const rows = links(graph, 'tauri-event');
    expect(names(rows)).toEqual(['broadcast > onText', 'constant > inline', 'notify > onText', 'targeted > onText']);
    for (const { edge } of rows) {
      expect(edge.kind).toBe('calls');
      expect(edge.metadata?.tier).toBe('server→client');
      expect(edge.metadata?.channel).toBe('event');
    }
    const notify = rows.find((r) => r.from.name === 'notify')!;
    expect(notify.edge.metadata?.event).toBe('new_text');
    expect(notify.edge.metadata?.registeredAt).toBe('src/a.ts:3');
    expect(notify.edge.line).toBe(3);
  });

  it('reads a listener on a window handle, and leaves built-in events alone', async () => {
    const { graph } = await index({
      'src-tauri/src/main.rs': 'use tauri::Emitter;\nfn notify(window: tauri::Window) { window.emit("ready", ()).unwrap(); }\n',
      'src/a.ts': [
        "import { getCurrentWindow } from '@tauri-apps/api/window';",
        "export function viaHandle() { getCurrentWindow().listen('ready', () => {}); }",
        "export function builtIn() { getCurrentWindow().listen('tauri://resize', () => {}); }",
      ].join('\n'),
    });
    expect(names(links(graph, 'tauri-event'))).toEqual(['notify > viaHandle']);
  });

  it('links a frontend emit to a Rust listener and to another window', async () => {
    const { graph } = await index({
      'src-tauri/src/main.rs': [
        'use tauri::Listener;',
        'fn wire(app: tauri::AppHandle) { app.listen("write-settled", |_e| {}); }',
        'fn other(app: tauri::AppHandle) { app.listen_any("write-settled", |_e| {}); }',
      ].join('\n'),
      'src/a.ts': [
        "import { emit, listen } from '@tauri-apps/api/event';",
        "export async function settle() { await emit('write-settled', { ok: true }); }",
        "export function otherWindow() { listen('write-settled', () => {}); }",
      ].join('\n'),
    });
    const rows = links(graph, 'tauri-event');
    expect(names(rows)).toEqual(['settle > other', 'settle > otherWindow', 'settle > wire']);
    expect(rows.find((r) => r.to.name === 'wire')!.edge.metadata?.tier).toBe('client→server');
    expect(rows.find((r) => r.to.name === 'otherWindow')!.edge.metadata?.tier).toBeUndefined();
  });

  const TYPED = [
    'use serde::Serialize;',
    'use tauri::Manager;',
    'use tauri_specta::Event;',
    '#[derive(Clone, Serialize, specta::Type, Event)]',
    'pub struct FileSaved { pub path: String }',
    '#[derive(Clone, Serialize, specta::Type, Event)]',
    '#[tauri_specta(event_name = "low-disk")]',
    'pub struct LowDiskPayload { pub path: String }',
    '#[derive(Clone, Serialize, specta::Type, tauri_specta::Event)]',
    'pub struct AIModelReady;',
    '#[derive(Clone, Serialize)]',
    'pub struct NotAnEvent;',
    'fn literal(app: &tauri::AppHandle) { let _ = FileSaved { path: String::new() }.emit(app); }',
    'fn wrapped(app: &tauri::AppHandle) { if let Err(e) = (LowDiskPayload { path: String::new() }).emit(app) { drop(e); } }',
    'fn unit(app: &tauri::AppHandle) { let _ = AIModelReady.emit(app); }',
    'fn local(app: &tauri::AppHandle) {',
    '  let event = FileSaved { path: String::new() };',
    '  let _ = event.emit(app);',
    '}',
    'fn from_param(app: &tauri::AppHandle, payload: &LowDiskPayload) { let _ = payload.emit(app); }',
    'fn chained(app: &tauri::AppHandle) {',
    '  let _ = FileSaved {',
    '    path: String::new(),',
    '  }',
    '  .emit(app);',
    '}',
    'fn targeted(app: &tauri::AppHandle) { let _ = FileSaved { path: String::new() }.emit_to(app, "main"); }',
    'fn not_one(app: &tauri::AppHandle) { let _ = NotAnEvent.emit(app); }',
    'fn run() { tauri_specta::Builder::<tauri::Wry>::new().events(tauri_specta::collect_events![FileSaved, LowDiskPayload, AIModelReady]); }',
  ].join('\n');

  it('links tauri-specta events through their structs', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': TYPED,
      'src/a.ts': [
        "import { events } from '#lib/ipc/bindings.js';",
        'export function onSaved() { return events.fileSaved.listen((e) => e); }',
        'export function onDisk() { return events.lowDiskPayload(appWindow).once((e) => e); }',
        'export function onModel() { return events.aiModelReady.listen((e) => e); }',
        'export function notAnEvent() { return events.notAnEvent.listen((e) => e); }',
      ].join('\n'),
    });
    const rows = links(graph, 'tauri-event');
    expect(names(rows.filter((r) => r.edge.kind === 'references'))).toEqual([
      'onDisk > LowDiskPayload', 'onModel > AIModelReady', 'onSaved > FileSaved',
    ]);
    expect(names(rows.filter((r) => r.edge.kind === 'calls'))).toEqual([
      'chained > onSaved', 'from_param > onDisk', 'literal > onSaved', 'local > onSaved', 'targeted > onSaved', 'unit > onModel', 'wrapped > onDisk',
    ]);
    const typed = rows.find((r) => r.to.name === 'LowDiskPayload')!;
    expect(typed.edge.metadata?.event).toBe('low-disk');
    expect(typed.edge.metadata?.registeredAt).toBe('src-tauri/src/lib.rs:8');
  });

  it('meets a raw listener on the wire name of a typed event', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': TYPED,
      'src/a.ts': [
        "import { listen } from '@tauri-apps/api/event';",
        "export function rawSaved() { return listen('file-saved', () => {}); }",
        "export function rawDisk() { return listen('low-disk', () => {}); }",
      ].join('\n'),
    });
    const rows = links(graph, 'tauri-event');
    expect(names(rows.filter((r) => r.edge.kind === 'references'))).toEqual(['rawDisk > LowDiskPayload', 'rawSaved > FileSaved']);
    expect(names(rows.filter((r) => r.edge.kind === 'calls'))).toEqual([
      'chained > rawSaved', 'from_param > rawDisk', 'literal > rawSaved', 'local > rawSaved', 'targeted > rawSaved', 'wrapped > rawDisk',
    ]);
  });

  it('links a typed emit in the frontend to a typed listener in Rust', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': [
        'use tauri_specta::Event;',
        '#[derive(Clone, serde::Serialize, specta::Type, Event)]',
        'pub struct DemoEvent(String);',
        'fn wire(app: &tauri::AppHandle) { DemoEvent::listen(app, |event| { drop(event); }); }',
      ].join('\n'),
      'src/a.ts': "import { events } from './bindings';\nexport function tell() { return events.demoEvent.emit('x'); }\n",
    });
    const rows = links(graph, 'tauri-event');
    expect(names(rows)).toEqual(['tell > wire']);
    expect(rows[0]!.edge.metadata?.tier).toBe('client→server');
    expect(rows[0]!.edge.metadata?.event).toBe('demo-event');
  });

  it('keeps the events of two apps apart', async () => {
    const app = (name: string) => [
      'use tauri_specta::Event;',
      '#[derive(Clone, serde::Serialize, specta::Type, Event)]',
      'pub struct Ready;',
      `fn ${name}_raw(app: tauri::AppHandle) { app.emit("tick", ()).unwrap(); }`,
      `fn ${name}_typed(app: &tauri::AppHandle) { let _ = Ready.emit(app); }`,
    ].join('\n');
    const front = (name: string) => [
      "import { listen } from '@tauri-apps/api/event';",
      "import { events } from './bindings';",
      `export function ${name}Tick() { return listen('tick', () => {}); }`,
      `export function ${name}Ready() { return events.ready.listen(() => {}); }`,
    ].join('\n');
    const { graph } = await index({
      'apps/a/src-tauri/src/main.rs': app('a'),
      'apps/a/src/main.ts': front('a'),
      'apps/b/src-tauri/src/main.rs': app('b'),
      'apps/b/src/main.ts': front('b'),
    });
    const rows = links(graph, 'tauri-event');
    expect(names(rows.filter((r) => r.edge.kind === 'calls'))).toEqual([
      'a_raw > aTick', 'a_typed > aReady', 'b_raw > bTick', 'b_typed > bReady',
    ]);
    expect(rows.filter((r) => r.edge.kind === 'references').map((r) => `${r.from.name} ${r.to.filePath}`).sort()).toEqual([
      'aReady apps/a/src-tauri/src/main.rs', 'bReady apps/b/src-tauri/src/main.rs',
    ]);
  });

  it('skips an event too many functions emit to read as a flow', async () => {
    const emitters = Array.from({ length: 20 }, (_, i) => `fn e${i}(a: tauri::AppHandle) { a.emit("busy", ()).unwrap(); }`);
    const { graph } = await index({
      'src-tauri/src/main.rs': ['use tauri::Emitter;', ...emitters].join('\n'),
      'src/a.ts': "import { listen } from '@tauri-apps/api/event';\nexport function on() { listen('busy', () => {}); }\n",
    });
    expect(names(links(graph, 'tauri-event'))).toEqual([]);
  });
});

describe('How a Tauri hop reads', () => {
  it('names the command and the event, with the wiring site', () => {
    const edge = (metadata: Record<string, unknown>): Edge => ({ source: 'a', target: 'b', kind: 'calls', provenance: 'heuristic', metadata });
    const command = describeSynthesizedHop(edge({ synthesizedBy: 'tauri-command', command: 'greet', registeredAt: 'src-tauri/src/lib.rs:6' }));
    expect(command).toMatchObject({ summary: 'Tauri command `greet`', registeredAt: 'src-tauri/src/lib.rs:6' });
    const event = describeSynthesizedHop(edge({ synthesizedBy: 'tauri-event', event: 'saved', tier: 'server→client', registeredAt: 'src/a.ts:3' }));
    expect(event).toMatchObject({ summary: 'Tauri event `saved`', detail: ' → frontend', registeredAt: 'src/a.ts:3' });
  });

  it('carries a flow across the seam in codegraph_explore', async () => {
    const { graph } = await index({
      'src-tauri/src/lib.rs': [
        'fn persist() {}',
        '#[tauri::command]',
        'fn save_file() { persist(); }',
        'fn run() { tauri::Builder::default().invoke_handler(tauri::generate_handler![save_file]); }',
      ].join('\n'),
      'src/a.ts': [
        'import { invoke } from "@tauri-apps/api/core";',
        'export function onSaveClick() { return invoke("save_file"); }',
      ].join('\n'),
    });
    const handler = new ToolHandler(graph);
    const res = await handler.execute('codegraph_explore', { query: 'onSaveClick save_file persist' });
    const text = res.content[0]!.text;
    expect(text).toContain('Tauri command `save_file`');
    expect(text).toContain('src-tauri/src/lib.rs:4');
  });
});
