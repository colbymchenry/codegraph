/**
 * Tauri IPC cross-language bridge resolver.
 *
 * Joins TypeScript command/event callsites to their Rust handlers:
 *
 * **Commands** (TS call -> Rust fn):
 *   - Typed (tauri-specta): `commands.fooBar(...)` where `fooBar` is the
 *     camelCase form of a `#[tauri::command] fn foo_bar`.
 *   - Raw: `invoke('foo_bar', ...)` using the exact snake_case wire name.
 *
 * **Events** (TS listen -> Rust emit):
 *   - Typed: `events.fooBar.listen(...)` or wrapper functions.
 *   - Raw: `listen('foo-bar', ...)` using the kebab-case wire name.
 *
 * The resolver only redirects JS/TS callers to Rust targets; Rust-side
 * references resolve through the normal Rust extractor.
 *
 * The wire join is a heuristic name inference (the real link is a runtime IPC
 * hop, not an AST edge), so it runs through `resolve()` like the React Native /
 * Fabric native bridges: the edge carries `metadata.resolvedBy: 'framework'`
 * with a sub-1.0 confidence, and an exact name-match always wins a tie. (The
 * `provenance:'heuristic'` column is reserved for `callback-synthesizer.ts`,
 * which fabricates edges for dynamic dispatch that has no statically-resolvable
 * name; a Tauri command/event name IS statically joinable, so it belongs on the
 * resolver path.)
 */
import type { Language, Node } from '../../types';
import {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolutionContext,
  UnresolvedRef,
} from '../types';

// -- Name conversion utilities ------------------------------------------------

/** snake_case -> camelCase (e.g. `get_mcp_port` -> `getMcpPort`). */
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** kebab-case -> snake_case (e.g. `volume-space-changed` -> `volume_space_changed`). */
function kebabToSnake(s: string): string {
  return s.replace(/-/g, '_');
}

/** PascalCase -> snake_case (e.g. `VolumeSpaceChanged` -> `volume_space_changed`). */
function pascalToSnake(s: string): string {
  return s.replace(/([A-Z])/g, (c, _, i) => (i > 0 ? '_' : '') + c.toLowerCase());
}

// -- Rust-side index ----------------------------------------------------------

interface TauriCommand {
  /** snake_case Rust fn name (the wire name). */
  rustName: string;
  /** The graph node for the Rust fn. */
  node: Node;
}

interface TauriEvent {
  /** snake_case form of the event struct name. */
  rustName: string;
  /** The graph node for the Rust struct/enum. */
  node: Node;
}

/** Per-context lazy cache. */
const indexCache: WeakMap<
  ResolutionContext,
  { commands: Map<string, TauriCommand>; events: Map<string, TauriEvent> }
> = new WeakMap();

/**
 * Scan all Rust files for `#[tauri::command]` functions and event structs,
 * building lookup maps keyed by the JS-visible name.
 */
function buildIndex(context: ResolutionContext) {
  const cached = indexCache.get(context);
  if (cached) return cached;

  const commands = new Map<string, TauriCommand>();
  const events = new Map<string, TauriEvent>();

  for (const file of context.getAllFiles()) {
    if (!file.endsWith('.rs')) continue;
    const source = context.readFile(file);
    if (!source) continue;

    // Commands: #[tauri::command] (possibly preceded by #[specta::specta])
    // followed by `fn name`.
    if (source.includes('tauri::command')) {
      const nodes = context.getNodesInFile(file);
      // Attributes can appear in either order. Match the fn that follows
      // an attribute block containing #[tauri::command].
      const cmdRegex = /(?:#\[[^\]]*\]\s*)*#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g;
      let m: RegExpExecArray | null;
      while ((m = cmdRegex.exec(source)) !== null) {
        const rustName = m[1]!;
        const camelName = snakeToCamel(rustName);
        const node = nodes.find(
          (n) => n.name === rustName && (n.kind === 'function' || n.kind === 'method')
        );
        if (!node) continue;
        const entry: TauriCommand = { rustName, node };
        commands.set(camelName, entry);
        commands.set(rustName, entry);
      }
    }

    // Events: struct deriving Event (tauri_specta::Event, tauri::Event, or
    // bare Event when `use tauri_specta::Event` is in scope).
    if (source.includes('Event')) {
      const eventRegex =
        /#\[derive\([^\)]*\b(?:tauri_specta::|tauri::)?Event\b[^\)]*\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?struct\s+(\w+)/g;
      let m: RegExpExecArray | null;
      while ((m = eventRegex.exec(source)) !== null) {
        const structName = m[1]!;

        // Check for #[tauri_specta(event_name = "...")] override between
        // the derive and the struct keyword.
        const blockBefore = source.slice(
          Math.max(0, m.index - 200),
          m.index + m[0].length
        );
        const overrideMatch = blockBefore.match(
          /#\[tauri_specta\s*\(\s*event_name\s*=\s*"([^"]+)"\s*\)\]/
        );

        const snakeName = pascalToSnake(structName);
        const camelName = snakeToCamel(snakeName);
        const kebabName = overrideMatch?.[1] ?? snakeName.replace(/_/g, '-');
        const nodes = context.getNodesInFile(file);
        const node = nodes.find(
          (n) => n.name === structName && (n.kind === 'struct' || n.kind === 'enum')
        );
        if (!node) continue;
        const entry: TauriEvent = { rustName: structName, node };
        events.set(camelName, entry);
        events.set(kebabName, entry);
        events.set(structName, entry);
        events.set(snakeName, entry);
      }
    }
  }

  const result = { commands, events };
  indexCache.set(context, result);
  return result;
}

// -- Extraction (raw invoke/listen wire-name references) ----------------------

const JS_EXT_TO_LANGUAGE: Record<string, Language> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.svelte': 'svelte',
  '.vue': 'typescript',
};

