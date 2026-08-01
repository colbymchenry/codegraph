import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import {
  decodePostgresEnumValueMutationDescriptor,
  decodePostgresTypeRenameDescriptor,
} from '../src/postgres/type-lifecycle';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['postgres']);
});

describe('PostgreSQL enum rename lifecycle', () => {
  it('encodes type identity and old/new value labels without classifying the alias early', () => {
    const result = extractFromSource('db/renames.sql', [
      "CREATE TYPE app.job_status AS ENUM ('queued', 'running');",
      'ALTER TYPE app.job_status RENAME TO task_status;',
      "ALTER TYPE app.task_status RENAME VALUE 'queued' TO 'pending';",
    ].join('\n'), 'postgres');

    expect(result.errors).toEqual([]);
    const alias = result.nodes.find((node) => node.qualifiedName === 'app.task_status')!;
    expect(alias).toMatchObject({
      kind: 'type_alias',
      decorators: expect.arrayContaining(['postgres:type', 'postgres:renamed-type']),
    });
    expect(alias.decorators).not.toContain('postgres:enum');
    expect(decodePostgresTypeRenameDescriptor(alias.decorators)).toEqual({
      sourceType: 'app.job_status',
      targetType: 'app.task_status',
    });

    const pending = result.nodes.find((node) => node.qualifiedName === 'app.task_status.pending')!;
    expect(decodePostgresEnumValueMutationDescriptor(pending.decorators)).toEqual({
      mutation: 'rename',
      enumType: 'app.task_status',
      sourceValue: 'queued',
      targetValue: 'pending',
    });
  });

  it('carries exact effective membership through chained type and value renames', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-enum-lifecycle-'));
    fs.writeFileSync(
      path.join(projectDir, '001_enum.sql'),
      "CREATE TYPE app.job_status AS ENUM ('queued', 'running');\n"
    );
    fs.writeFileSync(
      path.join(projectDir, '002_first_rename.sql'),
      'ALTER TYPE app.job_status RENAME TO task_status;\n'
    );
    fs.writeFileSync(
      path.join(projectDir, '003_values.sql'),
      [
        "ALTER TYPE app.task_status ADD VALUE 'paused';",
        "ALTER TYPE app.task_status RENAME VALUE 'queued' TO 'pending';",
      ].join('\n') + '\n'
    );
    fs.writeFileSync(
      path.join(projectDir, '004_second_rename.sql'),
      'ALTER TYPE app.task_status RENAME TO workflow_status;\n'
    );
    fs.writeFileSync(
      path.join(projectDir, '005_final_values.sql'),
      [
        "ALTER TYPE app.workflow_status RENAME VALUE 'running' TO 'active';",
        "ALTER TYPE app.workflow_status ADD VALUE 'done';",
      ].join('\n') + '\n'
    );

    const graph = CodeGraph.initSync(projectDir);
    try {
      await graph.indexAll();
      const original = graph.getNodesByQualifiedName('app.job_status')[0]!;
      const intermediate = graph.getNodesByQualifiedName('app.task_status')[0]!;
      const current = graph.getNodesByQualifiedName('app.workflow_status')[0]!;

      expect(current).toMatchObject({
        kind: 'type_alias',
        decorators: expect.arrayContaining(['postgres:type', 'postgres:renamed-type']),
      });
      const relationTargets = (nodeId: string) => graph.getOutgoingEdges(nodeId)
        .filter((edge) => edge.metadata?.postgresRelation === 'enum-rename')
        .map((edge) => edge.target);
      expect(relationTargets(original.id)).toEqual([intermediate.id]);
      expect(relationTargets(intermediate.id)).toEqual([current.id]);

      const effectiveMembers = (nodeId: string) => graph.getOutgoingEdges(nodeId)
        .filter((edge) => edge.metadata?.postgresRelation === 'enum-effective-containment')
        .map((edge) => graph.getNode(edge.target)!.name)
        .sort();
      expect(effectiveMembers(intermediate.id)).toEqual(['paused', 'pending', 'running']);
      expect(effectiveMembers(current.id)).toEqual(['active', 'done', 'paused', 'pending']);
      expect(effectiveMembers(current.id)).not.toContain('queued');
      expect(effectiveMembers(current.id)).not.toContain('running');

      // Historical declarations and mutation nodes remain queryable even when
      // their labels are no longer part of the current enum identity.
      expect(graph.getNodesByQualifiedName('app.job_status.queued')).not.toEqual([]);
      expect(graph.getNodesByQualifiedName('app.task_status.pending')).not.toEqual([]);
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('records a native enum value rename as an explicit historical transition', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-native-enum-rename-'));
    fs.writeFileSync(
      path.join(projectDir, '001_enum.sql'),
      "CREATE TYPE app.status AS ENUM ('pending', 'active');\n"
    );
    fs.writeFileSync(
      path.join(projectDir, '002_rename.sql'),
      "ALTER TYPE app.status RENAME VALUE 'pending' TO 'queued';\n"
    );

    const graph = CodeGraph.initSync(projectDir);
    try {
      await graph.indexAll();
      const status = graph.getNodesByQualifiedName('app.status')[0]!;
      const pending = graph.getNodesByQualifiedName('app.status.pending')[0]!;
      const queued = graph.getNodesByQualifiedName('app.status.queued')[0]!;
      const containedMembers = graph.getOutgoingEdges(status.id)
        .filter((edge) => edge.kind === 'contains')
        .map((edge) => graph.getNode(edge.target)!)
        .filter((node) => node.kind === 'enum_member');

      // Ordinary containment is source history: CREATE TYPE's old label stays
      // queryable, and ALTER TYPE's replacement is attached by synthesis.
      expect(containedMembers.map((member) => member.name).sort()).toEqual([
        'active',
        'pending',
        'queued',
      ]);

      const transition = graph.getOutgoingEdges(pending.id).find(
        (edge) => edge.metadata?.postgresRelation === 'enum-value-rename'
      );
      expect(transition).toMatchObject({
        target: queued.id,
        kind: 'references',
        metadata: {
          postgresRelation: 'enum-value-rename',
          enumType: 'app.status',
          sourceValue: 'pending',
          targetValue: 'queued',
        },
      });

      const superseded = new Set(containedMembers
        .filter((member) => graph.getOutgoingEdges(member.id).some(
          (edge) => edge.metadata?.postgresRelation === 'enum-value-rename'
        ))
        .map((member) => member.id));
      expect(containedMembers
        .filter((member) => !superseded.has(member.id))
        .map((member) => member.name)
        .sort()).toEqual(['active', 'queued']);
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not infer enum identity for a renamed composite type', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-type-lifecycle-'));
    fs.writeFileSync(
      path.join(projectDir, '001_type.sql'),
      'CREATE TYPE app.point AS (x integer, y integer);\n'
    );
    fs.writeFileSync(
      path.join(projectDir, '002_rename.sql'),
      'ALTER TYPE app.point RENAME TO coordinate;\n'
    );

    const graph = CodeGraph.initSync(projectDir);
    try {
      await graph.indexAll();
      const alias = graph.getNodesByQualifiedName('app.coordinate')[0]!;
      expect(alias.kind).toBe('type_alias');
      expect(graph.getIncomingEdges(alias.id).some(
        (edge) => edge.metadata?.postgresRelation === 'enum-rename'
      )).toBe(false);
      expect(graph.getOutgoingEdges(alias.id).some(
        (edge) => edge.metadata?.postgresRelation === 'enum-effective-containment'
      )).toBe(false);
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
