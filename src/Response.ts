/**
 * Response
 *
 * A plain in-memory `Response` from @tsnomad/http, the counterpart to the
 * `Response` model in PHPNomad's Guzzle fetch integration.
 * `NativeFetchStrategy` answers one, and a Node REST setup can build its
 * replies with it.
 *
 * - A new response has status 200, no headers and an empty body.
 * - Header names are stored in lower case, so they compare without regard
 *   to case, and `getHeaders()` answers them in lower case.
 * - `setJson` sets `content-type: application/json`.
 * - `getResponse()` answers a plain copy, `{ status, headers, body, error }`.
 *
 * Where this differs from PHPNomad: `setStatus` refuses a code outside 100
 * to 599, `setJson` refuses a value JSON cannot encode, and `getJson`
 * throws on a body that is not JSON. PHP's model stores any integer,
 * encodes `false` for a value it cannot encode, and answers an empty array
 * for a body it cannot decode.
 */

import type { Response as HttpResponse } from '@tsnomad/http';

export interface ResponseSnapshot {
  status: number;
  headers: Record<string, string>;
  body: string;
  error: string | null;
}

export class Response implements HttpResponse {
  private status = 200;
  private readonly headers = new Map<string, string>();
  private body = '';
  private error: string | null = null;

  /** @throws RangeError when `code` is not a whole number from 100 to 599 */
  setStatus(code: number): this {
    if (!Number.isInteger(code) || code < 100 || code > 599) {
      throw new RangeError(`Response: the status must be a whole number from 100 to 599, got ${String(code)}`);
    }
    this.status = code;
    return this;
  }

  getStatus(): number {
    return this.status;
  }

  setHeader(name: string, value: string): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  getHeader(name: string): string | null {
    return this.headers.get(name.toLowerCase()) ?? null;
  }

  /** A copy of every header, under lower-case names. */
  getHeaders(): Record<string, string> {
    return Object.fromEntries(this.headers);
  }

  setBody(body: string): this {
    this.body = body;
    return this;
  }

  /**
   * @throws TypeError when JSON cannot encode `data`, such as undefined, a
   *   function, a BigInt or a circular object. The response is unchanged.
   */
  setJson(data: unknown): this {
    // JSON.stringify throws a TypeError for a BigInt or a circular object,
    // and answers undefined for undefined, a function or a symbol. Encode
    // first, so a refusal leaves the response as it was.
    const encoded: string | undefined = JSON.stringify(data);
    if (typeof encoded !== 'string') {
      throw new TypeError(`Response: JSON cannot encode a value of type ${typeof data}`);
    }
    this.body = encoded;
    this.headers.set('content-type', 'application/json');
    return this;
  }

  /** @throws SyntaxError when the body is not JSON, the empty body included */
  getJson(): unknown {
    return JSON.parse(this.body);
  }

  getBody(): string {
    return this.body;
  }

  /**
   * Sets the status, 400 by default, records the message, and sets the
   * JSON body `{ "error": message }`.
   *
   * @throws RangeError as `setStatus` does
   */
  setError(message: string, code: number = 400): this {
    this.setStatus(code);
    this.error = message;
    return this.setJson({ error: message });
  }

  getErrorMessage(): string | null {
    return this.error;
  }

  /** A plain copy of the response. */
  getResponse(): ResponseSnapshot {
    return { status: this.status, headers: this.getHeaders(), body: this.body, error: this.error };
  }
}
