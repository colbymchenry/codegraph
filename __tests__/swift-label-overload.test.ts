/**
 * Swift overloads by argument label as much as by count: Alamofire's
 * `self.tableView(tableView, numberOfRowsInSection: section)` inside
 * `tableView(_:titleForHeaderInSection:)` is the other `tableView`, and
 * `cancel(optionallyProducingResumeData:)` is not `cancel(producingResumeData:)`.
 * A call reaches the overload whose labels it spells, defaulted ones optional.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-swift-labels-'));
  const files: Record<string, string> = {
    'Sources/TableController.swift': `class TableController {
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        return 0
    }

    func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        if self.tableView(tableView, numberOfRowsInSection: section) == 0 { return nil }
        return "x"
    }

    func cancel(producingResumeData shouldProduce: Bool) -> Self {
        return cancel(optionallyProducingResumeData: nil)
    }

    private func cancel(optionallyProducingResumeData handler: ((Data?) -> Void)?, retry: Bool = false) -> Self {
        return self
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

const targetLineOfCallAt = (line: number) => {
  const ids = cg.getNodesInFile('Sources/TableController.swift').map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'calls' && e.line === line).map((e) => cg.getNode(e.target)!.startLine);
};

describe('Swift overloads by label', () => {
  it('reach the overload whose labels the call spells', () => {
    expect(targetLineOfCallAt(7)).toEqual([2]);
    expect(targetLineOfCallAt(12)).toEqual([15]);
  });
});
