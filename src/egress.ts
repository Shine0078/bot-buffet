import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolveSafeEndpoint } from './security.js';

const MAX_RESPONSE_BYTES = 10_000_000;

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
): Promise<Response> {
  const target = new URL(input);
  const { address } = await resolveSafeEndpoint(target.toString(), allowLocal);
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
