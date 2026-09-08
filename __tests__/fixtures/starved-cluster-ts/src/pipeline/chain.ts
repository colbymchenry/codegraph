import type { PipelineRequest, PipelineResponse, Interceptor, Socket } from './types';
import { encodeFrame, decodeFrame } from './framing';
import { defaultInterceptors } from './interceptors';

/**
 * A one-line summary of a chain, used only by the tracing hook in the caller.
 * It is TRIVIAL — it answers nothing about how a request travels — but it sits
 * next to the entry point in the call graph, so its cluster carries the file's
 * highest per-symbol importance.
 */
export function describeChain(chain: RequestChain): string {
  return `chain(${chain.index}/${chain.size}) -> ${chain.hostLabel}`;
}

// ---------------------------------------------------------------------------
//
// Everything below is the part a "how does a request reach the socket" question
// is actually asking about. It is separated from the helper above by more than
// the cluster gap threshold, so it forms its own cluster — a large one, whose
// symbols are reached transitively rather than named.
//
// ---------------------------------------------------------------------------

export class RequestChain {
  readonly index: number;
  readonly size: number;
  readonly hostLabel: string;
  private readonly interceptors: Interceptor[];
  private readonly socket: Socket;
  private readonly request: PipelineRequest;
  private connectTimeoutMs = 10_000;
  private readTimeoutMs = 10_000;
  private writeTimeoutMs = 10_000;
  private calls = 0;

  constructor(request: PipelineRequest, socket: Socket, index = 0, interceptors?: Interceptor[]) {
    this.request = request;
    this.socket = socket;
    this.index = index;
    this.interceptors = interceptors ?? defaultInterceptors();
    this.size = this.interceptors.length;
    this.hostLabel = `${request.host}:${request.port}`;
  }

  /**
   * Run the request through the remaining interceptors and, once they are
   * exhausted, hand it to the transport. This is the method the flow question
   * is about: every hop between the caller and the socket passes through here.
   */
  async proceed(request: PipelineRequest): Promise<PipelineResponse> {
    if (this.index >= this.size) {
      return this.writeAndRead(request);
    }
    this.calls += 1;
    if (this.calls > 1) {
      throw new Error(`chain link ${this.index} called ${this.calls} times`);
    }
    const next = this.advance(request);
    const interceptor = this.interceptors[this.index]!;
    const response = await interceptor.intercept(next);
    if (!response) {
      throw new Error(`interceptor ${interceptor.name} returned no response`);
    }
    if (this.index + 1 < this.size && next.callCount() === 0) {
      throw new Error(`interceptor ${interceptor.name} must call proceed()`);
    }
    return response;
  }

  /**
   * The next link in the chain: the same chain with the cursor moved on and the
   * timeouts carried over. Cloning here is what keeps each interceptor from
   * mutating the chain the one before it is still holding.
   */
  advance(request: PipelineRequest): RequestChain {
    const next = new RequestChain(request, this.socket, this.index + 1, this.interceptors);
    next.connectTimeoutMs = this.connectTimeoutMs;
    next.readTimeoutMs = this.readTimeoutMs;
    next.writeTimeoutMs = this.writeTimeoutMs;
    return next;
  }

  callCount(): number {
    return this.calls;
  }

  /**
   * The end of the chain: frame the request, put the bytes on the socket, wait
   * for the reply and decode it. Past this point there is no more pipeline —
   * this is the transport hop the question is looking for.
   */
  private async writeAndRead(request: PipelineRequest): Promise<PipelineResponse> {
    const frame = encodeFrame(request);
    await this.socket.connect(this.connectTimeoutMs);
    await this.socket.write(frame, this.writeTimeoutMs);
    const raw = await this.socket.read(this.readTimeoutMs);
    const decoded = decodeFrame(raw);
    return {
      status: decoded.status,
      headers: decoded.headers,
      body: decoded.body,
      request,
    };
  }

  withConnectTimeout(ms: number): RequestChain {
    const next = this.advance(this.request);
    next.connectTimeoutMs = checkDuration('connectTimeout', ms);
    return next;
  }

  withReadTimeout(ms: number): RequestChain {
    const next = this.advance(this.request);
    next.readTimeoutMs = checkDuration('readTimeout', ms);
    return next;
  }

  withWriteTimeout(ms: number): RequestChain {
    const next = this.advance(this.request);
    next.writeTimeoutMs = checkDuration('writeTimeout', ms);
    return next;
  }

  connectTimeout(): number {
    return this.connectTimeoutMs;
  }

  readTimeout(): number {
    return this.readTimeoutMs;
  }

  writeTimeout(): number {
    return this.writeTimeoutMs;
  }

