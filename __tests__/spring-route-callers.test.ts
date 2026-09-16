/** Qualified CLI lookup must not hide a correctly linked Spring route (#1442). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const CONTROLLERS = ['StartFlowController', 'StartFlowExcelCdController'];
const ROUTE = 'POST /excelStart/startFlowExcelCd';
const JAVA_DIR = 'src/main/java/com/ideal/devops/controller';
let projectRoot: string;
let cg: CodeGraph;

function runCli(command: string, symbol: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [BIN, command, symbol, '--path', projectRoot, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' },
    timeout: 30_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

beforeAll(async () => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-spring-callers-1442-'));
  const javaDir = path.join(projectRoot, JAVA_DIR);
  fs.mkdirSync(javaDir, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'pom.xml'),
    '<project><dependencies><dependency><groupId>org.springframework.boot</groupId>' +
    '<artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>');
  for (const controller of CONTROLLERS) {
    fs.writeFileSync(path.join(javaDir, `${controller}.java`), `package com.ideal.devops.controller;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/excelStart")
public class ${controller} {
  private ExecutePlanFillService executePlanFillService;
  ${controller === 'StartFlowExcelCdController' ? 'public void startFlowExcelCdPreview() {}' : ''}
  /** @param excelFlowStartDTO 启动参数 */
  @PostMapping("startFlowExcelCd")
  public R<Void> startFlowExcelCd(@Validated(Insert.class) @RequestBody ExcelFlowStartDto excelFlowStartDTO) {
    executePlanFillService.fillExecPlanModule();
    return null;
  }
}
`);
  }
  fs.writeFileSync(path.join(javaDir, 'ExecutePlanFillService.java'), `package com.ideal.devops.controller;
public class ExecutePlanFillService {
  public void fillExecPlanModule() { fillModuleList(); }
  public void fillModuleList() {}
}
`);
  cg = await CodeGraph.init(projectRoot, { index: true });
}, 30_000);

afterAll(() => {
  cg?.close();
  if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('Spring route callers (#1442)', () => {
  it('keeps both route-to-handler edges and both routes in downstream impact', () => {
    const methods = cg.getNodesByName('startFlowExcelCd');
    expect(methods).toHaveLength(2);
    for (const method of methods) {
      const callers = cg.getCallers(method.id);
      expect(callers.map(c => [c.node.name, c.node.filePath])).toEqual([[ROUTE, method.filePath]]);
      expect(cg.getCallees(callers[0].node.id).map(c => c.node.id)).toEqual([method.id]);
    }
    const impact = JSON.parse(runCli('impact', 'fillModuleList', ['-d', '5', '--json']));
    for (const controller of CONTROLLERS) {
      const filePath = `${JAVA_DIR}/${controller}.java`;
      expect(impact.affected).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'method', name: 'startFlowExcelCd', filePath }),
        expect.objectContaining({ kind: 'route', name: ROUTE, filePath }),
      ]));
    }
  });

  it('has a higher-ranked prefix lookalike while node still selects the annotated handler', () => {
    // Before #1801, callers compared a qualified query to bare node.name, then
    // fell back to this FTS hit. Only the second controller has a lookalike:
    // its callers appeared empty even though node and impact found the route.
    const symbol = 'StartFlowExcelCdController.startFlowExcelCd';
    const hits = cg.searchNodes(symbol, { limit: 50 });
    expect(hits[0].node.name).toBe('startFlowExcelCdPreview');
    expect(cg.getCallers(hits[0].node.id)).toEqual([]);
    expect(hits.some(h => h.node.name === 'startFlowExcelCd')).toBe(true);
    const node = runCli('node', symbol);
    expect(node).toContain('@PostMapping("startFlowExcelCd")');
    expect(node).toContain('public R<Void> startFlowExcelCd(');
    expect(node).toContain(`${JAVA_DIR}/StartFlowExcelCdController.java`);
    expect(node).not.toContain('public void startFlowExcelCdPreview()');
  });

  it.each(CONTROLLERS)('callers %s.startFlowExcelCd returns its own route', (controller) => {
    const symbol = `${controller}.startFlowExcelCd`;
    const out = JSON.parse(runCli('callers', symbol, ['--json']));
    expect(out.callers).toEqual([
      expect.objectContaining({ kind: 'route', name: ROUTE, filePath: `${JAVA_DIR}/${controller}.java` }),
    ]);
    const text = runCli('callers', symbol);
    expect(text).toContain(ROUTE);
    expect(text).toContain(`${JAVA_DIR}/${controller}.java`);
    expect(text).not.toContain('No callers found');
  });
});
