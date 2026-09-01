/**
 * `GET /api/steps` on servers: an Express API, a NestJS API, a FastAPI service
 * and a Spring controller, in one indexed fixture, shaped to cross every
 * boundary an endpoint's picture has — the request and what runs before the
 * handler, the database, a queue, an email, and the responses with their
 * status codes. Mirrors `ui-steps-api.test.ts` (the mobile app).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { buildSteps, projectKind } from '../src/ui-server/api/steps';
import type { WireBlock } from '../src/ui-server/api/program';
import { routeRoots } from '../src/ui-server/api/route-roots';

let tmpDir: string;
let cg: CodeGraph;

function write(rel: string, content: string): void {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ui-steps-servers-'));
  write(
    'package.json',
    JSON.stringify({ name: 'api', dependencies: { express: '4', '@nestjs/core': '10', '@nestjs/common': '10', bullmq: '5', '@prisma/client': '5', typeorm: '0.3' } })
  );
  // ---- Express: a named handler behind middleware, and an inline handler.
  write('src/server/db.ts', "import { PrismaClient } from '@prisma/client'\nexport const prisma = new PrismaClient()\n");
  write('src/server/queue.ts', "import { Queue } from 'bullmq'\nexport const emailQueue = new Queue('email')\n");
  write('src/server/errors.ts', 'export class NotFoundError extends Error {}\n');
  write('src/server/auth.ts', 'export function authenticate(req, res, next) {\n  next()\n}\n');
  write('src/server/validate.ts', 'export function validate(schema) {\n  return (req, res, next) => next()\n}\n');
  write(
    'src/server/users.service.ts',
    "import { prisma } from './db'\n" +
      "import { emailQueue } from './queue'\n" +
      "import { NotFoundError } from './errors'\n" +
      'export async function createUser(req, res) {\n' +
      '  const user = await prisma.user.create({ data: { email: req.body.email, name: req.body.name } })\n' +
      "  await emailQueue.add('welcome', { userId: user.id })\n" +
      '  if (!user.verified) {\n' +
      '    await sendVerification(user)\n' +
      '  }\n' +
      '  res.status(201).json({\n' +
      '    id: user.id,\n' +
      '    token: signToken(user.id),\n' +
      '  })\n' +
      '}\n' +
      'function signToken(id) {\n' +
      "  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1d' })\n" +
      '}\n' +
      'export async function getUser(id: string) {\n' +
      '  const user = await prisma.user.findUnique({ where: { id } })\n' +
      "  if (!user) throw new NotFoundError('no such user')\n" +
      '  return user\n' +
      '}\n' +
      'async function sendVerification(user) {\n' +
      '  await transporter.sendMail({ to: user.email })\n' +
      '}\n' +
      'export async function acceptUser(req, res) {\n' +
      '  const user = await prisma.user.update({ where: { id: req.params.id }, data: { accepted: true } })\n' +
      '  res.status(202)\n' +
      '  res.json(user)\n' +
      '}\n'
  );
  write(
    'src/server/users.routes.ts',
    "import { Router } from 'express'\n" +
      "import { authenticate } from './auth'\n" +
      "import { validate } from './validate'\n" +
      "import { createUser, getUser, acceptUser } from './users.service'\n" +
      'const router = Router()\n' +
      "router.post('/users', authenticate, validate(userSchema), createUser)\n" +
      "router.post('/users/:id/accept', authenticate, acceptUser)\n" +
      "router.get('/users/:id', authenticate, async (req, res) => {\n" +
      '  const user = await getUser(req.params.id)\n' +
      '  res.json(user)\n' +
      '})\n' +
      'export default router\n'
  );
  // ---- NestJS: guards on the class and the method, DI into a service, a queue consumer.
  write(
    'src/nest/cats.service.ts',
    "import { Injectable } from '@nestjs/common'\n" +
      "import { InjectRepository } from '@nestjs/typeorm'\n" +
      "import { Repository } from 'typeorm'\n" +
      "import { InjectQueue } from '@nestjs/bullmq'\n" +
      "import { Queue } from 'bullmq'\n" +
      "import { Cat } from './cat.entity'\n" +
      '@Injectable()\n' +
      'export class CatsService {\n' +
      '  constructor(\n' +
      '    @InjectRepository(Cat) private readonly catsRepository: Repository<Cat>,\n' +
      "    @InjectQueue('cats') private readonly catsQueue: Queue\n" +
      '  ) {}\n' +
      '  async create(dto) {\n' +
      '    const cat = await this.catsRepository.save(dto)\n' +
      "    await this.catsQueue.add('index', { id: cat.id })\n" +
      '    return cat\n' +
      '  }\n' +
      '  async findOne(id: string) {\n' +
      '    return this.catsRepository.findOne({ where: { id } })\n' +
      '  }\n' +
      '}\n'
  );
  write('src/nest/cat.entity.ts', "import { Entity } from 'typeorm'\n@Entity()\nexport class Cat {\n  id: string\n}\n");
  write(
    'src/nest/cats.controller.ts',
    "import { Controller, Get, Post, Body, Param, UseGuards, NotFoundException } from '@nestjs/common'\n" +
      "import { AuthGuard } from '@nestjs/passport'\n" +
      "import { CatsService } from './cats.service'\n" +
      "import { RolesGuard } from './roles.guard'\n" +
      "@Controller('cats')\n" +
      "@UseGuards(AuthGuard('jwt'))\n" +
      'export class CatsController {\n' +
      '  constructor(private readonly catsService: CatsService) {}\n' +
      '  @Post()\n' +
      '  @UseGuards(RolesGuard)\n' +
      '  async create(@Body() dto: CreateCatDto) {\n' +
      '    return this.catsService.create(dto)\n' +
      '  }\n' +
      "  @Get(':id')\n" +
      "  async findOne(@Param('id') id: string) {\n" +
      '    const cat = await this.catsService.findOne(id)\n' +
      "    if (!cat) throw new NotFoundException('no cat')\n" +
      '    return cat\n' +
      '  }\n' +
      '}\n'
  );
  write('src/nest/roles.guard.ts', "import { Injectable } from '@nestjs/common'\n@Injectable()\nexport class RolesGuard {\n  canActivate() { return true }\n}\n");
  write(
    'src/nest/cats.processor.ts',
    "import { Processor, Process } from '@nestjs/bull'\n" +
      "@Processor('cats')\n" +
      'export class CatsProcessor {\n' +
      "  @Process('index')\n" +
      '  async handleIndex(job) {\n' +
      '    await searchClient.index(job.data)\n' +
      '  }\n' +
      '}\n'
  );
  // ---- FastAPI: a dependency on the route, SQLModel, an HTTPException, a Celery task.
  write(
    'api/items.py',
    'from fastapi import APIRouter, Depends, HTTPException\n' +
      'from sqlmodel import select\n' +
      'from .deps import get_current_user, SessionDep\n' +
      'from .models import Item, ItemCreate\n' +
      'from .tasks import send_welcome\n' +
      '\n' +
      'router = APIRouter()\n' +
      '\n' +
      '@router.post("/items", dependencies=[Depends(get_current_user)])\n' +
      'def create_item(session: SessionDep, item_in: ItemCreate):\n' +
      '    item = Item.model_validate(item_in)\n' +
      '    session.add(item)\n' +
      '    session.commit()\n' +
      '    if item.price < 0:\n' +
      '        raise HTTPException(status_code=422, detail="bad price")\n' +
      '    send_welcome.delay(item.id)\n' +
      '    return item\n'
  );
  write('api/deps.py', 'def get_current_user():\n    return None\n\nSessionDep = None\n');
  write('api/models.py', 'class Item:\n    pass\n\nclass ItemCreate:\n    pass\n');
  write('api/tasks.py', 'from celery import shared_task\n\n@shared_task\ndef send_welcome(item_id):\n    return item_id\n');
  // A router with its own prefix, included by an aggregate router, mounted at a literal prefix — and one at a computed one.
  write(
    'api/orders.py',
    'from fastapi import APIRouter\n' +
      '\n' +
      'router = APIRouter(prefix="/orders", tags=["orders"])\n' +
      '\n' +
      '@router.get("/")\n' +
      'def list_orders():\n' +
      '    return []\n' +
      '\n' +
      '@router.get("/{order_id}")\n' +
      'def get_order(order_id: int):\n' +
      '    return order_id\n'
  );
  write('api/v1.py', 'from fastapi import APIRouter\nfrom .orders import router as orders_router\napi_router = APIRouter()\napi_router.include_router(orders_router)\n');
  write(
    'api/main.py',
    'from fastapi import FastAPI\nfrom .items import router\nfrom .v1 import api_router\nfrom .config import settings\napp = FastAPI()\napp.include_router(router)\napp.include_router(api_router, prefix="/api/v1")\napp.include_router(api_router, prefix=settings.LEGACY)\n'
  );
  write('api/config.py', 'settings = None\n');
  write('requirements.txt', 'fastapi\nsqlmodel\ncelery\n');
  // ---- Spring: a repository typed on a field, ResponseEntity replies, a guard annotation.
  write(
    'src/main/java/demo/OwnerController.java',
    'package demo;\n' +
      'import org.springframework.web.bind.annotation.*;\n' +
      'import org.springframework.http.*;\n' +
      '@RestController\n' +
      '@RequestMapping("/owners")\n' +
      'public class OwnerController {\n' +
      '  private final OwnerRepository owners;\n' +
      '  public OwnerController(OwnerRepository owners) { this.owners = owners; }\n' +
      '  @PostMapping("/new")\n' +
      '  @PreAuthorize("hasRole(\'ADMIN\')")\n' +
      '  public ResponseEntity<Owner> create(@RequestBody Owner owner) {\n' +
      '    if (owner.getName() == null) {\n' +
      '      return ResponseEntity.badRequest().build();\n' +
      '    }\n' +
      '    Owner saved = owners.save(owner);\n' +
      '    return ResponseEntity.status(HttpStatus.CREATED).body(saved);\n' +
      '  }\n' +
      '}\n'
  );
  write(
    'src/main/java/demo/OwnerRepository.java',
    'package demo;\nimport org.springframework.data.jpa.repository.JpaRepository;\npublic interface OwnerRepository extends JpaRepository<Owner, Integer> {\n}\n'
  );
  write('src/main/java/demo/Owner.java', 'package demo;\npublic class Owner {\n  private String name;\n  public String getName() { return name; }\n}\n');
  // ---- ASP.NET Minimal API, endpoint-group style: the class is the group,
  // the handler is the first argument, the app's extension supplies `/api/`.
  write(
    'src/Web/Endpoints/TodoItems.cs',
    'using Microsoft.AspNetCore.Http.HttpResults;\n' +
      'namespace Demo.Web.Endpoints;\n' +
      'public class TodoItems : IEndpointGroup\n' +
      '{\n' +
      '    public static void Map(RouteGroupBuilder groupBuilder)\n' +
      '    {\n' +
      '        groupBuilder.RequireAuthorization();\n' +
      '        groupBuilder.MapPost(CreateTodoItem);\n' +
      '        groupBuilder.MapPut(UpdateTodoItem, "{id}");\n' +
      '    }\n' +
      '    public static async Task<Created<int>> CreateTodoItem(ISender sender, CreateTodoItemCommand command)\n' +
      '    {\n' +
      '        var id = await sender.Send(command);\n' +
      '        return TypedResults.Created($"/{nameof(TodoItems)}/{id}", id);\n' +
      '    }\n' +
      '    public static async Task<Results<NoContent, BadRequest>> UpdateTodoItem(ISender sender, int id, UpdateTodoItemCommand command)\n' +
      '    {\n' +
      '        if (id != command.Id)\n' +
      '            return TypedResults.BadRequest();\n' +
      '        await sender.Send(command);\n' +
      '        return TypedResults.NoContent();\n' +
      '    }\n' +
      '}\n'
  );
  write(
    'src/Web/Infrastructure/WebApplicationExtensions.cs',
    'using Microsoft.AspNetCore.Builder;\n' +
      'namespace Demo.Web.Infrastructure;\n' +
      'public static class WebApplicationExtensions\n' +
      '{\n' +
      '    public static WebApplication MapEndpoints(this WebApplication app)\n' +
      '    {\n' +
      '        var groupName = "x";\n' +
      '        var group = app.MapGroup($"/api/{groupName}").WithTags(groupName);\n' +
      '        return app;\n' +
      '    }\n' +
      '}\n'
  );
  cg = CodeGraph.initSync(tmpDir);
  await cg.indexAll();
});

afterAll(() => {
  cg?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const q = (params: Record<string, string>) => new URLSearchParams(params);
const route = (name: string) => {
  const r = cg.getNodesByKind('route').find((r) => r.name === name);
  if (!r) throw new Error(`no route ${name}: ${cg.getNodesByKind('route').map((r) => r.name).join(', ')}`);
  return r;
};
const effect = (p: Awaited<ReturnType<typeof buildSteps>>, category: string) => p.steps.find((s) => s.kind === 'effect' && s.effect?.category === category);

/**
 * The `program` reading, one line per item, indented — the rail as a reader
 * meets it. A step prints its label, a fork its condition and each arm's, a
 * bracketed run its words.
 */