  /**
   * Retry policy for the transport hop. Sits inside the same cluster as the
   * proceed/advance pair, so it is part of what a shrink has to choose between.
   */
  async retryWrite(request: PipelineRequest, attempts: number): Promise<PipelineResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.writeAndRead(request);
      } catch (error) {
        lastError = error;
        await backoff(attempt);
      }
    }
    throw lastError;
  }

  /** Whether the chain may still be resumed after a transport failure. */
  canRetry(error: unknown): boolean {
    if (this.index >= this.size) return false;
    if (!(error instanceof Error)) return false;
    return error.message.includes('timeout') || error.message.includes('reset');
  }

  /** The interceptor names, in the order the request will visit them. */
  route(): string[] {
    return this.interceptors.slice(this.index).map((i) => i.name);
  }

  /** A copy of the chain rewound to the first interceptor. */
  rewind(): RequestChain {
    return new RequestChain(this.request, this.socket, 0, this.interceptors);
  }

  /** Drop one interceptor by name and return the shortened chain. */
  without(name: string): RequestChain {
    const kept = this.interceptors.filter((i) => i.name !== name);
    return new RequestChain(this.request, this.socket, this.index, kept);
  }

  /** Append an interceptor to the end of the chain. */
  with(interceptor: Interceptor): RequestChain {
    return new RequestChain(
      this.request,
      this.socket,
      this.index,
      [...this.interceptors, interceptor],
    );
  }

  /** Close the transport this chain was built around. */
  async close(): Promise<void> {
    await this.socket.close();
  }

  /** Headers the transport hop will actually put on the wire. */
  effectiveHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...this.request.headers };
    headers['host'] = this.hostLabel;
    headers['x-chain-index'] = String(this.index);
    headers['x-chain-size'] = String(this.size);
    if (this.request.body) headers['content-length'] = String(this.request.body.length);
    return headers;
  }

  /** The request as the next link will see it, with the chain's headers merged. */
  prepared(): PipelineRequest {
    return { ...this.request, headers: this.effectiveHeaders() };
  }

  /**
   * Send the prepared request through the rest of the chain. The convenience
   * wrapper most callers use instead of building the request themselves.
   */
  async send(): Promise<PipelineResponse> {
    return this.proceed(this.prepared());
  }

  /** Whether the chain has any interceptor left before the transport hop. */
  hasNext(): boolean {
    return this.index < this.size;
  }

  /** The interceptor the next `proceed` will run, if there is one. */
  peek(): Interceptor | undefined {
    return this.interceptors[this.index];
  }

  /** Total configured wait for one attempt, across all three timeouts. */
  totalTimeout(): number {
    return this.connectTimeoutMs + this.readTimeoutMs + this.writeTimeoutMs;
  }

  /** Apply one timeout budget to all three phases at once. */
  withTimeout(ms: number): RequestChain {
    const next = this.advance(this.request);
    const checked = checkDuration('timeout', ms);
    next.connectTimeoutMs = checked;
    next.readTimeoutMs = checked;
    next.writeTimeoutMs = checked;
    return next;
  }

  /**
   * Run the chain and translate a transport failure into a response, so a
   * caller that only cares about the status code never sees an exception.
   */
  async sendOrStatus(status: number): Promise<PipelineResponse> {
    try {
      return await this.send();
    } catch {
      return {
        status,
        headers: this.effectiveHeaders(),
        body: new Uint8Array(),
        request: this.request,
      };
    }
  }

  /** A short description of where in the chain this link sits. */
  position(): string {
    return `${this.index + 1} of ${this.size + 1}`;
  }

  /** The chain rebuilt around a different transport. */
  onSocket(socket: Socket): RequestChain {
    return new RequestChain(this.request, socket, this.index, this.interceptors);
  }

  /**
   * Replay the request through the chain from the start, reusing the transport.
   * Used when an interceptor decides the response it got is not usable and the
   * whole pipeline has to run again against the same connection.
   */
  async replay(): Promise<PipelineResponse> {
    const fresh = this.rewind();
    try {
      return await fresh.send();
    } finally {
      if (!fresh.hasNext()) await fresh.close();
    }
  }

  /**
   * Validate the chain before it runs: every interceptor named once, timeouts
   * inside their bounds, and a transport still open at the end of it.
   */
  validate(): string[] {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const interceptor of this.interceptors) {
      if (seen.has(interceptor.name)) problems.push(`duplicate interceptor ${interceptor.name}`);
      seen.add(interceptor.name);
    }
    if (this.connectTimeoutMs <= 0) problems.push('connect timeout must be positive');
    if (this.readTimeoutMs <= 0) problems.push('read timeout must be positive');
    if (this.writeTimeoutMs <= 0) problems.push('write timeout must be positive');
    if (this.index > this.size) problems.push('chain cursor is past the end');
    return problems;
  }

  /**
   * The transport hop on its own, with the chain's timeouts but none of its
   * interceptors — the escape hatch a caller uses to bypass the pipeline.
   */
  async direct(request: PipelineRequest): Promise<PipelineResponse> {
    const problems = this.validate();
    if (problems.length > 0) throw new Error(problems.join('; '));
    return this.writeAndRead(request);
  }
}

function checkDuration(name: string, ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`${name} must be a positive duration`);
  if (ms > 24 * 60 * 60 * 1000) throw new Error(`${name} is longer than a day`);
  return Math.round(ms);
}

async function backoff(attempt: number): Promise<void> {
  const ms = Math.min(1000, 25 * 2 ** attempt);
  await new Promise((resolve) => setTimeout(resolve, ms));
}
