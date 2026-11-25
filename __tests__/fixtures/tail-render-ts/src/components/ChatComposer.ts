import { createSessionStore } from '../lib/session-store';

/** The composer owns the textarea and decides send-vs-queue. */
export function createComposer(endpoint: string) {
	const store = createSessionStore({
		getProjectId: () => 'demo',
		getEndpoint: () => endpoint,
		onError: () => {},
	});
	let draft = '';

	function setDraft(next: string) {
		draft = next;
	}

	function submit(streaming: boolean) {
		if (streaming) store.queueMessage(draft);
		else store.sendMessage(draft, [], []);
		draft = '';
	}

	function onTurnEnd() {
		store.flushQueuedMessages();
	}

	return { setDraft, submit, onTurnEnd, store };
}
