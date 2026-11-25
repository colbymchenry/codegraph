/**
 * codegraph_explore drops test files from its answer, and the dominant-file
 * and route-file detectors skip them — but each kept a list of test names of
 * its own, so they missed every convention the engine's `isTestFile` learned
 * later: LLVM's `unittests/` trees (a helper there has no test-like name),
 * Google's `foo_unittest.cc`, a C++ `FooTest.cpp`, `e2e/` folders and the
 * examples around a project. On an LLVM-style repo a unit test's harness, named
 * like the code under test, took a file slot in the answer.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';

const write = (root: string, files: Record<string, string>) => {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
};

const renderedFiles = (text: string): string[] => [...text.matchAll(/^\*\*`([^`]+)`\*\* —/gm)].map((m) => m[1]!);

describe('codegraph_explore leaves out unit tests the engine knows', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-explore-low-value-'));
    write(root, {
      'src/lexer.h': `#pragma once

class Lexer {
 public:
  int nextToken();
};
`,
      'src/lexer.cc': `#include "lexer.h"

int Lexer::nextToken() { return 1; }
`,
      'src/parser.h': `#pragma once

class Parser {
 public:
  int parseExpression(const char* text);
  int parseStatement(const char* text);
};
`,
      'src/parser.cc': `#include "parser.h"
#include "lexer.h"

int Parser::parseExpression(const char* text) {
  Lexer lexer;
  return lexer.nextToken() + (text ? 1 : 0);
}

int Parser::parseStatement(const char* text) {
  return parseExpression(text) + 1;
}
`,
      // Google's naming: the unittest sits beside the code it tests.
      'src/parser_unittest.cc': `#include "parser.h"

void ParsesExpressions() {
  Parser parser;
  parser.parseExpression("1 + 2");
  parser.parseStatement("x = 1;");
}
`,
      // LLVM's: a unittests/ tree, with a harness named like what it tests.
      'unittests/Parse/ParserHarness.h': `#pragma once

#include "../../src/parser.h"

class ParserHarness {
 public:
  int parseExpression(const char* text) { return parser.parseExpression(text); }
  int parseStatement(const char* text) { return parser.parseStatement(text); }

 private:
  Parser parser;
};
`,
      'unittests/Parse/ParserTest.cpp': `#include "ParserHarness.h"

int ParsesStatements() {
  ParserHarness harness;
  return harness.parseStatement("y = 2;") + harness.parseExpression("3");
}
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('answers from the production files, not the unit tests that call them', async () => {
    const handler = new ToolHandler(cg);
    const result = await handler.execute('codegraph_explore', { query: 'Parser parseExpression parseStatement Lexer nextToken' });
    const files = renderedFiles(result.content?.[0]?.text ?? '');
    expect(files).toContain('src/parser.cc');
    expect(files.filter((f) => /unittests\/|_unittest\.cc$|Test\.cpp$/.test(f))).toEqual([]);
  });
});

describe('the route-file detector skips an e2e mock server', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-route-low-value-'));
    write(root, {
      'package.json': JSON.stringify({ name: 'shop', dependencies: { express: '^4.19.0' } }),
      'src/routes.js': `const express = require('express');
const router = express.Router();

function listOrders(req, res) { res.json([]); }
function showOrder(req, res) { res.json({}); }
function createOrder(req, res) { res.status(201).end(); }

router.get('/orders', listOrders);
router.get('/orders/:id', showOrder);
router.post('/orders', createOrder);

module.exports = router;
`,
      // A stand-in payment provider the end-to-end suite starts.
      'e2e/mock-server.js': `const express = require('express');
const app = express();

function ok(req, res) { res.json({ ok: true }); }

app.get('/v1/charges', ok);
app.post('/v1/charges', ok);
app.get('/v1/refunds', ok);
app.post('/v1/refunds', ok);
app.get('/v1/balance', ok);

module.exports = app;
`,
    });
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("names the app's own routes file", () => {
    expect(cg.getTopRouteFile()?.filePath).toBe('src/routes.js');
  });
});
