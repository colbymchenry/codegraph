export interface ClientConfig {
  host: string;
  port: number;
  retries: number;
  userAgent: string;
}

export function defaultConfig(): ClientConfig {
  return { host: 'localhost', port: 8080, retries: 3, userAgent: 'pipeline/1.0' };
}

export function withHost(config: ClientConfig, host: string): ClientConfig {
  return { ...config, host };
}
