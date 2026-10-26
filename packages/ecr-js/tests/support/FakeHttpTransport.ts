import { HttpResponse, type HttpTransport } from '../../src/webservice/http/HttpTransport.js';

export interface Post {
  url: string;
  body: string;
  headers: Record<string, string>;
  connect: number;
  total: number;
}

/** A scripted HTTP transport: records each post and answers from a function. */
export class FakeHttpTransport implements HttpTransport {
  readonly posts: Post[] = [];

  /** `respond` may throw HttpTransportException. */
  constructor(private readonly respond: (url: string, body: string, n: number) => HttpResponse | Promise<HttpResponse>) {}

  static reply(status: number, body: string, reason = ''): FakeHttpTransport {
    return new FakeHttpTransport(() => new HttpResponse(status, body, reason));
  }

  async post(url: string, body: string, headers: Record<string, string>, connectTimeout: number, totalTimeout: number): Promise<HttpResponse> {
    const n = this.posts.length;
    this.posts.push({ url, body, headers, connect: connectTimeout, total: totalTimeout });
    return this.respond(url, body, n);
  }
}

/**
 * Sends the SDK's real HTTP request to the local fake Hub instead of Amwal:
 * same path, same body, same headers and deadlines, another host. Test-only.
 */
export class RewritingTransport implements HttpTransport {
  readonly urls: string[] = [];

  constructor(private readonly inner: HttpTransport, private readonly base: string, private currentMode: string) {}

  mode(mode: string): void {
    this.currentMode = mode;
  }

  post(url: string, body: string, headers: Record<string, string>, connectTimeout: number, totalTimeout: number): Promise<HttpResponse> {
    this.urls.push(url);
    const path = new URL(url).pathname;
    return this.inner.post(`${this.base}${path}?mode=${encodeURIComponent(this.currentMode)}`, body, headers, connectTimeout, totalTimeout);
  }
}
