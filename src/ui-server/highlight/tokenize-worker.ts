/**
 * The worker side of bounded highlighting (`bounded-tokenize.ts`): classifies
 * one slice per message with the engine's own grammars, off the server's
 * thread, so a grammar that never finishes a slice can be terminated.
 */

import { parentPort } from 'worker_threads';
import { tokenizeSource } from '../../extraction/syntax-tokens';
import type { Language } from '../../types';

interface TokenizeRequest {
  id: number;
  text: string;
  language: Language;
}

parentPort?.on('message', async (msg: TokenizeRequest) => {
  let result: Awaited<ReturnType<typeof tokenizeSource>> = null;
  try {
    result = await tokenizeSource(msg.text, msg.language);
  } catch {
    result = null;
  }
  parentPort?.postMessage({ id: msg.id, result });
});
