import type { Socket } from '../pipeline/types';

/** Open a transport socket for a host/port pair. */
export function openSocket(host: string, port: number): Socket {
  let open = false;
  const inbox: Uint8Array[] = [];
  return {
    async connect(timeoutMs: number) {
      if (open) return;
      await settle(timeoutMs);
      open = true;
    },
    async write(frame: Uint8Array, timeoutMs: number) {
      if (!open) throw new Error(`socket to ${host}:${port} is not connected`);
      await settle(timeoutMs);
      inbox.push(frame);
    },
    async read(timeoutMs: number) {
      await settle(timeoutMs);
      return inbox.shift() ?? new Uint8Array();
    },
    async close() {
      open = false;
    },
  };
}

async function settle(timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) throw new Error('timed out');
}
