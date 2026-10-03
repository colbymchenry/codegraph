/**
 * An Express handler written inline as `function (req, res) {…}` — the form
 * Express's own examples use — is the route's body just like an arrow is:
 * its calls are the route's, so Steps draws what `POST /login` does instead
 * of a lone box. The handler is the LAST argument; an inline middleware
 * before a named handler is not it, and a trailing comma changes nothing.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-express-fnexpr-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app', private: true, dependencies: { express: '^4.0.0' } }),
    'app.js': `const express = require('express');
const app = express();
const router = express.Router();

function authenticate(name, pass, fn) {
  fn(null, { name });
}

function restrict(req, res, next) {
  next();
}

function loadUser(id) {
  return { id };
}

function listPosts() {
  return [];
}

function wrap(fn) {
  return fn;
}

function showPost(req, res) {
  res.send('post');
}

app.post('/login', function (req, res, next) {
  authenticate(req.body.username, req.body.password, function (err, user) {
    res.redirect('/');
  });
});

app.get('/restricted', restrict, function named(req, res) {
  res.send(loadUser(req.params.id));
});

router.get(
  '/posts',
  wrap(async function (req, res) {
    res.json(listPosts());
  }),
);

app.get('/post/:id', (req, res, next) => next(), showPost);

router.route('/users/:id').get(function (req, res) {
  res.json(loadUser(req.params.id));
});
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

const fromRoute = (name: string, kind: string) => {
  const route = cg.getNodesByKind('route').find((r) => r.name === name);
  expect(route, name).toBeDefined();
  return cg.getOutgoingEdgesFrom([route!.id]).filter((e) => e.kind === kind).map((e) => cg.getNode(e.target)!.name);
};

describe('Express function-expression handlers', () => {
  it('lend the route their calls', () => {
    expect(fromRoute('POST /login', 'calls')).toContain('authenticate');
    expect(fromRoute('GET /restricted', 'calls')).toContain('loadUser');
    expect(fromRoute('GET /users/:id', 'calls')).toContain('loadUser');
  });

  it('are found inside a wrapper call, past a trailing comma', () => {
    expect(fromRoute('GET /posts', 'calls')).toContain('listPosts');
  });

  it('leave a named last argument the handler, even after an inline middleware', () => {
    expect(fromRoute('GET /post/:id', 'references')).toContain('showPost');
    expect(fromRoute('GET /post/:id', 'calls')).toEqual([]);
  });
});
