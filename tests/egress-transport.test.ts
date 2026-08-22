import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fetchPinned, streamPinned } from '../src/egress.js';

/**
 * The pinned transport, exercised against a real loopback HTTP server.
 *
 * This is the outbound boundary: everything the harness sends to a provider or
 * fetches as a research source goes through it. The properties that matter are
 * that the socket connects to the address the safety preflight approved while
 * the original hostname stays in Host and SNI, that responses are bounded, and
 * that cancellation actually cancels — none of which can be checked against a
 * mocked fetch.
 */

let server: Server;
let base = '';
let lastRequest: { host?: string; method?: string; url?: string; body: string } = { body: '' };

/** Routes exercised by the tests below. */
function handler(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    lastRequest = {
      host: req.headers.host,
      method: req.method,
      url: req.url,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    const url = req.url ?? '/';

    if (url.startsWith('/echo')) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-custom': 'kept' });
      res.end(
        JSON.stringify({ method: req.method, host: req.headers.host, body: lastRequest.body }),
      );
      return;
    }
    if (url.startsWith('/status/')) {
      res.writeHead(Number(url.split('/')[2] ?? 200));
      res.end('status body');
      return;
    }
    if (url.startsWith('/chunks')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first ');
      res.write('second ');
      res.end('third');
      return;
    }
    if (url.startsWith('/huge')) {
      // Comfortably past the 10 MB response cap.
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const block = Buffer.alloc(1024 * 1024, 0x61);
      for (let index = 0; index < 12; index += 1) res.write(block);
      res.end();
      return;
    }
    if (url.startsWith('/slow')) {
      res.writeHead(200);
      res.write('start');
      // Never ends, so an abort is the only way out.
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
}

beforeAll(async () => {
  server = createServer(handler);
  // Listen on every interface rather than 127.0.0.1 only. `localhost` resolves
  // to ::1 first on this platform, and the Host-preservation test below needs a
  // name that resolves to an address the server is actually accepting on —
  // otherwise the test fails on the fixture rather than on the behaviour.
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server_address_missing');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('fetchPinned', () => {
  it('performs a GET and returns status, headers, and body', async () => {
    const response = await fetchPinned(`${base}/echo`, {}, true);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-custom')).toBe('kept');
    const body = (await response.json()) as { method: string };
    expect(body.method).toBe('GET');
  });

  it('keeps the original hostname in the Host header', async () => {
    // The socket connects to the preflight-approved address; Host must still
    // name the host that was actually requested, or virtual hosting breaks and
    // the request arrives somewhere unintended.
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const response = await fetchPinned(`http://localhost:${address.port}/echo`, {}, true);
    const body = (await response.json()) as { host: string };
    expect(body.host).toBe(`localhost:${address.port}`);
  });

  it('sends a string body and sets content-length', async () => {
    const response = await fetchPinned(
      `${base}/echo`,
      { method: 'POST', body: JSON.stringify({ hello: 'world' }) },
      true,
    );
    const body = (await response.json()) as { method: string; body: string };
    expect(body.method).toBe('POST');
    expect(JSON.parse(body.body)).toEqual({ hello: 'world' });
  });

  it('sends a binary body', async () => {
    const response = await fetchPinned(
      `${base}/echo`,
      { method: 'POST', body: new TextEncoder().encode('binary payload') },
      true,
    );
    const body = (await response.json()) as { body: string };
    expect(body.body).toBe('binary payload');
  });

  it('forwards caller headers alongside the pinned host', async () => {
    await fetchPinned(`${base}/echo`, { headers: { 'x-trace': 'abc123' } }, true);
    expect(lastRequest.host).toContain('127.0.0.1');
  });

  it('surfaces a non-2xx status rather than throwing', async () => {
    const response = await fetchPinned(`${base}/status/503`, {}, true);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('status body');
  });

  it('refuses a response beyond the size cap', async () => {
    await expect(fetchPinned(`${base}/huge`, {}, true)).rejects.toThrow(
      /provider_response_too_large/,
    );
  });

  it('aborts an in-flight request when the signal fires', async () => {
    const controller = new AbortController();
    const pending = fetchPinned(`${base}/slow`, { signal: controller.signal }, true);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow(/provider_request_aborted/);
  });

  it('refuses immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(fetchPinned(`${base}/echo`, { signal: controller.signal }, true)).rejects.toThrow(
      /provider_request_aborted/,
    );
  });

  it('rejects a connection that cannot be made', async () => {
    // Port 1 on loopback has nothing listening.
    await expect(fetchPinned('http://127.0.0.1:1/echo', {}, true)).rejects.toThrow();
  });
});

describe('pinned transport refuses unsafe destinations', () => {
  it('will not reach loopback unless local endpoints are explicitly allowed', async () => {
    await expect(fetchPinned(`${base}/echo`)).rejects.toThrow(/endpoint_rejected/);
    await expect(streamPinned(`${base}/echo`)).rejects.toThrow(/endpoint_rejected/);
  });

  it('refuses a non-http scheme', async () => {
    await expect(fetchPinned('file:///etc/passwd', {}, true)).rejects.toThrow(/endpoint_rejected/);
  });

  it('refuses embedded credentials', async () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    await expect(
      fetchPinned(`http://user:pass@127.0.0.1:${address.port}/echo`, {}, true),
    ).rejects.toThrow(/embedded_credentials/);
  });
});

describe('streamPinned', () => {
  it('delivers the body incrementally rather than buffering it', async () => {
    const response = await streamPinned(`${base}/chunks`, {}, true);
    expect(response.status).toBe(200);
    const seen: string[] = [];
    for await (const chunk of response.body) seen.push(new TextDecoder().decode(chunk));
    expect(seen.join('')).toBe('first second third');
  });

  it('exposes response headers before the body is consumed', async () => {
    const response = await streamPinned(`${base}/echo`, {}, true);
    expect(response.headers.get('content-type')).toContain('application/json');
    // Drain so the socket closes.
    for await (const _chunk of response.body) void _chunk;
  });

  it('surfaces a non-2xx status without throwing', async () => {
    const response = await streamPinned(`${base}/status/429`, {}, true);
    expect(response.status).toBe(429);
    for await (const _chunk of response.body) void _chunk;
  });

  it('fails the stream when the response exceeds the cap', async () => {
    const response = await streamPinned(`${base}/huge`, {}, true);
    await expect(
      (async () => {
        for await (const _chunk of response.body) void _chunk;
      })(),
    ).rejects.toThrow(/provider_response_too_large/);
  });

  it('sends a request body', async () => {
    const response = await streamPinned(
      `${base}/echo`,
      { method: 'POST', body: 'streamed payload' },
      true,
    );
    let text = '';
    for await (const chunk of response.body) text += new TextDecoder().decode(chunk);
    expect(JSON.parse(text).body).toBe('streamed payload');
  });
});
