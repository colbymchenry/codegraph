/**
 * Protobuf contract synthesis — a `.proto` declaration to its generated peers.
 *
 * One `.proto` field is implemented again in every language the project
 * generates for: a Python module, an Elixir module, a TypeScript declaration, a
 * Go struct. Every one of those sites is machine-written and must never be
 * hand-edited, which means the `.proto` is the ONLY place the shared shape is
 * authored — and, without these edges, the only place with no link to anything
 * that consumes it.
 *
 * That gap is where a specific family of defects lives, and each member of it
 * is invisible to every tier's own checks by construction:
 *
 *   - a field decoded on one side but never read on another;
 *   - a field whose meaning changed while its name and tag did not;
 *   - a field the server stopped sending that a client still declares.
 *
 * Each is green in every single-language gate and wrong at runtime. Linking the
 * three sites is what makes "I am changing this field — what else moves in the
 * same commit" a question the graph can answer.
 *
 * DISCOVERY IS BY CONVENTION, NOT CONFIGURATION. Every protobuf generator names
 * its output after the `.proto` it came from (`foo.proto` → `foo_pb2.py`,
 * `foo.pb.ex`, `foo.pb.go`, `foo_pb.ts`), and those conventions are published
 * and stable. Nothing here needs a project to declare its layout.
 *
 * PRECISION COMES FROM THE PEER-FILE GATE. A field named `id` is linked only to
 * symbols inside the generated peers OF ITS OWN `.proto`, never repo-wide — the
 * scoping that makes a name as common as `id` or `name` safe to match on. A
 * proto with no generated peers in the index produces nothing.
 */

