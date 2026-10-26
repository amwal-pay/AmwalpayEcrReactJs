import { describe, expect, it, vi } from 'vitest';
import { ApiError, createEcrClient, qrUrl } from '../src/client.js';

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('createEcrClient', () => {
  it('GETs with Accept only', async () => {
    const fetch = fakeFetch(200, { operations: [] });
    await createEcrClient({ fetch }).meta();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/meta');
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({ Accept: 'application/json' });
    expect(init?.body).toBeUndefined();
    expect(init?.cache).toBe('no-store');
  });

  it('sends JSON on every mutating call, {} when there is nothing to say', async () => {
    const fetch = fakeFetch(200, {});
    await createEcrClient({ fetch, baseUrl: 'http://till.local/' }).cancel('ab/c');
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://till.local/api/transactions/ab%2Fc/cancel');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init?.body).toBe('{}');
  });

  it('acknowledges with keepalive and reads 204 as null', async () => {
    const fetch = fakeFetch(204, null);
    expect(await createEcrClient({ fetch }).acknowledge('x')).toBeNull();
    expect(fetch.mock.calls[0]![1]?.keepalive).toBe(true);
    expect(fetch.mock.calls[0]![1]?.method).toBe('DELETE');
  });

  it('announces a config load when asked', async () => {
    const fetch = fakeFetch(200, {});
    await createEcrClient({ fetch }).config('SN 1', true);
    expect(fetch.mock.calls[0]![0]).toBe('/api/terminals/SN%201/config?announce=true');
  });

  it('turns a 422 into per-field errors', async () => {
    const fetch = fakeFetch(422, { errors: { amount: 'Required field' }, message: null });
    const error = await createEcrClient({ fetch }).start({} as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).fields).toEqual({ amount: 'Required field' });
  });

  it('uses the server error text', async () => {
    const fetch = fakeFetch(409, { error: 'A transaction is already running on this terminal', transactionId: 'abc' });
    const error = (await createEcrClient({ fetch }).start({} as never).catch((e: unknown) => e)) as ApiError;
    expect(error.message).toBe('A transaction is already running on this terminal');
    expect(error.body.transactionId).toBe('abc');
  });

  it('reports an unreachable server as status 0', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const error = (await createEcrClient({ fetch }).meta().catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.message).toBe('The app could not be reached');
  });

  it('builds the QR URL', () => {
    expect(qrUrl('https://x.invalid/r?a=1&b=2')).toBe('/api/qr?text=https%3A%2F%2Fx.invalid%2Fr%3Fa%3D1%26b%3D2');
  });
});
