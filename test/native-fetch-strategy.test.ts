/**
 * Acceptance tests for NativeFetchStrategy, against a loopback HTTP server
 * and, for options and inputs, a fake fetch.
 *
 * Every request aims at 127.0.0.1 or a host under .invalid. The network
 * guard in test/network-guard.ts refuses anything else.
 */

import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { FetchException, FetchPayload } from '@tsnomad/fetch';
import { DEFAULT_FETCH_TIMEOUT_MS, NativeFetchStrategy, Response } from '@tsnomad/node-integration';
import { closedPort, startLocalServer } from './local-server.js';
import type { LocalServer } from './local-server.js';

let server: LocalServer;

beforeAll(async () => {
  server = await startLocalServer();
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  server.received.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

describe('NativeFetchStrategy against a local HTTP server', () => {
  test('sends the method, headers and body as given, and answers the status, lower-case headers and body', async () => {
    const strategy = new NativeFetchStrategy();
    const response = await strategy.fetch(
      new FetchPayload(`${server.origin}/echo`, '{"a":1}', 'POST', { 'Content-Type': 'application/json', 'X-Custom': 'value' }),
    );

    expect(response).toBeInstanceOf(Response);
    expect(response.getStatus()).toBe(200);
    expect(response.getHeader('x-reply')).toBe('yes');
    expect(response.getHeaders()['x-reply']).toBe('yes');
    expect(Object.keys(response.getHeaders()).every((name) => name === name.toLowerCase())).toBe(true);
    const echoed = response.getJson() as { method: string; headers: Record<string, string>; body: string };
    expect(echoed.method).toBe('POST');
    expect(echoed.headers['x-custom']).toBe('value');
    expect(echoed.headers['content-type']).toBe('application/json');
    expect(echoed.body).toBe('{"a":1}');
    expect(server.received).toHaveLength(1);
  });

  test('sends no body when the payload body is null', async () => {
    const response = await new NativeFetchStrategy().fetch(new FetchPayload(`${server.origin}/echo`, null, 'DELETE'));

    const echoed = response.getJson() as { method: string; headers: Record<string, string>; body: string };
    expect(echoed.method).toBe('DELETE');
    expect(echoed.body).toBe('');
    expect(echoed.headers['content-length'] ?? '0').toBe('0');
    expect(echoed.headers['transfer-encoding']).toBeUndefined();
  });

  test('appends params to the query, after the query the URL already has', async () => {
    const response = await new NativeFetchStrategy().fetch(
      new FetchPayload(`${server.origin}/echo?a=1`, null, 'GET', {}, { b: 2, a: 3, c: true, d: 'x y&z' }),
    );

    expect((response.getJson() as { url: string }).url).toBe('/echo?a=1&b=2&a=3&c=true&d=x+y%26z');
  });

  test('answers a 4xx or 5xx as a response, never a rejection', async () => {
    const strategy = new NativeFetchStrategy();
    for (const code of [400, 401, 404, 429, 500, 503]) {
      const response = await strategy.fetch(new FetchPayload(`${server.origin}/status/${code}`, null));
      expect(response.getStatus()).toBe(code);
      expect(response.getBody()).toBe(`status ${code}`);
    }
  });

  test('does not follow a redirect, and answers the 3xx with its Location', async () => {
    const response = await new NativeFetchStrategy().fetch(new FetchPayload(`${server.origin}/redirect`, null));

    expect(response.getStatus()).toBe(302);
    expect(response.getHeader('location')).toBe('/target');
    expect(server.received.map((r) => r.url)).toEqual(['/redirect']);
  });

  test('sends once, with no retry, for a 503', async () => {
    await new NativeFetchStrategy().fetch(new FetchPayload(`${server.origin}/status/503`, null));
    // A retry would follow the first answer at once. 50 ms leaves it time
    // to reach the loopback server without slowing the suite.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(server.received).toHaveLength(1);
  });

  test('rejects a refused connection with FetchException, keeping header values and the query out of the message', async () => {
    const port = await closedPort();
    const error = await rejection(
      new NativeFetchStrategy().fetch(
        new FetchPayload(`http://127.0.0.1:${port}/connect/token?api_key=q-secret-1`, 'body-secret-2', 'POST', { Authorization: 'Bearer tok-secret-3' }),
      ),
    );

    expect(error).toBeInstanceOf(FetchException);
    const message = (error as FetchException).message;
    expect(message.startsWith(`Request failed: POST http://127.0.0.1:${port}/connect/token: `)).toBe(true);
    expect(message).not.toContain('secret');
    expect(message).not.toContain('?');
    expect((error as FetchException).cause).toBeInstanceOf(Error);
  });

  test('keeps the platform code on the cause chain of a refused connection, even when a request value is short', async () => {
    const port = await closedPort();
    // Short values such as 1 turn up in stack frames and port numbers, so a
    // rule that searched what a logger prints would drop the nested cause.
    const error = await rejection(
      new NativeFetchStrategy().fetch(new FetchPayload(`http://127.0.0.1:${port}/x`, null, 'GET', { 'X-Retry': '1' }, { page: 1 })),
    );

    expect(error).toBeInstanceOf(FetchException);
    const codes: unknown[] = [];
    for (let cause: unknown = (error as FetchException).cause; cause instanceof Error; cause = cause.cause) {
      codes.push((cause as { code?: unknown }).code);
    }
    expect(codes).toContain('ECONNREFUSED');
  });

  test('rejects a host that does not resolve with FetchException', async () => {
    const error = await rejection(new NativeFetchStrategy().fetch(new FetchPayload('http://api.example.invalid/ping', null)));

    expect(error).toBeInstanceOf(FetchException);
    expect((error as FetchException).message.startsWith('Request failed: GET http://api.example.invalid/ping: ')).toBe(true);
    expect((error as FetchException).cause).toBeDefined();
  });

  test("aborts at the payload's timeout and rejects with FetchException, naming no secret", async () => {
    const started = Date.now();
    const error = await rejection(
      new NativeFetchStrategy().fetch(
        new FetchPayload(`${server.origin}/slow-headers?api_key=q-secret-1`, 'body-secret-2', 'POST', { Authorization: 'Bearer tok-secret-3' }, {}, 100),
      ),
    );

    expect(error).toBeInstanceOf(FetchException);
    expect((error as FetchException).message).toBe(`Request timed out after 100 ms: POST ${server.origin}/slow-headers`);
    // /slow-headers answers after 2000 ms, so a bound under that shows the
    // timeout cut the wait. 1500 ms leaves room for a loaded machine.
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test("uses the strategy's timeout for a payload without one, and the payload's over the strategy's", async () => {
    const strategy = new NativeFetchStrategy({ timeout: 100 });
    const error = await rejection(strategy.fetch(new FetchPayload(`${server.origin}/slow-headers`, null)));
    expect((error as FetchException).message).toBe(`Request timed out after 100 ms: GET ${server.origin}/slow-headers`);

    const longer = await rejection(new NativeFetchStrategy({ timeout: 60_000 }).fetch(new FetchPayload(`${server.origin}/slow-headers`, null, 'GET', {}, {}, 150)));
    expect((longer as FetchException).message).toBe(`Request timed out after 150 ms: GET ${server.origin}/slow-headers`);
  });

  test('the timeout covers the body read', async () => {
    const error = await rejection(new NativeFetchStrategy().fetch(new FetchPayload(`${server.origin}/slow-body`, null, 'GET', {}, {}, 150)));

    expect(error).toBeInstanceOf(FetchException);
    expect((error as FetchException).message).toBe(`Request timed out after 150 ms: GET ${server.origin}/slow-body`);
  });

  test('rejects with FetchException when the connection drops while the body is read, naming no secret', async () => {
    const error = await rejection(
      new NativeFetchStrategy().fetch(new FetchPayload(`${server.origin}/drop-body`, null, 'GET', { Authorization: 'Bearer tok-secret-3' }, { api_key: 'q-secret-1' })),
    );

    expect(error).toBeInstanceOf(FetchException);
    expect((error as FetchException).message.startsWith(`Reading the response body failed: GET ${server.origin}/drop-body: `)).toBe(true);
    expect((error as FetchException).message).not.toContain('secret');
    expect((error as FetchException).cause).toBeDefined();
  });
});

describe('NativeFetchStrategy options and inputs', () => {
  function fakeFetch(): { fn: typeof fetch; calls: Array<[string, RequestInit]> } {
    const calls: Array<[string, RequestInit]> = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push([String(input), init ?? {}]);
      return new globalThis.Response('faked', { status: 201, headers: { 'X-Fake': '1' } });
    }) as typeof fetch;
    return { fn, calls };
  }

  test('reads the global fetch at each call when no fetch option is given', async () => {
    const strategy = new NativeFetchStrategy();
    const fake = fakeFetch();
    vi.stubGlobal('fetch', fake.fn);

    const response = await strategy.fetch(new FetchPayload('http://api.example.invalid/x', null, 'PATCH', { A: '1' }));

    expect(response.getStatus()).toBe(201);
    expect(response.getBody()).toBe('faked');
    expect(response.getHeader('x-fake')).toBe('1');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0][0]).toBe('http://api.example.invalid/x');
    expect(fake.calls[0][1].method).toBe('PATCH');
    expect(fake.calls[0][1].redirect).toBe('manual');
    expect(fake.calls[0][1].headers).toEqual({ A: '1' });
    expect(fake.calls[0][1].body).toBeUndefined();
    expect(fake.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  test('calls the fetch option instead of the global fetch', async () => {
    const own = fakeFetch();
    const global = fakeFetch();
    vi.stubGlobal('fetch', global.fn);

    await new NativeFetchStrategy({ fetch: own.fn }).fetch(new FetchPayload('http://api.example.invalid/x', 'b', 'POST'));

    expect(own.calls).toHaveLength(1);
    expect(own.calls[0][1].body).toBe('b');
    expect(global.calls).toHaveLength(0);
  });

  test('rejects with the fetch error wrapped in FetchException when fetch rejects, and calls fetch once', async () => {
    const cause = new TypeError('fetch failed');
    let calls = 0;
    const failing = (async () => {
      calls++;
      throw cause;
    }) as typeof fetch;

    const error = await rejection(new NativeFetchStrategy({ fetch: failing }).fetch(new FetchPayload('http://api.example.invalid/x', null)));

    expect(error).toBeInstanceOf(FetchException);
    expect((error as FetchException).cause).toBe(cause);
    expect((error as FetchException).message).toBe('Request failed: GET http://api.example.invalid/x: fetch failed');
    expect(calls).toBe(1);
  });

  test('defaults to a 30 second timeout', async () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(30_000);
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () => reject(signal?.reason));
      })) as typeof fetch;

    const pending = rejection(new NativeFetchStrategy({ fetch: hanging }).fetch(new FetchPayload('http://api.example.invalid/x', null)));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;

    expect(signal?.aborted).toBe(true);
    expect((error as FetchException).message).toBe('Request timed out after 30000 ms: GET http://api.example.invalid/x');
  });

  test('refuses a timeout option that is not a number above zero and at most 2147483647', () => {
    for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => new NativeFetchStrategy({ timeout }), String(timeout)).toThrow(RangeError);
    }
    expect(() => new NativeFetchStrategy({ timeout: '100' as never })).toThrow(RangeError);
    expect(() => new NativeFetchStrategy({ timeout: 2_147_483_647 })).not.toThrow();
  });

  test('rejects an invalid URL with a TypeError that holds no part of the URL, before calling fetch', async () => {
    const fake = fakeFetch();
    const error = await rejection(new NativeFetchStrategy({ fetch: fake.fn }).fetch(new FetchPayload('not a url?api_key=q-secret-1', null)));

    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(FetchException);
    const own = Object.getOwnPropertyNames(error).map((name) => String((error as Record<string, unknown>)[name]));
    expect(own.join(' ')).not.toContain('secret');
    expect(String((error as Error).cause ?? '')).not.toContain('secret');
    // What a logger prints: the error with every property and its cause chain.
    expect(inspect(error, { depth: 10, showHidden: true })).not.toContain('secret');
    expect(fake.calls).toHaveLength(0);
  });

  test('rejects a URL with a user name or password with a TypeError that holds no part of the URL, before calling fetch', async () => {
    const fake = fakeFetch();
    for (const url of [
      'http://user-secret-6:pass-secret-7@api.example.invalid/x',
      'http://user-secret-6@api.example.invalid/x',
      'http://:pass-secret-7@api.example.invalid/x',
    ]) {
      const error = await rejection(new NativeFetchStrategy({ fetch: fake.fn }).fetch(new FetchPayload(url, null)));

      expect(error, url).toBeInstanceOf(TypeError);
      expect(error, url).not.toBeInstanceOf(FetchException);
      expect(inspect(error, { depth: 10, showHidden: true }), url).not.toContain('secret');
    }
    expect(fake.calls).toHaveLength(0);
  });

  test("keeps a header value Node's fetch refuses out of the message and out of what a logger prints", async () => {
    // Node's own fetch quotes a header value it refuses in its error, and
    // refuses it before any connection opens. The test proves something
    // only while that holds.
    let refusal: unknown;
    try {
      new Headers({ Authorization: 'Bearer tok-secret-3\nx' });
    } catch (thrown) {
      refusal = thrown;
    }
    expect(String((refusal as Error | undefined)?.message)).toContain('tok-secret-3');

    const error = await rejection(
      new NativeFetchStrategy().fetch(new FetchPayload('http://api.example.invalid/x', null, 'GET', { Authorization: 'Bearer tok-secret-3\nx' })),
    );

    expect(error).toBeInstanceOf(FetchException);
    expect((error as FetchException).message.startsWith('Request failed: GET http://api.example.invalid/x: ')).toBe(true);
    expect((error as FetchException).message).not.toContain('secret');
    expect((error as FetchException).cause).toBeInstanceOf(TypeError);
    expect(inspect(error, { depth: 10, showHidden: true })).not.toContain('secret');
  });

  test("keeps a padded header value Node's fetch trims and then refuses out of the message and out of what a logger prints", async () => {
    // Node trims space, tab, CR and LF from both ends before it checks the
    // value, so its error quotes the trimmed text, not the value as given.
    for (const padded of ['\ttok-secret-3\nx', 'tok-secret-3\nx ', ' \r\ntok-secret-3\nx\t']) {
      let refusal: unknown;
      try {
        new Headers({ Authorization: padded });
      } catch (thrown) {
        refusal = thrown;
      }
      const quoted = String((refusal as Error | undefined)?.message);
      expect(quoted, JSON.stringify(padded)).toContain('tok-secret-3\nx');
      expect(quoted, JSON.stringify(padded)).not.toContain(padded);

      const error = await rejection(
        new NativeFetchStrategy().fetch(new FetchPayload('http://api.example.invalid/x', null, 'GET', { Authorization: padded })),
      );

      expect(error, JSON.stringify(padded)).toBeInstanceOf(FetchException);
      expect((error as FetchException).message, JSON.stringify(padded)).not.toContain('secret');
      expect(inspect(error, { depth: 10, showHidden: true }), JSON.stringify(padded)).not.toContain('secret');
    }
  });

  test('keeps request parts out of what a logger prints when a fetch error repeats them in its message, a nested cause or a property', async () => {
    const thrown = [
      new TypeError('saw body-secret-2 and tok-secret-3 and api_key=q-secret-1'),
      new TypeError('fetch failed', { cause: new Error('sent body-secret-2') }),
      Object.assign(new TypeError('fetch failed'), { request: { headers: { Authorization: 'tok-secret-3' } } }),
    ];
    for (const repeated of thrown) {
      const echoing = (async () => {
        throw repeated;
      }) as typeof fetch;

      const error = await rejection(
        new NativeFetchStrategy({ fetch: echoing }).fetch(
          new FetchPayload('http://api.example.invalid/x?api_key=q-secret-1', 'body-secret-2', 'POST', { Authorization: 'tok-secret-3' }),
        ),
      );

      expect(error, repeated.message).toBeInstanceOf(FetchException);
      expect((error as FetchException).message.startsWith('Request failed: POST http://api.example.invalid/x: '), repeated.message).toBe(true);
      expect((error as FetchException).cause, repeated.message).toBeInstanceOf(TypeError);
      expect(inspect(error, { depth: 10, showHidden: true }), repeated.message).not.toContain('secret');
    }
  });

  test('keeps request parts out of a cause whose property a logger prints escaped, or reads through a getter', async () => {
    const body = '{\n  "token": "body-secret-2"\n}';
    const thrown = [
      Object.assign(new TypeError('fetch failed'), { request: { body } }),
      Object.defineProperty(new TypeError('fetch failed'), 'request', { get: () => ({ headers: { Authorization: 'tok-secret-3' } }), enumerable: true }),
    ];
    for (const [index, repeated] of thrown.entries()) {
      const echoing = (async () => {
        throw repeated;
      }) as typeof fetch;

      const error = await rejection(
        new NativeFetchStrategy({ fetch: echoing }).fetch(new FetchPayload('http://api.example.invalid/x', body, 'POST', { Authorization: 'tok-secret-3' })),
      );

      expect(error, String(index)).toBeInstanceOf(FetchException);
      expect(inspect(error, { depth: 10, showHidden: true, getters: true }), String(index)).not.toContain('secret');
    }
  });

  test('keeps request parts out of the cause when the timeout aborts a fetch, or a body read, that rejects with its request attached', async () => {
    const attached = () => Object.assign(new Error('aborted'), { config: { headers: { Authorization: 'tok-secret-3' } } });
    const onAbort = (signal: AbortSignal | null | undefined) =>
      new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(attached())));
    const hangingCall = ((_input: unknown, init?: RequestInit) => onAbort(init?.signal)) as typeof fetch;
    const hangingBody = (async (_input: unknown, init?: RequestInit) =>
      ({ status: 200, headers: new Headers(), text: () => onAbort(init?.signal) }) as unknown as globalThis.Response) as typeof fetch;

    for (const hanging of [hangingCall, hangingBody]) {
      const error = await rejection(
        new NativeFetchStrategy({ fetch: hanging, timeout: 20 }).fetch(new FetchPayload('http://api.example.invalid/x', null, 'GET', { Authorization: 'tok-secret-3' })),
      );

      expect((error as FetchException).message).toBe('Request timed out after 20 ms: GET http://api.example.invalid/x');
      expect((error as FetchException).cause).toBeInstanceOf(Error);
      expect(inspect(error, { depth: 10, showHidden: true, getters: true })).not.toContain('secret');
    }
  });

  test('joins the values of a header the server sent more than once', async () => {
    const twice = (async () =>
      new globalThis.Response('ok', { headers: [['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2'], ['X-One', 'only']] })) as typeof fetch;

    const response = await new NativeFetchStrategy({ fetch: twice }).fetch(new FetchPayload('http://api.example.invalid/x', null));

    expect(response.getHeader('set-cookie')).toBe('a=1, b=2');
    expect(response.getHeader('x-one')).toBe('only');
  });
});
