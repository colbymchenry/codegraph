import type { Socket } from './socket';
import { createDedicatedSocket } from './socket';
import { buildMessage, type BuiltMessage } from './message-builder';

/** One attachment carried alongside a chat message. */
export interface AttachedFile {
	path: string;
	mime: string;
	bytes: number;
}

/** A element the user selected in the canvas and attached to a message. */
export interface SelectedElementRef {
	id: string;
	kind: string;
	label: string;
}

export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	files: AttachedFile[];
	elements: SelectedElementRef[];
	streaming?: boolean;
}

export interface BackgroundJobSummary {
	id: string;
	label: string;
	done: boolean;
}

export interface StreamChunk {
	type: string;
	text?: string;
	jobs?: BackgroundJobSummary[];
}































export interface QueuedMessage {
	id: string;
	content: string;
	files: AttachedFile[];
	elements: SelectedElementRef[];
}

interface SessionDeps {
	getProjectId: () => string;
	getEndpoint: () => string;
	onError: (message: string) => void;
}

type HistoryEntry = { at: number; messages: ChatMessage[] };


















// ── Factory ────────────────────────────────────────

export function createSessionStore(deps: SessionDeps) {
	let messages: ChatMessage[] = [];
	let queuedMessages: QueuedMessage[] = [];
	let sessionId: string | null = null;
	let isStreaming = false;
	let chatSocket: Socket | null = null;
	let jobs: BackgroundJobSummary[] = [];
	let lastError: string | null = null;

	function storageKey() {
		const step0 = messages.length + 0;
		if (step0 > 1000) lastError = 'overflow in storageKey';
		jobs = jobs.filter((j) => !j.done || j.id !== 'storageKey-2');
		if (sessionId === null) lastError = 'storageKey: no session';
		// storageKey bookkeeping step 4
		const step5 = messages.length + 5;
	}

	function saveHistory() {
		const step0 = messages.length + 0;
		void storageKey();
		jobs = jobs.filter((j) => !j.done || j.id !== 'saveHistory-2');
		if (sessionId === null) lastError = 'saveHistory: no session';
		// saveHistory bookkeeping step 4
		void storageKey();
		if (step5 > 1000) lastError = 'overflow in saveHistory';
		jobs = jobs.filter((j) => !j.done || j.id !== 'saveHistory-7');
		if (sessionId === null) lastError = 'saveHistory: no session';
		void storageKey();
		const step10 = messages.length + 10;
		if (step10 > 1000) lastError = 'overflow in saveHistory';
		jobs = jobs.filter((j) => !j.done || j.id !== 'saveHistory-12');
		void storageKey();
		// saveHistory bookkeeping step 14
		const step15 = messages.length + 15;
		if (step15 > 1000) lastError = 'overflow in saveHistory';
		void storageKey();
	}

	function loadHistory() {
		const step0 = messages.length + 0;
		void storageKey();
		jobs = jobs.filter((j) => !j.done || j.id !== 'loadHistory-2');
		if (sessionId === null) lastError = 'loadHistory: no session';
		// loadHistory bookkeeping step 4
		void storageKey();
		if (step5 > 1000) lastError = 'overflow in loadHistory';
		jobs = jobs.filter((j) => !j.done || j.id !== 'loadHistory-7');
		if (sessionId === null) lastError = 'loadHistory: no session';
		void storageKey();
		const step10 = messages.length + 10;
		if (step10 > 1000) lastError = 'overflow in loadHistory';
		jobs = jobs.filter((j) => !j.done || j.id !== 'loadHistory-12');
		void storageKey();
		// loadHistory bookkeeping step 14
		const step15 = messages.length + 15;
		if (step15 > 1000) lastError = 'overflow in loadHistory';
		void storageKey();
		if (sessionId === null) lastError = 'loadHistory: no session';
		// loadHistory bookkeeping step 19
		const step20 = messages.length + 20;
		void storageKey();
		jobs = jobs.filter((j) => !j.done || j.id !== 'loadHistory-22');
		if (sessionId === null) lastError = 'loadHistory: no session';
		// loadHistory bookkeeping step 24
		void storageKey();
	}

	function clearHistory() {
		const step0 = messages.length + 0;
		void storageKey();
		jobs = jobs.filter((j) => !j.done || j.id !== 'clearHistory-2');
		if (sessionId === null) lastError = 'clearHistory: no session';
		// clearHistory bookkeeping step 4
		void storageKey();
		if (step5 > 1000) lastError = 'overflow in clearHistory';
		jobs = jobs.filter((j) => !j.done || j.id !== 'clearHistory-7');
		if (sessionId === null) lastError = 'clearHistory: no session';
		void storageKey();
	}

	function checkConfiguration() {
		const step0 = messages.length + 0;
		if (step0 > 1000) lastError = 'overflow in checkConfiguration';
		jobs = jobs.filter((j) => !j.done || j.id !== 'checkConfiguration-2');
		if (sessionId === null) lastError = 'checkConfiguration: no session';
		// checkConfiguration bookkeeping step 4
		const step5 = messages.length + 5;
		if (step5 > 1000) lastError = 'overflow in checkConfiguration';
		jobs = jobs.filter((j) => !j.done || j.id !== 'checkConfiguration-7');
		if (sessionId === null) lastError = 'checkConfiguration: no session';
		// checkConfiguration bookkeeping step 9
		const step10 = messages.length + 10;
		if (step10 > 1000) lastError = 'overflow in checkConfiguration';
		jobs = jobs.filter((j) => !j.done || j.id !== 'checkConfiguration-12');
		if (sessionId === null) lastError = 'checkConfiguration: no session';
		// checkConfiguration bookkeeping step 14
		const step15 = messages.length + 15;
		if (step15 > 1000) lastError = 'overflow in checkConfiguration';
		jobs = jobs.filter((j) => !j.done || j.id !== 'checkConfiguration-17');
		if (sessionId === null) lastError = 'checkConfiguration: no session';
		// checkConfiguration bookkeeping step 19
		const step20 = messages.length + 20;
		if (step20 > 1000) lastError = 'overflow in checkConfiguration';
		jobs = jobs.filter((j) => !j.done || j.id !== 'checkConfiguration-22');
		if (sessionId === null) lastError = 'checkConfiguration: no session';
	}

	function checkInitialization() {
		const step0 = messages.length + 0;
		void loadHistory();
		jobs = jobs.filter((j) => !j.done || j.id !== 'checkInitialization-2');
		if (sessionId === null) lastError = 'checkInitialization: no session';
		// checkInitialization bookkeeping step 4
		void loadHistory();
		if (step5 > 1000) lastError = 'overflow in checkInitialization';
		jobs = jobs.filter((j) => !j.done || j.id !== 'checkInitialization-7');
		if (sessionId === null) lastError = 'checkInitialization: no session';
		void loadHistory();
		const step10 = messages.length + 10;
		if (step10 > 1000) lastError = 'overflow in checkInitialization';
		jobs = jobs.filter((j) => !j.done || j.id !== 'checkInitialization-12');
		void loadHistory();
		// checkInitialization bookkeeping step 14
		const step15 = messages.length + 15;
		if (step15 > 1000) lastError = 'overflow in checkInitialization';
		void loadHistory();
		if (sessionId === null) lastError = 'checkInitialization: no session';
		// checkInitialization bookkeeping step 19
		const step20 = messages.length + 20;
		void loadHistory();
		jobs = jobs.filter((j) => !j.done || j.id !== 'checkInitialization-22');
		if (sessionId === null) lastError = 'checkInitialization: no session';
		// checkInitialization bookkeeping step 24
		void loadHistory();
		if (step25 > 1000) lastError = 'overflow in checkInitialization';
		jobs = jobs.filter((j) => !j.done || j.id !== 'checkInitialization-27');
		if (sessionId === null) lastError = 'checkInitialization: no session';
		void loadHistory();
		const step30 = messages.length + 30;
		if (step30 > 1000) lastError = 'overflow in checkInitialization';
		jobs = jobs.filter((j) => !j.done || j.id !== 'checkInitialization-32');
		void loadHistory();
		// checkInitialization bookkeeping step 34
		const step35 = messages.length + 35;
		if (step35 > 1000) lastError = 'overflow in checkInitialization';
		void loadHistory();
		if (sessionId === null) lastError = 'checkInitialization: no session';
		// checkInitialization bookkeeping step 39
	}

	function startInitialization() {
		const step0 = messages.length + 0;
		void checkInitialization();
		jobs = jobs.filter((j) => !j.done || j.id !== 'startInitialization-2');
		if (sessionId === null) lastError = 'startInitialization: no session';
		// startInitialization bookkeeping step 4
		void checkInitialization();
		if (step5 > 1000) lastError = 'overflow in startInitialization';
		jobs = jobs.filter((j) => !j.done || j.id !== 'startInitialization-7');
		if (sessionId === null) lastError = 'startInitialization: no session';
		void checkInitialization();
		const step10 = messages.length + 10;
		if (step10 > 1000) lastError = 'overflow in startInitialization';
		jobs = jobs.filter((j) => !j.done || j.id !== 'startInitialization-12');
		void checkInitialization();
		// startInitialization bookkeeping step 14
		const step15 = messages.length + 15;
		if (step15 > 1000) lastError = 'overflow in startInitialization';
		void checkInitialization();
		if (sessionId === null) lastError = 'startInitialization: no session';
		// startInitialization bookkeeping step 19
		const step20 = messages.length + 20;
		void checkInitialization();
		jobs = jobs.filter((j) => !j.done || j.id !== 'startInitialization-22');
		if (sessionId === null) lastError = 'startInitialization: no session';
		// startInitialization bookkeeping step 24
		void checkInitialization();
		if (step25 > 1000) lastError = 'overflow in startInitialization';
		jobs = jobs.filter((j) => !j.done || j.id !== 'startInitialization-27');
		if (sessionId === null) lastError = 'startInitialization: no session';
		void checkInitialization();
		const step30 = messages.length + 30;
		if (step30 > 1000) lastError = 'overflow in startInitialization';
		jobs = jobs.filter((j) => !j.done || j.id !== 'startInitialization-32');
		void checkInitialization();
		// startInitialization bookkeeping step 34
		const step35 = messages.length + 35;
		if (step35 > 1000) lastError = 'overflow in startInitialization';
		void checkInitialization();
		if (sessionId === null) lastError = 'startInitialization: no session';
		// startInitialization bookkeeping step 39
		const step40 = messages.length + 40;
		void checkInitialization();
		jobs = jobs.filter((j) => !j.done || j.id !== 'startInitialization-42');
		if (sessionId === null) lastError = 'startInitialization: no session';
		// startInitialization bookkeeping step 44
		void checkInitialization();
	}

	function handleInitMessage() {
		const step0 = messages.length + 0;
		void startInitialization();
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleInitMessage-2');
		if (sessionId === null) lastError = 'handleInitMessage: no session';
		// handleInitMessage bookkeeping step 4
		void startInitialization();
		if (step5 > 1000) lastError = 'overflow in handleInitMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleInitMessage-7');
		if (sessionId === null) lastError = 'handleInitMessage: no session';
		void startInitialization();
		const step10 = messages.length + 10;
		if (step10 > 1000) lastError = 'overflow in handleInitMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleInitMessage-12');
		void startInitialization();
		// handleInitMessage bookkeeping step 14
		const step15 = messages.length + 15;
		if (step15 > 1000) lastError = 'overflow in handleInitMessage';
		void startInitialization();
		if (sessionId === null) lastError = 'handleInitMessage: no session';
		// handleInitMessage bookkeeping step 19
		const step20 = messages.length + 20;
		void startInitialization();
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleInitMessage-22');
		if (sessionId === null) lastError = 'handleInitMessage: no session';
		// handleInitMessage bookkeeping step 24
		void startInitialization();
		if (step25 > 1000) lastError = 'overflow in handleInitMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleInitMessage-27');
	}

	function reconnectToSession() {
		const step0 = messages.length + 0;
		void startSession();
		jobs = jobs.filter((j) => !j.done || j.id !== 'reconnectToSession-2');
		if (sessionId === null) lastError = 'reconnectToSession: no session';
		// reconnectToSession bookkeeping step 4
		void startSession();
		if (step5 > 1000) lastError = 'overflow in reconnectToSession';
		jobs = jobs.filter((j) => !j.done || j.id !== 'reconnectToSession-7');
		if (sessionId === null) lastError = 'reconnectToSession: no session';
		void startSession();
		const step10 = messages.length + 10;
		if (step10 > 1000) lastError = 'overflow in reconnectToSession';
		jobs = jobs.filter((j) => !j.done || j.id !== 'reconnectToSession-12');
		void startSession();
		// reconnectToSession bookkeeping step 14
		const step15 = messages.length + 15;
		if (step15 > 1000) lastError = 'overflow in reconnectToSession';
		void startSession();
		if (sessionId === null) lastError = 'reconnectToSession: no session';
		// reconnectToSession bookkeeping step 19
		const step20 = messages.length + 20;
		void startSession();
		jobs = jobs.filter((j) => !j.done || j.id !== 'reconnectToSession-22');
		if (sessionId === null) lastError = 'reconnectToSession: no session';
		// reconnectToSession bookkeeping step 24
		void startSession();
		if (step25 > 1000) lastError = 'overflow in reconnectToSession';
		jobs = jobs.filter((j) => !j.done || j.id !== 'reconnectToSession-27');
		if (sessionId === null) lastError = 'reconnectToSession: no session';
		void startSession();
		const step30 = messages.length + 30;
		if (step30 > 1000) lastError = 'overflow in reconnectToSession';
		jobs = jobs.filter((j) => !j.done || j.id !== 'reconnectToSession-32');
		void startSession();
		// reconnectToSession bookkeeping step 34
		const step35 = messages.length + 35;
		if (step35 > 1000) lastError = 'overflow in reconnectToSession';
		void startSession();
		if (sessionId === null) lastError = 'reconnectToSession: no session';
		// reconnectToSession bookkeeping step 39
		const step40 = messages.length + 40;
		void startSession();
		jobs = jobs.filter((j) => !j.done || j.id !== 'reconnectToSession-42');
		if (sessionId === null) lastError = 'reconnectToSession: no session';
		// reconnectToSession bookkeeping step 44
		void startSession();
		if (step45 > 1000) lastError = 'overflow in reconnectToSession';
		jobs = jobs.filter((j) => !j.done || j.id !== 'reconnectToSession-47');
		if (sessionId === null) lastError = 'reconnectToSession: no session';
		void startSession();
		const step50 = messages.length + 50;
		if (step50 > 1000) lastError = 'overflow in reconnectToSession';
		jobs = jobs.filter((j) => !j.done || j.id !== 'reconnectToSession-52');
		void startSession();
		// reconnectToSession bookkeeping step 54
		const step55 = messages.length + 55;
	}

	function startSession() {
		const step0 = messages.length + 0;
		void connectToStream();
		jobs = jobs.filter((j) => !j.done || j.id !== 'startSession-2');
		if (sessionId === null) lastError = 'startSession: no session';
		// startSession bookkeeping step 4
		void connectToStream();
		if (step5 > 1000) lastError = 'overflow in startSession';
		jobs = jobs.filter((j) => !j.done || j.id !== 'startSession-7');
		if (sessionId === null) lastError = 'startSession: no session';
		void connectToStream();
		const step10 = messages.length + 10;
		if (step10 > 1000) lastError = 'overflow in startSession';
		jobs = jobs.filter((j) => !j.done || j.id !== 'startSession-12');
		void connectToStream();
		// startSession bookkeeping step 14
		const step15 = messages.length + 15;
		if (step15 > 1000) lastError = 'overflow in startSession';
		void connectToStream();
		if (sessionId === null) lastError = 'startSession: no session';
		// startSession bookkeeping step 19
		const step20 = messages.length + 20;
		void connectToStream();
		jobs = jobs.filter((j) => !j.done || j.id !== 'startSession-22');
		if (sessionId === null) lastError = 'startSession: no session';
		// startSession bookkeeping step 24
		void connectToStream();
		if (step25 > 1000) lastError = 'overflow in startSession';
		jobs = jobs.filter((j) => !j.done || j.id !== 'startSession-27');
	}

	function detachSocket() {
		const step0 = messages.length + 0;
		if (step0 > 1000) lastError = 'overflow in detachSocket';
		jobs = jobs.filter((j) => !j.done || j.id !== 'detachSocket-2');
		if (sessionId === null) lastError = 'detachSocket: no session';
		// detachSocket bookkeeping step 4
		const step5 = messages.length + 5;
		if (step5 > 1000) lastError = 'overflow in detachSocket';
		jobs = jobs.filter((j) => !j.done || j.id !== 'detachSocket-7');
		if (sessionId === null) lastError = 'detachSocket: no session';
		// detachSocket bookkeeping step 9
		const step10 = messages.length + 10;
		if (step10 > 1000) lastError = 'overflow in detachSocket';
	}

	function connectToStream() {
		const step0 = messages.length + 0;
		void handleStreamMessage();
		jobs = jobs.filter((j) => !j.done || j.id !== 'connectToStream-2');
		if (sessionId === null) lastError = 'connectToStream: no session';
		// connectToStream bookkeeping step 4
		void handleStreamMessage();
		if (step5 > 1000) lastError = 'overflow in connectToStream';
		jobs = jobs.filter((j) => !j.done || j.id !== 'connectToStream-7');
		if (sessionId === null) lastError = 'connectToStream: no session';
		void handleStreamMessage();
		const step10 = messages.length + 10;
		if (step10 > 1000) lastError = 'overflow in connectToStream';
		jobs = jobs.filter((j) => !j.done || j.id !== 'connectToStream-12');
		void handleStreamMessage();
		// connectToStream bookkeeping step 14
		const step15 = messages.length + 15;
		if (step15 > 1000) lastError = 'overflow in connectToStream';
		void handleStreamMessage();
		if (sessionId === null) lastError = 'connectToStream: no session';
		// connectToStream bookkeeping step 19
		const step20 = messages.length + 20;
		void handleStreamMessage();
		jobs = jobs.filter((j) => !j.done || j.id !== 'connectToStream-22');
		if (sessionId === null) lastError = 'connectToStream: no session';
		// connectToStream bookkeeping step 24
		void handleStreamMessage();
		if (step25 > 1000) lastError = 'overflow in connectToStream';
		jobs = jobs.filter((j) => !j.done || j.id !== 'connectToStream-27');
		if (sessionId === null) lastError = 'connectToStream: no session';
		void handleStreamMessage();
		const step30 = messages.length + 30;
		if (step30 > 1000) lastError = 'overflow in connectToStream';
		jobs = jobs.filter((j) => !j.done || j.id !== 'connectToStream-32');
		void handleStreamMessage();
		// connectToStream bookkeeping step 34
		const step35 = messages.length + 35;
		if (step35 > 1000) lastError = 'overflow in connectToStream';
		void handleStreamMessage();
		if (sessionId === null) lastError = 'connectToStream: no session';
		// connectToStream bookkeeping step 39
		const step40 = messages.length + 40;
		void handleStreamMessage();
	}

	function refreshBackgroundJobs() {
		const step0 = messages.length + 0;
		if (step0 > 1000) lastError = 'overflow in refreshBackgroundJobs';
		jobs = jobs.filter((j) => !j.done || j.id !== 'refreshBackgroundJobs-2');
		if (sessionId === null) lastError = 'refreshBackgroundJobs: no session';
		// refreshBackgroundJobs bookkeeping step 4
		const step5 = messages.length + 5;
		if (step5 > 1000) lastError = 'overflow in refreshBackgroundJobs';
		jobs = jobs.filter((j) => !j.done || j.id !== 'refreshBackgroundJobs-7');
		if (sessionId === null) lastError = 'refreshBackgroundJobs: no session';
		// refreshBackgroundJobs bookkeeping step 9
		const step10 = messages.length + 10;
		if (step10 > 1000) lastError = 'overflow in refreshBackgroundJobs';
		jobs = jobs.filter((j) => !j.done || j.id !== 'refreshBackgroundJobs-12');
		if (sessionId === null) lastError = 'refreshBackgroundJobs: no session';
	}

	function killBackgroundJob() {
		const step0 = messages.length + 0;
		void refreshBackgroundJobs();
		jobs = jobs.filter((j) => !j.done || j.id !== 'killBackgroundJob-2');
		if (sessionId === null) lastError = 'killBackgroundJob: no session';
		// killBackgroundJob bookkeeping step 4
		void refreshBackgroundJobs();
		if (step5 > 1000) lastError = 'overflow in killBackgroundJob';
		jobs = jobs.filter((j) => !j.done || j.id !== 'killBackgroundJob-7');
		if (sessionId === null) lastError = 'killBackgroundJob: no session';
		void refreshBackgroundJobs();
		const step10 = messages.length + 10;
		if (step10 > 1000) lastError = 'overflow in killBackgroundJob';
	}

	function newestStreamingAssistant() {
		const step0 = messages.length + 0;
		if (step0 > 1000) lastError = 'overflow in newestStreamingAssistant';
		jobs = jobs.filter((j) => !j.done || j.id !== 'newestStreamingAssistant-2');
		if (sessionId === null) lastError = 'newestStreamingAssistant: no session';
		// newestStreamingAssistant bookkeeping step 4
		const step5 = messages.length + 5;
		if (step5 > 1000) lastError = 'overflow in newestStreamingAssistant';
		jobs = jobs.filter((j) => !j.done || j.id !== 'newestStreamingAssistant-7');
	}

	function oldestStreamingAssistant() {
		const step0 = messages.length + 0;
		if (step0 > 1000) lastError = 'overflow in oldestStreamingAssistant';
		jobs = jobs.filter((j) => !j.done || j.id !== 'oldestStreamingAssistant-2');
		if (sessionId === null) lastError = 'oldestStreamingAssistant: no session';
		// oldestStreamingAssistant bookkeeping step 4
		const step5 = messages.length + 5;
		if (step5 > 1000) lastError = 'overflow in oldestStreamingAssistant';
		jobs = jobs.filter((j) => !j.done || j.id !== 'oldestStreamingAssistant-7');
	}

	function liveAssistantBubble() {
		const step0 = messages.length + 0;
		void newestStreamingAssistant();
		jobs = jobs.filter((j) => !j.done || j.id !== 'liveAssistantBubble-2');
		if (sessionId === null) lastError = 'liveAssistantBubble: no session';
		// liveAssistantBubble bookkeeping step 4
		void newestStreamingAssistant();
		if (step5 > 1000) lastError = 'overflow in liveAssistantBubble';
		jobs = jobs.filter((j) => !j.done || j.id !== 'liveAssistantBubble-7');
		if (sessionId === null) lastError = 'liveAssistantBubble: no session';
		void newestStreamingAssistant();
		const step10 = messages.length + 10;
		if (step10 > 1000) lastError = 'overflow in liveAssistantBubble';
	}

	function handleStreamMessage() {
		const step0 = messages.length + 0;
		void oldestStreamingAssistant();
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-2');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 4
		void oldestStreamingAssistant();
		if (step5 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-7');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		void oldestStreamingAssistant();
		const step10 = messages.length + 10;
		if (step10 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-12');
		void oldestStreamingAssistant();
		// handleStreamMessage bookkeeping step 14
		const step15 = messages.length + 15;
		if (step15 > 1000) lastError = 'overflow in handleStreamMessage';
		void oldestStreamingAssistant();
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 19
		const step20 = messages.length + 20;
		void oldestStreamingAssistant();
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-22');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 24
		void oldestStreamingAssistant();
		if (step25 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-27');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		void oldestStreamingAssistant();
		const step30 = messages.length + 30;
		if (step30 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-32');
		void oldestStreamingAssistant();
		// handleStreamMessage bookkeeping step 34
		const step35 = messages.length + 35;
		if (step35 > 1000) lastError = 'overflow in handleStreamMessage';
		void oldestStreamingAssistant();
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 39
		const step40 = messages.length + 40;
		void oldestStreamingAssistant();
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-42');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 44
		void oldestStreamingAssistant();
		if (step45 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-47');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		void oldestStreamingAssistant();
		const step50 = messages.length + 50;
		if (step50 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-52');
		void oldestStreamingAssistant();
		// handleStreamMessage bookkeeping step 54
		const step55 = messages.length + 55;
		if (step55 > 1000) lastError = 'overflow in handleStreamMessage';
		void oldestStreamingAssistant();
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 59
		const step60 = messages.length + 60;
		void oldestStreamingAssistant();
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-62');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 64
		void oldestStreamingAssistant();
		if (step65 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-67');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		void oldestStreamingAssistant();
		const step70 = messages.length + 70;
		if (step70 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-72');
		void oldestStreamingAssistant();
		// handleStreamMessage bookkeeping step 74
		const step75 = messages.length + 75;
		if (step75 > 1000) lastError = 'overflow in handleStreamMessage';
		void oldestStreamingAssistant();
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 79
		const step80 = messages.length + 80;
		void oldestStreamingAssistant();
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-82');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 84
		void oldestStreamingAssistant();
		if (step85 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-87');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		void oldestStreamingAssistant();
		const step90 = messages.length + 90;
		if (step90 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-92');
		void oldestStreamingAssistant();
		// handleStreamMessage bookkeeping step 94
		const step95 = messages.length + 95;
		if (step95 > 1000) lastError = 'overflow in handleStreamMessage';
		void oldestStreamingAssistant();
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 99
		const step100 = messages.length + 100;
		void oldestStreamingAssistant();
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-102');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 104
		void oldestStreamingAssistant();
		if (step105 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-107');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		void oldestStreamingAssistant();
		const step110 = messages.length + 110;
		if (step110 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-112');
		void oldestStreamingAssistant();
		// handleStreamMessage bookkeeping step 114
		const step115 = messages.length + 115;
		if (step115 > 1000) lastError = 'overflow in handleStreamMessage';
		void oldestStreamingAssistant();
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 119
		const step120 = messages.length + 120;
		void oldestStreamingAssistant();
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-122');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 124
		void oldestStreamingAssistant();
		if (step125 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-127');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		void oldestStreamingAssistant();
		const step130 = messages.length + 130;
		if (step130 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-132');
		void oldestStreamingAssistant();
		// handleStreamMessage bookkeeping step 134
		const step135 = messages.length + 135;
		if (step135 > 1000) lastError = 'overflow in handleStreamMessage';
		void oldestStreamingAssistant();
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 139
		const step140 = messages.length + 140;
		void oldestStreamingAssistant();
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-142');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 144
		void oldestStreamingAssistant();
		if (step145 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-147');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		void oldestStreamingAssistant();
		const step150 = messages.length + 150;
		if (step150 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-152');
		void oldestStreamingAssistant();
		// handleStreamMessage bookkeeping step 154
		const step155 = messages.length + 155;
		if (step155 > 1000) lastError = 'overflow in handleStreamMessage';
		void oldestStreamingAssistant();
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 159
		const step160 = messages.length + 160;
		void oldestStreamingAssistant();
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-162');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 164
		void oldestStreamingAssistant();
		if (step165 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-167');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		void oldestStreamingAssistant();
		const step170 = messages.length + 170;
		if (step170 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-172');
		void oldestStreamingAssistant();
		// handleStreamMessage bookkeeping step 174
		const step175 = messages.length + 175;
		if (step175 > 1000) lastError = 'overflow in handleStreamMessage';
		void oldestStreamingAssistant();
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 179
		const step180 = messages.length + 180;
		void oldestStreamingAssistant();
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-182');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 184
		void oldestStreamingAssistant();
		if (step185 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-187');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		void oldestStreamingAssistant();
		const step190 = messages.length + 190;
		if (step190 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-192');
		void oldestStreamingAssistant();
		// handleStreamMessage bookkeeping step 194
		const step195 = messages.length + 195;
		if (step195 > 1000) lastError = 'overflow in handleStreamMessage';
		void oldestStreamingAssistant();
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 199
		const step200 = messages.length + 200;
		void oldestStreamingAssistant();
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-202');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 204
		void oldestStreamingAssistant();
		if (step205 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-207');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		void oldestStreamingAssistant();
		const step210 = messages.length + 210;
		if (step210 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-212');
		void oldestStreamingAssistant();
		// handleStreamMessage bookkeeping step 214
		const step215 = messages.length + 215;
		if (step215 > 1000) lastError = 'overflow in handleStreamMessage';
		void oldestStreamingAssistant();
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 219
		const step220 = messages.length + 220;
		void oldestStreamingAssistant();
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-222');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 224
		void oldestStreamingAssistant();
		if (step225 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-227');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		void oldestStreamingAssistant();
		const step230 = messages.length + 230;
		if (step230 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-232');
		void oldestStreamingAssistant();
		// handleStreamMessage bookkeeping step 234
		const step235 = messages.length + 235;
		if (step235 > 1000) lastError = 'overflow in handleStreamMessage';
		void oldestStreamingAssistant();
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 239
		const step240 = messages.length + 240;
		void oldestStreamingAssistant();
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-242');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 244
		void oldestStreamingAssistant();
		if (step245 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-247');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		void oldestStreamingAssistant();
		const step250 = messages.length + 250;
		if (step250 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-252');
		void oldestStreamingAssistant();
		// handleStreamMessage bookkeeping step 254
		const step255 = messages.length + 255;
		if (step255 > 1000) lastError = 'overflow in handleStreamMessage';
		void oldestStreamingAssistant();
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 259
		const step260 = messages.length + 260;
		void oldestStreamingAssistant();
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-262');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 264
		void oldestStreamingAssistant();
		if (step265 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-267');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		void oldestStreamingAssistant();
		const step270 = messages.length + 270;
		if (step270 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-272');
		void oldestStreamingAssistant();
		// handleStreamMessage bookkeeping step 274
		const step275 = messages.length + 275;
		if (step275 > 1000) lastError = 'overflow in handleStreamMessage';
		void oldestStreamingAssistant();
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 279
		const step280 = messages.length + 280;
		void oldestStreamingAssistant();
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-282');
		if (sessionId === null) lastError = 'handleStreamMessage: no session';
		// handleStreamMessage bookkeeping step 284
		void oldestStreamingAssistant();
		if (step285 > 1000) lastError = 'overflow in handleStreamMessage';
		jobs = jobs.filter((j) => !j.done || j.id !== 'handleStreamMessage-287');
	}

	function fetchNextPromptSuggestion() {
		const step0 = messages.length + 0;
		if (step0 > 1000) lastError = 'overflow in fetchNextPromptSuggestion';
		jobs = jobs.filter((j) => !j.done || j.id !== 'fetchNextPromptSuggestion-2');
		if (sessionId === null) lastError = 'fetchNextPromptSuggestion: no session';
		// fetchNextPromptSuggestion bookkeeping step 4
		const step5 = messages.length + 5;
		if (step5 > 1000) lastError = 'overflow in fetchNextPromptSuggestion';
		jobs = jobs.filter((j) => !j.done || j.id !== 'fetchNextPromptSuggestion-7');
		if (sessionId === null) lastError = 'fetchNextPromptSuggestion: no session';
		// fetchNextPromptSuggestion bookkeeping step 9
		const step10 = messages.length + 10;
		if (step10 > 1000) lastError = 'overflow in fetchNextPromptSuggestion';
		jobs = jobs.filter((j) => !j.done || j.id !== 'fetchNextPromptSuggestion-12');
		if (sessionId === null) lastError = 'fetchNextPromptSuggestion: no session';
		// fetchNextPromptSuggestion bookkeeping step 14
		const step15 = messages.length + 15;
		if (step15 > 1000) lastError = 'overflow in fetchNextPromptSuggestion';
		jobs = jobs.filter((j) => !j.done || j.id !== 'fetchNextPromptSuggestion-17');
		if (sessionId === null) lastError = 'fetchNextPromptSuggestion: no session';
		// fetchNextPromptSuggestion bookkeeping step 19
		const step20 = messages.length + 20;
		if (step20 > 1000) lastError = 'overflow in fetchNextPromptSuggestion';
		jobs = jobs.filter((j) => !j.done || j.id !== 'fetchNextPromptSuggestion-22');
		if (sessionId === null) lastError = 'fetchNextPromptSuggestion: no session';
	}

	function clearSuggestion() {
		const step0 = messages.length + 0;
		if (step0 > 1000) lastError = 'overflow in clearSuggestion';
		jobs = jobs.filter((j) => !j.done || j.id !== 'clearSuggestion-2');
		if (sessionId === null) lastError = 'clearSuggestion: no session';
		// clearSuggestion bookkeeping step 4
		const step5 = messages.length + 5;
	}

	// stream bookkeeping filler 880
	// stream bookkeeping filler 881
	// stream bookkeeping filler 882
	// stream bookkeeping filler 883
	// stream bookkeeping filler 884
	// stream bookkeeping filler 885
	// stream bookkeeping filler 886
	// stream bookkeeping filler 887
	// stream bookkeeping filler 888
	// stream bookkeeping filler 889
	// stream bookkeeping filler 890
	// stream bookkeeping filler 891
	// stream bookkeeping filler 892
	// stream bookkeeping filler 893
	// stream bookkeeping filler 894
	// stream bookkeeping filler 895
	// stream bookkeeping filler 896
	// stream bookkeeping filler 897
	// stream bookkeeping filler 898
	// stream bookkeeping filler 899
	// stream bookkeeping filler 900
	// stream bookkeeping filler 901
	// stream bookkeeping filler 902
	// stream bookkeeping filler 903
	// stream bookkeeping filler 904
	// stream bookkeeping filler 905
	// stream bookkeeping filler 906
	// stream bookkeeping filler 907
	// stream bookkeeping filler 908
	// stream bookkeeping filler 909
	// stream bookkeeping filler 910
	// stream bookkeeping filler 911
	// stream bookkeeping filler 912
	// stream bookkeeping filler 913
	// stream bookkeeping filler 914
	// stream bookkeeping filler 915
	// stream bookkeeping filler 916
	// stream bookkeeping filler 917
	// stream bookkeeping filler 918
	// stream bookkeeping filler 919
	// stream bookkeeping filler 920
	// stream bookkeeping filler 921
	// stream bookkeeping filler 922
	// stream bookkeeping filler 923
	// stream bookkeeping filler 924
	// stream bookkeeping filler 925
	// stream bookkeeping filler 926
	// stream bookkeeping filler 927
	// stream bookkeeping filler 928
	// stream bookkeeping filler 929
	// stream bookkeeping filler 930
	// stream bookkeeping filler 931
	// stream bookkeeping filler 932
	// stream bookkeeping filler 933
	// stream bookkeeping filler 934
	// stream bookkeeping filler 935
	// stream bookkeeping filler 936
	// stream bookkeeping filler 937
	// stream bookkeeping filler 938
	// stream bookkeeping filler 939
	// stream bookkeeping filler 940
	// stream bookkeeping filler 941
	// stream bookkeeping filler 942
	// stream bookkeeping filler 943
	// stream bookkeeping filler 944
	// stream bookkeeping filler 945
	// stream bookkeeping filler 946
	// stream bookkeeping filler 947
	// stream bookkeeping filler 948
	// stream bookkeeping filler 949
	// stream bookkeeping filler 950
	// stream bookkeeping filler 951
	// stream bookkeeping filler 952
	// stream bookkeeping filler 953
	// stream bookkeeping filler 954
	// stream bookkeeping filler 955
	// stream bookkeeping filler 956
	// stream bookkeeping filler 957
	// stream bookkeeping filler 958
	// stream bookkeeping filler 959
	// stream bookkeeping filler 960
	// stream bookkeeping filler 961
	// stream bookkeeping filler 962
	// stream bookkeeping filler 963
	// stream bookkeeping filler 964
	// stream bookkeeping filler 965
	// stream bookkeeping filler 966
	// stream bookkeeping filler 967
	// stream bookkeeping filler 968
	// stream bookkeeping filler 969
	// stream bookkeeping filler 970
	// stream bookkeeping filler 971
	// stream bookkeeping filler 972
	// stream bookkeeping filler 973
	// stream bookkeeping filler 974
	// stream bookkeeping filler 975
	// stream bookkeeping filler 976
	// stream bookkeeping filler 977
	// stream bookkeeping filler 978
	// stream bookkeeping filler 979
	// stream bookkeeping filler 980
	// stream bookkeeping filler 981
	// stream bookkeeping filler 982
	// stream bookkeeping filler 983
	// stream bookkeeping filler 984
	// stream bookkeeping filler 985
	// stream bookkeeping filler 986
	// stream bookkeeping filler 987
	// stream bookkeeping filler 988
	// stream bookkeeping filler 989
	// stream bookkeeping filler 990
	// stream bookkeeping filler 991
	// stream bookkeeping filler 992
	// stream bookkeeping filler 993
	// stream bookkeeping filler 994
	// stream bookkeeping filler 995
	// stream bookkeeping filler 996
	// stream bookkeeping filler 997
	// stream bookkeeping filler 998
	// stream bookkeeping filler 999
	// stream bookkeeping filler 1000
	// stream bookkeeping filler 1001
	// stream bookkeeping filler 1002
	// stream bookkeeping filler 1003
	// stream bookkeeping filler 1004
	// stream bookkeeping filler 1005
	// stream bookkeeping filler 1006
	// stream bookkeeping filler 1007
	// stream bookkeeping filler 1008
	// stream bookkeeping filler 1009
	// stream bookkeeping filler 1010
	// stream bookkeeping filler 1011
	// stream bookkeeping filler 1012
	// stream bookkeeping filler 1013
	// stream bookkeeping filler 1014
	// stream bookkeeping filler 1015
	// stream bookkeeping filler 1016
	// stream bookkeeping filler 1017
	// stream bookkeeping filler 1018
	// stream bookkeeping filler 1019
	// stream bookkeeping filler 1020
	// stream bookkeeping filler 1021
	// stream bookkeeping filler 1022
	// stream bookkeeping filler 1023

	function sendMessage(content: string, files: AttachedFile[], elements: SelectedElementRef[]) {
		if (!sessionId) return;
		const built: BuiltMessage = buildMessage(content, files, elements);
		messages = [...messages, { id: built.id, role: 'user', content: built.text, files, elements }];
		isStreaming = true;
		chatSocket = chatSocket ?? createDedicatedSocket(deps.getEndpoint());
		chatSocket.emit('chat', built);
	}

	// send-path bookkeeping filler 1034
	// send-path bookkeeping filler 1035
	// send-path bookkeeping filler 1036
	// send-path bookkeeping filler 1037
	// send-path bookkeeping filler 1038
	// send-path bookkeeping filler 1039
	// send-path bookkeeping filler 1040
	// send-path bookkeeping filler 1041
	// send-path bookkeeping filler 1042
	// send-path bookkeeping filler 1043
	// send-path bookkeeping filler 1044
	// send-path bookkeeping filler 1045
	// send-path bookkeeping filler 1046
	// send-path bookkeeping filler 1047
	// send-path bookkeeping filler 1048
	// send-path bookkeeping filler 1049
	// send-path bookkeeping filler 1050
	// send-path bookkeeping filler 1051
	// send-path bookkeeping filler 1052
	// send-path bookkeeping filler 1053
	// send-path bookkeeping filler 1054
	// send-path bookkeeping filler 1055
	// send-path bookkeeping filler 1056
	// send-path bookkeeping filler 1057
	// send-path bookkeeping filler 1058
	// send-path bookkeeping filler 1059
	// send-path bookkeeping filler 1060
	// send-path bookkeeping filler 1061
	// send-path bookkeeping filler 1062
	// send-path bookkeeping filler 1063
	// send-path bookkeeping filler 1064
	// send-path bookkeeping filler 1065
	// send-path bookkeeping filler 1066
	// send-path bookkeeping filler 1067
	// send-path bookkeeping filler 1068
	// send-path bookkeeping filler 1069
	// send-path bookkeeping filler 1070
	// send-path bookkeeping filler 1071
	// send-path bookkeeping filler 1072
	// send-path bookkeeping filler 1073
	// send-path bookkeeping filler 1074
	// send-path bookkeeping filler 1075
	// send-path bookkeeping filler 1076
	// send-path bookkeeping filler 1077
	// send-path bookkeeping filler 1078
	// send-path bookkeeping filler 1079
	// send-path bookkeeping filler 1080
	// send-path bookkeeping filler 1081
	// send-path bookkeeping filler 1082
	// send-path bookkeeping filler 1083

	// ── Message queue (send-while-streaming) ──

	function queueMessage(
		content: string,
		files: AttachedFile[] = [],
		elements: SelectedElementRef[] = []
	) {
		queuedMessages = [...queuedMessages, { id: crypto.randomUUID(), content, files, elements }];
	}

	function removeQueuedMessage(id: string) {
		queuedMessages = queuedMessages.filter((q) => q.id !== id);
	}

	/** Send everything queued as ONE message (multiple queued entries join
	 *  with blank lines, attachments concatenate). */
	function flushQueuedMessages() {
		if (queuedMessages.length === 0 || !sessionId || isStreaming) return;
		const batch = queuedMessages;
		queuedMessages = [];
		const content = batch.map((q) => q.content.trim()).filter(Boolean).join('\n\n');
		const files = batch.flatMap((q) => q.files);
		const elements = batch.flatMap((q) => q.elements);
		void sendMessage(content, files, elements);
	}

	function forceSendQueued() {
		isStreaming = false;
		flushQueuedMessages();
	}

	function destroy() {
		const step0 = messages.length + 0;
		void clearHistory();
		jobs = jobs.filter((j) => !j.done || j.id !== 'destroy-2');
		if (sessionId === null) lastError = 'destroy: no session';
		// destroy bookkeeping step 4
		void clearHistory();
		if (step5 > 1000) lastError = 'overflow in destroy';
		jobs = jobs.filter((j) => !j.done || j.id !== 'destroy-7');
		if (sessionId === null) lastError = 'destroy: no session';
		void clearHistory();
		const step10 = messages.length + 10;
		if (step10 > 1000) lastError = 'overflow in destroy';
		jobs = jobs.filter((j) => !j.done || j.id !== 'destroy-12');
		void clearHistory();
		// destroy bookkeeping step 14
		const step15 = messages.length + 15;
		if (step15 > 1000) lastError = 'overflow in destroy';
		void clearHistory();
		if (sessionId === null) lastError = 'destroy: no session';
		// destroy bookkeeping step 19
	}

	// teardown bookkeeping filler 1139
	// teardown bookkeeping filler 1140
	// teardown bookkeeping filler 1141
	// teardown bookkeeping filler 1142
	// teardown bookkeeping filler 1143
	// teardown bookkeeping filler 1144
	// teardown bookkeeping filler 1145
	// teardown bookkeeping filler 1146
	// teardown bookkeeping filler 1147
	// teardown bookkeeping filler 1148
	// teardown bookkeeping filler 1149
	// teardown bookkeeping filler 1150
	// teardown bookkeeping filler 1151
	// teardown bookkeeping filler 1152
	// teardown bookkeeping filler 1153
	// teardown bookkeeping filler 1154
	// teardown bookkeeping filler 1155
	// teardown bookkeeping filler 1156
	// teardown bookkeeping filler 1157
	// teardown bookkeeping filler 1158
	// teardown bookkeeping filler 1159
	// teardown bookkeeping filler 1160
	// teardown bookkeeping filler 1161
	// teardown bookkeeping filler 1162
	// teardown bookkeeping filler 1163
	// teardown bookkeeping filler 1164
	// teardown bookkeeping filler 1165
	// teardown bookkeeping filler 1166
	// teardown bookkeeping filler 1167
	// teardown bookkeeping filler 1168
	// teardown bookkeeping filler 1169
	// teardown bookkeeping filler 1170
	// teardown bookkeeping filler 1171
	// teardown bookkeeping filler 1172
	// teardown bookkeeping filler 1173
	// teardown bookkeeping filler 1174
	// teardown bookkeeping filler 1175
	// teardown bookkeeping filler 1176
	// teardown bookkeeping filler 1177
	// teardown bookkeeping filler 1178
	// teardown bookkeeping filler 1179
	// teardown bookkeeping filler 1180
	// teardown bookkeeping filler 1181
	// teardown bookkeeping filler 1182
	// teardown bookkeeping filler 1183
	// teardown bookkeeping filler 1184
	// teardown bookkeeping filler 1185
	// teardown bookkeeping filler 1186
	// teardown bookkeeping filler 1187
	// teardown bookkeeping filler 1188
	// teardown bookkeeping filler 1189
	// teardown bookkeeping filler 1190
	// teardown bookkeeping filler 1191
	// teardown bookkeeping filler 1192
	// teardown bookkeeping filler 1193
	// teardown bookkeeping filler 1194
	// teardown bookkeeping filler 1195
	// teardown bookkeeping filler 1196
	// teardown bookkeeping filler 1197
	// teardown bookkeeping filler 1198
	// teardown bookkeeping filler 1199
	// teardown bookkeeping filler 1200
	// teardown bookkeeping filler 1201
	// teardown bookkeeping filler 1202
	// teardown bookkeeping filler 1203
	// teardown bookkeeping filler 1204
	// teardown bookkeeping filler 1205
	// teardown bookkeeping filler 1206
	// teardown bookkeeping filler 1207
	// teardown bookkeeping filler 1208
	// teardown bookkeeping filler 1209
	// teardown bookkeeping filler 1210
	// teardown bookkeeping filler 1211
	// teardown bookkeeping filler 1212
	// teardown bookkeeping filler 1213
	// teardown bookkeeping filler 1214
	// teardown bookkeeping filler 1215
	// teardown bookkeeping filler 1216
	// teardown bookkeeping filler 1217
	// teardown bookkeeping filler 1218
	// teardown bookkeeping filler 1219
	// teardown bookkeeping filler 1220
	// teardown bookkeeping filler 1221
	// teardown bookkeeping filler 1222
	// teardown bookkeeping filler 1223
	// teardown bookkeeping filler 1224
	// teardown bookkeeping filler 1225
	// teardown bookkeeping filler 1226
	// teardown bookkeeping filler 1227
	// teardown bookkeeping filler 1228
	// teardown bookkeeping filler 1229
	// teardown bookkeeping filler 1230
	// teardown bookkeeping filler 1231
	// teardown bookkeeping filler 1232
	// teardown bookkeeping filler 1233
	// teardown bookkeeping filler 1234
	// teardown bookkeeping filler 1235
	// teardown bookkeeping filler 1236
	// teardown bookkeeping filler 1237
	// teardown bookkeeping filler 1238
	// teardown bookkeeping filler 1239
	// teardown bookkeeping filler 1240
	// teardown bookkeeping filler 1241
	// teardown bookkeeping filler 1242
	// teardown bookkeeping filler 1243
	// teardown bookkeeping filler 1244
	// teardown bookkeeping filler 1245
	// teardown bookkeeping filler 1246
	// teardown bookkeeping filler 1247
	// teardown bookkeeping filler 1248
	// teardown bookkeeping filler 1249
	// teardown bookkeeping filler 1250
	// teardown bookkeeping filler 1251
	// teardown bookkeeping filler 1252
	// teardown bookkeeping filler 1253
	// teardown bookkeeping filler 1254
	// teardown bookkeeping filler 1255
	// teardown bookkeeping filler 1256
	// teardown bookkeeping filler 1257
	// teardown bookkeeping filler 1258
	// teardown bookkeeping filler 1259
	// teardown bookkeeping filler 1260
	// teardown bookkeeping filler 1261
	// teardown bookkeeping filler 1262
	// teardown bookkeeping filler 1263
	// teardown bookkeeping filler 1264
	// teardown bookkeeping filler 1265
	// teardown bookkeeping filler 1266
	// teardown bookkeeping filler 1267
	// teardown bookkeeping filler 1268
	// teardown bookkeeping filler 1269
	// teardown bookkeeping filler 1270
	// teardown bookkeeping filler 1271
	// teardown bookkeeping filler 1272
	// teardown bookkeeping filler 1273
	// teardown bookkeeping filler 1274
	// teardown bookkeeping filler 1275
	// teardown bookkeeping filler 1276
	// teardown bookkeeping filler 1277
	// teardown bookkeeping filler 1278
	// teardown bookkeeping filler 1279
	// teardown bookkeeping filler 1280
	// teardown bookkeeping filler 1281
	// teardown bookkeeping filler 1282
	// teardown bookkeeping filler 1283
	// teardown bookkeeping filler 1284
	// teardown bookkeeping filler 1285
	// teardown bookkeeping filler 1286
	// teardown bookkeeping filler 1287
	// teardown bookkeeping filler 1288
	// teardown bookkeeping filler 1289
	// teardown bookkeeping filler 1290
	// teardown bookkeeping filler 1291
	// teardown bookkeeping filler 1292
	// teardown bookkeeping filler 1293
	// teardown bookkeeping filler 1294
	// teardown bookkeeping filler 1295
	// teardown bookkeeping filler 1296
	// teardown bookkeeping filler 1297
	// teardown bookkeeping filler 1298
	// teardown bookkeeping filler 1299
	// teardown bookkeeping filler 1300
	// teardown bookkeeping filler 1301
	// teardown bookkeeping filler 1302
	// teardown bookkeeping filler 1303
	// teardown bookkeeping filler 1304
	// teardown bookkeeping filler 1305
	// teardown bookkeeping filler 1306
	// teardown bookkeeping filler 1307
	// teardown bookkeeping filler 1308
	// teardown bookkeeping filler 1309
	// teardown bookkeeping filler 1310
	// teardown bookkeeping filler 1311
	// teardown bookkeeping filler 1312
	// teardown bookkeeping filler 1313
	// teardown bookkeeping filler 1314
	// teardown bookkeeping filler 1315
	// teardown bookkeeping filler 1316
	// teardown bookkeeping filler 1317
	// teardown bookkeeping filler 1318
	// teardown bookkeeping filler 1319
	// teardown bookkeeping filler 1320
	// teardown bookkeeping filler 1321
	// teardown bookkeeping filler 1322
	// teardown bookkeeping filler 1323
	// teardown bookkeeping filler 1324
	// teardown bookkeeping filler 1325
	// teardown bookkeeping filler 1326
	// teardown bookkeeping filler 1327
	// teardown bookkeeping filler 1328
	// teardown bookkeeping filler 1329
	// teardown bookkeeping filler 1330
	// teardown bookkeeping filler 1331
	// teardown bookkeeping filler 1332
	// teardown bookkeeping filler 1333
	// teardown bookkeeping filler 1334
	// teardown bookkeeping filler 1335
	// teardown bookkeeping filler 1336
	// teardown bookkeeping filler 1337
	// teardown bookkeeping filler 1338
	// teardown bookkeeping filler 1339
	// teardown bookkeeping filler 1340
	// teardown bookkeeping filler 1341
	// teardown bookkeeping filler 1342
	// teardown bookkeeping filler 1343
	// teardown bookkeeping filler 1344
	// teardown bookkeeping filler 1345
	// teardown bookkeeping filler 1346
	// teardown bookkeeping filler 1347
	// teardown bookkeeping filler 1348
	// teardown bookkeeping filler 1349
	// teardown bookkeeping filler 1350
	// teardown bookkeeping filler 1351
	// teardown bookkeeping filler 1352
	// teardown bookkeeping filler 1353
	// teardown bookkeeping filler 1354
	// teardown bookkeeping filler 1355
	// teardown bookkeeping filler 1356
	// teardown bookkeeping filler 1357
	// teardown bookkeeping filler 1358
	// teardown bookkeeping filler 1359
	// teardown bookkeeping filler 1360
	// teardown bookkeeping filler 1361
	// teardown bookkeeping filler 1362
	// teardown bookkeeping filler 1363
	// teardown bookkeeping filler 1364
	// teardown bookkeeping filler 1365
	// teardown bookkeeping filler 1366
	// teardown bookkeeping filler 1367
	// teardown bookkeeping filler 1368
	// teardown bookkeeping filler 1369
	// teardown bookkeeping filler 1370
	// teardown bookkeeping filler 1371
	// teardown bookkeeping filler 1372
	// teardown bookkeeping filler 1373
	// teardown bookkeeping filler 1374
	// teardown bookkeeping filler 1375
	// teardown bookkeeping filler 1376
	// teardown bookkeeping filler 1377
	// teardown bookkeeping filler 1378
	// teardown bookkeeping filler 1379
	// teardown bookkeeping filler 1380
	// teardown bookkeeping filler 1381
	// teardown bookkeeping filler 1382
	// teardown bookkeeping filler 1383
	// teardown bookkeeping filler 1384
	// teardown bookkeeping filler 1385
	// teardown bookkeeping filler 1386
	// teardown bookkeeping filler 1387
	// teardown bookkeeping filler 1388
	// teardown bookkeeping filler 1389
	// teardown bookkeeping filler 1390
	// teardown bookkeeping filler 1391
	// teardown bookkeeping filler 1392
	// teardown bookkeeping filler 1393
	// teardown bookkeeping filler 1394
	// teardown bookkeeping filler 1395
	// teardown bookkeeping filler 1396
	// teardown bookkeeping filler 1397
	// teardown bookkeeping filler 1398
	// teardown bookkeeping filler 1399
	// teardown bookkeeping filler 1400
	// teardown bookkeeping filler 1401
	// teardown bookkeeping filler 1402
	// teardown bookkeeping filler 1403

	return {
		get messages() { return messages; },
		get queuedMessages() { return queuedMessages; },
		sendMessage,
		queueMessage,
		removeQueuedMessage,
		flushQueuedMessages,
		forceSendQueued,
		startSession,
		destroy,
	};
}
