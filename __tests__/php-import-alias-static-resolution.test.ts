import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

const fixtureDir = path.join(__dirname, 'fixtures', 'php-import-alias-static');

describe('PHP static calls through import aliases (#1545)', () => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-static-alias-'));
    fs.cpSync(fixtureDir, dir, { recursive: true });
  });

  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('attributes callers, callees and impact to SettleService instead of SettleRepository', async () => {
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const method = (qualifiedName: string) => {
      const node = cg!.searchNodes(qualifiedName.split('::').pop()!)
        .map((result) => result.node)
        .find((n) => n.qualifiedName === qualifiedName);
      expect(node, qualifiedName).toBeDefined();
      return node!;
    };
    const excel = method('App\\Http\\Controllers\\Backend::SettleController::excel');
    const service = method('App\\Services::SettleService::getSettlesToExcel');
    const repository = method('App\\Repositories::SettleRepository::getSettlesToExcel');

    expect(cg.getCallees(excel.id).map(({ node }) => node.id)).toContain(service.id);
    expect(cg.getCallees(excel.id).map(({ node }) => node.id)).not.toContain(repository.id);
    expect(cg.getCallers(service.id).map(({ node }) => node.id)).toContain(excel.id);
    expect(cg.getCallers(repository.id).map(({ node }) => node.id)).not.toContain(excel.id);
    expect([...cg.getImpactRadius(service.id).nodes.keys()]).toContain(excel.id);
    expect([...cg.getImpactRadius(repository.id).nodes.keys()]).not.toContain(excel.id);
  });

  const write = (file: string, source: string) => {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  };

  const controllerPath = 'app/Http/Controllers/Backend/SettleController.php';
  const servicePath = 'app/Services/SettleService.php';
  const controllerSource = fs.readFileSync(path.join(fixtureDir, controllerPath), 'utf8');
  const serviceSource = fs.readFileSync(path.join(fixtureDir, servicePath), 'utf8');
  const serviceMethod = 'App\\Services::SettleService::getSettlesToExcel';

  const callees = async () => {
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const excel = cg.searchNodes('excel').map(({ node }) => node)
      .find((n) => n.kind === 'method' && n.filePath === controllerPath)!;
    expect(excel).toBeDefined();
    return cg.getCallees(excel.id).map(({ node }) => node.qualifiedName).sort();
  };

  it('uses the imported namespace even when another namespace declares SettleService', async () => {
    write('app/Repositories/SettleService.php', serviceSource.replace('App\\Services', 'App\\Repositories'));
    expect(await callees()).toEqual([serviceMethod]);
  });

  it('uses the import instead of a class whose actual name is the alias', async () => {
    write('app/Http/Controllers/Backend/Settle.php', serviceSource
      .replace('App\\Services', 'App\\Http\\Controllers\\Backend')
      .replace('class SettleService', 'class Settle'));
    expect(await callees()).toEqual([serviceMethod]);
  });

  it('constrains the method to its owner when another class shares the imported file', async () => {
    write(servicePath, serviceSource.replace(
      'class SettleService',
      'class SettleServiceDecoy { public static function getSettlesToExcel() {} }\nclass SettleService',
    ));
    expect(await callees()).toEqual([serviceMethod]);
  });

  it('resolves by namespace even when the file is not named after the imported class', async () => {
    fs.renameSync(path.join(dir, servicePath), path.join(dir, 'app/Services/exports.php'));
    expect(await callees()).toEqual([serviceMethod]);
  });

  it('handles an import with a leading namespace separator', async () => {
    write(controllerPath, controllerSource.replace('use App\\', 'use \\App\\'));
    expect(await callees()).toEqual([serviceMethod]);
  });

  it('keeps an unaliased class import on its declared namespace', async () => {
    write(controllerPath, controllerSource.replace(' as Settle;', ';').replace('Settle::', 'SettleService::'));
    write('app/Repositories/SettleService.php', serviceSource.replace('App\\Services', 'App\\Repositories'));
    expect(await callees()).toEqual([serviceMethod]);
  });

  it('supports an alias for a class in the global namespace', async () => {
    write(controllerPath, controllerSource.replace('App\\Services\\SettleService', 'SettleService'));
    write(servicePath, serviceSource.replace('namespace App\\Services;', ''));
    expect(await callees()).toEqual(['SettleService::getSettlesToExcel']);
  });

  it.each(['method missing', 'class outside the index'])('leaves the call unresolved when the imported %s', async (scenario) => {
    if (scenario === 'method missing') {
      write(servicePath, serviceSource.replace('getSettlesToExcel', 'otherMethod'));
    } else {
      fs.rmSync(path.join(dir, servicePath));
      // Even the right short name in the wrong namespace cannot donate a method.
      write('app/Repositories/SettleService.php', serviceSource.replace('App\\Services', 'App\\Repositories'));
    }
    expect(await callees()).toEqual([]);
  });

  it('keeps a variable and a static receiver with the same spelling in separate namespaces', async () => {
    write('app/Services/OtherService.php', String.raw`<?php
namespace App\Services;
class OtherService {
    public function getSettlesToExcel() {}
}
`);
    write(controllerPath, controllerSource.replace(
      'return Settle::',
      '$Settle = new OtherService();\n        $Settle->getSettlesToExcel();\n        return Settle::',
    ));
    expect((await callees()).filter((name) => name.endsWith('::getSettlesToExcel'))).toEqual([
      'App\\Services::OtherService::getSettlesToExcel',
      serviceMethod,
    ]);
  });
});
