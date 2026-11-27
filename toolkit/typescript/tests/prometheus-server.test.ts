import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createPrometheusServer } from '../src/index.js';

const metricsText = '# TYPE example_calls_total counter\nexample_calls_total{site="\u8bfe\u5802"} 1\n';

function request(server: Server, url: string, method = 'GET') {
  const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
  server.emit('request', { url, method } as IncomingMessage, response as unknown as ServerResponse);
  return response;
}

function serverPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No bound TCP address');
  return address.port;
}

async function listen(server: Server, port = 0): Promise<number> {
  const started = once(server, 'listening');
  server.listen(port, '127.0.0.1');
  await started;
  return serverPort(server);
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function scrape(port: number, path: string, method = 'GET') {
  return new Promise<{ status: number | undefined; headers: IncomingMessage['headers']; body: Buffer }>((resolve, reject) => {
    const client = httpRequest({ host: '127.0.0.1', port, path, method, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    client.once('error', reject);
    client.end();
  });
}

describe('createPrometheusServer', () => {
  it.each(['/healthz', '/readyz', 'metrics', '/metrics?which=all', '/metrics#fragment'])(
    'rejects reserved or invalid scrape pathname %s before listening',
    metricsPath => {
      expect(() => createPrometheusServer({ metricsPath, renderMetrics: () => '' }))
        .toThrow(RangeError);
    },
  );

  it('serves the supplied metrics text for a custom path', () => {
    const server = createPrometheusServer({ renderMetrics: () => metricsText, metricsPath: '/scrape' });

    const reply = request(server, '/scrape');
    const body = Buffer.from(metricsText, 'utf8');
    expect(reply.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Content-Length': String(body.length),
    });
    expect(reply.end).toHaveBeenCalledWith(body);
    expect(request(server, '/metrics').writeHead).toHaveBeenCalledWith(404);
  });

  it('keeps liveness and readiness separate from metric rendering', () => {
    const renderMetrics = vi.fn(() => '');
    let ready = false;
    const server = createPrometheusServer({ renderMetrics, isReady: () => ready });

    expect(request(server, '/healthz').writeHead).toHaveBeenCalledWith(200);
    expect(request(server, '/readyz').writeHead).toHaveBeenCalledWith(503);
    ready = true;
    expect(request(server, '/readyz').writeHead).toHaveBeenCalledWith(200);
    expect(request(server, '/metrics', 'POST').writeHead).toHaveBeenCalledWith(405, { Allow: 'GET' });
    expect(renderMetrics).not.toHaveBeenCalled();
  });

  it('returns an empty 500 on render failure and serves a subsequent scrape', () => {
    const renderMetrics = vi.fn(() => 'example 1\n').mockImplementationOnce(() => {
      throw new Error('collector failed');
    });
    const server = createPrometheusServer({ renderMetrics });

    const failed = request(server, '/metrics');
    expect(failed.writeHead).toHaveBeenCalledWith(500);
    expect(failed.end).toHaveBeenCalledWith();
    expect(request(server, '/metrics').end).toHaveBeenCalledWith(Buffer.from('example 1\n'));
  });

  it('routes by pathname, retaining the custom path and probe method contracts', async () => {
    let ready = false;
    const server = createPrometheusServer({
      metricsPath: '/private/scrape',
      renderMetrics: () => 'apcore_requests_total{route="\u6e2c\u8a66"} 1\n',
      isReady: () => ready,
    });
    const port = await listen(server);
    try {
      const reply = await scrape(port, '/private/scrape?source=prometheus');
      expect(reply.status).toBe(200);
      expect(reply.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
      expect(reply.headers['content-length']).toBe(String(reply.body.length));
      expect(reply.body.toString()).toBe('apcore_requests_total{route="\u6e2c\u8a66"} 1\n');
      expect((await scrape(port, '/private/scrape/', 'GET')).status).toBe(404);
      expect((await scrape(port, '/metrics')).status).toBe(404);
      expect((await scrape(port, '/healthz?verbose=false')).body.toString()).toBe('OK');
      const unavailable = await scrape(port, '/readyz?probe=1');
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.toString()).toBe('Not ready');
      ready = true;
      const available = await scrape(port, '/readyz?probe=2');
      expect(available.status).toBe(200);
      expect(available.body.toString()).toBe('OK');
      const rejected = await scrape(port, '/private/scrape?source=prometheus', 'POST');
      expect(rejected.status).toBe(405);
      expect(rejected.headers.allow).toBe('GET');
      expect(rejected.body.length).toBe(0);
    } finally {
      await close(server);
    }
  });

  it('renders current metrics on every scrape', async () => {
    let text = '';
    const server = createPrometheusServer({ renderMetrics: () => text });
    const port = await listen(server);
    try {
      const cold = await scrape(port, '/metrics');
      expect(cold.status).toBe(200);
      expect(cold.headers['content-length']).toBe('0');
      expect(cold.body.length).toBe(0);
      text = metricsText;
      const live = await scrape(port, '/metrics');
      expect(live.status).toBe(200);
      expect(live.body).toEqual(Buffer.from(metricsText, 'utf8'));
      expect(live.headers['content-length']).toBe(String(live.body.length));
    } finally {
      await close(server);
    }
  });

  it('reports bind errors through Node and supports another listen attempt', async () => {
    const server = createPrometheusServer({ renderMetrics: () => 'example 1\n' });
    const occupied = createPrometheusServer({ renderMetrics: () => '' });
    const port = await listen(occupied);
    try {
      await expect(listen(server, port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(server.listening).toBe(false);
      await close(occupied);
      expect(await listen(server, port)).toBe(port);
      expect((await scrape(port, '/metrics')).status).toBe(200);
    } finally {
      if (occupied.listening) await close(occupied);
      if (server.listening) await close(server);
    }
  });

  it('drains an accepted request before closing and refuses new connections', async () => {
    const server = createPrometheusServer({ renderMetrics: () => 'example 1\n' });
    const port = await listen(server);
    const events: string[] = [];
    let closed: Promise<void> | undefined;
    server.prependOnceListener('request', (_request, response) => {
      response.once('finish', () => { events.push('finished response'); });
      closed = close(server).then(() => { events.push('closed listener'); });
    });
    try {
      const reply = await scrape(port, '/metrics');
      expect(reply.status).toBe(200);
      expect(reply.body.toString()).toBe('example 1\n');
      expect(closed).toBeDefined();
      await closed;
      expect(events).toEqual(['finished response', 'closed listener']);
      await expect(scrape(port, '/metrics')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      if (server.listening) await close(server);
    }
  });
});
