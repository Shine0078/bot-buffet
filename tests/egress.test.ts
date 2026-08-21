import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchPinned } from '../src/egress.js';

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('pinned provider egress', () => {
  it('connects to the preflight-resolved local address while preserving request semantics', async () => {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      res.setHeader('content-type', 'text/plain');
      res.end(`${req.method}:${req.headers.host}:${Buffer.concat(chunks).toString('utf8')}`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server_address_missing');
    const response = await fetchPinned(
      `http://127.0.0.1:${address.port}/echo`,
      { method: 'POST', headers: { 'x-test': 'ok' }, body: 'payload' },
      true,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`POST:127.0.0.1:${address.port}:payload`);
  });

  it('rejects private targets unless the caller explicitly permits local mode', async () => {
    await expect(fetchPinned('http://127.0.0.1:1/models')).rejects.toThrow(
      'endpoint_rejected:metadata_or_loopback',
    );
  });
});
