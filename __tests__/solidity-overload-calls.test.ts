/**
 * Solidity overloads by parameter count like the other overloading
 * languages: OpenZeppelin's `_checkRole(role, _msgSender())` inside the
 * one-argument `_checkRole(bytes32 role)` is the two-argument overload, not
 * a call to itself.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sol-overload-'));
  const files: Record<string, string> = {
    'contracts/access/AccessControl.sol': `pragma solidity ^0.8.20;

abstract contract AccessControl {
    function _checkRole(bytes32 role) internal view virtual {
        _checkRole(role, msg.sender);
    }

    function _checkRole(bytes32 role, address account) internal view virtual {
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

describe('Solidity overloads', () => {
  it('a call reaches the overload its argument count fits', () => {
    const ids = cg.getNodesInFile('contracts/access/AccessControl.sol').map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'calls' && e.line === 5).map((e) => cg.getNode(e.target)!.startLine);
    expect(targets).toEqual([8]);
  });
});
