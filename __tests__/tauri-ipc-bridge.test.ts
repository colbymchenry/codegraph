import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Node, Language } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import { tauriBridgeResolver } from '../src/resolution/frameworks/tauri';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function makeContext(nodes: Node[], fileContents: Record<string, string> = {}): ResolutionContext {
  const byName = new Map<string, Node[]>();
  const byFile = new Map<string, Node[]>();
  for (const n of nodes) {
    const arr = byName.get(n.name);
    if (arr) arr.push(n);
    else byName.set(n.name, [n]);
    const fArr = byFile.get(n.filePath);
    if (fArr) fArr.push(n);
    else byFile.set(n.filePath, [n]);
  }
  const allFiles = new Set<string>(
    [...nodes.map((n) => n.filePath), ...Object.keys(fileContents)]
  );
  return {
    getNodesInFile: (fp) => byFile.get(fp) ?? [],
    getNodesByName: (name) => byName.get(name) ?? [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
    getNodesByLowerName: () => [],
    fileExists: (fp) => allFiles.has(fp),
    readFile: (fp) => fileContents[fp] ?? null,
    getProjectRoot: () => '/test',
    getAllFiles: () => Array.from(allFiles),
    getImportMappings: () => [],
  };
}

function rustFn(name: string, filePath: string, startLine = 10): Node {
  return {
    id: `rust:${filePath}:${name}:${startLine}`,
    kind: 'function',
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: 'rust',
    startLine,
    endLine: startLine + 5,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  } as Node;
}

function rustStruct(name: string, filePath: string, startLine = 10): Node {
  return {
    id: `rust:${filePath}:${name}:${startLine}`,
    kind: 'struct',
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: 'rust',
    startLine,
    endLine: startLine + 5,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  } as Node;
}

function ref(name: string, language: Language, filePath: string): UnresolvedRef {
  return {
    fromNodeId: `caller:${filePath}`,
    referenceName: name,
    referenceKind: 'calls',
    line: 1,
    column: 0,
    filePath,
    language,
  };
}

describe('Tauri IPC bridge resolver', () => {
  describe('detect()', () => {
    it('returns true when tauri.conf.json exists at root', () => {
      const ctx = makeContext([], { 'tauri.conf.json': '{}' });
      expect(tauriBridgeResolver.detect(ctx)).toBe(true);
    });

    it('returns true when tauri.conf.json exists in a subdirectory', () => {
      const ctx = makeContext([], {
        'apps/desktop/src-tauri/tauri.conf.json': '{}',
      });
      expect(tauriBridgeResolver.detect(ctx)).toBe(true);
    });

    it('returns true when package.json depends on @tauri-apps/api', () => {
      const ctx = makeContext([], {
        'package.json': '{"dependencies":{"@tauri-apps/api":"^2.0.0"}}',
      });
      expect(tauriBridgeResolver.detect(ctx)).toBe(true);
    });

    it('returns false when no Tauri signals are present', () => {
      const ctx = makeContext([], {
        'package.json': '{"dependencies":{"react":"^18.0"}}',
      });
      expect(tauriBridgeResolver.detect(ctx)).toBe(false);
    });
  });

  describe('commands', () => {
    it('resolves typed camelCase call to snake_case Rust command', () => {
      const node = rustFn('get_mcp_port', 'src/commands/settings.rs');
      const ctx = makeContext([node], {
        'src-tauri/tauri.conf.json': '{}',
        'src/commands/settings.rs':
          '#[tauri::command]\npub async fn get_mcp_port() -> u16 { 0 }\n',
      });
      const result = tauriBridgeResolver.resolve(
        ref('getMcpPort', 'typescript', 'src/settings.ts'),
        ctx
      );
      expect(result?.targetNodeId).toBe(node.id);
      expect(result?.resolvedBy).toBe('framework');
    });

    it('resolves receiver-qualified call (commands.getMcpPort)', () => {
      const node = rustFn('get_mcp_port', 'src/commands/settings.rs');
      const ctx = makeContext([node], {
        'src-tauri/tauri.conf.json': '{}',
        'src/commands/settings.rs':
          '#[tauri::command]\npub async fn get_mcp_port() -> u16 { 0 }\n',
      });
      const result = tauriBridgeResolver.resolve(
        ref('commands.getMcpPort', 'typescript', 'src/settings.ts'),
        ctx
      );
      expect(result?.targetNodeId).toBe(node.id);
    });

    it('resolves raw invoke with snake_case wire name', () => {
      const node = rustFn('list_directory', 'src/commands/fs.rs');
      const ctx = makeContext([node], {
        'src-tauri/tauri.conf.json': '{}',
        'src/commands/fs.rs':
          '#[tauri::command]\npub async fn list_directory(path: String) -> Vec<Entry> { vec![] }\n',
      });
      const result = tauriBridgeResolver.resolve(
        ref('list_directory', 'typescript', 'src/fs.ts'),
        ctx
      );
      expect(result?.targetNodeId).toBe(node.id);
    });

    it('handles commands with multiple attributes (specta + tauri::command)', () => {
      const node = rustFn('get_settings', 'src/commands/settings.rs');
      const ctx = makeContext([node], {
        'src-tauri/tauri.conf.json': '{}',
        'src/commands/settings.rs':
          '#[specta::specta]\n#[tauri::command]\npub async fn get_settings() -> Settings { todo!() }\n',
      });
      const result = tauriBridgeResolver.resolve(
        ref('getSettings', 'typescript', 'src/app.ts'),
        ctx
      );
      expect(result?.targetNodeId).toBe(node.id);
    });

    it('returns null for a Rust-language caller', () => {
      const node = rustFn('get_mcp_port', 'src/commands/settings.rs');
      const ctx = makeContext([node], {
        'src-tauri/tauri.conf.json': '{}',
        'src/commands/settings.rs':
          '#[tauri::command]\npub async fn get_mcp_port() -> u16 { 0 }\n',
      });
      expect(
        tauriBridgeResolver.resolve(ref('get_mcp_port', 'rust', 'src/other.rs'), ctx)
      ).toBeNull();
    });

    it('returns null when no matching command exists', () => {
      const ctx = makeContext([], {
        'src-tauri/tauri.conf.json': '{}',
      });
      expect(
        tauriBridgeResolver.resolve(ref('nonExistent', 'typescript', 'src/app.ts'), ctx)
      ).toBeNull();
    });
  });

  describe('events', () => {
    it('resolves typed camelCase event listener to Rust Event struct', () => {
      const node = rustStruct('VolumeSpaceChanged', 'src/space_poller.rs');
      const ctx = makeContext([node], {
        'src-tauri/tauri.conf.json': '{}',
        'src/space_poller.rs':
          '#[derive(Clone, serde::Serialize, tauri_specta::Event)]\npub struct VolumeSpaceChanged { pub path: String }\n',
      });
      const result = tauriBridgeResolver.resolve(
        ref('volumeSpaceChanged', 'typescript', 'src/volumes.ts'),
        ctx
      );
      expect(result?.targetNodeId).toBe(node.id);
      expect(result?.resolvedBy).toBe('framework');
    });

    it('resolves receiver-qualified event (events.volumeSpaceChanged)', () => {
      const node = rustStruct('VolumeSpaceChanged', 'src/space_poller.rs');
      const ctx = makeContext([node], {
        'src-tauri/tauri.conf.json': '{}',
        'src/space_poller.rs':
          '#[derive(Clone, serde::Serialize, tauri_specta::Event)]\npub struct VolumeSpaceChanged { pub path: String }\n',
      });
      const result = tauriBridgeResolver.resolve(
        ref('events.volumeSpaceChanged', 'typescript', 'src/volumes.ts'),
        ctx
      );
      expect(result?.targetNodeId).toBe(node.id);
    });

    it('resolves raw kebab-case event listener', () => {
      const node = rustStruct('VolumeSpaceChanged', 'src/space_poller.rs');
      const ctx = makeContext([node], {
        'src-tauri/tauri.conf.json': '{}',
        'src/space_poller.rs':
          '#[derive(Clone, serde::Serialize, tauri_specta::Event)]\npub struct VolumeSpaceChanged { pub path: String }\n',
      });
      const result = tauriBridgeResolver.resolve(
        ref('volume-space-changed', 'typescript', 'src/volumes.ts'),
        ctx
      );
      expect(result?.targetNodeId).toBe(node.id);
    });

    it('returns null for a Rust-language listener', () => {
      const node = rustStruct('VolumeSpaceChanged', 'src/space_poller.rs');
      const ctx = makeContext([node], {
        'src-tauri/tauri.conf.json': '{}',
        'src/space_poller.rs':
          '#[derive(Clone, serde::Serialize, tauri_specta::Event)]\npub struct VolumeSpaceChanged { pub path: String }\n',
      });
      expect(
        tauriBridgeResolver.resolve(
          ref('VolumeSpaceChanged', 'rust', 'src/other.rs'),
          ctx
        )
      ).toBeNull();
    });

    it('handles bare Event derive (use tauri_specta::Event in scope)', () => {
      const node = rustStruct('AccentColorChanged', 'src/theme.rs');
      const ctx = makeContext([node], {
        'src-tauri/tauri.conf.json': '{}',
        'src/theme.rs':
          'use tauri_specta::Event;\n' +
          '#[derive(Clone, Serialize, Event)]\n' +
          'pub struct AccentColorChanged { pub color: String }\n',
      });
      const result = tauriBridgeResolver.resolve(
        ref('accentColorChanged', 'typescript', 'src/theme.ts'),
        ctx
      );
      expect(result?.targetNodeId).toBe(node.id);
    });

    it('respects #[tauri_specta(event_name = "...")] override', () => {
      const node = rustStruct('LowDiskSpacePayload', 'src/space_poller.rs');
      const ctx = makeContext([node], {
        'src-tauri/tauri.conf.json': '{}',
        'src/space_poller.rs':
          '#[derive(Clone, Serialize, tauri_specta::Event)]\n' +
          '#[tauri_specta(event_name = "low-disk-space")]\n' +
          'pub struct LowDiskSpacePayload { pub path: String }\n',
      });
      // The override kebab name should resolve.
      const result = tauriBridgeResolver.resolve(
        ref('low-disk-space', 'typescript', 'src/space.ts'),
        ctx
      );
      expect(result?.targetNodeId).toBe(node.id);
    });
  });

  describe('extract() — raw invoke/listen wire names', () => {
    it('emits a reference for invoke(\'snake_name\') attributed to the file node', () => {
      const result = tauriBridgeResolver.extract!(
        'src/api.ts',
        "import { invoke } from '@tauri-apps/api/core';\n" +
        "export const detect = (t) => invoke('lang_detect', { text: t });\n"
      );
      expect(result.nodes).toEqual([]);
      expect(result.references).toHaveLength(1);
      const ref = result.references[0]!;
      expect(ref.referenceName).toBe('lang_detect');
      expect(ref.fromNodeId).toBe('file:src/api.ts');
      expect(ref.referenceKind).toBe('calls');
      expect(ref.language).toBe('typescript');
    });

    it('emits references for invoke<T>(...), listen(...), and once(...)', () => {
      const refs = tauriBridgeResolver.extract!(
        'src/x.tsx',
        "invoke<number>('get_port');\n" +
        "listen('volume-space-changed', cb);\n" +
        "once('app-ready', cb);\n"
      ).references.map((r) => r.referenceName);
      expect(refs).toEqual(['get_port', 'volume-space-changed', 'app-ready']);
    });

    it('skips dynamic (non-literal) names', () => {
      const refs = tauriBridgeResolver.extract!(
        'src/x.ts',
        'invoke(cmdName);\ninvoke(`evt_${id}`);\n'
      ).references;
      expect(refs).toEqual([]);
    });

    it('returns nothing for a non-JS file', () => {
      const result = tauriBridgeResolver.extract!('src/main.rs', "invoke('x')");
      expect(result.references).toEqual([]);
    });
  });
});

describe('Tauri IPC end-to-end', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-ipc-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('links a TS typed command call to a Rust #[tauri::command] fn', async () => {
    // Minimal Tauri project structure.
    const srcTauri = path.join(dir, 'src-tauri', 'src');
    fs.mkdirSync(srcTauri, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src-tauri', 'tauri.conf.json'),
      '{"identifier":"test"}'
    );
    fs.writeFileSync(
      path.join(dir, 'src-tauri', 'Cargo.toml'),
      '[package]\nname = "test"\nversion = "0.1.0"\n'
    );
    fs.writeFileSync(
      path.join(srcTauri, 'main.rs'),
      '#[tauri::command]\npub async fn get_mcp_port() -> u16 { 9090 }\n'
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      '{"dependencies":{"@tauri-apps/api":"^2.0.0"}}'
    );
    fs.writeFileSync(
      path.join(dir, 'settings.ts'),
      'import { commands } from "./bindings";\n' +
      'export async function loadPort() { return commands.getMcpPort(); }\n'
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    // The Rust command fn should be in the graph.
    const rustNodes = db.prepare(
      "SELECT * FROM nodes WHERE name='get_mcp_port' AND language='rust'"
    ).all();
    expect(rustNodes.length).toBeGreaterThan(0);

    // The TS call site should have an edge to the Rust fn.
    const edges = db.prepare(
      `SELECT e.* FROM edges e
       JOIN nodes s ON s.id=e.source
       JOIN nodes t ON t.id=e.target
       WHERE t.name='get_mcp_port' AND t.language='rust'
         AND s.language IN ('typescript','tsx','javascript')
         AND e.kind IN ('calls','references')`
    ).all();

    cg.close?.();
    expect(edges.length).toBeGreaterThan(0);
  });

  it('links a TS typed event listener to a Rust Event struct', async () => {
    const srcTauri = path.join(dir, 'src-tauri', 'src');
    fs.mkdirSync(srcTauri, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src-tauri', 'tauri.conf.json'),
      '{"identifier":"test"}'
    );
    fs.writeFileSync(
      path.join(dir, 'src-tauri', 'Cargo.toml'),
      '[package]\nname = "test"\nversion = "0.1.0"\n'
    );
    fs.writeFileSync(
      path.join(srcTauri, 'lib.rs'),
      '#[derive(Clone, serde::Serialize, tauri_specta::Event)]\n' +
      'pub struct VolumeSpaceChanged {\n' +
      '    pub path: String,\n' +
      '    pub available: u64,\n' +
      '}\n'
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      '{"dependencies":{"@tauri-apps/api":"^2.0.0"}}'
    );
    fs.writeFileSync(
      path.join(dir, 'volumes.ts'),
      'import { events } from "./bindings";\n' +
      'events.volumeSpaceChanged.listen((e) => console.log(e));\n'
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    // The Rust Event struct should be in the graph.
    const rustNodes = db.prepare(
      "SELECT * FROM nodes WHERE name='VolumeSpaceChanged' AND language='rust'"
    ).all();
    expect(rustNodes.length).toBeGreaterThan(0);

    cg.close?.();
  });

  it('links a raw invoke(\'wire_name\') call to a Rust #[tauri::command] fn', async () => {
    // The non-specta convention: the wire name is a string literal, so the JS
    // extractor never emits it as a reference. extract() must surface it.
    const srcTauri = path.join(dir, 'src-tauri', 'src');
    fs.mkdirSync(srcTauri, { recursive: true });
    fs.writeFileSync(path.join(dir, 'src-tauri', 'tauri.conf.json'), '{"identifier":"test"}');
    fs.writeFileSync(
      path.join(dir, 'src-tauri', 'Cargo.toml'),
      '[package]\nname = "test"\nversion = "0.1.0"\n'
    );
    fs.writeFileSync(
      path.join(srcTauri, 'main.rs'),
      '#[tauri::command]\npub fn lang_detect(text: String) -> String { text }\n'
    );
    fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"@tauri-apps/api":"^2.0.0"}}');
    fs.writeFileSync(
      path.join(dir, 'detect.ts'),
      "import { invoke } from '@tauri-apps/api/core';\n" +
      "export const detect = (t: string) => invoke('lang_detect', { text: t });\n"
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const edges = db.prepare(
      `SELECT e.* FROM edges e
       JOIN nodes t ON t.id=e.target
       WHERE t.name='lang_detect' AND t.language='rust'
         AND json_extract(e.metadata,'$.resolvedBy')='framework'`
    ).all();

    cg.close?.();
    expect(edges.length).toBeGreaterThan(0);
  });
});
