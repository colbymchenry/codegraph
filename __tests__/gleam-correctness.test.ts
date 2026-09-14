import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Gleam graph correctness', () => {
  let projectDir = '';
  let graph: CodeGraph | undefined;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gleam-correctness-'));
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    graph?.destroy();
    graph = undefined;
    if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true, force: true });
  });

  function writeProjectFile(filePath: string, content: string): void {
    const absolutePath = path.join(projectDir, filePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }

  function unresolvedStatuses(filePath: string): Array<{ reference_name: string; status: string }> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(projectDir, '.codegraph', 'codegraph.db'));
    try {
      return db.prepare(
        'SELECT reference_name, status FROM unresolved_refs WHERE file_path = ? ORDER BY reference_name',
      ).all(filePath) as Array<{ reference_name: string; status: string }>;
    } finally {
      db.close();
    }
  }

  it('keeps opaque constructors private while exporting ordinary constructors', () => {
    const result = extractFromSource('src/types.gleam', [
      'pub opaque type Secret { Secret(value: String) }',
      'pub type Visible { Visible(value: String) }',
    ].join('\n'));

    expect(result.nodes.find((node) => node.kind === 'enum' && node.name === 'Secret')?.isExported).toBe(true);
    expect(result.nodes.find((node) => node.kind === 'enum_member' && node.name === 'Secret')?.isExported).toBe(false);
    expect(result.nodes.find((node) => node.kind === 'enum_member' && node.name === 'Visible')?.isExported).toBe(true);
  });

  it('resolves a local call to the constructor instead of its same-named type', async () => {
    writeProjectFile(
      'src/main.gleam',
      'pub type User { User(name: String) }\npub fn make() -> User { User("A") }\n',
    );

    graph = await CodeGraph.init(projectDir, { index: true });
    const make = graph.getNodesByKind('function').find((node) => node.name === 'make')!;
    const call = graph.getOutgoingEdges(make.id).find((edge) => edge.kind === 'calls')!;

    expect(graph.getNode(call.target)).toMatchObject({ kind: 'enum_member', name: 'User' });
  }, 30_000);

  it('resolves an imported call to the constructor instead of its same-named type', async () => {
    writeProjectFile('src/models.gleam', 'pub type User { User(name: String) }\n');
    writeProjectFile('src/main.gleam', 'import models.{User}\npub fn make() { User("A") }\n');

    graph = await CodeGraph.init(projectDir, { index: true });
    const make = graph.getNodesByKind('function').find((node) => node.name === 'make')!;
    const call = graph.getOutgoingEdges(make.id).find((edge) => edge.kind === 'calls')!;

    expect(graph.getNode(call.target)).toMatchObject({ kind: 'enum_member', name: 'User' });
  }, 30_000);

  it('extracts local and remote types from every Gleam type position', () => {
    const result = extractFromSource('src/domain.gleam', [
      'import app/models as models',
      'pub type Local { Local }',
      'pub type Event { Event(owner: models.User, local: Local) }',
      'pub type Owner = models.User',
      'pub fn convert(value: models.User, local: Local) -> Result(models.User, Local) { todo }',
    ].join('\n'));
    const refs = result.unresolvedReferences.filter((ref) => ref.referenceKind === 'references');
    const convert = result.nodes.find((node) => node.kind === 'function' && node.name === 'convert')!;
    const event = result.nodes.find((node) => node.kind === 'enum' && node.name === 'Event')!;
    const owner = result.nodes.find((node) => node.kind === 'type_alias' && node.name === 'Owner')!;

    expect(refs.filter((ref) => ref.fromNodeId === convert.id).map((ref) => ref.referenceName))
      .toEqual(expect.arrayContaining(['models.User', 'Local']));
    expect(refs.filter((ref) => ref.fromNodeId === event.id).map((ref) => ref.referenceName))
      .toEqual(expect.arrayContaining(['models.User', 'Local']));
    expect(refs.filter((ref) => ref.fromNodeId === owner.id).map((ref) => ref.referenceName))
      .toContain('models.User');
    expect(refs.some((ref) => ref.referenceName === 'Result')).toBe(false);
  });

  it('resolves local and imported Gleam type references end to end', async () => {
    writeProjectFile('src/models.gleam', 'pub type User { User(name: String) }\n');
    writeProjectFile('src/main.gleam', [
      'import models',
      'pub type Local { Local }',
      'pub type Event { Event(owner: models.User, local: Local) }',
      'pub type Owner = models.User',
      'pub fn convert(value: models.User, local: Local) -> Local { local }',
    ].join('\n'));

    graph = await CodeGraph.init(projectDir, { index: true });
    const owners = graph.getNodesByKind('function').filter((node) => node.name === 'convert');
    owners.push(...graph.getNodesByKind('enum').filter((node) => node.name === 'Event'));
    owners.push(...graph.getNodesByKind('type_alias').filter((node) => node.name === 'Owner'));
    const targets = owners.flatMap((ownerNode) =>
      graph!.getOutgoingEdges(ownerNode.id)
        .filter((edge) => edge.kind === 'references')
        .map((edge) => graph!.getNode(edge.target)),
    );

    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'enum', name: 'User', filePath: 'src/models.gleam' }),
      expect.objectContaining({ kind: 'enum', name: 'Local', filePath: 'src/main.gleam' }),
    ]));
  }, 30_000);

  it('keeps absent package and unshadowed prelude refs external without false edges', async () => {
    writeProjectFile('src/decoy.gleam', 'pub fn decode(value: String) -> String { value }\n');
    writeProjectFile('src/main.gleam', [
      'import external_pkg/json.{decode}',
      'pub fn main(value: String) {',
      '  let _ = decode(value)',
      '  Ok(Nil)',
      '}',
    ].join('\n'));

    graph = await CodeGraph.init(projectDir, { index: true });
    const main = graph.getNodesByKind('function').find((node) => node.name === 'main')!;

    expect(graph.getOutgoingEdges(main.id).filter((edge) => edge.kind === 'calls')).toHaveLength(0);
    expect(unresolvedStatuses('src/main.gleam')).toEqual(expect.arrayContaining([
      { reference_name: 'decode', status: 'external' },
      { reference_name: 'Ok', status: 'external' },
    ]));
  }, 30_000);

  it('resolves a project constructor that shadows a Gleam prelude name', async () => {
    writeProjectFile('src/project_result.gleam', 'pub type ProjectResult { Ok(value: String) }\n');
    writeProjectFile('src/main.gleam', [
      'import project_result.{Ok}',
      'pub fn main() { Ok("project") }',
    ].join('\n'));

    graph = await CodeGraph.init(projectDir, { index: true });
    const main = graph.getNodesByKind('function').find((node) => node.name === 'main')!;
    const call = graph.getOutgoingEdges(main.id).find((edge) => edge.kind === 'calls')!;

    expect(graph.getNode(call.target)).toMatchObject({
      kind: 'enum_member',
      name: 'Ok',
      filePath: 'src/project_result.gleam',
    });
  }, 30_000);

  it('does not treat an unrelated project constructor as a prelude shadow', async () => {
    writeProjectFile('src/logging.gleam', 'pub type LogLevel { Error }\n');
    writeProjectFile('src/main.gleam', 'pub fn main() { Error("prelude result") }\n');

    graph = await CodeGraph.init(projectDir, { index: true });
    const main = graph.getNodesByKind('function').find((node) => node.name === 'main')!;

    expect(graph.getOutgoingEdges(main.id).filter((edge) => edge.kind === 'calls')).toHaveLength(0);
    expect(unresolvedStatuses('src/main.gleam')).toContainEqual({
      reference_name: 'Error',
      status: 'external',
    });
  }, 30_000);

  it.each([
    ['without an import', 'pub fn make() { Secret("x") }\n'],
    ['through a selective import', 'import secret.{Secret}\npub fn make() { Secret("x") }\n'],
    ['through a namespace import', 'import secret\npub fn make() { secret.Secret("x") }\n'],
  ])('does not expose an opaque constructor across files %s', async (_label, mainSource) => {
    writeProjectFile('src/secret.gleam', 'pub opaque type Secret { Secret(value: String) }\n');
    writeProjectFile('src/main.gleam', mainSource);

    graph = await CodeGraph.init(projectDir, { index: true });
    const make = graph.getNodesByKind('function').find((node) => node.name === 'make')!;
    const wrongEdges = graph.getOutgoingEdges(make.id).filter((edge) => {
      if (edge.kind !== 'calls' && edge.kind !== 'instantiates') return false;
      return graph!.getNode(edge.target)?.filePath === 'src/secret.gleam';
    });

    expect(wrongEdges).toHaveLength(0);
  }, 30_000);

  it('resolves an opaque constructor inside its defining module', async () => {
    writeProjectFile(
      'src/secret.gleam',
      'pub opaque type Secret { Secret(value: String) }\nfn make() { Secret("x") }\n',
    );

    graph = await CodeGraph.init(projectDir, { index: true });
    const make = graph.getNodesByKind('function').find((node) => node.name === 'make')!;
    const call = graph.getOutgoingEdges(make.id).find((edge) => edge.kind === 'calls')!;

    expect(graph.getNode(call.target)).toMatchObject({
      kind: 'enum_member',
      name: 'Secret',
      filePath: 'src/secret.gleam',
      isExported: false,
    });
  }, 30_000);
});
