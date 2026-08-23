import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolveSafeEndpoint, type DnsLookup } from './security.js';

const MAX_RESPONSE_BYTES = 10_000_000;

export interface PinnedStreamResponse {
  status: number;
  headers: Headers;
  body: AsyncIterable<Uint8Array>;
}

function responseHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const output = new Headers();
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined) output.set(name, Array.isArray(value) ? value.join(', ') : value);
  return output;
}

/**
 * Fetch an endpoint using the IP returned by the safety preflight. The original
 * hostname remains the HTTP Host/SNI value, while the socket connects to the
 * checked address so a later DNS answer cannot redirect the request.
 */
export async function fetchPinned(
  input: string | URL,
  init: RequestInit = {},
  allowLocal = false,
  lookupFn?: DnsLookup,
): Promise<Response> {
  const target = new URL(input);
  const { address } = await resolveSafeEndpoint(target.toString(), allowLocal, lookupFn);
  const headers = new Headers(init.headers);
  const body =
    typeof init.body === 'string'
      ? Buffer.from(init.body)
      : init.body instanceof Uint8Array
        ? Buffer.from(init.body)
        : undefined;
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, name) => {
    requestHeaders[name] = value;
  });
  requestHeaders.host = target.host;
  if (body && !requestHeaders['content-length'])
    requestHeaders['content-length'] = String(body.length);
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const options = {
      hostname: address,
      port: target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80,
      method: init.method ?? 'GET',
      path: `${target.pathname}${target.search}`,
      headers: requestHeaders,
      ...(target.protocol === 'https:'
        ? { rejectUnauthorized: true, servername: target.hostname }
        : {}),
    };
    const request = transport(options, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('provider_response_too_large'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(
          new Response(Buffer.concat(chunks), {
            status: response.statusCode ?? 502,
            headers: responseHeaders(response.headers),
          }),
        );
      });
    });
    request.on('error', (error) => fail(error));
    const signal = init.signal;
    if (signal) {
      const abort = (): void => {
        request.destroy(new Error('provider_request_aborted'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    if (body) request.write(body);
    request.end();
  });
}

/**
 * Open a pinned response without buffering it. The socket still connects to
 * the DNS-preflight address while Host/SNI retain the provider hostname.
 */
export async function streamPinned(
  input: string | URL,
  init: RequestInit = {},
  allowLocal = false,
  lookupFn?: DnsLookup,
): Promise<PinnedStreamResponse> {
  const target = new URL(input);
  const { address } = await resolveSafeEndpoint(target.toString(), allowLocal, lookupFn);
  const headers = new Headers(init.headers);
  const body =
    typeof init.body === 'string'
      ? Buffer.from(init.body)
      : init.body instanceof Uint8Array
        ? Buffer.from(init.body)
        : undefined;
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, name) => {
    requestHeaders[name] = value;
  });
  requestHeaders.host = target.host;
  if (body && !requestHeaders['content-length'])
    requestHeaders['content-length'] = String(body.length);
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<PinnedStreamResponse>((resolve, reject) => {
    let settled = false;
    let total = 0;
    const queue: Buffer[] = [];
    const waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
    let ended = false;
    let streamError: Error | undefined;
    const flush = (): void => {
      while (waiters.length && queue.length)
        waiters.shift()!({ value: queue.shift()!, done: false });
      if (ended && !queue.length)
        while (waiters.length) waiters.shift()!({ value: undefined, done: true });
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      streamError = error;
      ended = true;
      while (waiters.length) waiters.shift()!({ value: undefined, done: true });
      reject(error);
    };
    const bodyStream = (async function* (): AsyncGenerator<Uint8Array> {
      while (!ended || queue.length) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        const next = await new Promise<IteratorResult<Uint8Array>>((wait) => waiters.push(wait));
        if (next.done) break;
        yield next.value;
      }
      if (streamError) throw streamError;
    })();
    const options = {
      hostname: address,
      port: target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80,
      method: init.method ?? 'GET',
      path: `${target.pathname}${target.search}`,
      headers: requestHeaders,
      ...(target.protocol === 'https:'
        ? { rejectUnauthorized: true, servername: target.hostname }
        : {}),
    };
    const request = transport(options, (response) => {
      if (settled) return;
      settled = true;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          streamError = new Error('provider_response_too_large');
          ended = true;
          request.destroy(streamError);
          flush();
          return;
        }
        queue.push(Buffer.from(chunk));
        flush();
      });
      response.on('end', () => {
        ended = true;
        flush();
      });
      response.on('error', (error) => {
        streamError = error;
        ended = true;
        flush();
      });
      resolve({
        status: response.statusCode ?? 502,
        headers: responseHeaders(response.headers),
        body: bodyStream,
      });
    });
    request.on('error', (error) => {
      if (!settled) fail(error);
      else {
        streamError = error;
        ended = true;
        flush();
      }
    });
    const signal = init.signal;
    if (signal) {
      const abort = (): void => {
        request.destroy(new Error('provider_request_aborted'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    if (body) request.write(body);
    request.end();
  });
}