function inOrder(p: Awaited<ReturnType<typeof buildSteps>>): string[] {
  const label = (id: string) => p.steps.find((s) => s.id === id)?.label ?? id;
  const out: string[] = [];
  const walk = (block: WireBlock, indent: string): void => {
    for (const item of block) {
      if (item.kind === 'step') {
        out.push(`${indent}${label(item.step)}${item.again ? ' (again)' : ''}`);
        if (item.body) walk(item.body, `${indent}  `);
      } else if (item.kind === 'fork') {
        out.push(`${indent}${item.form} ${item.on}`);
        for (const arm of item.arms) {
          out.push(`${indent}  ${arm.when}${arm.ends ? ` → ${arm.ends}` : ''}`);
          walk(arm.body, `${indent}    `);
        }
      } else if (item.kind === 'block') {
        out.push(`${indent}${item.block} ${item.via?.name ?? item.by ?? ''}`.trimEnd());
        walk(item.body, `${indent}  `);
      } else out.push(`${indent}cut ${item.why}`);
    }
  };
  if (p.program) walk(p.program.root, '');
  return out;
}

describe('in the code’s order', () => {
  it('reads an Express handler as it is written, helper and all', async () => {
    // `create` → `emailQueue.add` → `if (!user.verified) sendVerification(user)`
    // → `res.status(201).json({ token: signToken(user.id) })`. The token is
    // signed INSIDE the reply, so it is drawn before the 201, not beside it.
    const p = await buildSteps(cg, tmpDir, q({ anchor: route('POST /users').id }));
    expect(p.defaultView).toBe('order');
    expect(inOrder(p)).toEqual([
      'prisma.user.create({ data })',
      "emailQueue.add('welcome', { userId })",
      'if !user.verified',
      '  !user.verified',
      '    inline sendVerification',
      '      transporter.sendMail({ to })',
      'inline signToken',
      '  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn })',
      '201',
    ]);
  });

  it('reads a Python handler, its raise ending the arm it is in', async () => {
    // `session.add` / `session.commit` are one database box drawn at both its
    // sites; `raise HTTPException(422)` is an early exit, so the arm that
    // raises answers there and the Celery job is on the other one.
    const p = await buildSteps(cg, tmpDir, q({ anchor: route('POST /items').id }));
    expect(inOrder(p)).toEqual([
      'session.add +1',
      'session.add +1',
      'if item.price < 0',
      '  item.price < 0 → reply',
      '    422',
      '  !(item.price < 0)',
      '    send_welcome.delay(item.id)',
    ]);
  });

  it('reads a Java handler, its early return as the fork’s other arm', async () => {
    // `if (owner.getName() == null) return badRequest();` — one comparison
    // flips rather than wrapping, so the arm that runs on says `!= null`.
    const p = await buildSteps(cg, tmpDir, q({ anchor: route('POST /owners/new').id }));
    expect(inOrder(p)).toEqual([
      'if owner.getName() == null',
      '  owner.getName() == null → reply',
      '    400',
      '  owner.getName() != null → reply',
      '    owners.save(owner)',
      '    201',
    ]);
  });

  it('reads a C# handler’s two outcomes', async () => {
    const p = await buildSteps(cg, tmpDir, q({ anchor: route('PUT /api/TodoItems/{id}').id }));
    expect(inOrder(p)).toEqual([
      'if id != command.Id',
      '  id != command.Id → reply',
      '    400',
      '  id == command.Id → reply',
      '    204',
    ]);
  });

  it('reads a Nest handler through the service it delegates to', async () => {
    const p = await buildSteps(cg, tmpDir, q({ anchor: route('POST /cats').id }));
    expect(inOrder(p)).toEqual(['inline create', '  this.catsRepository.save(dto)', '  handleIndex']);
  });

  it('has no order to read for a screen, and says so', async () => {
    // A route with an inline handler still has a body; what has none is a
    // symbol nothing in the picture happens inside.
    const p = await buildSteps(cg, tmpDir, q({ symbol: 'RolesGuard' }));
    expect(p.program).toBeNull();
    expect(p.defaultView).toBe('tree');
  });
});

