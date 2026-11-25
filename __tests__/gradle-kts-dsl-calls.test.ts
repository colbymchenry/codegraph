/**
 * A Gradle script's bare calls — `plugins { }`, `dependencies { }`,
 * `api(projects.core)` — run on the build tool's own types, never on a class
 * the project declares: nowinandroid's 110 such calls went to its build
 * logic's `Graph.plugins()` / `Graph.dependencies()` and a lint registry's
 * `api` property. Build logic's extension functions on Gradle's types stay.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-gradle-kts-'));
  const files: Record<string, string> = {
    'build-logic/src/main/kotlin/com/example/Graph.kt': `package com.example

class Graph {
    fun plugins(): List<String> = emptyList()
    fun dependencies(): List<String> = emptyList()
}
`,
    'build-support/src/main/kotlin/SourceSets.kt': `import org.gradle.api.NamedDomainObjectContainer

fun NamedDomainObjectContainer<String>.createSourceSet(name: String) {
}
`,
    'app/build.gradle.kts': `plugins {
    id("com.android.application")
}

dependencies {
    implementation(libs.core)
}

kotlin {
    sourceSets {
        createSourceSet("nonJvm")
    }
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('Gradle Kotlin script calls', () => {
  it('never reach a member of a project class, but reach build-logic extensions', () => {
    const ids = cg.getNodesInFile('app/build.gradle.kts').map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.name);
    expect(targets).not.toContain('plugins');
    expect(targets).not.toContain('dependencies');
    expect(targets).toContain('createSourceSet');
  });
});
