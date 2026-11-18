/**
 * NativeFetchStrategy
 *
 * The `FetchStrategy` for a plain Node process, over the Fetch API that
 * Node provides. It plays the role of PHPNomad's Guzzle and WordPress
 * fetch strategies and keeps every rule `FetchStrategy` lists.
 *
 * For each payload it:
 *
 * 1. Parses the URL. An invalid URL rejects with a `TypeError` that holds
 *    no part of the URL, neither in its message nor in any property or
 *    cause, before anything is sent. The parser's own error keeps the
 *    URL in its `input`, so it is not passed on. A URL with a user name
 *    or password is refused the same way, since fetch will not send one
 *    and its own refusal quotes the whole URL.
 * 2. Appends each param to the query string, after any query the URL
 *    already has, in the payload's order. A param that shares a name with
 *    the URL's query is added beside it, never in its place.
 * 3. Calls fetch once with the payload's method, headers and body (none
 *    when the body is null), `redirect: 'manual'`, and an abort signal.
 * 4. Answers a `Response` with the status, every header under its
 *    lower-case name, and the body as text, for every status, 3xx
 *    included. A header the server sent more than once, such as
 *    `set-cookie`, holds every value joined with `, `, as Guzzle's
 *    response does.
 *
 * The timeout is the payload's, or else the strategy's, 30 seconds unless
 * the options set another. It covers the whole call, the body read
 * included, and aborts the request when it runs out.
 *
 * It rejects with `FetchException`, the fetch error as `cause`, when fetch
 * rejects, the timeout aborts the call, or the connection drops while the
 * body is read. The message is `Request failed: <METHOD> <origin><path>:
 * <cause message>`, or `Reading the response body failed: ...` for the
 * body read, or `Request timed out after <n> ms: <METHOD> <origin><path>`.
 * It never names a header value, the query string or the body, and it
 * looks for each header value both as given and trimmed of space, tab,
 * CR and LF, since Node quotes a refused value after it trims it. The
 * `cause` is the fetch error itself only when it is a plain error: no own
 * property but its stack, its message and a string or number `code`, and
 * no request part in either. Any other error, Node's `fetch failed` with
 * its socket error included, becomes a copy that keeps the error class,
 * the name, the code and a copy of its cause made the same way, with
 * every request part taken out of each message and nothing else. A
 * logger that prints the cause chain prints no secret, and a caller can
 * still read a code such as `ECONNREFUSED` on the nested cause. The
 * timeout's cause follows the same rule.
 */

import type { FetchPayload, FetchStrategy } from '@tsnomad/fetch';
import { FetchException } from '@tsnomad/fetch';
import { Response } from './Response.js';

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** The longest delay Node's `setTimeout` honors. It fires a longer one at once. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface NativeFetchOptions {
  /**
   * The fetch to call. Without one, the global `fetch` is read at each
   * call, so a fetch replaced after the strategy was built is used.
   */
  fetch?: typeof globalThis.fetch;

  /** The default timeout in milliseconds, for payloads without their own. */
  timeout?: number;
}

export class NativeFetchStrategy implements FetchStrategy {
  private readonly fetchImpl: typeof globalThis.fetch | undefined;
  private readonly timeout: number;

