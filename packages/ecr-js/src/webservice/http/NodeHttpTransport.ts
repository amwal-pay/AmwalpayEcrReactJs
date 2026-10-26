import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';
import { RuntimeException } from '../../exception/errors.js';
import { HttpResponse, HttpTransportException, type HttpTransport } from './HttpTransport.js';

/**
 * HTTPS with Node's own `https` module. The TLS certificate and host name are
 * always verified. Plain HTTP is accepted only because the URL is never the
 * caller's: the SDK resolves it (always https), or a custom transport rewrites
 * it, e.g. in tests.
 *
 * Behind a TLS-inspecting proxy, or with a private CA, pass `caBundlePath` in
 * the config (or set `NODE_EXTRA_CA_CERTS`). Never turn verification off: the
 * Hub's answer is what decides whether goods are handed over, and only TLS
 * proves it came from the Hub. Redirects are not followed.
 */
export class NodeHttpTransport implements HttpTransport {
  private readonly ca: string[] | undefined;

  /** @param caBundlePath A PEM file of extra CA certificates, added to Node's own. */
  constructor(caBundlePath: string | null = null) {
    if (caBundlePath !== null && caBundlePath !== '') {
      let pem: string;
      try {
        pem = readFileSync(caBundlePath, 'utf8');
      } catch (error) {
        throw new RuntimeException('The CA bundle cannot be read: ' + caBundlePath, { cause: error });
      }
      this.ca = [...rootCertificates, pem];
    }
  }

  post(url: string, body: string, headers: Record<string, string>, connectTimeout: number, totalTimeout: number): Promise<HttpResponse> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return Promise.reject(new HttpTransportException('Invalid Web Service URL'));
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return Promise.reject(new HttpTransportException('Unsupported protocol ' + target.protocol));
    }
    const secure = target.protocol === 'https:';
    const payload = Buffer.from(body, 'utf8');

    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      const timers: NodeJS.Timeout[] = [];
      const done = (error: HttpTransportException | null, response?: HttpResponse): void => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        if (error !== null) {
          req.destroy();
          reject(error);
        } else {
          resolve(response!);
        }
      };

      const options = {
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(payload.length) },
        agent: false as const,
        ...(secure ? { rejectUnauthorized: true, ...(this.ca ? { ca: this.ca } : {}) } : {}),
      };
      const req = (secure ? httpsRequest : httpRequest)(target, options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, new HttpResponse(res.statusCode ?? 0, Buffer.concat(chunks), res.statusMessage ?? '')));
        res.on('error', (error) => done(new HttpTransportException(error.message || 'Web Service request failed', false, { cause: error })));
      });

      const totalMs = Math.max(1, Math.round(totalTimeout * 1000));
      timers.push(setTimeout(() => done(new HttpTransportException(`Operation timed out after ${totalMs} milliseconds`, true)), totalMs));

      req.on('socket', (socket) => {
        const connectMs = Math.max(1, Math.round(connectTimeout * 1000));
        const timer = setTimeout(() => done(new HttpTransportException(`Connection timed out after ${connectMs} milliseconds`, true)), connectMs);
        timers.push(timer);
        socket.once(secure ? 'secureConnect' : 'connect', () => clearTimeout(timer));
      });
      req.on('error', (error: NodeJS.ErrnoException) => {
        done(new HttpTransportException(NodeHttpTransport.reason(error), error.code === 'ETIMEDOUT', { cause: error }));
      });
      req.end(payload);
    });
  }

  private static reason(error: NodeJS.ErrnoException): string {
    const code = error.code ?? '';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Could not resolve host (${code})`;
    if (code === 'ECONNREFUSED') return 'Failed to connect: connection refused (ECONNREFUSED)';
    if (code === 'ECONNRESET') return 'Connection reset by the Web Service (ECONNRESET)';
    if (code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
      return `SSL certificate problem: ${error.message} (${code})`;
    }
    return error.message !== '' ? error.message : 'Web Service request failed';
  }
}
