/**
 * A call written without a receiver reaches what its language lets it:
 *
 * - Solidity: a function of the contract around the call or of one it
 *   inherits (OpenZeppelin's `_msgSender()` in a Context-derived Governor
 *   went to ERC2771Context's override 83 times);
 * - Erlang: another module's function only through `-import(Mod, [f/N])`
 *   (cowboy's `-import(req_SUITE, [do_get/3])` went to compress_SUITE's
 *   `do_get/3`).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sol-erl-scope-'));
  const files: Record<string, string> = {
    'contracts/Context.sol': `pragma solidity ^0.8.20;

abstract contract Context {
    function _msgSender() internal view virtual returns (address) {
        return msg.sender;
    }
}
`,
    'contracts/ERC2771Context.sol': `pragma solidity ^0.8.20;

import {Context} from "./Context.sol";

abstract contract ERC2771Context is Context {
    function _msgSender() internal view virtual override returns (address) {
        return msg.sender;
    }
}
`,
    'contracts/Governor.sol': `pragma solidity ^0.8.20;

import {Context} from "./Context.sol";

abstract contract Governor is Context {
    function castVote() public returns (address) {
        return _msgSender();
    }
}
`,
    'test/req_SUITE.erl': `-module(req_SUITE).
-export([do_get/3]).

do_get(Path, Headers, Config) -> {Path, Headers, Config}.
`,
    'test/compress_SUITE.erl': `-module(compress_SUITE).
-export([do_get/3]).

do_get(Path, Headers, Config) -> {Path, Headers, Config}.
`,
    'test/static_handler_SUITE.erl': `-module(static_handler_SUITE).
-export([etag/1]).
-import(req_SUITE, [do_get/3]).

etag(Config) -> do_get("/etag", [], Config).
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

/** `Owner::member` of every call edge out of a file. */
function callsFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('receiver-less calls', () => {
  it('Solidity: reach the inherited function, not a sibling override', () => {
    expect(callsFrom('contracts/Governor.sol')).toEqual(['Context::_msgSender']);
  });

  it('Erlang: reach the module the file imports the function from', () => {
    expect(callsFrom('test/static_handler_SUITE.erl')).toEqual(['req_SUITE::do_get/3']);
  });
});
