/**
 * A Kotlin import from outside the project owns its name (#2196): after
 * `import androidx.compose.ui.Modifier`, `Modifier.fillMaxSize()` is
 * Compose's, never a project method that happens to be called `fillMaxSize`.
 * But Kotlin lets the project extend that type — `fun Modifier.pad()`,
 * indexed as `Modifier::pad` — and `Modifier.pad()` is that extension when
 * the call site can see it: in its own package, or imported by name or `.*`.
 * `fun Color.Companion.fromHex()` is called the same way, `Color.fromHex()`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-kotlin-ext-imported-'));
  const files: Record<string, string> = {
    'src/main/kotlin/app/ui/Ext.kt': `package app.ui

import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color

fun Modifier.pad(): Modifier = this

fun Modifier.hidden(): Modifier = this

fun Color.Companion.fromHex(hex: String): Color = Color.Red
`,
    'src/main/kotlin/app/other/Box.kt': `package app.other

class Box {
    fun fillMaxSize(): Box = this
}
`,
    'src/main/kotlin/app/gen/Gen.kt': `package app.gen

import javax.lang.model.element.Modifier

fun Modifier.keyword(): String = name
`,
    'src/main/kotlin/app/ui/Screen.kt': `package app.ui

import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color

fun screen() {
    Modifier.pad()
    Modifier.fillMaxSize()
    Color.fromHex("#fff")
}
`,
    'src/main/kotlin/app/feature/Feed.kt': `package app.feature

import androidx.compose.ui.Modifier
import app.gen.keyword
import app.ui.pad

fun feed() {
    Modifier.pad()
    Modifier.hidden()
    Modifier.keyword()
}
`,
    'src/main/kotlin/app/settings/Settings.kt': `package app.settings

import androidx.compose.ui.Modifier
import app.ui.*

fun settings() {
    Modifier.hidden()
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

/** `kind qualified-name` of every non-structural edge out of a file. */
function edgesFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind !== 'contains' && e.kind !== 'imports')
    .map((e) => `${e.kind} ${cg.getNode(e.target)!.qualifiedName}`)
    .sort();
}

describe('Kotlin: a project extension on a type an outside import names', () => {
  it('is what a call on that type reaches from the same package; the type’s own members stay outside', () => {
    expect(edgesFrom('src/main/kotlin/app/ui/Screen.kt')).toEqual([
      'calls Color::fromHex',
      'calls Modifier::pad',
    ]);
  });

  it('is reached from another package only through an import of it, by name or `.*`', () => {
    expect(edgesFrom('src/main/kotlin/app/feature/Feed.kt')).toEqual(['calls Modifier::pad']);
    expect(edgesFrom('src/main/kotlin/app/settings/Settings.kt')).toEqual(['calls Modifier::hidden']);
  });
});
