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

  /** Every bridged hop as `Source > HandlerClass via Type`. */
  const bridges = async (): Promise<string[]> => {
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const rows = db.prepare(
      `SELECT s.name source, t.file_path file, t.start_line line, json_extract(e.metadata,'$.via') via
       FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
       WHERE json_extract(e.metadata,'$.synthesizedBy') = 'mediatr-dispatch'`
    ).all() as Array<{ source: string; file: string; line: number; via: string }>;
    const out = rows.map((r) => {
      const owner = db.prepare(`SELECT name FROM nodes WHERE file_path = ? AND kind = 'class' AND start_line <= ? AND end_line >= ? ORDER BY start_line DESC LIMIT 1`).get(r.file, r.line, r.line);
      return `${r.source} > ${owner?.name} via ${r.via}`;
    }).sort();
    cg.close?.();
    return out;
  };

  const SENDER = `namespace Shop;
using System.Threading.Tasks;
public class ThingsController {
    private readonly ISender _mediator;
    public ThingsController(ISender mediator) { _mediator = mediator; }
    public async Task GetThings() { await _mediator.Send(new GetThingsQuery()); }
    public async Task Create(CreateThingCommand command) { await _mediator.Send(command); }
}
`;

  it('reads a handler through an interface the project derives from MediatR, with no configuration', async () => {
    write('Abstractions.cs', `namespace Shop;
using MediatR;
public interface ICommandHandler<in TCommand, TResult> : IRequestHandler<TCommand, TResult> where TCommand : ICommand<TResult> { }
public interface IQueryHandler<in TQuery, TResult> : IRequestHandler<TQuery, TResult> where TQuery : IQuery<TResult> { }
`);
    write('Handlers.cs', `namespace Shop;
public class GetThingsQueryHandler : IQueryHandler<GetThingsQuery, ThingsVm> {
    public Task<ThingsVm> Handle(GetThingsQuery request, CancellationToken ct) => Task.FromResult(new ThingsVm());
}
public class CreateThingCommandHandler : ICommandHandler<CreateThingCommand, int> {
    public Task<int> Handle(CreateThingCommand request, CancellationToken ct) => Task.FromResult(1);
}
`);
    write('ThingsController.cs', SENDER);
    expect(await bridges()).toEqual([
      'Create > CreateThingCommandHandler via CreateThingCommand',
      'GetThings > GetThingsQueryHandler via GetThingsQuery',
    ]);
  });

  it('reads a handler whose interface comes from a package the index does not hold', async () => {
    // martinothamar/Mediator and Ardalis.SharedKernel: no declaration to read in the repository.
    write('Handlers.cs', `namespace Shop;
using Mediator;
public class GetThingsHandler(IReadRepository<Thing> repository, ILogger<GetThingsHandler> logger)
  : IQueryHandler<GetThingsQuery, Result<ThingsVm>>
{
  public async ValueTask<Result<ThingsVm>> Handle(GetThingsQuery request, CancellationToken ct) => default;
}
public sealed class CreateThingHandler : Shared.Kernel.ICommandHandler<Commands.CreateThingCommand>
{
  public ValueTask Handle(Commands.CreateThingCommand command, CancellationToken ct) => default;
}
`);
    write('ThingsController.cs', SENDER);
    expect(await bridges()).toEqual([
      'Create > CreateThingHandler via CreateThingCommand',
      'GetThings > GetThingsHandler via GetThingsQuery',
    ]);
  });

  it('reads each Handle of a class that handles several types', async () => {
    write('Handlers.cs', `namespace Shop;
public class AuditHandler : IDomainEventHandler<ThingCreated>, IDomainEventHandler<ThingDeleted> {
    public Task Handle(ThingCreated notification, CancellationToken ct) => Task.CompletedTask;
    public Task Handle(ThingDeleted notification, CancellationToken ct) => Task.CompletedTask;
}
`);
    write('Service.cs', `namespace Shop;
public class Service {
    private readonly IPublisher _publisher;
    public async Task Created() { await _publisher.Publish(new ThingCreated()); }
    public async Task Deleted() { await _publisher.Publish(new ThingDeleted()); }
}
`);
    expect(await bridges()).toEqual(['Created > AuditHandler via ThingCreated', 'Deleted > AuditHandler via ThingDeleted']);
  });

  it('takes the type a mapper builds as what is sent', async () => {
    write('Handlers.cs', `namespace Shop;
public class CreateThingHandler : ICommandHandler<CreateThing, int> {
    public Task<int> Handle(CreateThing command, CancellationToken ct) => Task.FromResult(1);
}
public class UpdateThingHandler : ICommandHandler<UpdateThing, int> {
    public Task<int> Handle(UpdateThing command, CancellationToken ct) => Task.FromResult(1);
}
`);
    write('Endpoint.cs', `namespace Shop;
public class Endpoint {
    public async Task Create(CreateThingDto dto, IMediator mediator, IMapper mapper) {
        var command = mapper.Map<CreateThing>(dto);
        await mediator.Send(command);
    }
    public async Task Update(UpdateThingDto dto, IMediator mediator) {
        var command = dto.Adapt<UpdateThingDto, Commands.UpdateThing>();
        await mediator.Send(command);
    }
}
`);
    expect(await bridges()).toEqual(['Create > CreateThingHandler via CreateThing', 'Update > UpdateThingHandler via UpdateThing']);
  });

  it('keeps two solutions of one repository apart when a type has the same name in both', async () => {
    const solution = (root: string): void => {
      write(`${root}/UseCases/CreateHandler.cs`, `namespace ${root};
public class CreateThingHandler : ICommandHandler<CreateThing, int> {
    public Task<int> Handle(CreateThing command, CancellationToken ct) => Task.FromResult(1);
}
public class ThingCreatedHandler : INotificationHandler<ThingCreated> {
    public Task Handle(ThingCreated notification, CancellationToken ct) => Task.CompletedTask;
}
`);
      write(`${root}/Web/Create.cs`, `namespace ${root};
public class Create${root} {
    private readonly IMediator _mediator;
    public async Task Run() { await _mediator.Send(new CreateThing()); }
    public async Task Tell() { await _mediator.Publish(new ThingCreated()); }
}
`);
    };
    solution('src');
    solution('sample');
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const rows = db.prepare(
      `SELECT s.file_path source, t.file_path target
       FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
       WHERE json_extract(e.metadata,'$.synthesizedBy') = 'mediatr-dispatch'`
    ).all() as Array<{ source: string; target: string }>;
    cg.close?.();
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.source.split('/')[0]).toBe(row.target.split('/')[0]);
  });

  it('lets a notification reach every module of a solution', async () => {
    write('src/Orders/Service.cs', `namespace Orders;
public class Service {
    private readonly IPublisher _publisher;
    public async Task Tell() { await _publisher.Publish(new ThingCreated()); }
}
`);
    write('src/Orders/Handlers/Audit.cs', `namespace Orders;
public class AuditHandler : INotificationHandler<ThingCreated> {
    public Task Handle(ThingCreated notification, CancellationToken ct) => Task.CompletedTask;
}
`);
    write('src/Billing/Handlers/Charge.cs', `namespace Billing;
public class ChargeHandler : INotificationHandler<ThingCreated> {
    public Task Handle(ThingCreated notification, CancellationToken ct) => Task.CompletedTask;
}
`);
    expect(await bridges()).toEqual(['Tell > AuditHandler via ThingCreated', 'Tell > ChargeHandler via ThingCreated']);
  });

  it('wants the type in both the base list and Handle', async () => {
    write('Handlers.cs', `namespace Shop;
public class NoBaseList {
    public Task Handle(GetThingsQuery request, CancellationToken ct) => Task.CompletedTask;
}
public class OtherType : IThingHandler<GetThingsQuery> {
    public Task Handle(string request, CancellationToken ct) => Task.CompletedTask;
}
public class Decorator<T> : ICommandHandler<T> {
    public Task Handle(T command, CancellationToken ct) => Task.CompletedTask;
}
public class ConstructorOnly(IRepository<CreateThingCommand> repository) : IThingService {
    public Task Handle(CreateThingCommand command, CancellationToken ct) => Task.CompletedTask;
}
`);
    write('ThingsController.cs', SENDER);
    write('Generic.cs', `namespace Shop;
public class Generic {
    private readonly IMediator _mediator;
    public async Task Run<T>(T command) { await _mediator.Send(command); }
}
`);
    expect(await bridges()).toEqual([]);
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
