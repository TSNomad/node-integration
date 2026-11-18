/**
 * Unit tests for two internals of NativeFetchStrategy that the acceptance
 * tests do not reach. They run through the public fetch method.
 *
 * - The private causeText helper takes header values, query values, the
 *   query string and the body out of the cause's message before it goes
 *   into a FetchException's message. A fake fetch echoes parts of the
 *   request, and one test has Node's own fetch refuse a header value,
 *   which is the case that needs the helper.
 * - The timeout timer is cleared when the call ends, however it ends.
 * - The TypeError for an invalid URL carries no cause. The acceptance
 *   test reads the cause through String(), which does not show the
 *   parser error's input property, where the URL sits.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { FetchException, FetchPayload } from '@tsnomad/fetch';
import { NativeFetchStrategy } from '@tsnomad/node-integration';

afterEach(() => {
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

function rejectingWith(message: string): typeof fetch {
  return (async () => {
    throw new TypeError(message);
  }) as typeof fetch;
}

describe('NativeFetchStrategy keeps request parts out of a cause message it repeats', () => {
  test('takes out header values, query values, the body and the query string', async () => {
    const echo = 'saw tok-secret-3 and body-secret-2 and api_key=q-secret-1&page=7 and param-secret-4';
    const error = await rejection(
      new NativeFetchStrategy({ fetch: rejectingWith(echo) }).fetch(
        new FetchPayload(
          'http://api.example.invalid/x?api_key=q-secret-1',
          'body-secret-2',
          'POST',
          { Authorization: 'tok-secret-3' },
          { page: 7, extra: 'param-secret-4' },
        ),
      ),
    );

    expect(error).toBeInstanceOf(FetchException);
    const message = (error as FetchException).message;
    expect(message.startsWith('Request failed: POST http://api.example.invalid/x: saw ')).toBe(true);
    expect(message).not.toContain('secret');
    expect(message).toContain('[redacted]');
    expect((error as FetchException).cause).toBeInstanceOf(TypeError);
    expect(((error as FetchException).cause as Error).message).not.toContain('secret');
  });

  test('takes out a query string the URL already had, with no params added', async () => {
    const error = await rejection(
      new NativeFetchStrategy({ fetch: rejectingWith('bad query a=q-secret-1') }).fetch(
        new FetchPayload('http://api.example.invalid/x?a=q-secret-1', null),
      ),
    );

    expect((error as FetchException).message).toBe('Request failed: GET http://api.example.invalid/x: bad query [redacted]');
  });

  test('takes out a query value that appears alone, from a param or from the URL', async () => {
    const error = await rejection(
      new NativeFetchStrategy({ fetch: rejectingWith('bad param q-secret-1') }).fetch(
        new FetchPayload('http://api.example.invalid/x', null, 'GET', {}, { a: 'q-secret-1', b: 'other' }),
      ),
    );
    expect((error as FetchException).message).toBe('Request failed: GET http://api.example.invalid/x: bad param [redacted]');

    const own = await rejection(
      new NativeFetchStrategy({ fetch: rejectingWith('bad value q-secret-5') }).fetch(
        new FetchPayload('http://api.example.invalid/x?k=q-secret-5&j=2', null),
      ),
    );
    expect((own as FetchException).message).toBe('Request failed: GET http://api.example.invalid/x: bad value [redacted]');
  });

  test('takes out the longest value first, so no part of it is left behind', async () => {
    const error = await rejection(
      new NativeFetchStrategy({ fetch: rejectingWith('value abc-long-secret') }).fetch(
        new FetchPayload('http://api.example.invalid/x', null, 'GET', { A: 'abc', B: 'abc-long-secret' }),
      ),
    );

    expect((error as FetchException).message).toBe('Request failed: GET http://api.example.invalid/x: value [redacted]');
  });

  test('leaves the message alone for an empty header value or body', async () => {
    const error = await rejection(
      new NativeFetchStrategy({ fetch: rejectingWith('fetch failed') }).fetch(
        new FetchPayload('http://api.example.invalid/x', '', 'POST', { A: '' }),
      ),
    );

    expect((error as FetchException).message).toBe('Request failed: POST http://api.example.invalid/x: fetch failed');
  });

  test('reads a thrown value that is not an Error with String()', async () => {
    const throwing = (async () => {
      throw 'plain tok-secret-3';
    }) as typeof fetch;
    const error = await rejection(
      new NativeFetchStrategy({ fetch: throwing }).fetch(new FetchPayload('http://api.example.invalid/x', null, 'GET', { A: 'tok-secret-3' })),
    );

    expect((error as FetchException).message).toBe('Request failed: GET http://api.example.invalid/x: plain [redacted]');
  });

  test('takes them out of a body read failure too', async () => {
    const failingBody = (async () =>
      new globalThis.Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error('stream broke near tok-secret-3'));
          },
        }),
      )) as typeof fetch;
    const error = await rejection(
      new NativeFetchStrategy({ fetch: failingBody }).fetch(new FetchPayload('http://api.example.invalid/x', null, 'GET', { A: 'tok-secret-3' })),
    );

    expect(error).toBeInstanceOf(FetchException);
    expect((error as FetchException).message).toBe('Reading the response body failed: GET http://api.example.invalid/x: stream broke near [redacted]');
  });

  test("keeps a header value Node's own fetch refuses out of the message", async () => {
    const error = await rejection(
      new NativeFetchStrategy().fetch(new FetchPayload('http://api.example.invalid/x', null, 'GET', { Authorization: 'Bearer tok-secret-3\nx' })),
    );

    expect(error).toBeInstanceOf(FetchException);
    const message = (error as FetchException).message;
    expect(message.startsWith('Request failed: GET http://api.example.invalid/x: ')).toBe(true);
    expect(message).not.toContain('secret');
    expect(String(((error as FetchException).cause as Error).message)).not.toContain('secret');
  });

  test('keeps the fetch error itself as cause when its message quoted nothing, and copies its name and code when it did', async () => {
    const plain = Object.assign(new TypeError('fetch failed'), { code: 'E_PLAIN' });
    const kept = await rejection(
      new NativeFetchStrategy({ fetch: (async () => { throw plain; }) as typeof fetch }).fetch(new FetchPayload('http://api.example.invalid/x', null, 'GET', { A: 'tok-secret-3' })),
    );
    expect((kept as FetchException).cause).toBe(plain);

    const quoting = Object.assign(new RangeError('saw tok-secret-3'), { code: 'E_QUOTE' });
    const copied = await rejection(
      new NativeFetchStrategy({ fetch: (async () => { throw quoting; }) as typeof fetch }).fetch(new FetchPayload('http://api.example.invalid/x', null, 'GET', { A: 'tok-secret-3' })),
    );
    const cause = (copied as FetchException).cause as Error & { code?: unknown };
    expect(cause).not.toBe(quoting);
    expect(cause).toBeInstanceOf(RangeError);
    expect(cause.name).toBe('RangeError');
    expect(cause.code).toBe('E_QUOTE');
    expect(cause.message).toBe('saw [redacted]');

    const named = Object.assign(new Error('saw tok-secret-3'), { name: 'SocketError' });
    const renamed = await rejection(
      new NativeFetchStrategy({ fetch: (async () => { throw named; }) as typeof fetch }).fetch(new FetchPayload('http://api.example.invalid/x', null, 'GET', { A: 'tok-secret-3' })),
    );
    expect(((renamed as FetchException).cause as Error).name).toBe('SocketError');
    expect('code' in ((renamed as FetchException).cause as object)).toBe(false);
  });
});

describe('NativeFetchStrategy clears its timeout timer when the call ends', () => {
  test('after a response', async () => {
    vi.useFakeTimers();
    const answering = (async () => new globalThis.Response('ok')) as typeof fetch;

    await new NativeFetchStrategy({ fetch: answering }).fetch(new FetchPayload('http://api.example.invalid/x', null));

    expect(vi.getTimerCount()).toBe(0);
  });

  test('after a failure', async () => {
    vi.useFakeTimers();

    await rejection(new NativeFetchStrategy({ fetch: rejectingWith('fetch failed') }).fetch(new FetchPayload('http://api.example.invalid/x', null)));

    expect(vi.getTimerCount()).toBe(0);
  });

  test('and sets one while the call runs, so the zero above can fail', async () => {
    vi.useFakeTimers();
    let during = -1;
    const counting = (async () => {
      during = vi.getTimerCount();
      return new globalThis.Response('ok');
    }) as typeof fetch;

    await new NativeFetchStrategy({ fetch: counting }).fetch(new FetchPayload('http://api.example.invalid/x', null));

    expect(during).toBe(1);
  });
});

describe('NativeFetchStrategy refuses an invalid URL without passing the parser error on', () => {
  test("the TypeError has no cause, since the parser's own error keeps the URL in its input", async () => {
    const bad = 'not a url?api_key=q-secret-1';
    // The hazard: Node's URL parser keeps the whole input on its error, in
    // a property that String() does not show.
    let parserError: unknown;
    try {
      new URL(bad);
    } catch (error) {
      parserError = error;
    }
    expect(String((parserError as { input?: unknown }).input)).toContain('secret');

    const error = await rejection(new NativeFetchStrategy({ fetch: rejectingWith('unused') }).fetch(new FetchPayload(bad, null)));

    expect(error).toBeInstanceOf(TypeError);
    expect('cause' in (error as object)).toBe(false);
  });
});