describe('route roots', () => {
  it('names the handler an API route runs, the route itself for an inline handler', () => {
    const roots = routeRoots(cg, cg.getNodesByKind('route'));
    expect(roots.get(route('POST /users').id)).toMatchObject({ inline: false, node: { name: 'createUser' } });
    expect(roots.get(route('GET /users/:id').id)).toMatchObject({ inline: true });
    expect(roots.get(route('POST /cats').id)?.node.qualifiedName).toContain('CatsController');
    expect(roots.get(route('POST /items').id)?.node.name).toBe('create_item');
    expect(roots.get(route('POST /owners/new').id)?.node.name).toBe('create');
  });
  it('calls the project an API', () => {
    expect(projectKind(cg.getNodesByKind('route'), 0)).toBe('api');
  });
});

describe('Express', () => {
  it('draws the handler’s database write, the queue job, the email, and the 201 — after the middleware', async () => {
    const p = await buildSteps(cg, tmpDir, q({ anchor: route('POST /users').id }));
    expect(p.project).toBe('api');
    const anchor = p.steps.find((s) => s.anchor)!;
    expect(anchor.kind).toBe('screen');
    expect(anchor.sub).toBe('createUser');
    expect(anchor.screen).toMatchObject({ path: 'POST /users', endpoint: true, inline: false, component: { name: 'createUser' } });
    expect(anchor.trigger).toEqual({ kind: 'request', name: 'POST', of: '/users', in: 'users.routes.ts', after: ['authenticate', 'validate(…)'] });

    const db = effect(p, 'database')!;
    expect(db.label).toBe('prisma.user.create({ data })');
    expect(db.effect).toMatchObject({ model: 'user', access: 'write', by: { name: 'createUser' } });
    expect(db.sub).toBe('database · user · write · createUser');
    const queue = effect(p, 'queue')!;
    expect(queue.label).toBe("emailQueue.add('welcome', { userId })");
    const mail = effect(p, 'email')!;
    expect(mail.label).toBe('transporter.sendMail({ to })');
    const mailLink = p.links.find((l) => l.to === mail.id)!;
    expect(mailLink.via.map((v) => v.name)).toEqual(['sendVerification']);
    expect(mailLink.when).toBe('!user.verified');
    const res = effect(p, 'response')!;
    expect(res.label).toBe('201');
    expect(res.effect?.statuses).toEqual([201]);
    const resLink = p.links.find((l) => l.to === res.id)!;
    expect(resLink.sites[0]).toMatchObject({ text: 'res.status(201).json', args: '{ id, token }', status: 201 });
    // The token is signed while the reply is built: the link says so, and
    // the row reads in the code's order — the write, the job, the mail, the
    // signing (inside the reply's arguments), then the reply.
    const auth = effect(p, 'auth')!;
    expect(auth.label).toBe('jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn })');
    const authLink = p.links.find((l) => l.to === auth.id)!;
    expect(authLink.via.map((v) => v.name)).toEqual(['signToken']);
    expect(authLink.within).toBe('res.status(201).json');
    expect(resLink.within).toBeUndefined();
    const row = p.steps.filter((s) => s.depth === 1).sort((a, b) => a.order! - b.order!).map((s) => s.label);
    expect(row).toEqual([
      'prisma.user.create({ data })',
      "emailQueue.add('welcome', { userId })",
      'transporter.sendMail({ to })',
      'jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn })',
      '201',
    ]);
  });

  it('walks an inline handler as the route itself, into the service’s read and its 404', async () => {
    const p = await buildSteps(cg, tmpDir, q({ anchor: route('GET /users/:id').id }));
    const anchor = p.steps.find((s) => s.anchor)!;
    expect(anchor.sub).toBe('inline handler · users.routes.ts');
    expect(anchor.trigger).toMatchObject({ kind: 'request', name: 'GET', of: '/users/:id', after: ['authenticate'] });
    const db = effect(p, 'database')!;
    expect(db.effect).toMatchObject({ model: 'user', access: 'read', by: { name: 'getUser' } });
    // `res.json(user)` in the inline handler sets no status: a 200, the
    // route's own reply box; the service's `NotFoundError` is `getUser`'s box.
    const replies = p.steps.filter((s) => s.kind === 'effect' && s.effect?.category === 'response');
    expect(replies.map((s) => [s.effect!.by.name, s.label]).sort()).toEqual([
      ['GET /users/:id', '200'],
      ['getUser', '404'],
    ]);
    const own = replies.find((s) => s.effect!.by.name === 'GET /users/:id')!;
    expect(p.links.find((l) => l.to === own.id)!.sites[0]).toMatchObject({ text: 'res.json', args: 'user', status: 200 });
    const notFound = replies.find((s) => s.effect!.by.name === 'getUser')!;
    const link = p.links.find((l) => l.to === notFound.id)!;
    expect(link.sites[0]).toMatchObject({ text: 'NotFoundError', status: 404, when: '!user' });
    expect(link.via.map((v) => v.name)).toEqual(['getUser']);
  });

  it('a status set by the statement before the reply is that reply’s, not a 200', async () => {
    const p = await buildSteps(cg, tmpDir, q({ anchor: route('POST /users/:id/accept').id }));
    const res = effect(p, 'response')!;
    expect(res.label).toBe('202');
    expect(p.links.find((l) => l.to === res.id)!.sites.map((x) => [x.text, x.status])).toEqual([
      ['res.status', 202],
      ['res.json', 202],
    ]);
  });
});

