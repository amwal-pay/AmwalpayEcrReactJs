import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { Api } from './Api.js';
import { Response } from './Response.js';

/**
 * Everything between Node's HTTP server and the API: host filtering, security
 * headers, the `/api` guard, the 64 KB body cap, static files, and the
 * exception handler. The counterpart of the web sample's Program.cs and
 * SecurityMiddleware, and of the PHP sample's FrontController.
 *
 * No authentication. These controls make a local, single-operator deployment
 * reasonable; they do not make it a service. Read "Before you expose this" in
 * examples/README.md.
 */
export class FrontController {
  /** No request here carries more than a form. */
  static MAX_BODY_BYTES = 64 * 1024;

  /** Loopback names only by default: defeats DNS rebinding. `AMWAL_ECR_EXAMPLE_ALLOWED_HOSTS` overrides. */
  static DEFAULT_ALLOWED_HOSTS = '127.0.0.1;localhost;[::1]';

  // No inline script or style anywhere, so the policy needs no exceptions.
  static #CONTENT_SECURITY_POLICY = "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; "
    + "form-action 'self'; frame-ancestors 'none'";

  static #STATIC_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };

  #publicDirectory;
  #app;
  #api;

  /**
   * @param publicDirectory The built page (examples/web/dist).
   * @param app The {@link EcrApp}.
   */
  constructor(publicDirectory, app) {
    this.#publicDirectory = publicDirectory;
    this.#app = app;
    this.#api = new Api(app);
  }

  /** A Node `http` request listener. */
  listener() {
    return (req, res) => {
      this.#read(req)
        .then((raw) => this.handle(req, raw))
        .catch(() => Response.json(500, { error: 'Unexpected error', transactionId: null }))
        .then((response) => response.send(res));
    };
  }

  /** Handles one request whose body has been read (null when it was too large). */
  async handle(req, rawBody) {
    const response = await this.#route(req, rawBody);
    const headers = {
      ...response.headers,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': FrontController.#CONTENT_SECURITY_POLICY,
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    };
    const path = pathOf(req.url);
    // Terminals, results and the log are operator data: never cached.
    if (path.startsWith('/api')) headers['Cache-Control'] = 'no-store';
    return new Response(response.status, headers, response.body);
  }

  async #route(req, rawBody) {
    const host = String(req.headers.host ?? '').toLowerCase();
    const hostName = host.replace(/:[0-9]+$/, '');
    const allowed = (process.env.AMWAL_ECR_EXAMPLE_ALLOWED_HOSTS || FrontController.DEFAULT_ALLOWED_HOSTS)
      .split(';').map((h) => h.trim().toLowerCase());
    if (!allowed.includes(hostName) && !allowed.includes('*')) return Response.empty(400);

    const method = String(req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (!path.startsWith('/api/') && path !== '/api') return this.#staticFile(path);

    if (!sameOrigin(req, host)) return Response.json(403, { error: 'Cross-origin requests are not accepted' });
    const mutating = method !== 'GET' && method !== 'HEAD';
    if (mutating && !isJson(String(req.headers['content-type'] ?? ''))) {
      return Response.json(415, { error: 'Use Content-Type: application/json' });
    }
    if (rawBody === null || Number(req.headers['content-length'] ?? 0) > FrontController.MAX_BODY_BYTES) return Response.empty(413);

    let body = {};
    if (mutating && rawBody.trim() !== '') {
      let decoded;
      try {
        decoded = JSON.parse(rawBody);
      } catch {
        decoded = undefined;
      }
      if (decoded === null || typeof decoded !== 'object' || (Array.isArray(decoded) && decoded.length !== 0) || depth(decoded) > 16) {
        return Response.json(400, { error: 'The request could not be read', transactionId: null });
      }
      body = Array.isArray(decoded) ? {} : decoded;
    }

    try {
      return await this.#api.handle(method, path, url.searchParams, body);
    } catch (error) {
      // Never the error text: it can name paths, and it is not for a browser.
      console.error('[AmwalECR example]', error);
      return Response.json(500, { error: 'Unexpected error', transactionId: null });
    }
  }

  /** `/` is index.html; files under the public folder are served with the same headers. */
  #staticFile(path) {
    const relative = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const type = FrontController.#STATIC_TYPES[extname(relative).toLowerCase()];
    if (!/^[a-z0-9_./-]+$/i.test(relative) || relative.includes('..') || type === undefined) {
      return new Response(404, { 'Content-Type': 'text/plain' }, 'Not found');
    }
    const file = normalize(join(this.#publicDirectory, relative.split('/').join(sep)));
    if (!file.startsWith(normalize(this.#publicDirectory)) || !existsSync(file) || !statSync(file).isFile()) {
      return new Response(404, { 'Content-Type': 'text/plain' }, 'Not found');
    }
    return new Response(200, { 'Content-Type': type }, readFileSync(file));
  }

  /** The body as text, or null when it is larger than {@link MAX_BODY_BYTES}. */
  #read(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > FrontController.MAX_BODY_BYTES) tooLarge = true;
        else chunks.push(chunk);
      });
      req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
}

function pathOf(url) {
  try {
    return new URL(url ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

/**
 * Refuses requests another origin made. No CORS is configured, so a browser
 * will not let another site read a response; requiring JSON on mutating
 * calls forces a preflight that fails, and an Origin must be this host.
 */
function sameOrigin(req, host) {
  const site = String(req.headers['sec-fetch-site'] ?? '');
  if (site !== '' && site !== 'same-origin' && site !== 'none') return false;
  const origin = String(req.headers.origin ?? '');
  if (origin === '') return true;
  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function isJson(contentType) {
  return contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}

function depth(value, level = 1) {
  if (value === null || typeof value !== 'object') return level - 1;
  let max = level;
  for (const item of Object.values(value)) max = Math.max(max, depth(item, level + 1));
  return max;
}
