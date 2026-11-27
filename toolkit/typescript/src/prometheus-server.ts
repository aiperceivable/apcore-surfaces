import { createServer, type Server } from 'node:http';

export interface PrometheusServerOptions {
  /** Return the current Prometheus exposition from the application's collectors. */
  renderMetrics: () => string;
  /** Exact absolute scrape pathname, defaulting to /metrics. Probe paths are reserved. */
  metricsPath?: string;
  /** Report readiness on each request, defaulting to false. */
  isReady?: () => boolean;
}

/** Create a Node HTTP server for metrics, liveness and readiness. The caller owns listen and close. */
export function createPrometheusServer({
  renderMetrics,
  metricsPath = '/metrics',
  isReady = () => false,
}: PrometheusServerOptions): Server {
  if (!metricsPath.startsWith('/') || /[?#\s]/.test(metricsPath) ||
      metricsPath === '/healthz' || metricsPath === '/readyz') {
    throw new RangeError('metricsPath must be an absolute pathname distinct from /healthz and /readyz');
  }
  return createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end();
      return;
    }

    try {
      // For origin-form request targets, keep the configured pathname exact
      // while ignoring Prometheus scrape query parameters.
      const pathname = request.url?.split('?', 1)[0];
      switch (pathname) {
        case '/healthz':
          response.writeHead(200).end('OK');
          break;
        case '/readyz':
          if (isReady()) response.writeHead(200).end('OK');
          else response.writeHead(503).end('Not ready');
          break;
        case metricsPath: {
          const body = Buffer.from(renderMetrics(), 'utf8');
          response.writeHead(200, {
            'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
            'Content-Length': String(body.length),
          }).end(body);
          break;
        }
        default:
          response.writeHead(404).end();
      }
    } catch {
      response.writeHead(500).end();
    }
  });
}
