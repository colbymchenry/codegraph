import type { URLSessionTask } from './types';

export class RequestQueue {
  private readonly waiting: URLSessionTask[] = [];
  private running = 0;

  enqueue(task: URLSessionTask, limit: number): void {
    if (this.running < limit) {
      this.running += 1;
      return;
    }
    this.waiting.push(task);
  }

  release(): URLSessionTask | undefined {
    this.running = Math.max(0, this.running - 1);
    return this.waiting.shift();
  }

  get depth(): number {
    return this.waiting.length;
  }
}
