/**
 * Cross-tier channels (`src/resolution/tier-synthesizer.ts`) and the Steps
 * picture they make: a monorepo with a Next.js client (`apps/web`) and an
 * Express + NestJS API (`apps/api`) in one indexed fixture. The page's form
 * posts to its own route, a service puts a job on a queue that a processor
 * consumes, a service emits an event a listener handles, and a chat component
 * talks to a gateway over a socket in both directions. Mirrors
 * `ui-steps-api-servers.test.ts` (the servers) and `ui-steps-api.test.ts`
 * (the mobile app).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { buildSteps } from '../src/ui-server/api/steps';
import type { Edge, Node } from '../src/types';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ui-steps-tier-'));
  write(
    'package.json',
    JSON.stringify({
      name: 'mono',
      workspaces: ['apps/*'],
      dependencies: {
        next: '15',
        react: '19',
        express: '4',
        axios: '1',
        bullmq: '5',
        '@nestjs/common': '10',
        '@nestjs/core': '10',
        '@nestjs/bull': '10',
        '@nestjs/event-emitter': '2',
        '@nestjs/websockets': '10',
        'socket.io': '4',
        'socket.io-client': '4',
        '@prisma/client': '5',
      },
    })
  );

  // ---- The web app: a page, a client form that posts to the API and calls a
  // server action, a card that reads through an axios instance, a chat.
  write(
    'apps/web/app/users/page.tsx',
    "import { NewUserForm } from '../../components/new-user-form'\n" +
      'export default function UsersPage() {\n' +
      '  return <NewUserForm />\n' +
      '}\n'
  );
  write(
    'apps/web/components/new-user-form.tsx',
    "'use client'\n" +
      "import { useCallback, useState } from 'react'\n" +
      "import { createUserAction } from '../app/actions'\n" +
      'export function NewUserForm() {\n' +
      "  const [email, setEmail] = useState('')\n" +
      '  const handleSubmit = useCallback(async (e) => {\n' +
      '    e.preventDefault()\n' +
      '    if (!email) return\n' +
      "    const res = await fetch('/api/users', { method: 'POST', body: JSON.stringify({ email }) })\n" +
      '    if (res.ok) await createUserAction({ email })\n' +
      '  }, [email])\n' +
      '  return <form onSubmit={handleSubmit}><input value={email} onChange={(e) => setEmail(e.target.value)} /></form>\n' +
      '}\n'
  );
  write(
    'apps/web/app/actions.ts',
    "'use server'\n" +
      "import { prisma } from '../lib/db'\n" +
      "import { redirect } from 'next/navigation'\n" +
      'export async function createUserAction(data) {\n' +
      '  await prisma.user.create({ data })\n' +
      "  redirect('/users')\n" +
      '}\n'
  );
  write('apps/web/lib/db.ts', "import { PrismaClient } from '@prisma/client'\nexport const prisma = new PrismaClient()\n");
  write('apps/web/lib/api.ts', "import axios from 'axios'\nexport const api = axios.create({ baseURL: '/api' })\n");
  write(
    'apps/web/components/user-card.tsx',
    "'use client'\n" +
      "import { api } from '../lib/api'\n" +
      'export function UserCard({ id, url }) {\n' +
      '  async function load() {\n' +
      '    const { data } = await api.get(`/users/${id}`)\n' +
      "    const external = await fetch('https://api.stripe.com/v1/charges')\n" +
      '    const dynamic = await fetch(url)\n' +
      '    const orders = await fetch(`${process.env.API_URL}/api/users/${id}/orders`)\n' +
      '    return [data, external, dynamic, orders]\n' +
      '  }\n' +
      '  return null\n' +
      '}\n'
  );
  write(
    'apps/web/components/chat.tsx',
    "'use client'\n" +
      "import { useEffect, useState } from 'react'\n" +
      "import { io } from 'socket.io-client'\n" +
      'const socket = io()\n' +
      'export function Chat() {\n' +
      '  const [messages, setMessages] = useState([])\n' +
      '  useEffect(() => {\n' +
      "    socket.on('message', (m) => {\n" +
      '      setMessages((prev) => [...prev, m])\n' +
      '    })\n' +
      '  }, [])\n' +
      '  function send(text) {\n' +
      "    socket.emit('message', text)\n" +
      '  }\n' +
      '  return null\n' +
      '}\n'
  );

  // ---- The API: Express routes, a queue and its Nest processor, a Nest
  // service emitting an event and its listener, a gateway, a BullMQ worker.
  write(
    'apps/api/src/app.ts',
    "import express from 'express'\n" +
      "import { createUser, getUser, listOrders } from './users'\n" +
      'const app = express()\n' +
      "app.post('/api/users', createUser)\n" +
      "app.get('/api/users/:id', getUser)\n" +
      "app.get('/api/users/:id/orders', listOrders)\n" +
      "const v1 = require('./v1')\n" +
      "app.use('/api/v1', authenticate, v1)\n" +
      'export default app\n'
  );
  // A mounted router, two levels deep: its routes are written relative to the mount.
  write(
    'apps/api/src/v1/index.ts',
    "import { Router } from 'express'\n" +
      "import ordersRouter from '../orders.routes'\n" +
      'const router = Router()\n' +
      "router.use('/orders', ordersRouter)\n" +
      'export default router\n'
  );
  write(
    'apps/api/src/orders.routes.ts',
    "import { Router } from 'express'\n" +
      "import { prisma } from './db'\n" +
      'const router = Router()\n' +
      "router.get('/', listAllOrders)\n" +
      "router.post('/:id/refund', refund)\n" +
      'export async function listAllOrders(req, res) {\n' +
      '  res.json(await prisma.order.findMany())\n' +
      '}\n' +
      'export async function refund(req, res) {\n' +
      '  res.status(202).end()\n' +
      '}\n' +
      'export default router\n'
  );
  write(
    'apps/web/components/orders.tsx',
    "'use client'\n" +
      "import useSWR from 'swr'\n" +
      'export function Orders() {\n' +
      "  const { data } = useSWR<Order[]>('/api/v1/orders', fetcher)\n" +
      '  async function loadOrders() {\n' +
      "    const res = await fetch('/api/v1/orders')\n" +
      '    return res.json()\n' +
      '  }\n' +
      '  return data\n' +
      '}\n'
  );
  write(
    'apps/api/src/users.ts',
    "import { prisma } from './db'\n" +
      "import { emailQueue, reportQueue } from './queue'\n" +
      'export async function createUser(req, res) {\n' +
      '  const user = await prisma.user.create({ data: req.body })\n' +
      "  await emailQueue.add('welcome', { userId: user.id })\n" +
      '  if (req.body.plan) {\n' +
      "    await reportQueue.add('monthly', { userId: user.id })\n" +
      '  }\n' +
      '  res.status(201).json(user)\n' +
      '}\n' +
      'export async function getUser(req, res) {\n' +
      '  const user = await prisma.user.findUnique({ where: { id: req.params.id } })\n' +
      '  res.json(user)\n' +
      '}\n' +
      'export async function listOrders(req, res) {\n' +
      '  res.json(await prisma.order.findMany({ where: { userId: req.params.id } }))\n' +
      '}\n'
  );
  write('apps/api/src/db.ts', "import { PrismaClient } from '@prisma/client'\nexport const prisma = new PrismaClient()\n");
  write('apps/api/src/queue.ts', "import { Queue } from 'bullmq'\nexport const emailQueue = new Queue('email')\nexport const reportQueue = new Queue('reports')\n");
  write(
    'apps/api/src/email.processor.ts',
    "import { Processor, Process } from '@nestjs/bull'\n" +
      "@Processor('email')\n" +
      'export class EmailProcessor {\n' +
      '  constructor(private readonly mailer: MailerService) {}\n' +
      "  @Process('welcome')\n" +
      '  async sendWelcome(job) {\n' +
      '    await this.mailer.sendMail({ to: job.data.email })\n' +
      '  }\n' +
      '}\n'
  );
  write(
    'apps/api/src/reports.worker.ts',
    "import { Worker } from 'bullmq'\n" +
      "export const reportWorker = new Worker('reports', async (job) => {\n" +
      '  await buildReport(job.data)\n' +
      '})\n' +
      'export async function buildReport(data) {\n' +
      '  return data\n' +
      '}\n'
  );
  write(
    'apps/api/src/users.service.ts',
    "import { Injectable } from '@nestjs/common'\n" +
      "import { EventEmitter2 } from '@nestjs/event-emitter'\n" +
      '@Injectable()\n' +
      'export class UsersService {\n' +
      '  constructor(private readonly eventEmitter: EventEmitter2) {}\n' +
      '  async create(dto) {\n' +
      '    const user = { id: 1, ...dto }\n' +
      "    this.eventEmitter.emit('user.created', user)\n" +
      '    return user\n' +
      '  }\n' +
      '}\n'
  );
  write(
    'apps/api/src/notifications.listener.ts',
    "import { Injectable } from '@nestjs/common'\n" +
      "import { OnEvent } from '@nestjs/event-emitter'\n" +
      '@Injectable()\n' +
      'export class NotificationsListener {\n' +
      "  @OnEvent('user.created')\n" +
      '  handleUserCreated(user) {\n' +
      '    return notify(user)\n' +
      '  }\n' +
      "  @OnEvent('user.*')\n" +
      '  audit(payload) {\n' +
      '    return log(payload)\n' +
      '  }\n' +
      "  @OnEvent('order.paid')\n" +
      '  handleOrderPaid(order) {\n' +
      '    return order\n' +
      '  }\n' +
      '}\n'
  );
  write(
    'apps/api/src/chat.gateway.ts',
    "import { WebSocketGateway, SubscribeMessage, WebSocketServer } from '@nestjs/websockets'\n" +
      '@WebSocketGateway()\n' +
      'export class ChatGateway {\n' +
      '  @WebSocketServer() server\n' +
      "  @SubscribeMessage('message')\n" +
      '  handleMessage(client, payload) {\n' +
      "    this.server.emit('message', payload)\n" +
      '    return payload\n' +
      '  }\n' +
      '}\n'
  );
  // A test suite calling the API is the test's story: never a source.
  write(
    'apps/api/src/__tests__/users.test.ts',
    "import { it } from 'vitest'\n" +
      "it('creates a user', async () => {\n" +
      "  await fetch('/api/users', { method: 'POST' })\n" +
      '})\n'
  );
  cg = CodeGraph.initSync(tmpDir);
  await cg.indexAll();
});

afterAll(() => {
  cg?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const q = (params: Record<string, string>) => new URLSearchParams(params);
const sym = (name: string, file?: string): Node => {
  const found = cg.getNodesByName(name).filter((n) => n.kind !== 'route' && n.kind !== 'file' && (!file || n.filePath.endsWith(file)));
  if (!found[0]) throw new Error(`no symbol ${name}`);
  return found[0];
};
const route = (name: string): Node => {
  const r = cg.getNodesByKind('route').find((r) => r.name === name);
  if (!r) throw new Error(`no route ${name}: ${cg.getNodesByKind('route').map((r) => r.name).join(', ')}`);
  return r;
};
const synthesized = (from: Node, by: string): Edge[] =>
  cg.getOutgoingEdges(from.id).filter((e) => e.provenance === 'heuristic' && (e.metadata as Record<string, unknown>)?.synthesizedBy === by);
const effect = (p: Awaited<ReturnType<typeof buildSteps>>, category: string) => p.steps.find((s) => s.kind === 'effect' && s.effect?.category === category);

describe('http-client: a literal path in a client call reaches its own route', () => {
  it('binds fetch("/api/users", { method: "POST" }) to POST /api/users, remembering the registration', () => {
    const edges = synthesized(sym('handleSubmit'), 'http-client');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.target).toBe(route('POST /api/users').id);
    expect(edges[0]!.kind).toBe('calls');
    expect(edges[0]!.line).toBe(9);
    expect(edges[0]!.metadata).toEqual({
      synthesizedBy: 'http-client',
      channel: 'http',
      callee: 'fetch',
      tier: 'client→server',
      method: 'POST',
      href: '/api/users',
      registeredAt: 'apps/api/src/app.ts:4',
    });
  });

  it('joins an axios instance’s literal baseURL, matches a template hole to a :param, and a base-URL hole by the tail', () => {
    const edges = synthesized(sym('load'), 'http-client');
    const byHref = new Map(edges.map((e) => [(e.metadata as Record<string, unknown>).href, e]));
    expect([...byHref.keys()].sort()).toEqual(['/api/users/${…}', '/api/users/${…}/orders']);
    expect(byHref.get('/api/users/${…}')!.target).toBe(route('GET /api/users/:id').id);
    expect((byHref.get('/api/users/${…}')!.metadata as Record<string, unknown>).method).toBe('GET');
    expect(byHref.get('/api/users/${…}/orders')!.target).toBe(route('GET /api/users/:id/orders').id);
  });

  it('produces nothing for an external URL, a variable url, or a call in a test suite', () => {
    // `load` makes four calls; only two name a route (asserted above).
    expect(synthesized(sym('load'), 'http-client')).toHaveLength(2);
    const testFns = cg.getNodesInFile('apps/api/src/__tests__/users.test.ts');
    for (const n of testFns) expect(synthesized(n, 'http-client')).toHaveLength(0);
    const incoming = cg.getIncomingEdgesTo([route('POST /api/users').id], ['calls']).filter((e) => e.provenance === 'heuristic');
    expect(incoming.map((e) => e.source)).toEqual([sym('handleSubmit').id]);
  });
});

describe('express mounts: a mounted router’s routes are named by the path a request takes', () => {
  it('composes app.use("/api/v1") and router.use("/orders") onto the routes, and a client path binds to the composed name', () => {
    const names = cg.getNodesByKind('route').map((r) => r.name);
    expect(names).toContain('GET /api/v1/orders');
    expect(names).toContain('POST /api/v1/orders/:id/refund');
    expect(names).not.toContain('GET /');
    const edges = synthesized(sym('loadOrders'), 'http-client');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.target).toBe(route('GET /api/v1/orders').id);
    expect((edges[0]!.metadata as Record<string, unknown>).registeredAt).toBe('apps/api/src/orders.routes.ts:4');
    // `useSWR<Order[]>('/api/v1/orders')` — a type argument between the name and the call.
    const hook = synthesized(sym('Orders'), 'http-client');
    expect(hook).toHaveLength(1);
    expect(hook[0]!.target).toBe(route('GET /api/v1/orders').id);
    expect((hook[0]!.metadata as Record<string, unknown>).callee).toBe('useSWR');
  });
});

describe('queue-job: a job put on a named queue reaches its consumer', () => {
  it('pairs emailQueue.add("welcome") with the @Process("welcome") method of the @Processor("email") class', () => {
    const edges = synthesized(sym('createUser'), 'queue-job');
    const welcome = edges.find((e) => (e.metadata as Record<string, unknown>).event === 'welcome')!;
    expect(welcome).toBeDefined();
    expect(welcome.target).toBe(sym('sendWelcome').id);
    expect(welcome.line).toBe(5);
    expect(welcome.metadata).toEqual({ synthesizedBy: 'queue-job', channel: 'queue', callee: 'emailQueue.add', event: 'welcome', queue: 'email', registeredAt: 'apps/api/src/email.processor.ts:5' });
  });

  it('pairs reportQueue.add("monthly") with the BullMQ Worker on that queue', () => {
    const edges = synthesized(sym('createUser'), 'queue-job');
    const monthly = edges.find((e) => (e.metadata as Record<string, unknown>).event === 'monthly')!;
    expect(monthly).toBeDefined();
    const target = cg.getNode(monthly.target)!;
    expect(target.filePath).toBe('apps/api/src/reports.worker.ts');
    expect((monthly.metadata as Record<string, unknown>).queue).toBe('reports');
    expect((monthly.metadata as Record<string, unknown>).registeredAt).toBe('apps/api/src/reports.worker.ts:2');
  });
});

describe('event-bus: an emitted event reaches its listeners; a socket message crosses tiers both ways', () => {
  it('pairs eventEmitter.emit("user.created") with @OnEvent("user.created") and the "user.*" glob, not "order.paid"', () => {
    const edges = synthesized(sym('create', 'users.service.ts'), 'event-bus');
    const targets = edges.map((e) => cg.getNode(e.target)!.name).sort();
    expect(targets).toEqual(['audit', 'handleUserCreated']);
    const direct = edges.find((e) => e.target === sym('handleUserCreated').id)!;
    expect(direct.metadata).toEqual({ synthesizedBy: 'event-bus', channel: 'event', callee: 'this.eventEmitter.emit', event: 'user.created', registeredAt: 'apps/api/src/notifications.listener.ts:5' });
  });

  it('a client’s socket.emit lands on the gateway’s @SubscribeMessage, client → server', () => {
    const edges = synthesized(sym('send'), 'event-bus');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.target).toBe(sym('handleMessage').id);
    expect(edges[0]!.metadata).toEqual({ synthesizedBy: 'event-bus', channel: 'socket', callee: 'socket.emit', event: 'message', tier: 'client→server', registeredAt: 'apps/api/src/chat.gateway.ts:5' });
  });

  it('the gateway’s server.emit lands in the component that registered socket.on inline, server → client', () => {
    const edges = synthesized(sym('handleMessage'), 'event-bus');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.target).toBe(sym('Chat').id);
    expect(edges[0]!.metadata).toEqual({ synthesizedBy: 'event-bus', channel: 'socket', callee: 'this.server.emit', event: 'message', tier: 'server→client', registeredAt: 'apps/web/components/chat.tsx:8' });
  });
});

describe('the Steps picture across the tiers', () => {
  it('draws the route as a boundary the form crosses to (⇢), and enters it on request', async () => {
    const boundary = await buildSteps(cg, tmpDir, q({ symbol: 'UsersPage' }));
    expect(boundary.project).toBe('web');
    const handler = boundary.steps.find((s) => s.kind === 'trigger' && s.node?.name === 'handleSubmit')!;
    expect(handler).toBeDefined();
    expect(handler.trigger).toMatchObject({ kind: 'prop', name: 'onSubmit', of: 'form' });
    const bridge = boundary.steps.find((s) => s.kind === 'bridge' && s.screen?.path === 'POST /api/users')!;
    expect(bridge).toBeDefined();
    expect(bridge.cut).toBe('screen');
    expect(bridge.sub).toBe('createUser');
    expect(bridge.trigger).toEqual({ kind: 'request', name: 'POST', of: '/api/users', in: 'app.ts' });
    const link = boundary.links.find((l) => l.from === handler.id && l.to === bridge.id)!;
    expect(link.kind).toBe('bridge');
    expect(link.synthesized).toBe(true);
    expect(link.when).toBe('email');
    expect(link.sites[0]).toMatchObject({ text: 'fetch', args: "'/api/users', { method, body }", line: 9 });
    expect(link.label).toContain('POST /api/users');
    expect(link.label).toContain('to the server');
    expect(link.label).toContain('registered at apps/api/src/app.ts:4');
    // The fetch is the crossing, not also a network call outside the index;
    // the route is not entered, so the handler's write is not drawn — the
    // server action's is, since a function the code crosses to is walked.
    expect(effect(boundary, 'network')).toBeUndefined();
    const writes = boundary.steps.filter((s) => s.kind === 'effect' && s.effect?.category === 'database');
    expect(writes.map((s) => s.effect!.by.name)).toEqual(['createUserAction']);

    const through = await buildSteps(cg, tmpDir, q({ symbol: 'UsersPage', through: '1' }));
    const entered = through.steps.find((s) => s.kind === 'bridge' && s.screen?.path === 'POST /api/users')!;
    expect(entered.cut).toBeNull();
    const db = through.steps.filter((s) => s.kind === 'effect' && s.effect?.category === 'database');
    expect(db.map((s) => s.effect!.by.name).sort()).toEqual(['createUser', 'createUserAction']);
    const res = effect(through, 'response')!;
    expect(res.label).toBe('201');
    expect(res.effect!.by.name).toBe('createUser');
    const welcome = through.steps.find((s) => s.kind === 'event' && s.event === 'welcome')!;
    expect(welcome).toBeDefined();
    expect(welcome.node!.name).toBe('sendWelcome');
    expect(welcome.trigger).toEqual({ kind: 'decorator', name: 'Process', of: "'welcome'", in: 'email.processor.ts' });
    const toWelcome = through.links.find((l) => l.to === welcome.id)!;
    expect(toWelcome.kind).toBe('event');
    expect(toWelcome.sites[0]).toMatchObject({ text: 'emailQueue.add', args: "'welcome', { userId }", line: 5 });
    expect(toWelcome.label).toBe('via queue-job · job welcome · queue email · registered at apps/api/src/email.processor.ts:5');
    expect(effect(through, 'queue')?.effect?.apis ?? []).not.toContain('emailQueue.add');
    const mail = effect(through, 'email')!;
    expect(mail.effect!.by.name).toBe('sendWelcome');
  });

  it('a server action called from a client component is a crossing to the server, by its directive', async () => {
    const p = await buildSteps(cg, tmpDir, q({ symbol: 'NewUserForm' }));
    const action = p.steps.find((s) => s.node?.name === 'createUserAction')!;
    expect(action).toBeDefined();
    expect(action.kind).toBe('bridge');
    const link = p.links.find((l) => l.to === action.id)!;
    expect(link.kind).toBe('bridge');
    expect(link.when).toBe('email && res.ok');
    expect(link.label).toContain('server action');
    expect(link.sites[0]).toMatchObject({ text: 'calls createUserAction', args: '{ email }' });
    expect(effect(p, 'database')?.effect?.by.name).toBe('createUserAction');
  });

  it('a socket message arriving in a component is an event landing, drawn as a boundary', async () => {
    const p = await buildSteps(cg, tmpDir, q({ symbol: 'handleMessage' }));
    const chat = p.steps.find((s) => s.kind === 'event' && s.node?.name === 'Chat')!;
    expect(chat).toBeDefined();
    expect(chat.event).toBe('message');
    expect(chat.cut).toBe('component');
    const link = p.links.find((l) => l.to === chat.id)!;
    expect(link.kind).toBe('event');
    expect(link.label).toContain('from the server');
  });
});
