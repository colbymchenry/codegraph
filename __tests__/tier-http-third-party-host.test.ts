/**
 * Tier synthesis, http-client channel: a call to another company's API is
 * not a call to the project's own route (#2974).
 *
 * `fetch('https://api.github.com/users/' + name)` linked to the project's own
 * `GET /users/:id`: the URL's host was dropped before its path was matched.
 * An absolute URL now matches the project's routes only when its host can be
 * the project's: loopback (a dev server), a host the code fills in, or the
 * host of the client's own base URL. A literal base URL keeps its path
 * prefix, whatever its host.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import type { Edge, Node } from '../src/types';

let tmpDir: string;
let cg: CodeGraph;

function write(rel: string, content: string): void {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tier-third-party-'));
  write('package.json', JSON.stringify({ name: 'app', dependencies: { express: '^4.0.0', axios: '^1.0.0' } }));
  write(
    'src/server.js',
    "const app = require('express')()\n" +
      'function getUser (req, res) { res.json({}) }\n' +
      'function getApiUser (req, res) { res.json({}) }\n' +
      "app.get('/users/:id', getUser)\n" +
      "app.get('/v2/users/:id', getApiUser)\n"
  );
  write(
    'src/client.js',
    // The issue's two calls.
    'async function loadGithubProfile (name) { return fetch(`https://api.github.com/users/${name}`) }\n' +
      'async function loadOwn (id) { return fetch(`/users/${id}`) }\n' +
      // This machine, and a host the code fills in.
      'async function loadLocal (id) { return fetch(`http://localhost:3000/users/${id}`) }\n' +
      'async function loadLoopback (id) { return fetch(`http://127.0.0.1:3000/users/${id}`) }\n' +
      'async function loadConfigured (host, id) { return fetch(`https://${host}/users/${id}`) }\n'
  );
  write(
    'src/api.js',
    "const axios = require('axios')\n" +
      "const api = axios.create({ baseURL: 'https://api.example.com/v2' })\n" +
      // A literal base URL keeps its prefix; its own host is the client's.
      'async function viaBase (id) { return api.get(`/users/${id}`) }\n' +
      'async function sameHost (id) { return api.get(`https://api.example.com/v2/users/${id}`) }\n' +
      'async function otherHost (id) { return api.get(`https://other.example.org/users/${id}`) }\n'
  );
  cg = CodeGraph.initSync(tmpDir);
  await cg.indexAll();
});

afterAll(() => {
  cg?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const sym = (name: string): Node => {
  const found = cg.getNodesByName(name).filter((n) => n.kind === 'function');
  if (found.length !== 1) throw new Error(`no single function ${name}`);
  return found[0]!;
};
/** The routes a function's http-client calls reach, by name. */
const reaches = (name: string): string[] =>
  cg
    .getOutgoingEdges(sym(name).id)
    .filter((e: Edge) => e.provenance === 'heuristic' && (e.metadata as Record<string, unknown>)?.synthesizedBy === 'http-client')
    .map((e) => cg.getNode(e.target)!.name)
    .sort();

describe('http-client: a call to another host (#2974)', () => {
  it("links no route of the project's for a third-party API's URL", () => {
    expect(reaches('loadGithubProfile')).toEqual([]);
    expect(reaches('loadOwn')).toEqual(['GET /users/:id']);
  });

  it('links a loopback host and a host the code fills in', () => {
    expect(reaches('loadLocal')).toEqual(['GET /users/:id']);
    expect(reaches('loadLoopback')).toEqual(['GET /users/:id']);
    expect(reaches('loadConfigured')).toEqual(['GET /users/:id']);
  });

  it("keeps a literal base URL's prefix, and its host as the client's own", () => {
    expect(reaches('viaBase')).toEqual(['GET /v2/users/:id']);
    expect(reaches('sameHost')).toEqual(['GET /v2/users/:id']);
    expect(reaches('otherHost')).toEqual([]);
  });
});