import type { Edge, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';

/** Backstop only; a real project is a handful of peers per proto. */
const FANOUT_CAP = 20000;

/** Generated-peer filename markers, in the spelling each generator emits. */
const PEER_SUFFIXES = [
  '_pb2', '_pb2_grpc', // Python (protoc), and its grpc service stub
  '_pb', '_grpc',      // TypeScript / JS (protoc-gen-js, ts-proto), Go grpc
  '.pb', '.pb.gw',     // Go, Elixir, and grpc-gateway
  'pb',                // `<name>pb` package-style output
];

/** Kinds a generated MESSAGE or ENUM can take across the target languages. */
const TYPE_KINDS = new Set<Node['kind']>([
  'class', 'struct', 'interface', 'module', 'type_alias', 'enum', 'namespace',
]);

/** Kinds a generated FIELD can take (a property, an accessor, a constant). */
const MEMBER_KINDS = new Set<Node['kind']>([
  'field', 'property', 'variable', 'constant', 'method', 'function', 'enum_member',
]);

/**
 * The stem a generated file shares with its `.proto`: `foo_pb2.py` → `foo`,
 * `foo.pb.ex` → `foo`, `foo_grpc.pb.go` → `foo`. Returns null when the name
 * carries no generator marker at all, which is what keeps a hand-written
 * `foo.ts` sitting beside `foo.proto` from being treated as generated output.
 */
export function generatedPeerStem(filePath: string): string | null {
  const base = filePath.split('/').pop() ?? '';
  // Strip the real extension, then any further generator-added extensions
  // (`.pb.ex` and `.pb.go` both leave a trailing `.pb`).
  let stem = base.replace(/\.[^.]+$/, '');
  let matched = false;
  for (;;) {
    const before = stem;
    for (const suffix of PEER_SUFFIXES) {
      if (suffix.startsWith('.')) {
        if (stem.toLowerCase().endsWith(suffix)) {
          stem = stem.slice(0, -suffix.length);
          matched = true;
        }
      } else if (stem.toLowerCase().endsWith(`_${suffix.replace(/^_/, '')}`)) {
        stem = stem.slice(0, -(suffix.replace(/^_/, '').length + 1));
        matched = true;
      }
    }
    if (stem === before) break;
  }
  if (!matched || !stem) return null;
  return stem.toLowerCase();
}

/**
 * The spellings a generator may give one protobuf name. Protobuf declares
 * fields in `snake_case` and types in `PascalCase`; the generators then apply
 * their target language's convention — `observed_at` becomes `observedAt` in
 * TypeScript, `ObservedAt` in Go and C#, and stays `observed_at` in Python and
 * Elixir. A generated accessor may also be prefixed (`getObservedAt`).
 */
export function nameVariants(name: string): string[] {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return [name];
  const snake = words.join('_');
  const pascal = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
  const camel = pascal[0]!.toLowerCase() + pascal.slice(1);
  const screaming = snake.toUpperCase();
  return [...new Set([name, snake, camel, pascal, screaming, `get${pascal}`, `set${pascal}`])];
}

/** Group nodes under every spelling a generator might have used. */
function indexByVariant(nodes: Node[]): Map<string, Node[]> {
  const out = new Map<string, Node[]>();
  for (const node of nodes) {
    for (const variant of nameVariants(node.name)) {
      let bucket = out.get(variant);
      if (!bucket) { bucket = []; out.set(variant, bucket); }
      bucket.push(node);
    }
  }
  return out;
}

/** Simple (last) segment of a dotted protobuf fully-qualified name. */
function simpleName(qualifiedName: string): string {
  const dot = qualifiedName.lastIndexOf('.');
  return dot >= 0 ? qualifiedName.slice(dot + 1) : qualifiedName;
}

/** Simple name of the declaration a member belongs to (`a.b.Msg.f` → `Msg`). */
function declaringName(qualifiedName: string): string | null {
  const parts = qualifiedName.split('.');
  return parts.length >= 2 ? parts[parts.length - 2]! : null;
}

/** The tag a proto field node carries, for the edge's metadata. */
function tagOf(node: Node): number | undefined {
  const marker = node.decorators?.find((d) => d.startsWith('tag='));
  return marker ? Number(marker.slice(4)) : undefined;
}

export async function protobufContractEdges(
  ctx: ResolutionContext,
  onYield: MaybeYield
): Promise<Edge[]> {
  // Proto declarations, grouped by the file they came from.
  const protoNodesByFile = new Map<string, Node[]>();
  let scanned = 0;
  for (const kind of ['struct', 'enum', 'interface', 'field', 'method', 'enum_member'] as const) {
    for (const node of ctx.iterateNodesByKind?.(kind) ?? ctx.getNodesByKind(kind)) {
      if ((++scanned & 63) === 0) await onYield();
      if (node.language !== 'proto') continue;
      // A reservation is not a live declaration and has no generated peer.
      if (node.decorators?.includes('reserved')) continue;
      let bucket = protoNodesByFile.get(node.filePath);
      if (!bucket) { bucket = []; protoNodesByFile.set(node.filePath, bucket); }
      bucket.push(node);
    }
  }
  if (protoNodesByFile.size === 0) return [];

  // Candidate generated files, grouped by the stem they were generated from.
  // Built once for the whole project: the join is stem-to-stem, so a proto only
  // ever sees the outputs that name it.
  const peersByStem = new Map<string, string[]>();
  for (const filePath of ctx.getAllFiles()) {
    if ((++scanned & 63) === 0) await onYield();
    const stem = generatedPeerStem(filePath);
    if (!stem) continue;
    let bucket = peersByStem.get(stem);
    if (!bucket) { bucket = []; peersByStem.set(stem, bucket); }
    bucket.push(filePath);
  }
  if (peersByStem.size === 0) return [];

  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const [protoPath, protoNodes] of protoNodesByFile) {
    await onYield();
    const stem = (protoPath.split('/').pop() ?? '').replace(/\.proto$/i, '').toLowerCase();
    const peerFiles = peersByStem.get(stem);
    if (!peerFiles || peerFiles.length === 0) continue;

    // Every symbol in this proto's generated outputs, indexed by the spellings
    // a generator could have produced. Scoped to these files — that scoping is
    // what makes matching on a name as common as `id` safe.
    const peerNodes: Node[] = [];
    for (const peerFile of peerFiles) {
      if (peerFile === protoPath) continue;
      for (const node of ctx.getNodesInFile(peerFile)) {
        if (node.kind === 'file' || node.kind === 'import') continue;
        peerNodes.push(node);
      }
    }
    if (peerNodes.length === 0) continue;
    const byVariant = indexByVariant(peerNodes);

    const lookup = (name: string, allowed: Set<Node['kind']>): Node[] => {
      const found: Node[] = [];
      for (const variant of nameVariants(name)) {
        for (const candidate of byVariant.get(variant) ?? []) {
          if (!allowed.has(candidate.kind)) continue;
          if (candidate.language === 'proto') continue;
          found.push(candidate);
        }
      }
      return found;
    };

    for (const protoNode of protoNodes) {
      const isMember = protoNode.kind === 'field' || protoNode.kind === 'enum_member'
        || protoNode.kind === 'method';
      const bare = simpleName(protoNode.qualifiedName) || protoNode.name;

      let matches = lookup(bare, isMember ? MEMBER_KINDS : TYPE_KINDS);
      // How the match was made, so a consumer can tell an exact peer from the
      // coarser fallback below.
      let match: 'symbol' | 'declaring-type' = 'symbol';

      // Fall back to the generated TYPE that declares this member.
      //
      // An rpc DOES find its generated method (every generator emits one), but
      // a message FIELD generally does not: Go struct fields, Python class
      // annotations and TypeScript interface members are all deliberately not
      // extracted as their own nodes, to keep the graph from exploding on
      // member-dense code. Without this fallback a field therefore has no edge
      // at all — and "I am changing this field, what else moves" is exactly the
      // question the contract is supposed to answer. Containment does not
      // rescue it either: dependents are traversed along incoming edges, and
      // `contains` points message → field, so a field's impact never climbs to
      // its message. Linking it to the declaring type is coarser than a member
      // edge but it is true — regenerating that type IS what the change
      // requires — and it names the right files.
      if (matches.length === 0 && isMember) {
        const owner = declaringName(protoNode.qualifiedName);
        if (owner) {
          matches = lookup(owner, TYPE_KINDS);
          match = 'declaring-type';
        }
      }
      if (matches.length === 0) continue;

      const tag = tagOf(protoNode);
      for (const target of matches) {
        const key = `${protoNode.id}>${target.id}`;
        if (seen.has(key) || edges.length >= FANOUT_CAP) continue;
        seen.add(key);
        // Direction: GENERATED → PROTO. Generated code is derived from the
        // `.proto`, so it is the dependent, and that is the direction impact
        // analysis traverses — "what else moves when I change this field"
        // walks a symbol's INCOMING edges. Emitting it the other way round
        // records the same relationship but leaves the question unanswered.
        edges.push({
          source: target.id,
          target: protoNode.id,
          kind: 'references',
          line: target.startLine,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'protobuf-contract',
            // What was matched and how, so a wrong edge is diagnosable and the
            // generated side is identifiable as generated.
            protoName: protoNode.qualifiedName,
            ...(tag !== undefined ? { tag } : {}),
            generatedIn: target.language,
            match,
            registeredAt: `${target.filePath}:${target.startLine}`,
          },
        });
      }
    }
  }

  return edges;
}
