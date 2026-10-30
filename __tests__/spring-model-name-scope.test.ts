/**
 * The Spring resolver's name heuristics (an entity under `/model/`, a
 * `…Service`, a `…Controller`) start from what the reference's own scope
 * declares — its file, then its package — and never reach a class nested in
 * another file's class by its bare name: every MyBatis `XExample` declares its
 * own nested `Criteria`, and mall's `new Criteria()` all went to the first.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const example = (name: string) => `package com.macro.mall.model;

public class ${name} {
    public Criteria createCriteria() {
        Criteria criteria = new Criteria();
        return criteria;
    }

    public static class Criteria {
    }
}
`;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-spring-model-'));
  const files: Record<string, string> = {
    'pom.xml': '<project><dependency>spring-boot-starter</dependency></project>\n',
    'mall-mbg/src/main/java/com/macro/mall/model/CmsHelpCategoryExample.java': example('CmsHelpCategoryExample'),
    'mall-mbg/src/main/java/com/macro/mall/model/OmsOrderExample.java': example('OmsOrderExample'),
    'mall-admin/src/main/java/com/macro/mall/service/OrderService.java': `package com.macro.mall.service;

@Service
public class OrderService {
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

describe('Spring name heuristics', () => {
  it('resolve a name to its own file’s nested class, not another file’s', () => {
    const file = 'mall-mbg/src/main/java/com/macro/mall/model/OmsOrderExample.java';
    const ids = cg.getNodesInFile(file).map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'instantiates' || e.kind === 'references')
      .map((e) => cg.getNode(e.target)!).filter((t) => t.name === 'Criteria').map((t) => t.filePath);
    expect(targets.length).toBeGreaterThan(0);
    expect(new Set(targets)).toEqual(new Set([file]));
  });
});
