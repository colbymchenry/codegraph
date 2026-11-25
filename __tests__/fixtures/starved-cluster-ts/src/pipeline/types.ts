export interface PipelineRequest {
  host: string;
  port: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface PipelineResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  request: PipelineRequest;
}

export interface Interceptor {
  name: string;
  intercept(chain: { proceed(request: PipelineRequest): Promise<PipelineResponse> }): Promise<PipelineResponse>;
}

export interface Socket {
  connect(timeoutMs: number): Promise<void>;
  write(frame: Uint8Array, timeoutMs: number): Promise<void>;
  read(timeoutMs: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
