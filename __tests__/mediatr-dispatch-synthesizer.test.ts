/**
 * MediatR request/notification dispatch bridge (C#/.NET).
 *
 * MediatR decouples a `_mediator.Send(x)` / `_mediator.Publish(x)` call from the `Handle`
 * method that runs it, linked by the request/notification TYPE (the `IRequestHandler<T,…>`
 * generic). This bridges each mediator dispatch → the `Handle` of the matching handler.
 * The sent type is resolved from the argument three ways — inline `new X(...)`, a local
 * `var v = new X(...)`, and a parameter/local declared `X v` — and precision rests on two
 * gates proven here: the receiver must be mediator-ish (a `MessagingCenter.Send` is ignored),
 * and the type must have a handler (an `IRequest` with no handler is never bridged). Covers
 * `IRequest<T>`, void `IRequest` (single-arg `IRequestHandler<T>`), and `INotification`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('mediatr-dispatch synthesizer', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediatr-dispatch-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  it('bridges Send/Publish to the matching Handle across inline, local, and param arg forms', async () => {
    write('Requests.cs', `namespace Shop;
using MediatR;
public record GetThingsQuery : IRequest<ThingsVm>;
public record CreateThingCommand(string Name) : IRequest<int>;
public record DeleteThingCommand(int Id) : IRequest;
public record ThingDeletedNotification(int Id) : INotification;
public class UnhandledCommand : IRequest<int> { }
`);
    write('Handlers.cs', `namespace Shop;
using MediatR;
using System.Threading;
using System.Threading.Tasks;
public class GetThingsQueryHandler : IRequestHandler<GetThingsQuery, ThingsVm> {
    public Task<ThingsVm> Handle(GetThingsQuery request, CancellationToken ct) => Task.FromResult(new ThingsVm());
}
public class CreateThingCommandHandler : IRequestHandler<CreateThingCommand, int> {
    public Task<int> Handle(CreateThingCommand request, CancellationToken ct) => Task.FromResult(1);
}
public class DeleteThingCommandHandler : IRequestHandler<DeleteThingCommand> {
    public Task Handle(DeleteThingCommand request, CancellationToken ct) => Task.CompletedTask;
}
public class ThingDeletedNotificationHandler : INotificationHandler<ThingDeletedNotification> {
    public Task Handle(ThingDeletedNotification notification, CancellationToken ct) => Task.CompletedTask;
}
`);
    write('ThingsController.cs', `namespace Shop;
using MediatR;
using System.Threading.Tasks;
public class ThingsController {
    private readonly ISender _mediator;
    public ThingsController(ISender mediator) { _mediator = mediator; }

    public async Task GetThings() {
        var vm = await _mediator.Send(new GetThingsQuery());
    }
    public async Task Create(CreateThingCommand command) {
        var id = await _mediator.Send(command);
    }
    public async Task Delete(int id) {
        var command = new DeleteThingCommand(id);
        await _mediator.Send(command);
    }
    public async Task Notify(int id) {
        await _mediator.Publish(new ThingDeletedNotification(id));
    }
    public async Task Bogus() {
        await _mediator.Send(new UnhandledCommand());
    }
    public void ViaMessagingCenter() {
        MessagingCenter.Send(this, "evt", new CreateThingCommand("x"));
    }
}
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const edges = db
      .prepare(
        `SELECT s.name source, t.name target, json_extract(e.metadata,'$.via') via
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'mediatr-dispatch'`
      )
      .all();

    // Four bridged dispatches: inline (GetThings, Notify), param-typed (Create), local var (Delete).
    expect(edges.map((r: any) => r.source).sort()).toEqual(['Create', 'Delete', 'GetThings', 'Notify']);
    expect([...new Set(edges.map((r: any) => r.via))].sort()).toEqual([
      'CreateThingCommand', 'DeleteThingCommand', 'GetThingsQuery', 'ThingDeletedNotification',
    ]);
    // Every target is a Handle method.
    expect(edges.every((r: any) => r.target === 'Handle')).toBe(true);
    // PRECISION: an IRequest with no handler is never bridged; a non-mediator .Send is ignored.
    expect(edges.some((r: any) => r.via === 'UnhandledCommand')).toBe(false);
    expect(edges.some((r: any) => r.source === 'ViaMessagingCenter')).toBe(false);

    cg.close?.();
  });

  it('produces no edges in a C# project with no MediatR (clean control)', async () => {
    write('Service.cs', `namespace Shop;
public class Service {
    private readonly IRepo _repo;
    public Service(IRepo repo) { _repo = repo; }
    public string Find(string id) => _repo.Get(id);
}
`);
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const count = db
      .prepare(`SELECT count(*) c FROM edges WHERE json_extract(metadata,'$.synthesizedBy') = 'mediatr-dispatch'`)
      .get();
    expect(count.c).toBe(0);
    cg.close?.();
  });
});