describe('NestJS', () => {
  it('reads the guards on the class and the method, follows DI into the repository and the queue', async () => {
    const p = await buildSteps(cg, tmpDir, q({ anchor: route('POST /cats').id }));
    const anchor = p.steps.find((s) => s.anchor)!;
    expect(anchor.sub).toBe('create');
    expect(anchor.trigger).toEqual({ kind: 'request', name: 'POST', of: '/cats', in: 'cats.controller.ts', after: ["UseGuards(AuthGuard('jwt'))", 'UseGuards(RolesGuard)'] });
    const db = effect(p, 'database')!;
    expect(db.label).toBe('this.catsRepository.save(dto)');
    expect(db.effect).toMatchObject({ model: 'cats', access: 'write', by: { name: 'create' } });
    const dbLink = p.links.find((l) => l.to === db.id)!;
    expect(dbLink.via.map((v) => v.name)).toEqual(['create']);
    // The job put on the `cats` queue lands on the processor that consumes it
    // — an arrival, not a call outside the index; the site is the `add` as written.
    expect(effect(p, 'queue')).toBeUndefined();
    const landing = p.steps.find((s) => s.kind === 'event' && s.node?.name === 'handleIndex')!;
    expect(landing).toBeDefined();
    expect(landing.event).toBe('index');
    expect(landing.trigger).toEqual({ kind: 'decorator', name: 'Process', of: "'index'", in: 'cats.processor.ts' });
    const toLanding = p.links.find((l) => l.to === landing.id)!;
    expect(toLanding.kind).toBe('event');
    expect(toLanding.synthesized).toBe(true);
    expect(toLanding.sites[0]).toMatchObject({ text: 'this.catsQueue.add', args: "'index', { id }" });
    expect(toLanding.label).toBe('via queue-job · job index · queue cats · registered at src/nest/cats.processor.ts:4');
  });

  it('a thrown exception is the 404 the request gets', async () => {
    const p = await buildSteps(cg, tmpDir, q({ anchor: route('GET /cats/:id').id }));
    const res = effect(p, 'response')!;
    expect(res.label).toBe('404');
    const resLink = p.links.find((l) => l.to === res.id)!;
    expect(resLink.sites[0]).toMatchObject({ text: 'NotFoundException', args: "'no cat'", status: 404, when: '!cat' });
    expect(effect(p, 'database')?.effect).toMatchObject({ access: 'read' });
  });

  it('a queue consumer says the job that fires it', async () => {
    const p = await buildSteps(cg, tmpDir, q({ symbol: 'handleIndex' }));
    expect(p.steps.find((s) => s.anchor)?.trigger).toEqual({ kind: 'decorator', name: 'Process', of: "'index'", in: 'cats.processor.ts' });
  });
});

