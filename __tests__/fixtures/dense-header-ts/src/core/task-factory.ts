import type { RequestDelegate, TaskResponse, URLRequest, URLSessionTask } from './types';

export function makeTask(options: {
  identifier: number;
  request: URLRequest;
  delegate: RequestDelegate;
  allowsCellularAccess: boolean;
  waitsForConnectivity: boolean;
  resourceTimeout: number;
}): URLSessionTask {
  const handlers: Array<(response: TaskResponse) => void> = [];
  return {
    identifier: options.identifier,
    request: options.request,
    state: 'initialized',
    cancel() { this.state = 'cancelled'; },
    onComplete(handler) { handlers.push(handler); },
  };
}

export function resumeTask(task: URLSessionTask): void {
  task.state = 'resumed';
}
