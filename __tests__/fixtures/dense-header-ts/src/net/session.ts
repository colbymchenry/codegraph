import type {
  Adapter,
  CachePolicy,
  Credential,
  EventMonitor,
  Interceptor,
  RedirectHandler,
  RequestDelegate,
  RequestState,
  Retrier,
  Serializer,
  TrustEvaluator,
  URLRequest,
  URLSessionTask,
  Validator,
} from '../core/types';
import { buildURLRequest } from '../core/request-builder';
import { makeTask, resumeTask } from '../core/task-factory';
import { RequestQueue } from '../core/queue';

/**
 * The shape density-first ranking exists for: a class whose top-of-file header
 * is a long, tightly-packed property list — dozens of adjacent declarations,
 * each individually trivial — while the methods a flow question actually asks
 * about live hundreds of lines below it.
 *
 * Ranked by density alone the header wins the file's whole budget and the
 * methods are buried. The ranking puts importance first for exactly this
 * reason, and density only breaks ties inside one importance tier.
 */
export class Session {
  readonly identifier: string;
  readonly adapter: Adapter;
  readonly serializer: Serializer;
  readonly validator: Validator;
  readonly retrier: Retrier;
  readonly redirectHandler: RedirectHandler;
  readonly trustEvaluator: TrustEvaluator;
  readonly eventMonitor: EventMonitor;
  readonly cachePolicy: CachePolicy;
  readonly credential: Credential | null;
  readonly interceptors: Interceptor[];
  readonly delegate: RequestDelegate;
  readonly queue: RequestQueue;
  readonly startRequestsImmediately: boolean;
  readonly maximumConnectionsPerHost: number;
  readonly timeoutIntervalForRequest: number;
  readonly timeoutIntervalForResource: number;
  readonly allowsCellularAccess: boolean;
  readonly waitsForConnectivity: boolean;
  readonly httpShouldUsePipelining: boolean;
  readonly httpShouldSetCookies: boolean;
  readonly httpMaximumConnectionsPerHost: number;
  readonly sessionConfigurationName: string;
  readonly requestState: RequestState;
  readonly defaultHeaders: Record<string, string>;
  readonly userAgent: string;
  readonly acceptEncoding: string;
  readonly acceptLanguage: string;
  private taskCounter = 0;
  private active = new Map<number, URLSessionTask>();

  constructor(options: Partial<Session> & { identifier: string }) {
    this.identifier = options.identifier;
    this.adapter = options.adapter!;
    this.serializer = options.serializer!;
    this.validator = options.validator!;
    this.retrier = options.retrier!;
    this.redirectHandler = options.redirectHandler!;
    this.trustEvaluator = options.trustEvaluator!;
    this.eventMonitor = options.eventMonitor!;
    this.cachePolicy = options.cachePolicy ?? 'useProtocolCachePolicy';
    this.credential = options.credential ?? null;
    this.interceptors = options.interceptors ?? [];
    this.delegate = options.delegate!;
    this.queue = options.queue ?? new RequestQueue();
    this.startRequestsImmediately = options.startRequestsImmediately ?? true;
    this.maximumConnectionsPerHost = options.maximumConnectionsPerHost ?? 6;
    this.timeoutIntervalForRequest = options.timeoutIntervalForRequest ?? 60;
    this.timeoutIntervalForResource = options.timeoutIntervalForResource ?? 604800;
    this.allowsCellularAccess = options.allowsCellularAccess ?? true;
    this.waitsForConnectivity = options.waitsForConnectivity ?? false;
    this.httpShouldUsePipelining = options.httpShouldUsePipelining ?? false;
    this.httpShouldSetCookies = options.httpShouldSetCookies ?? true;
    this.httpMaximumConnectionsPerHost = options.httpMaximumConnectionsPerHost ?? 6;
    this.sessionConfigurationName = options.sessionConfigurationName ?? 'default';
    this.requestState = options.requestState ?? 'initialized';
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.userAgent = options.userAgent ?? 'session/1.0';
    this.acceptEncoding = options.acceptEncoding ?? 'br;q=1.0, gzip;q=0.9';
    this.acceptLanguage = options.acceptLanguage ?? 'en;q=1.0';
  }

  // -- configuration accessors ----------------------------------------------
  // Individually trivial, adjacent, and dense. On the density tiebreak alone
  // this block outranks anything with a body worth reading.

  get isBackground(): boolean {
    return this.sessionConfigurationName === 'background';
  }

  get connectionLimit(): number {
    return Math.min(this.maximumConnectionsPerHost, this.httpMaximumConnectionsPerHost);
  }

  get headerDefaults(): Record<string, string> {
    return { ...this.defaultHeaders, 'user-agent': this.userAgent };
  }

  get acceptHeaders(): Record<string, string> {
    return { 'accept-encoding': this.acceptEncoding, 'accept-language': this.acceptLanguage };
  }

  get activeCount(): number {
    return this.active.size;
  }

  get isIdle(): boolean {
    return this.active.size === 0;
  }

  get nextIdentifier(): number {
    return this.taskCounter + 1;
  }