function jsLanguageForFile(filePath: string): Language | null {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return null;
  return JS_EXT_TO_LANGUAGE[filePath.slice(dot).toLowerCase()] ?? null;
}

/**
 * Raw Tauri IPC uses string wire names the JS extractor never emits as
 * references: `invoke('foo_bar')`, `listen('foo-bar')`, `once('foo-bar')`. The
 * command/event name is a string argument, so the only call edge extraction
 * records is to `invoke`/`listen` itself, and `resolve()` never sees the wire
 * name. (The typed `commands.fooBar()` / `events.fooBar.listen()` path doesn't
 * need this: those are member accesses the JS extractor already emits a `fooBar`
 * reference for.) This scan surfaces each wire name as a `calls` reference so
 * `resolve()` can join it to the Rust handler / Event struct.
 *
 * Matches the `invoke`/`listen`/`once` API name on an identifier boundary
 * (`\b`), with optional generics and a string-literal first argument. A
 * dynamic name (`invoke(`${x}`)`) fails the literal match and is skipped.
 * Over-matching is harmless: `resolve()` only joins names that hit a real
 * command/event, so a stray `arr.includes(...)`-style call resolves to nothing.
 */
const WIRE_CALL_RE = /\b(?:invoke|listen|once)\s*(?:<[^>(]*>)?\s*\(\s*(['"`])([\w./:-]+)\1/g;

/**
 * Attributed to the file node (`file:<path>`, a stable un-hashed id) rather
 * than the enclosing function: a function's node id is a sha256 of
 * `path:kind:name:line`, which a string scan can't reconstruct without
 * re-parsing. File granularity still answers "which files use this command" for
 * `callers` / `impact` — coarser than the typed path's call-site edge, but
 * accurate and robust.
 */
function extractWireReferences(filePath: string, source: string): UnresolvedRef[] {
  const language = jsLanguageForFile(filePath);
  if (!language) return [];

  const refs: UnresolvedRef[] = [];
  const fromNodeId = `file:${filePath}`;
  WIRE_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIRE_CALL_RE.exec(source)) !== null) {
    const wireName = m[2]!;
    // Line/column of the wire-name literal, for the edge's location.
    const upto = source.slice(0, m.index);
    const line = upto.split('\n').length;
    const lastNl = upto.lastIndexOf('\n');
    refs.push({
      fromNodeId,
      referenceName: wireName,
      referenceKind: 'calls',
      line,
      column: m.index - lastNl - 1,
      filePath,
      language,
    });
  }
  return refs;
}

// -- Resolver -----------------------------------------------------------------

const TS_LANGUAGES = new Set(['javascript', 'typescript', 'tsx', 'jsx', 'svelte']);

export const tauriBridgeResolver: FrameworkResolver = {
  name: 'tauri-ipc',
  languages: ['javascript', 'typescript', 'tsx', 'jsx', 'svelte', 'rust'],

  detect(context) {
    // tauri.conf.json (or tauri.conf.json5) is the definitive marker at root.
    if (context.fileExists('tauri.conf.json') || context.fileExists('tauri.conf.json5')) {
      return true;
    }
    // Nested Tauri app (e.g. monorepo): check for src-tauri/tauri.conf.json if tracked,
    // though json files might not be tracked.
    const files = context.getAllFiles();
    for (const f of files) {
      if (f.endsWith('tauri.conf.json') || f.endsWith('tauri.conf.json5')) return true;
    }
    // Fallback 1: package.json at root depends on @tauri-apps/api.
    const pkg = context.readFile('package.json');
    if (pkg && /"@tauri-apps\/api"/.test(pkg)) return true;
    
    // Fallback 2 (Definitive for monorepos): any tracked Rust file uses tauri::command.
    for (const f of files) {
      if (!f.endsWith('.rs')) continue;
      const src = context.readFile(f);
      if (src && src.includes('tauri::command')) return true;
    }

    return false;
  },

  extract(filePath, source): FrameworkExtractionResult {
    // Only the raw `invoke`/`listen`/`once` wire-name references; the typed
    // `commands.*` / `events.*` path resolves through the JS extractor's own
    // member references. No framework nodes.
    if (!source.includes('invoke') && !source.includes('listen') && !source.includes('once')) {
      return { nodes: [], references: [] };
    }
    return { nodes: [], references: extractWireReferences(filePath, source) };
  },

  resolve(ref, context) {
    // Only redirect JS/TS callers.
    if (!TS_LANGUAGES.has(ref.language)) return null;

    const { commands, events } = buildIndex(context);

    // Strip receiver prefix: `commands.getMcpPort` -> `getMcpPort`,
    // `events.volumeSpaceChanged` -> `volumeSpaceChanged`.
    const name = ref.referenceName.includes('.')
      ? ref.referenceName.slice(ref.referenceName.lastIndexOf('.') + 1)
      : ref.referenceName;

    // Try command lookup first.
    let entry = commands.get(name);
    // For raw invoke('snake_name'), also try kebab -> snake conversion.
    if (!entry) entry = commands.get(kebabToSnake(name));
    if (entry) {
      return {
        original: ref,
        targetNodeId: entry.node.id,
        confidence: 0.7,
        resolvedBy: 'framework',
      };
    }

    // Try event lookup.
    let evt = events.get(name);
    if (!evt) evt = events.get(kebabToSnake(name));
    if (evt) {
      return {
        original: ref,
        targetNodeId: evt.node.id,
        confidence: 0.6,
        resolvedBy: 'framework',
      };
    }

    return null;
  },
};
