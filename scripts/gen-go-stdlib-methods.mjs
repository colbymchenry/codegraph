#!/usr/bin/env node
/**
 * Regenerate the table in src/resolution/go-stdlib-methods.ts from Go's own
 * source:
 *
 *   npm run build
 *   node scripts/gen-go-stdlib-methods.mjs <GOROOT> [--write]
 *
 * <GOROOT> is a Go source tree (a release's checkout of golang/go, say). For
 * every type the table lists now — add or drop one by editing the table, then
 * rerun — the script reads <GOROOT>/src/<import path>/*.go, tests skipped,
 * with the engine's Go grammar, and lists each method as
 * `name:params/results`:
 *   - an interface's methods, and those of the interfaces it embeds;
 *   - a struct's or other named type's (receiver T or *T), and those its
 *     embedded fields promote;
 *   - an alias's, its target's.
 * The counts come from the engine's own goSignatureArity, so a table method
 * is held to what the arity gate reads off a project method's stored
 * signature. Exported names are kept, and an unexported one only where a
 * listed interface requires it (`testing.TB`'s `private`).
 *
 * Prints the table body; --write puts it in the module instead. Exits 1 when
 * a listed type isn't found or a signature doesn't read.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = path.join(ROOT, 'src', 'resolution', 'go-stdlib-methods.ts');

const goRoot = process.argv[2];
const write = process.argv.includes('--write');
if (!goRoot || !fs.existsSync(path.join(goRoot, 'src', 'io'))) {
  console.error('usage: gen-go-stdlib-methods.mjs <GOROOT> [--write]  (a Go source tree, with src/io)');
  process.exit(2);
}
const wasm = path.join(ROOT, 'dist', 'extraction', 'wasm', 'tree-sitter-go.wasm');
if (!fs.existsSync(wasm)) {
  console.error('dist/ is missing: run `npm run build` first');
  process.exit(2);
}
const { goSignatureArity } = await import(pathToFileURL(path.join(ROOT, 'dist', 'resolution', 'callback-synthesizer.js')).href);
const { Parser, Language } = createRequire(path.join(ROOT, 'package.json'))('web-tree-sitter');

// The types the table lists, in its order.
const moduleText = fs.readFileSync(MODULE, 'utf8');
const open = moduleText.indexOf('{', moduleText.indexOf('const GO_STDLIB_METHODS'));
const close = moduleText.indexOf('\n};', open);
const listed = new Function(`return ${moduleText.slice(open, close + 2)}`)();

await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(wasm));

const signature = (node) => {
  const params = node.childForFieldName('parameters')?.text;
  const result = node.childForFieldName('result')?.text;
  return params && result ? `${params} ${result}` : params;
};

/** A package's top-level type declarations and the methods declared on each. */
const packages = new Map();
function pkg(importPath) {
  let found = packages.get(importPath);
  if (found) return found;
  found = { types: new Map(), methods: new Map() };
  packages.set(importPath, found);
  const dir = path.join(goRoot, 'src', importPath);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go')) : [];
  for (const file of files) {
    const tree = parser.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const imports = new Map();
    for (const spec of tree.rootNode.descendantsOfType('import_spec')) {
      const ip = spec.childForFieldName('path')?.text.replace(/^"|"$/g, '');
      if (ip) imports.set(spec.childForFieldName('name')?.text ?? ip.split('/').pop(), ip);
    }
    for (const spec of tree.rootNode.descendantsOfType(['type_spec', 'type_alias'])) {
      if (spec.parent?.type !== 'type_declaration' || spec.parent.parent?.type !== 'source_file') continue;
      const name = spec.childForFieldName('name')?.text;
      if (name && !found.types.has(name)) {
        found.types.set(name, { type: spec.childForFieldName('type'), imports, alias: spec.type === 'type_alias' });
      }
    }
    for (const m of tree.rootNode.namedChildren.filter((c) => c.type === 'method_declaration')) {
      const receiver = /\(\s*(?:\w+\s+)?\*?\s*(\w+)/.exec(m.childForFieldName('receiver')?.text ?? '')?.[1];
      const name = m.childForFieldName('name')?.text;
      if (!receiver || !name) continue;
      const methods = found.methods.get(receiver) ?? found.methods.set(receiver, new Map()).get(receiver);
      if (!methods.has(name)) methods.set(name, goSignatureArity(signature(m)));
    }
  }
  return found;
}

/** Method name → `params/results` for the type `name` the package at `importPath` declares. */
function methodsOf(importPath, name, seen = new Set()) {
  const methods = new Map();
  const key = `${importPath}.${name}`;
  if (seen.has(key)) return methods;
  seen.add(key);
  const p = pkg(importPath);
  for (const [m, arity] of p.methods.get(name) ?? []) methods.set(m, arity);
  const declared = p.types.get(name);
  if (!declared) return methods;
  const take = (more) => {
    for (const [m, arity] of more) if (!methods.has(m)) methods.set(m, arity);
  };
  const embedded = (type, imports) => {
    if (type?.type === 'pointer_type') type = type.namedChildren[0];
    if (type?.type === 'generic_type') type = type.childForFieldName('type');
    if (type?.type === 'qualified_type') {
      take(methodsOf(imports.get(type.childForFieldName('package').text), type.childForFieldName('name').text, seen));
    } else if (type?.type === 'type_identifier') {
      if (type.text === 'error') take(new Map([['Error', '0/1']]));
      else take(methodsOf(importPath, type.text, seen));
    }
  };
  const type = declared.type;
  if (type?.type === 'interface_type') {
    for (const element of type.namedChildren) {
      if (element.type === 'method_elem') methods.set(element.childForFieldName('name').text, goSignatureArity(signature(element)));
      else if (element.type === 'type_elem') {
        const terms = element.namedChildren.filter((c) => c.type !== 'comment');
        if (terms.length === 1) embedded(terms[0], declared.imports);
      }
    }
  } else if (type?.type === 'struct_type') {
    const fields = type.namedChildren.find((c) => c.type === 'field_declaration_list');
    for (const field of fields?.namedChildren.filter((c) => c.type === 'field_declaration') ?? []) {
      if (!field.namedChildren.some((c) => c.type === 'field_identifier')) embedded(field.childForFieldName('type'), declared.imports);
    }
  } else if (declared.alias) {
    embedded(type, declared.imports);
  }
  return methods;
}

const EXPORTED = /^\p{Lu}/u;
const generated = [];
const required = new Set();
let failed = false;
for (const [importPath, types] of Object.entries(listed)) {
  for (const name of Object.keys(types)) {
    const declared = pkg(importPath).types.get(name);
    if (!declared) {
      console.error(`not found: ${importPath}.${name}`);
      failed = true;
      continue;
    }
    const methods = methodsOf(importPath, name);
    generated.push({ importPath, name, methods });
    if (declared.type?.type === 'interface_type') for (const m of methods.keys()) if (!EXPORTED.test(m)) required.add(m);
  }
}

const lines = [];
let current = null;
for (const { importPath, name, methods } of generated) {
  if (importPath !== current) {
    if (current !== null) lines.push('  },');
    lines.push(`  ${/^[a-z]+$/.test(importPath) ? importPath : `'${importPath}'`}: {`);
    current = importPath;
  }
  const kept = [...methods].filter(([m]) => EXPORTED.test(m) || required.has(m)).sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [m, arity] of kept) {
    if (arity === null) {
      console.error(`signature doesn't read: ${importPath}.${name}.${m}`);
      failed = true;
    }
  }
  lines.push(`    ${name}: '${kept.map(([m, arity]) => `${m}:${arity}`).join(' ')}',`);
}
lines.push('  },');
if (failed) process.exit(1);

if (!write) {
  console.log(lines.join('\n'));
} else {
  const eol = moduleText.includes('\r\n') ? '\r\n' : '\n';
  const start = moduleText.indexOf('\n', open) + 1;
  const end = close + 1;
  fs.writeFileSync(MODULE, moduleText.slice(0, start) + lines.join(eol) + eol + moduleText.slice(end));
  console.error(`wrote ${generated.length} types to ${path.relative(ROOT, MODULE)}`);
}
