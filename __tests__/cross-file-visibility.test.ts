/**
 * A definition the language makes file-local is not a candidate for a
 * cross-file name match: a C `static`, a Kotlin `private fun`, a Go unexported
 * identifier in another package, a Rust non-`pub` item outside its module
 * subtree. Each case pairs the invisible shape with the visible one of
 * identical form, so the assertion discriminates on visibility alone.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

function project(files: Record<string, string>): void {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-visibility-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tempDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/** `calls` targets of the function named `caller`, as `file:name` strings. */
async function calleesOf(caller: string): Promise<string[]> {
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  const from = cg.getNodesByKind('function').concat(cg.getNodesByKind('method')).find((n) => n.name === caller)!;
  expect(from).toBeDefined();
  return cg
    .getOutgoingEdges(from.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg!.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => `${n.filePath}:${n.name}`);
}

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('C: a static function is local to its translation unit', () => {
  it('does not resolve a call onto a static in another file', async () => {
    project({
      'core.c': 'void coreRun(void)\n{\n    usbGetDescriptor();\n}\n',
      'usb_audio.c': 'static void usbGetDescriptor(void)\n{\n}\n',
    });
    expect(await calleesOf('coreRun')).not.toContain('usb_audio.c:usbGetDescriptor');
  });

  it('still resolves onto a non-static function in another file', async () => {
    project({
      'core.c': 'void coreRun(void)\n{\n    usbGetDescriptor();\n}\n',
      'usb_audio.c': 'void usbGetDescriptor(void)\n{\n}\n',
    });
    expect(await calleesOf('coreRun')).toContain('usb_audio.c:usbGetDescriptor');
  });

  it('keeps a same-file static, whichever line the keyword is on', async () => {
    project({
      'core.c': 'static void\nhelper(void)\n{\n}\n\nvoid coreRun(void)\n{\n    helper();\n}\n',
      'other.c': 'static void helper(void)\n{\n}\n',
    });
    expect(await calleesOf('coreRun')).toEqual(['core.c:helper']);
  });
});

describe('Kotlin: a private function is class- or file-local', () => {
  it('does not resolve an SDK-style call onto another file\'s private fun', async () => {
    project({
      'Budget.kt': 'class Budget {\n    private fun apply(bps: Long): Long = bps\n}\n',
      'Main.kt': 'class Main {\n    fun onCreate(editor: Editor) {\n        editor.apply()\n    }\n}\n',
    });
    expect(await calleesOf('onCreate')).not.toContain('Budget.kt:apply');
  });

  it('still resolves onto a public fun in another file', async () => {
    project({
      'Budget.kt': 'class Budget {\n    fun apply(bps: Long): Long = bps\n}\n',
      'Main.kt': 'class Main {\n    fun onCreate(budget: Budget) {\n        budget.apply(1L)\n    }\n}\n',
    });
    expect(await calleesOf('onCreate')).toContain('Budget.kt:apply');
  });
});

describe('Go: an unexported identifier is package-local', () => {
  it('does not resolve a call onto an unexported func in another package', async () => {
    project({
      'cmd/probe/main.go': 'package main\n\nfunc fail(msg string) {}\n',
      'server/turn.go': 'package server\n\nfunc Run() {\n\tfail("x")\n}\n',
    });
    expect(await calleesOf('Run')).not.toContain('cmd/probe/main.go:fail');
  });

  it('still resolves within the package and onto an exported func elsewhere', async () => {
    project({
      'server/util.go': 'package server\n\nfunc fail(msg string) {}\n',
      'server/turn.go': 'package server\n\nfunc Run() {\n\tfail("x")\n\tReport()\n}\n',
      'report/report.go': 'package report\n\nfunc Report() {}\n',
    });
    const callees = await calleesOf('Run');
    expect(callees).toContain('server/util.go:fail');
    expect(callees).toContain('report/report.go:Report');
  });
});

describe('Rust: a non-pub item is visible to its module subtree only', () => {
  it('does not resolve a sibling module\'s private fn, nor another crate\'s', async () => {
    project({
      'src/main.rs': 'mod util;\nmod net;\nfn main() {}\n',
      'src/util.rs': 'fn count() -> usize { 0 }\n',
      'src/net.rs': 'pub fn run() -> usize {\n    count()\n}\n',
    });
    expect(await calleesOf('run')).not.toContain('src/util.rs:count');
  });

  it('keeps a trait-impl method, which has the trait\'s visibility', async () => {
    project({
      'src/main.rs': 'mod shape;\nmod draw;\nfn main() {}\n',
      'src/shape.rs': 'pub struct Circle;\npub trait Area { fn area(&self) -> f64; }\nimpl Area for Circle {\n    fn area(&self) -> f64 { 1.0 }\n}\n',
      'src/draw.rs': 'use crate::shape::{Area, Circle};\npub fn render(c: &Circle) -> f64 {\n    c.area()\n}\n',
    });
    expect(await calleesOf('render')).toContain('src/shape.rs:area');
  });

  it('still resolves a parent module\'s private fn from a child, and any pub fn', async () => {
    project({
      'src/main.rs': 'mod net;\nmod util;\nfn main() {}\n',
      'src/net.rs': 'pub mod tcp;\nfn shared() {}\n',
      'src/net/tcp.rs': 'use super::shared;\nuse crate::util::exported;\npub fn open() {\n    shared();\n    exported();\n}\n',
      'src/util.rs': 'pub fn exported() {}\n',
    });
    const callees = await calleesOf('open');
    expect(callees).toContain('src/net.rs:shared');
    expect(callees).toContain('src/util.rs:exported');
  });
});