  /**
   * @throws RangeError when `options.timeout` is given and is not a number
   *   above zero and at most 2147483647, the longest delay Node's timers
   *   honor
   */
  constructor(options: NativeFetchOptions = {}) {
    const timeout = options.timeout;
    if (timeout !== undefined && !(typeof timeout === 'number' && timeout > 0 && timeout <= MAX_TIMEOUT_MS)) {
      throw new RangeError(`NativeFetchStrategy: the timeout option must be a number of milliseconds above zero and at most ${MAX_TIMEOUT_MS}, got ${String(timeout)}`);
    }
    // Left undefined without the option, so the global fetch is read at
    // each call.
    this.fetchImpl = options.fetch;
    this.timeout = timeout ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  async fetch(payload: FetchPayload): Promise<Response> {
    let url: URL;
    try {
      url = new URL(payload.getUrl());
    } catch {
      // A new error, with no cause: the parser's own error keeps the URL,
      // query and all, in its input.
      throw new TypeError('NativeFetchStrategy: the payload URL is not a valid absolute URL');
    }
    if (url.username !== '' || url.password !== '') {
      // Fetch refuses user info with an error that quotes the whole URL,
      // password included, so refuse it here without naming the URL.
      throw new TypeError('NativeFetchStrategy: the payload URL carries a user name or password, which fetch will not send');
    }
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(payload.getParams())) query.append(name, String(value));
    const extra = query.toString();
    // Added after the URL's own query, which is left as it was written.
    if (extra !== '') url.search = url.search === '' ? extra : `${url.search.slice(1)}&${extra}`;

    const method = payload.getMethod();
    const where = `${method} ${url.origin}${url.pathname}`;
    const ms = payload.getTimeout() ?? this.timeout;
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    const body = payload.getBody();

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
    try {
      let res: Awaited<ReturnType<typeof globalThis.fetch>>;
      try {
        res = await doFetch(url.href, {
          method,
          headers: payload.getHeaders(),
          ...(body === null ? {} : { body }),
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) throw this.timedOutFailure(ms, where, error, payload, url);
        throw this.failure(`Request failed: ${where}`, error, payload, url);
      }
      let text: string;
      try {
        // The timer still runs here, so the timeout covers the body read.
        text = await res.text();
      } catch (error) {
        if (timedOut) throw this.timedOutFailure(ms, where, error, payload, url);
        throw this.failure(`Reading the response body failed: ${where}`, error, payload, url);
      }
      const response = new Response().setStatus(res.status);
      // Node's Headers yields each set-cookie value on its own, so values
      // under a name already seen are joined to it, not put in its place.
      res.headers.forEach((value, name) => {
        const earlier = response.getHeader(name);
        response.setHeader(name, earlier === null ? value : `${earlier}, ${value}`);
      });
      return response.setBody(text);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The FetchException for a fetch error, its message `<what>: <cause
   * text>`, the cause text being the error's message with every request
   * part taken out, and its cause from `safeCause`.
   */
  private failure(what: string, error: unknown, payload: FetchPayload, url: URL): FetchException {
    const secrets = this.requestParts(payload, url);
    const text = redact(error instanceof Error ? error.message : String(error), secrets);
    return new FetchException(`${what}: ${text}`, { cause: safeCause(error, secrets) });
  }

  /** The FetchException for a call the timeout aborted, its cause from `safeCause`. */
  private timedOutFailure(ms: number, where: string, error: unknown, payload: FetchPayload, url: URL): FetchException {
    return new FetchException(`Request timed out after ${ms} ms: ${where}`, { cause: safeCause(error, this.requestParts(payload, url)) });
  }

  /**
   * Every header value, as given and trimmed of HTTP whitespace, every
   * query value, the whole query string and the body, longest first.
   * Node's fetch quotes a header value it refuses, after it trims space,
   * tab, CR and LF from both ends, and another fetch may echo more.
   */
  private requestParts(payload: FetchPayload, url: URL): string[] {
    return [
      ...Object.values(payload.getHeaders()).flatMap((value) => [value, value.replace(HTTP_WHITESPACE_ENDS, '')]),
      ...url.searchParams.values(),
      payload.getBody() ?? '',
      url.search.slice(1),
    ]
      .filter((secret) => secret !== '')
      // Longest first, so a short value inside a longer one cannot leave
      // part of the longer one behind.
      .sort((a, b) => b.length - a.length);
  }
}

/** Space, tab, CR and LF at either end of a header value, which Node trims before it checks the value. */
const HTTP_WHITESPACE_ENDS = /^[ \t\r\n]+|[ \t\r\n]+$/g;

/** `text` with each of `secrets`, longest first, replaced by `[redacted]`. */
function redact(text: string, secrets: readonly string[]): string {
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  return text;
}

/** The standard error classes a copy keeps, so `instanceof` still answers as it did. */
const STANDARD_ERRORS: ReadonlyArray<new (message: string) => Error> = [TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError];

/** How deep a copy follows a cause chain. */
const MAX_CAUSE_DEPTH = 10;

/**
 * The cause for a FetchException. The fetch error itself when it is a
 * plain error, one with no own property but its stack, its message and a
 * string or number `code`, and no request part in its message or code.
 * Anything else, such as Node's `fetch failed` with its socket error as
 * cause, or an error from another fetch that carries its request config,
 * is copied by `redactedCopy`. Searching what a logger prints for each
 * request part cannot work: escaping, getters and short values that turn
 * up in stack frames all defeat it.
 */
function safeCause(error: unknown, secrets: readonly string[]): unknown {
  if (!(error instanceof Error)) return redactedCopy(error, secrets, 0);
  const plain = Reflect.ownKeys(error).every((key) => {
    if (key === 'stack') return true;
    const own = Object.getOwnPropertyDescriptor(error, key);
    if (own === undefined || !('value' in own)) return false;
    if (key === 'message') return typeof own.value === 'string' && !secrets.some((secret) => (own.value as string).includes(secret));
    if (key === 'code') return (typeof own.value === 'string' || typeof own.value === 'number') && !secrets.some((secret) => String(own.value).includes(secret));
    return false;
  });
  return plain ? error : redactedCopy(error, secrets, 0);
}

/**
 * A copy of `error` that carries only what a caller reads: the same
 * standard error class, or else Error, the name and the message with
 * every request part taken out, the `code` when it is a string or a
 * number, and a copy of its cause made the same way, up to ten levels.
 * The code is copied as it is, since it is the platform's constant, such
 * as `ECONNREFUSED`, that tells a lasting failure from a passing one.
 */
function redactedCopy(error: unknown, secrets: readonly string[], depth: number): Error {
  const message = redact(error instanceof Error ? error.message : String(error), secrets);
  const Kind = STANDARD_ERRORS.find((kind) => error instanceof Error && error.constructor === kind) ?? Error;
  const copy = new Kind(message);
  if (error instanceof Error) {
    copy.name = redact(error.name, secrets);
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') {
      Object.defineProperty(copy, 'code', { value: code, enumerable: true, writable: true, configurable: true });
    }
    if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
      Object.defineProperty(copy, 'cause', { value: redactedCopy(error.cause, secrets, depth + 1), enumerable: false, writable: true, configurable: true });
    }
  }
  return copy;
}
