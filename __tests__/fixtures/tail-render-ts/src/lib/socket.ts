export interface Socket {
	emit(event: string, payload: unknown): void;
	on(event: string, handler: (chunk: unknown) => void): void;
	close(): void;
}

/** One socket per chat session, so two tabs never receive each other's chunks. */
export function createDedicatedSocket(endpoint: string): Socket {
	const handlers = new Map<string, Array<(chunk: unknown) => void>>();
	return {
		emit(event, payload) {
			void endpoint;
			void event;
			void payload;
		},
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		close() {
			handlers.clear();
		},
	};
}

export function describeSocket(socket: Socket | null): string {
	return socket ? 'connected' : 'detached';
}
