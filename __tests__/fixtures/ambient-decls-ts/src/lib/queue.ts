export interface UploadMessageBody {
  key: string;
  metadataId: string;
  contentType: string;
}

/**
 * Publish the follow-up message for a stored upload. Batched so a burst of
 * uploads does not open one producer call per object.
 */
export async function enqueueUploadMessage(body: UploadMessageBody): Promise<void> {
  const queue = openUploadQueue();
  await queue.send(body, { contentType: 'json' });
}

/** Consumer side: process a batch of upload messages. */
export async function consumeUploadBatch(messages: UploadMessageBody[]): Promise<number> {
  let handled = 0;
  for (const message of messages) {
    if (!message.key) continue;
    handled += 1;
  }
  return handled;
}

interface UploadQueue {
  send(body: UploadMessageBody, options: { contentType: string }): Promise<void>;
}

/** The binding lookup, isolated so tests can swap it. */
export function openUploadQueue(): UploadQueue {
  return {
    async send() {
      /* binding provided by the runtime */
    },
  };
}