describe('FastAPI', () => {
  it('names a mounted router’s routes by the path a request takes — the include prefix, then the router’s own', () => {
    const names = cg.getNodesByKind('route').map((r) => r.name);
    expect(names).toContain('GET /api/v1/orders');
    expect(names).toContain('GET /api/v1/orders/{order_id}');
    expect(names).toContain('POST /items');
    expect(names).not.toContain('GET /');
  });

  it('reads the dependency on the route, the session writes, the 422 and the Celery task', async () => {
    const p = await buildSteps(cg, tmpDir, q({ anchor: route('POST /items').id }));
    const anchor = p.steps.find((s) => s.anchor)!;
    expect(anchor.sub).toBe('create_item');
    expect(anchor.trigger).toEqual({ kind: 'request', name: 'POST', of: '/items', in: 'items.py', after: ['Depends(get_current_user)'] });
    const db = effect(p, 'database')!;
    expect(db.effect?.apis).toEqual(['session.add', 'session.commit']);
    expect(db.effect).toMatchObject({ access: 'write' });
    const res = effect(p, 'response')!;
    expect(res.label).toBe('422');
    const resLink = p.links.find((l) => l.to === res.id)!;
    expect(resLink.sites[0]).toMatchObject({ text: 'HTTPException', args: 'status_code=422, detail="bad price"', status: 422, when: 'item.price < 0' });
    const queue = effect(p, 'queue')!;
    expect(queue.label).toBe('send_welcome.delay(item.id)');
  });
});

