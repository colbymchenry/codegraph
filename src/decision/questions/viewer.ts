import type { PointSpec } from '../types';
import { choiceToOption, clip, code } from './common';

const EFFECTS: Record<string, string> = {
  network: 'Sends an HTTP, RPC or socket request to another service',
  storage: 'Reads or writes local files, key-value storage or browser storage',
  device: 'Uses device or OS services (camera, location, clipboard, notifications)',
  telemetry: 'Sends analytics, metrics, traces or error reports',
  database: 'Queries or changes a database (SQL, ORM, document store)',
  response: 'Sends the HTTP response back to the caller (status, body, redirect)',
  queue: 'Publishes to or consumes from a message or job queue',
  email: 'Sends an email',
  payments: 'Calls a payment provider',
  cache: 'Reads or writes a cache service',
  auth: 'Calls an authentication or identity provider, or checks credentials',
  process: 'Spawns a process, runs a shell command or exits the process',
  none: 'None of these: ordinary in-process code',
};

export const F1: PointSpec = {
  id: 'F1',
  build(rec, ctx) {
    const c = rec.payload.call as { text: string; kind: string; language: string; receiverType: string | null; args: string | null; enclosing: string; filePath: string; line: number };
    return {
      state: { call: { text: clip(c.text, 300), language: c.language, receiver_type: c.receiverType, args: c.args ? clip(c.args, 300) : null, inside: c.enclosing, file: c.filePath, line: c.line, code: code(ctx, c.filePath, c.line, 1) }, project: rec.payload.project },
      questions: {
        category: { type: 'choice', instructions: `What does the call \`${clip(c.text, 120)}\` in ${c.enclosing} do outside the process?`, criteria: EFFECTS },
        write: { type: 'noul', instructions: `Does \`${clip(c.text, 120)}\` change stored data (write, update or delete) rather than only read it?` },
      },
    };
  },
  interpret: (res) => choiceToOption(res, 'category', ['none']),
};
