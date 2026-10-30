/**
 * The root a Rust path's `crate::` names, as the manifest says: a `[[bin]]`
 * or `[lib]` with a `path` of its own (ripgrep's `crates/core/main.rs`), and
 * a package whose `name` its manifest writes after an array (axum-core's
 * `categories = [ … ]` first).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
const graphs: CodeGraph[] = [];

async function index(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-crate-roots-'));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  const cg = await CodeGraph.init(root, { index: true });
  graphs.push(cg);
  return cg;
}

let bin: CodeGraph;
let member: CodeGraph;

beforeAll(async () => {
  bin = await index({
    'Cargo.toml': '[package]\nname = "ripgrep"\nversion = "0.1.0"\nedition = "2021"\n\n[[bin]]\nbench = false\npath = "crates/core/main.rs"\nname = "rg"\n',
    'crates/core/main.rs': 'mod flags;\nmod messages;\n\nfn main() {\n    let _ = messages::errored();\n}\n',
    'crates/core/messages.rs': 'pub fn errored() -> bool {\n    false\n}\n',
    'crates/core/flags/mod.rs': 'pub mod parse;\npub mod doc;\n\npub enum Category {\n    Input,\n}\n',
    'crates/core/flags/parse.rs': 'pub fn lookup() -> usize {\n    1\n}\n',
    'crates/core/flags/doc.rs': 'use crate::flags::Category;\n\npub fn generate() -> usize {\n    crate::flags::parse::lookup()\n}\n',
    // Namesakes the paths must not reach.
    'crates/core/flags/doc/parse.rs': 'pub fn lookup() -> usize {\n    2\n}\n',
    'crates/core/other.rs': 'pub fn errored() -> bool {\n    true\n}\npub enum Category {\n    Output,\n}\n',
  });
  member = await index({
    'Cargo.toml': '[workspace]\nmembers = ["core-lib"]\n',
    'core-lib/Cargo.toml': '[package]\ncategories = ["asynchronous", "network-programming"]\ndescription = "Core types"\nedition = "2021"\nname = "core-lib"\nversion = "0.1.0"\n',
    'core-lib/src/lib.rs': 'pub mod body;\npub mod other;\n',
    'core-lib/src/body.rs': 'pub struct Body;\n\n#[cfg(test)]\nmod tests {\n    use crate::body::Body;\n}\n',
    'core-lib/src/other.rs': 'pub struct Body;\n',
  });
});

afterAll(() => {
  for (const cg of graphs) cg.close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const describeEdges = (cg: CodeGraph, file: string, kind: string, name?: string): string[] => {
  const ids = cg.getNodesInFile(file).filter((n) => name === undefined || n.name === name).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === kind)
    .map((e) => cg.getNode(e.target)!).map((t) => `${t.kind} ${t.qualifiedName} ${t.filePath}:${t.startLine}`);
};

describe('the crate a Rust path starts from', () => {
  it('is the binary a manifest places with a path of its own', () => {
    expect(describeEdges(bin, 'crates/core/flags/doc.rs', 'calls', 'generate')).toEqual(['function lookup crates/core/flags/parse.rs:1']);
    expect(describeEdges(bin, 'crates/core/flags/doc.rs', 'imports')).toEqual(['enum Category crates/core/flags/mod.rs:4']);
    expect(describeEdges(bin, 'crates/core/main.rs', 'calls', 'main')).toEqual(['function errored crates/core/messages.rs:1']);
  });

  it('is a package whose manifest writes its name after an array', () => {
    expect(describeEdges(member, 'core-lib/src/body.rs', 'imports')).toEqual(['struct Body core-lib/src/body.rs:1']);
  });
});
