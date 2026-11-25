import type { Interceptor } from './types';

export function defaultInterceptors(): Interceptor[] {
  return [retryInterceptor(), headerInterceptor(), logInterceptor()];
}

export function retryInterceptor(): Interceptor {
  return { name: 'retry', intercept: (chain) => chain.proceed(currentRequest()) };
}

export function headerInterceptor(): Interceptor {
  return { name: 'headers', intercept: (chain) => chain.proceed(currentRequest()) };
}

export function logInterceptor(): Interceptor {
  return { name: 'log', intercept: (chain) => chain.proceed(currentRequest()) };
}

function currentRequest() {
  return { host: 'localhost', port: 80, method: 'GET', path: '/', headers: {} };
}
