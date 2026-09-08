import { RequestChain, describeChain } from '../pipeline/chain';
import type { PipelineRequest, PipelineResponse } from '../pipeline/types';
import { openSocket } from '../transport/socket';

/**
 * The entry point a caller reaches for. Everything the chain does happens
 * underneath this call, which is why a flow question names it.
 */
export async function sendRequest(request: PipelineRequest): Promise<PipelineResponse> {
  const socket = openSocket(request.host, request.port);
  const chain = new RequestChain(request, socket);
  trace(describeChain(chain));
  return chain.proceed(request);
}

export function trace(line: string): void {
  if (process.env.PIPELINE_TRACE) process.stderr.write(`${line}\n`);
}

export async function sendAll(requests: PipelineRequest[]): Promise<PipelineResponse[]> {
  const out: PipelineResponse[] = [];
  for (const request of requests) out.push(await sendRequest(request));
  return out;
}