  get description(): string {
    return `Session(${this.identifier}, ${this.sessionConfigurationName})`;
  }

  cancelAll(): void {
    for (const task of this.active.values()) task.cancel();
    this.active.clear();
  }

  taskFor(identifier: number): URLSessionTask | undefined {
    return this.active.get(identifier);
  }

  headers(): Record<string, string> {
    return { ...this.headerDefaults, ...this.acceptHeaders };
  }

  withUserAgent(userAgent: string): Session {
    return new Session({ ...this, identifier: this.identifier, userAgent });
  }

  withTimeout(seconds: number): Session {
    return new Session({ ...this, identifier: this.identifier, timeoutIntervalForRequest: seconds });
  }

  withInterceptor(interceptor: Interceptor): Session {
    return new Session({
      ...this,
      identifier: this.identifier,
      interceptors: [...this.interceptors, interceptor],
    });
  }

  withCredential(credential: Credential): Session {
    return new Session({ ...this, identifier: this.identifier, credential });
  }

  withCachePolicy(cachePolicy: CachePolicy): Session {
    return new Session({ ...this, identifier: this.identifier, cachePolicy });
  }

  withQueue(queue: RequestQueue): Session {
    return new Session({ ...this, identifier: this.identifier, queue });
  }

  withAdapter(adapter: Adapter): Session {
    return new Session({ ...this, identifier: this.identifier, adapter });
  }

  withValidator(validator: Validator): Session {
    return new Session({ ...this, identifier: this.identifier, validator });
  }

  withRetrier(retrier: Retrier): Session {
    return new Session({ ...this, identifier: this.identifier, retrier });
  }

  withMonitor(eventMonitor: EventMonitor): Session {
    return new Session({ ...this, identifier: this.identifier, eventMonitor });
  }

  // -- the flow ---------------------------------------------------------------
  //
  // The methods below are what a "how does a request get built and sent" question
  // is about, and they sit hundreds of lines under the header block.

  /**
   * Turn a convenience call into a URLRequest, hand it to the adapter chain and
   * start the resulting task. The entry point of the whole flow.
   */
  async perform(url: string, method: string, body?: Uint8Array): Promise<URLSessionTask> {
    const initial = buildURLRequest({
      url,
      method,
      body,
      headers: this.headers(),
      timeout: this.timeoutIntervalForRequest,
      cachePolicy: this.cachePolicy,
    });
    const adapted = await this.adapt(initial);
    return this.didCreateURLRequest(adapted);
  }

  /**
   * Every interceptor gets a chance to rewrite the request before it becomes a
   * task. Runs in registration order, and a thrown error aborts the whole call.
   */
  private async adapt(request: URLRequest): Promise<URLRequest> {
    let current = request;
    for (const interceptor of this.interceptors) {
      current = await interceptor.adapt(current, this);
      this.eventMonitor.didAdaptRequest(current, interceptor.name);
    }
    if (this.credential) current = this.credential.apply(current);
    return current;
  }

  /**
   * The adapted request is final: build the task around it, register it and —
   * unless the session was told to wait — resume it immediately.
   */
  didCreateURLRequest(request: URLRequest): URLSessionTask {
    this.taskCounter += 1;
    const identifier = this.taskCounter;
    const created = this.task(request, identifier);
    this.active.set(identifier, created);
    this.eventMonitor.didCreateTask(created, request);
    if (this.startRequestsImmediately) this.resume(created);
    return created;
  }

  /**
   * Build the URLSessionTask for a request. Split out from
   * `didCreateURLRequest` because retries rebuild the task without going back
   * through the adapter chain.
   */
  task(request: URLRequest, identifier: number): URLSessionTask {
    const created = makeTask({
      identifier,
      request,
      delegate: this.delegate,
      allowsCellularAccess: this.allowsCellularAccess,
      waitsForConnectivity: this.waitsForConnectivity,
      resourceTimeout: this.timeoutIntervalForResource,
    });
    created.onComplete((response) => {
      this.active.delete(identifier);
      const verdict = this.validator.validate(response);
      if (!verdict.ok && this.retrier.shouldRetry(response, verdict)) {
        this.retry(request, identifier);
        return;
      }
      this.eventMonitor.didCompleteTask(created, response);
    });
    return created;
  }

  /** Put a built task on the queue and start it. */
  resume(task: URLSessionTask): void {
    this.queue.enqueue(task, this.connectionLimit);
    resumeTask(task);
    this.eventMonitor.didResumeTask(task);
  }

  /** Rebuild and restart a task the retrier asked for. */
  private retry(request: URLRequest, previousIdentifier: number): void {
    this.taskCounter += 1;
    const retried = this.task(request, this.taskCounter);
    this.active.set(this.taskCounter, retried);
    this.eventMonitor.didRetryTask(retried, previousIdentifier);
    this.resume(retried);
  }

  /** Follow a redirect by adapting and re-performing the new location. */
  async follow(response: { location: string }, original: URLRequest): Promise<URLSessionTask> {
    const target = this.redirectHandler.resolve(response.location, original);
    if (!target) throw new Error(`redirect to ${response.location} refused`);
    return this.perform(target.url, target.method, target.body);
  }
}
