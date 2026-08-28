export type CachePolicy = 'useProtocolCachePolicy' | 'reloadIgnoringLocalCacheData' | 'returnCacheDataElseLoad';
export type RequestState = 'initialized' | 'resumed' | 'suspended' | 'cancelled' | 'finished';

export interface URLRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  timeout: number;
  cachePolicy: CachePolicy;
}

export interface TaskResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface URLSessionTask {
  identifier: number;
  request: URLRequest;
  state: RequestState;
  cancel(): void;
  onComplete(handler: (response: TaskResponse) => void): void;
}

export interface Adapter { adapt(request: URLRequest): URLRequest; }
export interface Serializer { serialize(value: unknown): Uint8Array; }
export interface Validator { validate(response: TaskResponse): { ok: boolean; reason?: string }; }
export interface Retrier { shouldRetry(response: TaskResponse, verdict: { ok: boolean }): boolean; }
export interface RedirectHandler { resolve(location: string, original: URLRequest): { url: string; method: string; body?: Uint8Array } | null; }
export interface TrustEvaluator { evaluate(host: string): boolean; }
export interface Credential { apply(request: URLRequest): URLRequest; }
export interface Interceptor { name: string; adapt(request: URLRequest, session: unknown): Promise<URLRequest>; }
export interface RequestDelegate { willSend(request: URLRequest): void; }
export interface EventMonitor {
  didAdaptRequest(request: URLRequest, interceptor: string): void;
  didCreateTask(task: URLSessionTask, request: URLRequest): void;
  didResumeTask(task: URLSessionTask): void;
  didRetryTask(task: URLSessionTask, previousIdentifier: number): void;
  didCompleteTask(task: URLSessionTask, response: TaskResponse): void;
}