describe('ASP.NET endpoint groups', () => {
  it('names the group’s routes under the app’s /api/ head and starts the walk at the handler, with its replies', async () => {
    const names = cg.getNodesByKind('route').map((r) => r.name);
    expect(names).toContain('POST /api/TodoItems');
    expect(names).toContain('PUT /api/TodoItems/{id}');
    const p = await buildSteps(cg, tmpDir, q({ anchor: route('PUT /api/TodoItems/{id}').id }));
    const anchor = p.steps.find((s) => s.anchor)!;
    expect(anchor.sub).toBe('UpdateTodoItem');
    expect(anchor.trigger).toMatchObject({ kind: 'request', name: 'PUT', of: '/api/TodoItems/{id}' });
    // One box per outcome, each line carrying its own condition.
    const replies = p.steps.filter((s) => s.kind === 'effect' && s.effect?.category === 'response');
    const outcomes = replies.map((s) => [s.label, p.links.find((l) => l.to === s.id)!.when]).sort();
    expect(outcomes).toEqual([
      ['204', 'id == command.Id'],
      ['400', 'id != command.Id'],
    ]);
  });
});

describe('Spring', () => {
  it('types the repository off the field, reads the annotation guard, and both replies with their codes', async () => {
    const p = await buildSteps(cg, tmpDir, q({ anchor: route('POST /owners/new').id }));
    const anchor = p.steps.find((s) => s.anchor)!;
    expect(anchor.sub).toBe('create');
    expect(anchor.trigger).toEqual({ kind: 'request', name: 'POST', of: '/owners/new', in: 'OwnerController.java', after: ["PreAuthorize(\"hasRole('ADMIN')\")"] });
    const db = effect(p, 'database')!;
    expect(db.label).toBe('owners.save(owner)');
    expect(db.effect).toMatchObject({ model: 'Owner', access: 'write' });
    const dbLink = p.links.find((l) => l.to === db.id)!;
    expect(dbLink.when).toBe('owner.getName() != null');
    const replies = p.steps.filter((s) => s.kind === 'effect' && s.effect?.category === 'response');
    const outcomes = replies.map((s) => [s.label, s.effect!.statuses, p.links.find((l) => l.to === s.id)!.when]).sort();
    expect(outcomes).toEqual([
      ['201', [201], 'owner.getName() != null'],
      ['400', [400], 'owner.getName() == null'],
    ]);
  });
});
