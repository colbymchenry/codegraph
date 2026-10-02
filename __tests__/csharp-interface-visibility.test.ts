/**
 * C# interface visibility (#2164).
 *
 * Since #1745, cross-file resolution declines candidates whose `visibility`
 * is `private` — and the C# extractor defaulted every modifier-less member to
 * `private`. That default is wrong for interface members (implicitly `public`)
 * and for explicit interface implementations (`void IFoo.Bar()`), which carry
 * no modifier but are reachable through the interface.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cs-iface-vis-'));
  const files: Record<string, string> = {
    'Orders.Application/OrderService.cs': `namespace Orders.Application;

public interface IOrderService
{
    void CancelOrder(int id);
}

public class OrderService : IOrderService
{
    void IOrderService.CancelOrder(int id) { }
}
`,
    'Orders.Api/OrderController.cs': `namespace Orders.Api;

public class FieldController
{
    private readonly Orders.Application.IOrderService _service;

    public FieldController(Orders.Application.IOrderService service) { _service = service; }

    public void Cancel(int id) => _service.CancelOrder(id);
}

public class ParamController
{
    public void Cancel(Orders.Application.IOrderService service, int id) => service.CancelOrder(id);
}

public class CtorController(Orders.Application.IOrderService service)
{
    public void Cancel(int id) => service.CancelOrder(id);
}

public class ImplController
{
    public void Cancel(Orders.Application.OrderService service, int id) => service.CancelOrder(id);
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

const nodeByName = (qualifiedName: string) =>
  cg
    .getNodesInFile('Orders.Application/OrderService.cs')
    .find((n) => n.qualifiedName === qualifiedName)!;

const callsFrom = (file: string) =>
  cg
    .getOutgoingEdgesFrom(cg.getNodesInFile(file).map((n) => n.id))
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!.qualifiedName);

describe('C# interface visibility', () => {
  it('interface members are public even without a modifier', () => {
    expect(nodeByName('Orders.Application::IOrderService::CancelOrder').visibility).toBe('public');
  });

  it('calls through an interface-typed receiver resolve across files', () => {
    const calls = callsFrom('Orders.Api/OrderController.cs');
    const toInterface = calls.filter((q) => q === 'Orders.Application::IOrderService::CancelOrder');
    expect(toInterface).toHaveLength(3); // field, parameter, primary-constructor parameter
  });

  it('an explicit interface implementation is not treated as file-local private', () => {
    expect(nodeByName('Orders.Application::OrderService::CancelOrder').visibility).toBe('public');
    const calls = callsFrom('Orders.Api/OrderController.cs');
    expect(calls).toContain('Orders.Application::OrderService::CancelOrder');
  });
});
